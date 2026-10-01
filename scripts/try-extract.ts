/**
 * Run the REAL call-extraction prompt on a transcript and score the result.
 *
 * Needs only ANTHROPIC_API_KEY — no database, no Inngest, no CRM. This is
 * the fastest answer to "does the AI part actually work?", and the loop to
 * use when tuning src/lib/ai/prompts/call-extraction.ts.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... npm run try:extract
 *   ANTHROPIC_API_KEY=sk-ant-... npm run try:extract -- --transcript call.txt
 *
 * Transcript format: one utterance per line, "Speaker: text".
 *
 * Two kinds of checks:
 *  - GENERIC (any transcript): every evidence quote must appear verbatim in
 *    the transcript. A quote that doesn't is a hallucination, and it would
 *    otherwise be written to a customer's CRM as "evidence".
 *  - GROUND TRUTH (built-in sample only): the sample states each BANT field,
 *    a competitor and an objection plainly, so the right answers are known.
 *
 * Exit code 0 = every check passed.
 */
import { readFileSync } from "node:fs";

import { chunkTranscript } from "@/lib/ai/chunking";
import {
  EXTRACTION_MODEL_ID,
  extractChunk,
  mergeExtractions,
} from "@/lib/ai/extractor";
import {
  AUTO_WRITE_CONFIDENCE_FLOOR,
  overallConfidence,
  type CallExtraction,
} from "@/lib/ai/schemas";
import { SAMPLE_TRANSCRIPT } from "./fixtures/sample-call";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/** Normalize for "is this quote really in the transcript?" comparisons. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^["'\s]+|["'.\s]+$/g, "")
    .trim();
}

/** Strip "Speaker:" prefixes so a quote spanning one utterance matches. */
function transcriptBody(t: string): string {
  return norm(
    t
      .split("\n")
      .map((line) => line.replace(/^[^:]{1,60}:\s*/, ""))
      .join(" "),
  );
}

type Check = { label: string; pass: boolean; detail?: string };

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "Set ANTHROPIC_API_KEY (console.anthropic.com → API keys). It is the only thing this needs.",
    );
    process.exit(1);
  }

  const path = arg("transcript");
  const transcript = path ? readFileSync(path, "utf8") : SAMPLE_TRANSCRIPT;
  const title = arg("title") ?? (path ? null : "Discovery call (sample)");
  const chunks = chunkTranscript(transcript);

  console.log(
    `Model ${EXTRACTION_MODEL_ID} · ${transcript.length} chars · ${chunks.length} chunk(s)\n`,
  );
  const started = Date.now();
  const partials: CallExtraction[] = [];
  for (const [i, chunk] of chunks.entries()) {
    partials.push(
      await extractChunk(chunk, { title, chunkIndex: i, chunkCount: chunks.length }),
    );
  }
  const x = await mergeExtractions(partials, { title });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  // ---- What it understood ----
  console.log("═══ SUMMARY ═══");
  console.log(x.summary, "\n");
  console.log("═══ BANT ═══");
  for (const [k, s] of Object.entries(x.bant)) {
    const mark =
      s.value === null ? "·" : s.confidence >= AUTO_WRITE_CONFIDENCE_FLOOR ? "✓" : "?";
    console.log(
      `${mark} ${k.padEnd(9)} ${s.value === null ? "(not discussed)" : `${s.confidence.toFixed(2)}  ${s.value}`}`,
    );
    if (s.evidence) console.log(`             “${s.evidence}”`);
  }
  console.log("\n═══ COMPETITORS ═══");
  for (const c of x.competitors) console.log(`  ${c.name} (${c.sentiment}) — ${c.context}`);
  if (x.competitors.length === 0) console.log("  none");
  console.log("\n═══ OBJECTIONS ═══");
  for (const o of x.objections)
    console.log(`  [${o.category}${o.resolved ? ", resolved" : ""}] “${o.quote}”`);
  if (x.objections.length === 0) console.log("  none");
  console.log("\n═══ NEXT STEPS ═══");
  for (const n of x.nextSteps)
    console.log(`  ${n.owner}: ${n.action}${n.due ? ` (due ${n.due})` : ""}`);
  if (x.dealSignals.riskFlags.length > 0) {
    console.log("\n═══ RISK FLAGS ═══");
    for (const r of x.dealSignals.riskFlags) console.log(`  ⚠ ${r}`);
  }

  const overall = overallConfidence(x);
  console.log(
    `\nOverall confidence ${overall.toFixed(2)} → ${
      overall >= AUTO_WRITE_CONFIDENCE_FLOOR
        ? "AUTO-WRITES mapped fields to Pipedrive"
        : "held in /review for a human (note is still written)"
    }`,
  );
  console.log(`Took ${seconds}s\n`);

  // ---- Scorecard ----
  const checks: Check[] = [];
  const body = transcriptBody(transcript);
  const quotes: [string, string][] = [
    ...Object.entries(x.bant)
      .filter(([, s]) => s.evidence)
      .map(([k, s]) => [`evidence: ${k}`, s.evidence!] as [string, string]),
    ...x.objections.map(
      (o, i) => [`objection quote #${i + 1}`, o.quote] as [string, string],
    ),
  ];
  for (const [label, quote] of quotes) {
    // Allow a quote to be an excerpt, and allow "…" elisions between parts.
    const parts = quote.split(/\.\.\.|…/).map(norm).filter((p) => p.length > 0);
    const pass = parts.every((p) => body.includes(p));
    checks.push({ label: `${label} is verbatim`, pass, detail: pass ? undefined : quote });
  }
  for (const [k, s] of Object.entries(x.bant)) {
    if (s.value === null && s.confidence > 0) {
      checks.push({
        label: `${k}: null value carries confidence 0`,
        pass: false,
        detail: `confidence ${s.confidence}`,
      });
    }
  }

  if (!path) {
    const has = (v: string | null | undefined, ...needles: string[]) =>
      !!v && needles.some((n) => v.toLowerCase().includes(n));
    checks.push(
      { label: "budget: ~$50k approval limit", pass: has(x.bant.budget.value, "50", "fifty") },
      { label: "authority: CFO / Marcus above limit", pass: has(x.bant.authority.value, "cfo", "marcus") },
      { label: "timeline: before March QBR", pass: has(x.bant.timeline.value, "march", "qbr") },
      { label: "need: stated", pass: x.bant.need.value !== null },
      {
        label: "competitor: Gong, prospect leaning our way",
        pass: x.competitors.some((c) => /gong/i.test(c.name) && c.sentiment === "favored"),
        detail: JSON.stringify(x.competitors.map((c) => [c.name, c.sentiment])),
      },
      {
        label: "objection: security review",
        pass: x.objections.some((o) => o.category === "security"),
      },
      {
        label: "next step: rep sends SOC 2 report",
        pass: x.nextSteps.some((n) => /soc ?2/i.test(n.action)),
      },
      {
        label: "clear call clears the auto-write floor",
        pass: overall >= AUTO_WRITE_CONFIDENCE_FLOOR,
        detail: overall.toFixed(2),
      },
    );
  }

  console.log("═══ SCORECARD ═══");
  for (const c of checks) {
    console.log(`${c.pass ? "✓" : "✗"} ${c.label}${!c.pass && c.detail ? `  — ${c.detail}` : ""}`);
  }
  const failed = checks.filter((c) => !c.pass).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
