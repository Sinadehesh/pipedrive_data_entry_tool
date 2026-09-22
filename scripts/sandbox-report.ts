/**
 * Read back what the pipeline WOULD have written to Pipedrive for a
 * sandbox tenant — the whole point of sandbox mode.
 *
 * This is the verification step that used to require a paid CRM: it shows
 * the rendered note HTML, the custom-field patch, and the person/org that
 * identity resolution would have created, alongside the extraction that
 * produced them and its confidence.
 *
 * Usage:
 *   npm run sandbox:report -- --tenant <uuid> [--limit 20]
 */
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  extractions,
  interactions,
  sandboxWrites,
  syncOutbox,
} from "@/lib/db/schema";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/** Strip tags so a note reads in a terminal without an HTML viewer. */
function textFromHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|tr|h\d|b|strong|table|ul|li)>/gi, "\n")
    .replace(/<\/td>/gi, "  ")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function main(): Promise<void> {
  const tenantId = arg("tenant");
  const limit = Number(arg("limit") ?? "20");
  if (!tenantId) {
    console.error("Missing --tenant <uuid>");
    process.exit(1);
  }

  // --- What the pipeline understood ---
  const recent = await db
    .select({
      title: interactions.title,
      occurredAt: interactions.occurredAt,
      source: interactions.source,
      status: extractions.status,
      confidence: extractions.overallConfidence,
      payload: extractions.payload,
    })
    .from(extractions)
    .innerJoin(interactions, eq(extractions.interactionId, interactions.id))
    .where(eq(extractions.tenantId, tenantId))
    .orderBy(desc(extractions.createdAt))
    .limit(5);

  console.log("═══ EXTRACTIONS ═══");
  if (recent.length === 0) {
    console.log("(none yet — seed a call first)");
  }
  for (const r of recent) {
    console.log(
      `\n${r.source}  ${r.occurredAt.toISOString().slice(0, 16)}  ${r.title ?? "(untitled)"}`,
    );
    console.log(
      `  status=${r.status}  overall_confidence=${r.confidence ?? "n/a"}`,
    );
    const bant = (r.payload as { bant?: Record<string, unknown> } | null)?.bant;
    if (bant) {
      for (const [k, v] of Object.entries(bant)) {
        const s = v as { value?: string; confidence?: number } | null;
        if (!s?.value) continue;
        console.log(`    ${k.padEnd(10)} ${s.confidence} — ${s.value}`);
      }
    }
  }

  // --- What would have hit the CRM ---
  const writes = await db
    .select()
    .from(sandboxWrites)
    .where(eq(sandboxWrites.tenantId, tenantId))
    .orderBy(desc(sandboxWrites.createdAt))
    .limit(limit);

  console.log(`\n═══ SIMULATED PIPEDRIVE WRITES (${writes.length}) ═══`);
  if (writes.length === 0) {
    console.log("(none — check sync_outbox for failures)");
  }
  for (const w of writes.reverse()) {
    const body = (w.requestBody ?? {}) as Record<string, unknown>;
    const id = (w.responseBody as { id?: number } | null)?.id;
    console.log(`\n▸ ${w.method} ${w.path}  → id ${id ?? "?"}`);

    if (typeof body.content === "string") {
      console.log("  ── note body ──");
      for (const line of textFromHtml(body.content).split("\n")) {
        console.log(`  │ ${line}`);
      }
      if (body.deal_id) console.log(`  attached to deal ${body.deal_id}`);
    } else if (body.custom_fields) {
      console.log("  ── custom fields ──");
      for (const [k, v] of Object.entries(
        body.custom_fields as Record<string, string>,
      )) {
        console.log(`  │ ${k.slice(0, 12)}… = ${v}`);
      }
    } else {
      console.log(`  ${JSON.stringify(body)}`);
    }
  }

  // --- Anything stuck ---
  const stuck = await db
    .select({
      op: syncOutbox.op,
      status: syncOutbox.status,
      attempts: syncOutbox.attempts,
      lastError: syncOutbox.lastError,
    })
    .from(syncOutbox)
    .where(eq(syncOutbox.tenantId, tenantId))
    .orderBy(desc(syncOutbox.createdAt))
    .limit(10);

  const unfinished = stuck.filter((s) => s.status !== "completed");
  if (unfinished.length > 0) {
    console.log("\n═══ OUTBOX NOT COMPLETED ═══");
    for (const s of unfinished) {
      console.log(
        `  ${s.op.padEnd(20)} ${s.status.padEnd(10)} attempts=${s.attempts}  ${s.lastError ?? ""}`,
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
