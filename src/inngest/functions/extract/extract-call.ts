import { desc, eq } from "drizzle-orm";

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
import { getTranscript } from "@/lib/claap/client";
import { db } from "@/lib/db/client";
import { extractions, interactions, syncOutbox } from "@/lib/db/schema";
import { inngest } from "@/inngest/client";

/**
 * The long-running LLM job, decomposed into checkpointed steps.
 *
 * Each `step.run()` executes as its own short serverless invocation and is
 * memoized once complete — Inngest re-invokes the function after every step
 * and skips finished ones. A 3-minute logical job therefore never comes near
 * a platform timeout, and a transient Anthropic 429/529 retries only the
 * step that failed, without recomputing (or re-billing) completed chunks.
 */
export const extractCall = inngest.createFunction(
  {
    id: "extract-call",
    retries: 3,
    // Caps parallel LLM spend when a burst of calls ends at once.
    concurrency: { limit: 5 },
    onFailure: async ({ event, error }) => {
      // Retries exhausted: record a failed extraction version so the
      // interaction is visibly stuck (and replayable) rather than silently
      // lost. The ledger row itself is untouched.
      const { recordingId } = event.data.event.data;
      const [interaction] = await db
        .select({ id: interactions.id })
        .from(interactions)
        .where(eq(interactions.externalId, recordingId))
        .limit(1);
      if (!interaction) return;

      await db.insert(extractions).values({
        interactionId: interaction.id,
        version: await nextVersion(interaction.id),
        model: EXTRACTION_MODEL_ID,
        status: "failed",
        error: error.message,
      });
    },
  },
  { event: "claap/recording.completed" },
  async ({ event, step }) => {
    // ~2s: pull the transcript from Claap.
    const transcript = await step.run("fetch-transcript", () =>
      getTranscript(event.data.recordingId),
    );

    // Idempotent ledger write: unique (source, external_id) means a
    // redelivered webhook or a function retry can never duplicate the row.
    const interaction = await step.run("write-ledger", async () => {
      await db
        .insert(interactions)
        .values({
          source: "claap",
          externalId: transcript.recordingId,
          kind: "call",
          title: transcript.title,
          occurredAt: new Date(transcript.occurredAt),
          participants: transcript.participants,
          content: transcript.text,
          rawEventId: event.data.rawEventId,
        })
        .onConflictDoNothing();

      const [row] = await db
        .select({ id: interactions.id })
        .from(interactions)
        .where(eq(interactions.externalId, transcript.recordingId))
        .limit(1);
      return row;
    });

    // Deterministic (recomputed identically on every re-invocation from the
    // memoized transcript), so the map steps below line up across retries.
    const chunks = chunkTranscript(transcript.text);

    // Map: one checkpointed step per chunk. A 90-minute call becomes ~6
    // parallel ~25s LLM calls, each with its own invocation + retry budget.
    const partials = await Promise.all(
      chunks.map((chunk, i) =>
        step.run(`extract-chunk-${i}`, () =>
          extractChunk(chunk, {
            title: transcript.title,
            chunkIndex: i,
            chunkCount: chunks.length,
          }),
        ),
      ),
    );

    // Reduce: merge partials into one record (skips the LLM for 1 chunk).
    const merged = await step.run("reduce-merge", () =>
      mergeExtractions(partials, { title: transcript.title }),
    );

    // Persist the versioned extraction + enqueue outbox rows atomically-ish:
    // outbox idempotency keys are derived from ledger identity, so a step
    // retry can never enqueue the same write twice.
    const extraction = await step.run("persist-and-enqueue", async () => {
      const confidence = overallConfidence(merged);
      const version = await nextVersion(interaction.id);

      const [row] = await db
        .insert(extractions)
        .values({
          interactionId: interaction.id,
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

      // Notes are append-only and always safe — enqueued unconditionally.
      // Field updates only for auto-approved extractions (confidence gate).
      const ops = [
        {
          op: "create_note" as const,
          idempotencyKey: `note:${interaction.id}:v${version}`,
        },
        ...(row.status === "auto_approved"
          ? [
              {
                op: "update_deal_fields" as const,
                idempotencyKey: `deal-fields:${interaction.id}:v${version}`,
              },
            ]
          : []),
      ];

      await db
        .insert(syncOutbox)
        .values(
          ops.map(({ op, idempotencyKey }) => ({
            interactionId: interaction.id,
            extractionId: row.id,
            op,
            payload: {},
            idempotencyKey,
          })),
        )
        .onConflictDoNothing();

      return row;
    });

    // Hand off to the rate-limit-aware reconciler.
    await step.sendEvent("enqueue-sync", {
      name: "sync/extraction.ready",
      data: {
        interactionId: interaction.id,
        extractionId: extraction.id,
      },
    });

    return { interactionId: interaction.id, extractionId: extraction.id };
  },
);

async function nextVersion(interactionId: string): Promise<number> {
  const [latest] = await db
    .select({ version: extractions.version })
    .from(extractions)
    .where(eq(extractions.interactionId, interactionId))
    .orderBy(desc(extractions.version))
    .limit(1);
  return (latest?.version ?? 0) + 1;
}
