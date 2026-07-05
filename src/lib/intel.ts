import { and, eq } from "drizzle-orm";

import type { CallExtraction } from "@/lib/ai/schemas";
import { db } from "@/lib/db/client";
import { competitiveIntel } from "@/lib/db/schema";

/**
 * Keep competitive_intel in lockstep with an interaction's CURRENT
 * extraction version: replace-then-insert so a replay or reviewer edit
 * updates the aggregates instead of double-counting mentions. Called from
 * every path that persists an extraction version.
 */
export async function syncCompetitiveIntel(input: {
  tenantId: string;
  interactionId: string;
  extractionId: string;
  payload: CallExtraction;
  occurredAt: Date;
}): Promise<void> {
  await db
    .delete(competitiveIntel)
    .where(
      and(
        eq(competitiveIntel.tenantId, input.tenantId),
        eq(competitiveIntel.interactionId, input.interactionId),
      ),
    );

  const rows = input.payload.competitors
    .filter((c) => c.name.trim().length > 0)
    .map((c) => ({
      tenantId: input.tenantId,
      interactionId: input.interactionId,
      extractionId: input.extractionId,
      competitor: c.name.trim().toLowerCase(),
      rawName: c.name.trim(),
      context: c.context,
      sentiment: c.sentiment,
      occurredAt: input.occurredAt,
    }));

  if (rows.length > 0) {
    await db.insert(competitiveIntel).values(rows);
  }
}
