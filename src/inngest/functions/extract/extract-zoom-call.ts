import { and, eq } from "drizzle-orm";

import { chunkTranscript } from "@/lib/ai/chunking";
import { extractChunk, mergeExtractions } from "@/lib/ai/extractor";
import { db } from "@/lib/db/client";
import { interactions, rawEvents } from "@/lib/db/schema";
import {
  fetchZoomTranscript,
  type ZoomRecordingWebhook,
} from "@/lib/zoom/client";
import { inngest } from "@/inngest/client";
import { persistAndEnqueue } from "./persist";

/**
 * Zoom sibling of extract-call: fetch the VTT transcript using the
 * webhook's own download_token (re-read from raw_events, where the
 * verbatim payload lives), ledger it, then the standard checkpointed
 * map/reduce. Same call-extraction prompt — a Zoom call IS a call.
 *
 * The download_token expires (~24h), so the fetch step runs early and the
 * ledger row is what everything downstream (including replay) uses.
 */
export const extractZoomCall = inngest.createFunction(
  {
    id: "extract-zoom-call",
    retries: 3,
    concurrency: { key: "event.data.tenantId", limit: 5 },
  },
  { event: "zoom/recording.ready" },
  async ({ event, step }) => {
    const { tenantId, rawEventId } = event.data;

    // ~2s: pull the transcript while the download_token is still fresh.
    const transcript = await step.run("fetch-transcript", async () => {
      const [raw] = await db
        .select({ payload: rawEvents.payload })
        .from(rawEvents)
        .where(
          and(eq(rawEvents.tenantId, tenantId), eq(rawEvents.id, rawEventId)),
        )
        .limit(1);
      if (!raw) return null;
      return fetchZoomTranscript(raw.payload as ZoomRecordingWebhook);
    });

    if (!transcript) {
      return { skipped: "no transcript file in recording payload" };
    }
    if (transcript.text.trim().length === 0) {
      return { skipped: "empty transcript" };
    }

    // Idempotent ledger write keyed on the meeting uuid.
    const interaction = await step.run("write-ledger", async () => {
      await db
        .insert(interactions)
        .values({
          tenantId,
          source: "zoom",
          externalId: transcript.meetingUuid,
          kind: "call",
          title: transcript.topic,
          occurredAt: new Date(transcript.occurredAt),
          participants: transcript.participants,
          content: transcript.text,
          rawEventId,
        })
        .onConflictDoNothing();
      const [row] = await db
        .select({ id: interactions.id })
        .from(interactions)
        .where(
          and(
            eq(interactions.tenantId, tenantId),
            eq(interactions.source, "zoom"),
            eq(interactions.externalId, transcript.meetingUuid),
          ),
        )
        .limit(1);
      return row;
    });

    // Standard map/reduce over deterministic chunks.
    const chunks = chunkTranscript(transcript.text);
    const partials = await Promise.all(
      chunks.map((chunk, i) =>
        step.run(`extract-chunk-${i}`, () =>
          extractChunk(chunk, {
            title: transcript.topic,
            chunkIndex: i,
            chunkCount: chunks.length,
          }),
        ),
      ),
    );
    const merged = await step.run("reduce-merge", () =>
      mergeExtractions(partials, { title: transcript.topic }),
    );

    const extraction = await step.run("persist-and-enqueue", () =>
      persistAndEnqueue({
        tenantId,
        interactionId: interaction.id,
        payload: merged,
        occurredAt: new Date(transcript.occurredAt),
      }),
    );

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
