import { and, desc, eq } from "drizzle-orm";

import { chunkTranscript } from "@/lib/ai/chunking";
import {
  EXTRACTION_MODEL_ID,
  extractChunk,
  mergeExtractions,
} from "@/lib/ai/extractor";
import { getTranscriptText } from "@/lib/claap/client";
import {
  parseRecordingAdded,
  type ClaapWebhookPayload,
} from "@/lib/claap/webhook";
import { requireConnection } from "@/lib/connections";
import { db } from "@/lib/db/client";
import { extractions, interactions, rawEvents } from "@/lib/db/schema";
import { inngest } from "@/inngest/client";
import { persistAndEnqueue } from "./persist";

/**
 * The long-running LLM job, decomposed into checkpointed steps.
 *
 * Each `step.run()` executes as its own short serverless invocation and is
 * memoized once complete — Inngest re-invokes the function after every step
 * and skips finished ones. A 3-minute logical job therefore never comes near
 * a platform timeout, and a transient Anthropic 429/529 retries only the
 * step that failed, without recomputing (or re-billing) completed chunks.
 *
 * Multi-tenant: tenantId rides the event (originating from the verified
 * per-tenant webhook), every ledger write carries it, and the Claap API key
 * is the TENANT's own, decrypted inside the fetch step.
 */
export const extractCall = inngest.createFunction(
  {
    id: "extract-call",
    retries: 3,
    // Caps parallel LLM spend per tenant when a burst of calls ends at once.
    concurrency: { key: "event.data.tenantId", limit: 5 },
    onFailure: async ({ event, error }) => {
      // Retries exhausted: record a failed extraction version so the
      // interaction is visibly stuck (and replayable) rather than silently
      // lost. The ledger row itself is untouched.
      const { tenantId, recordingId } = event.data.event.data;
      const [interaction] = await db
        .select({ id: interactions.id })
        .from(interactions)
        .where(
          and(
            eq(interactions.tenantId, tenantId),
            eq(interactions.source, "claap"),
            eq(interactions.externalId, recordingId),
          ),
        )
        .limit(1);
      if (!interaction) return;

      await db.insert(extractions).values({
        tenantId,
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
    const { tenantId } = event.data;

    // ~2s: assemble the call. Metadata (title, start, participants) comes
    // from the verbatim recording_added payload in raw_events — Claap's
    // transcript endpoint returns segments only. The text is pulled with
    // the tenant's own Claap key, decrypted inside the step and never
    // returned from it; only the transcript (non-secret) is memoized.
    const transcript = await step.run("fetch-transcript", async () => {
      const [raw] = await db
        .select({ payload: rawEvents.payload })
        .from(rawEvents)
        .where(
          and(
            eq(rawEvents.tenantId, tenantId),
            eq(rawEvents.id, event.data.rawEventId),
          ),
        )
        .limit(1);
      const meta = raw
        ? parseRecordingAdded(raw.payload as ClaapWebhookPayload)
        : null;
      if (!meta) {
        throw new Error(
          `raw event ${event.data.rawEventId} is not a usable recording_added payload`,
        );
      }

      const claap = await requireConnection(tenantId, "claap");
      const text = await getTranscriptText(
        claap.credential,
        event.data.recordingId,
      );
      return {
        recordingId: meta.recordingId,
        title: meta.title,
        occurredAt: meta.occurredAt,
        participants: meta.participants,
        text,
      };
    });

    // Idempotent ledger write: unique (tenant, source, external_id) means a
    // redelivered webhook or a function retry can never duplicate the row.
    const interaction = await step.run("write-ledger", async () => {
      await db
        .insert(interactions)
        .values({
          tenantId,
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
        .where(
          and(
            eq(interactions.tenantId, tenantId),
            eq(interactions.source, "claap"),
            eq(interactions.externalId, transcript.recordingId),
          ),
        )
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

    // Shared tail: versioned extraction, confidence-gated outbox ops,
    // intel sync — all conflict-safe inside one step (see persist.ts).
    const extraction = await step.run("persist-and-enqueue", () =>
      persistAndEnqueue({
        tenantId,
        interactionId: interaction.id,
        payload: merged,
        occurredAt: new Date(transcript.occurredAt),
      }),
    );

    // Hand off to the per-tenant rate-limit-aware reconciler.
    await step.sendEvent("enqueue-sync", {
      name: "sync/extraction.ready",
      data: {
        tenantId,
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
