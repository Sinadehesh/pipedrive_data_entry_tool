import { desc, eq } from "drizzle-orm";

import { EXTRACTION_MODEL_ID } from "@/lib/ai/extractor";
import {
  AUTO_WRITE_CONFIDENCE_FLOOR,
  overallConfidence,
  type CallExtraction,
} from "@/lib/ai/schemas";
import { db } from "@/lib/db/client";
import { extractions, syncOutbox } from "@/lib/db/schema";
import { syncCompetitiveIntel } from "@/lib/intel";

/**
 * The shared tail of every extraction pipeline (call, email thread,
 * meeting, zoom, replay): append the next extraction version, gate field
 * writes on confidence, enqueue idempotent outbox ops, and sync the intel
 * table. Designed to run INSIDE a single Inngest step — every write is
 * conflict-safe, so a step retry can never duplicate a version's ops.
 */
export async function persistAndEnqueue(input: {
  tenantId: string;
  interactionId: string;
  payload: CallExtraction;
  occurredAt: Date;
  model?: string;
}): Promise<{ id: string; version: number; status: "auto_approved" | "needs_review" }> {
  const confidence = overallConfidence(input.payload);

  const [latest] = await db
    .select({ version: extractions.version })
    .from(extractions)
    .where(eq(extractions.interactionId, input.interactionId))
    .orderBy(desc(extractions.version))
    .limit(1);
  const version = (latest?.version ?? 0) + 1;
  const status =
    confidence >= AUTO_WRITE_CONFIDENCE_FLOOR ? "auto_approved" : "needs_review";

  const [row] = await db
    .insert(extractions)
    .values({
      tenantId: input.tenantId,
      interactionId: input.interactionId,
      version,
      model: input.model ?? EXTRACTION_MODEL_ID,
      payload: input.payload,
      overallConfidence: confidence,
      status,
    })
    .returning({ id: extractions.id });

  // Notes are append-only and always safe — enqueued unconditionally.
  // Field updates only for auto-approved extractions; the tenant's
  // field_mappings then decide what actually reaches Pipedrive.
  const ops = [
    {
      op: "create_note" as const,
      idempotencyKey: `note:${input.interactionId}:v${version}`,
    },
    ...(status === "auto_approved"
      ? [
          {
            op: "update_deal_fields" as const,
            idempotencyKey: `deal-fields:${input.interactionId}:v${version}`,
          },
        ]
      : []),
  ];
  await db
    .insert(syncOutbox)
    .values(
      ops.map(({ op, idempotencyKey }) => ({
        tenantId: input.tenantId,
        interactionId: input.interactionId,
        extractionId: row.id,
        op,
        payload: {},
        idempotencyKey,
      })),
    )
    .onConflictDoNothing();

  await syncCompetitiveIntel({
    tenantId: input.tenantId,
    interactionId: input.interactionId,
    extractionId: row.id,
    payload: input.payload,
    occurredAt: input.occurredAt,
  });

  return { id: row.id, version, status };
}
