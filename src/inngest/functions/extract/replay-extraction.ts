import { and, desc, eq } from "drizzle-orm";

import { chunkTranscript } from "@/lib/ai/chunking";
import {
  EXTRACTION_MODEL_ID,
  extractChunk,
  mergeExtractions,
} from "@/lib/ai/extractor";
import {
  AUTO_WRITE_CONFIDENCE_FLOOR,
  overallConfidence,
} from "@/lib/ai/schemas";
import { db } from "@/lib/db/client";
import { extractions, interactions, syncOutbox } from "@/lib/db/schema";
import { syncCompetitiveIntel } from "@/lib/intel";
import { inngest } from "@/inngest/client";

/**
 * The payoff of the event-sourced ledger: re-run extraction for any
 * interaction WITHOUT touching Claap/Gmail/Google — the immutable
 * interaction row is the source. A better prompt, a newer model, or a
 * botched extraction is fixed by appending version N+1; nothing is ever
 * rewritten, and the ledger is never re-ingested.
 *
 * Same checkpointed map/reduce as extract-call; only the source differs.
 */
export const replayExtraction = inngest.createFunction(
  {
    id: "replay-extraction",
    retries: 3,
    concurrency: { key: "event.data.tenantId", limit: 5 },
  },
  { event: "ledger/interaction.replay" },
  async ({ event, step }) => {
    const { tenantId, interactionId } = event.data;

    const interaction = await step.run("load-ledger", async () => {
      const [row] = await db
        .select({
          id: interactions.id,
          title: interactions.title,
          content: interactions.content,
          occurredAt: interactions.occurredAt,
        })
        .from(interactions)
        .where(
          and(
            eq(interactions.tenantId, tenantId),
            eq(interactions.id, interactionId),
          ),
        )
        .limit(1);
      return row ?? null;
    });

    if (!interaction) {
      return { skipped: "interaction not found for tenant" };
    }

    const chunks = chunkTranscript(interaction.content);

    const partials = await Promise.all(
      chunks.map((chunk, i) =>
        step.run(`extract-chunk-${i}`, () =>
          extractChunk(chunk, {
            title: interaction.title,
            chunkIndex: i,
            chunkCount: chunks.length,
          }),
        ),
      ),
    );

    const merged = await step.run("reduce-merge", () =>
      mergeExtractions(partials, { title: interaction.title }),
    );

    const extraction = await step.run("persist-and-enqueue", async () => {
      const confidence = overallConfidence(merged);

      const [latest] = await db
        .select({ version: extractions.version })
        .from(extractions)
        .where(eq(extractions.interactionId, interactionId))
        .orderBy(desc(extractions.version))
        .limit(1);
      const version = (latest?.version ?? 0) + 1;

      const [row] = await db
        .insert(extractions)
        .values({
          tenantId,
          interactionId,
          version,
          model: EXTRACTION_MODEL_ID,
          payload: merged,
          overallConfidence: confidence,
          status:
            confidence >= AUTO_WRITE_CONFIDENCE_FLOOR
              ? "auto_approved"
              : "needs_review",
        })
        .returning({ id: extractions.id, status: extractions.status });

      const ops = [
        {
          op: "create_note" as const,
          idempotencyKey: `note:${interactionId}:v${version}`,
        },
        ...(row.status === "auto_approved"
          ? [
              {
                op: "update_deal_fields" as const,
                idempotencyKey: `deal-fields:${interactionId}:v${version}`,
              },
            ]
          : []),
      ];
      await db
        .insert(syncOutbox)
        .values(
          ops.map(({ op, idempotencyKey }) => ({
            tenantId,
            interactionId,
            extractionId: row.id,
            op,
            payload: {},
            idempotencyKey,
          })),
        )
        .onConflictDoNothing();

      await syncCompetitiveIntel({
        tenantId,
        interactionId,
        extractionId: row.id,
        payload: merged,
        occurredAt: new Date(interaction.occurredAt),
      });

      return row;
    });

    await step.sendEvent("enqueue-sync", {
      name: "sync/extraction.ready",
      data: { tenantId, interactionId, extractionId: extraction.id },
    });

    return { extractionId: extraction.id, status: extraction.status };
  },
);
