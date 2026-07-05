import {
  AUTO_WRITE_CONFIDENCE_FLOOR,
  type CallExtraction,
  type Signal,
} from "@/lib/ai/schemas";
import type { fieldMappings } from "@/lib/db/schema";

/**
 * Write-safety guardrails for Pipedrive:
 *
 * - Notes are append-only and therefore always safe — written for every
 *   interaction regardless of confidence. This alone delivers visible
 *   "100% data entry" inside Pipedrive.
 * - Custom field updates are driven by the TENANT's field_mappings rows:
 *   a signal is written only if the tenant mapped it to one of their
 *   Pipedrive custom fields AND it clears the confidence floor (the
 *   mapping's own minConfidence, or the global 0.8 default). No mapping,
 *   no write — the signal remains visible in the note and in Postgres.
 */
export type FieldMapping = Pick<
  typeof fieldMappings.$inferSelect,
  "signal" | "pipedriveFieldKey" | "minConfidence"
>;

export function buildDealFieldUpdate(
  extraction: CallExtraction,
  mappings: FieldMapping[],
): Record<string, string> {
  // Partial: not every mappable signal is extraction-driven (deal_risk is
  // written by its own outbox op, not from a CallExtraction).
  const signals: Partial<Record<FieldMapping["signal"], Signal>> = {
    bant_budget: extraction.bant.budget,
    bant_authority: extraction.bant.authority,
    bant_need: extraction.bant.need,
    bant_timeline: extraction.bant.timeline,
  };

  const fields: Record<string, string> = {};
  for (const mapping of mappings) {
    const signal = signals[mapping.signal];
    if (!signal || signal.value === null) continue;
    const floor = mapping.minConfidence ?? AUTO_WRITE_CONFIDENCE_FLOOR;
    if (signal.confidence < floor) continue;
    fields[mapping.pipedriveFieldKey] = signal.value;
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
