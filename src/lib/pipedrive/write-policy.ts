import {
  AUTO_WRITE_CONFIDENCE_FLOOR,
  type CallExtraction,
  type Signal,
} from "@/lib/ai/schemas";
import { env } from "@/lib/env";

/**
 * Write-safety guardrails for Pipedrive:
 *
 * - Notes are append-only and therefore always safe — written for every
 *   interaction regardless of confidence. This alone delivers visible
 *   "100% data entry" inside Pipedrive.
 * - Custom field updates require per-signal confidence >= 0.8 AND a
 *   configured field key. A signal that doesn't clear the bar simply isn't
 *   written; it remains visible in the note and in Postgres for review.
 */
export function buildDealFieldUpdate(
  extraction: CallExtraction,
): Record<string, string> {
  const e = env();
  const fields: Record<string, string> = {};

  const mapping: [fieldKey: string, signal: Signal][] = [
    [e.PIPEDRIVE_FIELD_BANT_BUDGET, extraction.bant.budget],
    [e.PIPEDRIVE_FIELD_BANT_AUTHORITY, extraction.bant.authority],
    [e.PIPEDRIVE_FIELD_BANT_NEED, extraction.bant.need],
    [e.PIPEDRIVE_FIELD_BANT_TIMELINE, extraction.bant.timeline],
  ];

  for (const [fieldKey, signal] of mapping) {
    if (!fieldKey) continue;
    if (signal.value === null) continue;
    if (signal.confidence < AUTO_WRITE_CONFIDENCE_FLOOR) continue;
    fields[fieldKey] = signal.value;
  }

  return fields;
}

export function renderNoteHtml(
  extraction: CallExtraction,
  meta: { title: string | null; occurredAt: string },
): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const bantRow = (label: string, s: Signal) =>
    s.value === null
      ? `<li><b>${label}:</b> <i>not discussed</i></li>`
      : `<li><b>${label}:</b> ${esc(s.value)} <i>(confidence ${Math.round(s.confidence * 100)}%)</i></li>`;

  const parts = [
    `<b>📞 ${esc(meta.title ?? "Call")}</b> — ${meta.occurredAt.slice(0, 10)}`,
    `<p>${esc(extraction.summary)}</p>`,
    "<b>BANT</b>",
    "<ul>",
    bantRow("Budget", extraction.bant.budget),
    bantRow("Authority", extraction.bant.authority),
    bantRow("Need", extraction.bant.need),
    bantRow("Timeline", extraction.bant.timeline),
    "</ul>",
  ];

  if (extraction.objections.length > 0) {
    parts.push(
      "<b>Objections</b>",
      "<ul>",
      ...extraction.objections.map(
        (o) =>
          `<li>[${o.category}${o.resolved ? ", resolved" : ", open"}] "${esc(o.quote)}"</li>`,
      ),
      "</ul>",
    );
  }

  if (extraction.nextSteps.length > 0) {
    parts.push(
      "<b>Next steps</b>",
      "<ul>",
      ...extraction.nextSteps.map(
        (n) =>
          `<li>${esc(n.owner)}: ${esc(n.action)}${n.due ? ` (due ${n.due})` : ""}</li>`,
      ),
      "</ul>",
    );
  }

  parts.push("<p><i>Logged automatically by CRM Intelligence.</i></p>");
  return parts.join("\n");
}
