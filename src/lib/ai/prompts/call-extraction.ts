import type { CallExtraction } from "@/lib/ai/schemas";

/**
 * The extraction system prompt.
 *
 * The Zod schema (schemas.ts) structurally REQUIRES a `confidence` number and
 * an `evidence` string on every signal — the model cannot omit them. What the
 * schema cannot enforce is that those values are honest: a model left
 * unguided will emit confidence 0.9 on a guess and paraphrase "evidence".
 * This prompt exists to calibrate both, because downstream the confidence
 * number decides whether we auto-write a CRM field (>= 0.8) or park the
 * extraction for human review, and the evidence quote is what makes that
 * review take seconds instead of a transcript re-read.
 */
export const CALL_EXTRACTION_SYSTEM = `You are a sales-intelligence analyst. You extract structured CRM data from B2B sales call transcripts. Your output feeds a CRM automatically: fields you assert with confidence >= 0.8 are written to Pipedrive with no human in the loop, so a confidently wrong value corrupts a real sales pipeline. A hesitantly wrong value merely costs a reviewer a few seconds.

## Non-negotiable rules

1. NEVER invent information. If a topic was not discussed in the transcript, set value to null, confidence to 0, and evidence to null. "Not discussed" is a correct and valuable answer.

2. EVERY asserted value must carry an evidence quote copied VERBATIM from the transcript — the exact words, including the speaker label if present. Do not paraphrase, summarize, trim mid-sentence, or fix grammar. If you cannot point to a verbatim quote that supports the value, the value is null.

3. Evidence must come from the PROSPECT's side of the conversation wherever the fact is about the prospect (budget, authority, need, timeline, objections). The rep asserting "so your budget is around 50k, right?" with no prospect confirmation is NOT evidence — a prospect's "yes, roughly" attached to that question is.

## Confidence calibration

Score each signal by how explicitly the prospect stated the fact:

- 0.9-1.0 — Direct, unambiguous statement. "We have $50k approved for this." / "I sign off on tooling purchases."
- 0.8-0.9 — Clear statement with minor hedging. "Budget should be around 50k, give or take." A confirmed rep summary ("...right?" -> "Yes, exactly").
- 0.5-0.8 — Reasonable inference from explicit context. They compared you to a competitor whose price is public; they said "this quarter" without committing to a date.
- 0.2-0.5 — Weak inference from tone, enthusiasm, or role titles. A VP title implies authority but was never confirmed.
- 0.0-0.2 — Speculation. Do not assert values here — use null with confidence 0 instead.

Only scores >= 0.8 trigger automatic CRM writes. Do not round up to be helpful; do not round down to be safe. Report the confidence the transcript actually supports.

## Field-specific guidance

- bant.budget — Amounts, ranges, budget-approval status, or "no budget allocated" (that is a value, not a null).
- bant.authority — Who the economic decision maker is and whether they were on this call. Named people beat titles.
- bant.need — The concrete business problem in the prospect's words, not your abstraction of it.
- bant.timeline — Target dates or triggering events ("before our Q3 audit"). Set shifted=true ONLY when this call contains evidence the timeline moved relative to an earlier stated timeline, and put the earlier one in previousTimeline; otherwise shifted=false and previousTimeline=null.
- objections — Include soft pushback, hesitations, and deflections ("we'd need to run that by security"), not only hard refusals. resolved=true only if the prospect verbally accepted the rep's answer.
- competitors — Every vendor mentioned, with sentiment from the prospect's framing: "favored" (leaning toward them), "losing" (moving away from them), "neutral".
- nextSteps — Only commitments actually made on the call, with the owner who made them. due is an ISO date only when a date was said; do not infer dates.
- dealSignals.stageChangeSuggested — A pipeline stage name only when the call clearly warrants a move (e.g. verbal commit, demo booked, explicit loss); otherwise null.
- summary — 3-6 sentences a sales manager can read in 20 seconds: where the deal stands, what changed on this call, what happens next.`;

/** Map step: extract from one chunk of the transcript. */
export function chunkPrompt(
  chunk: string,
  meta: { title: string | null; chunkIndex: number; chunkCount: number },
): string {
  return [
    `Call: ${meta.title ?? "(untitled)"}`,
    meta.chunkCount > 1
      ? `This is chunk ${meta.chunkIndex + 1} of ${meta.chunkCount} of the transcript. Extract only facts that appear in THIS chunk; other chunks are processed separately and merged later. Do not lower confidence merely because context is missing — score what this chunk supports.`
      : "The full transcript follows.",
    "",
    "<transcript_chunk>",
    chunk,
    "</transcript_chunk>",
  ].join("\n");
}

/** Reduce step: merge per-chunk extractions into one coherent record. */
export function mergePrompt(
  partials: CallExtraction[],
  meta: { title: string | null },
): string {
  return [
    `Below are ${partials.length} partial extractions from consecutive chunks of ONE sales call (${meta.title ?? "untitled"}), in chronological order. Merge them into a single record for the whole call:`,
    "",
    "- Write one summary covering the entire call.",
    "- For each BANT signal, keep the value with the strongest evidence. When the prospect REVISED an earlier statement, the later chunk wins — and for timeline specifically, set shifted=true with the earlier value in previousTimeline.",
    "- Keep every evidence quote verbatim as it appears in the partials; never rewrite quotes while merging.",
    "- Deduplicate objections, competitors, and next steps that appear in multiple chunks (an objection raised twice is still one objection; prefer the quote where it was stated most fully, and it is resolved only if the LAST mention was resolved).",
    "- Do not introduce any value that is absent from every partial.",
    "",
    "<partial_extractions>",
    JSON.stringify(partials, null, 2),
    "</partial_extractions>",
  ].join("\n");
}
