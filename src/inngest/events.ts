import { z } from "zod";

/**
 * Typed event contracts. Every producer (webhook routes, steps, crons) and
 * every consumer (functions) share these schemas via the Inngest client.
 *
 * tenantId on an event always originates from server-side state — a ledger
 * row, a connection row, a verified webhook path — never from client input.
 */
export const eventSchemas = {
  "claap/recording.completed": {
    data: z.object({
      tenantId: z.string().uuid(),
      recordingId: z.string(),
      rawEventId: z.string().uuid(),
    }),
  },
  "sync/extraction.ready": {
    data: z.object({
      tenantId: z.string().uuid(),
      interactionId: z.string().uuid(),
      extractionId: z.string().uuid(),
    }),
  },
  "google/gmail.notified": {
    data: z.object({
      /** The mailbox the notification is about — joins to connections.accountRef. */
      emailAddress: z.string().email(),
      /**
       * historyId carried by the notification. Informational only: the sync
       * job always pulls from the CURSOR STORED in watch_channels, so missed
       * or out-of-order notifications can never skip messages.
       */
      notifiedHistoryId: z.string(),
    }),
  },
  "google/calendar.notified": {
    data: z.object({
      /**
       * The channel id WE generated at watch time — an unguessable uuid
       * that routes to exactly one watch_channels row (and one tenant).
       * Like Gmail, the ping carries no content; the job pulls the delta
       * from the stored syncToken cursor.
       */
      channelId: z.string(),
    }),
  },
  /**
   * Nightly staleness fan-out, stage 1 -> stage 2. One event per active
   * tenant so each tenant's scan runs in its own bounded invocation.
   */
  "sync/tenant.staleness.check": {
    data: z.object({
      tenantId: z.string().uuid(),
    }),
  },
  /**
   * A Gmail thread gained newly-ingested messages. Consumed by the
   * DEBOUNCED thread extractor, so a burst of replies is analyzed once
   * with full context instead of once per message.
   */
  "gmail/thread.changed": {
    data: z.object({
      tenantId: z.string().uuid(),
      threadId: z.string(),
    }),
  },
  /** A calendar meeting entered the ledger; extract signals from it. */
  "gcal/meeting.ingested": {
    data: z.object({
      tenantId: z.string().uuid(),
      interactionId: z.string().uuid(),
    }),
  },
  /** A Zoom transcript-ready webhook was persisted; fetch and extract. */
  "zoom/recording.ready": {
    data: z.object({
      tenantId: z.string().uuid(),
      rawEventId: z.string().uuid(),
    }),
  },
  /**
   * Fired after a new connection is established: import a bounded window
   * of history through the identical ledger -> extract -> sync path.
   */
  "connection/backfill.requested": {
    data: z.object({
      tenantId: z.string().uuid(),
      connectionId: z.string().uuid(),
      provider: z.enum(["google"]),
      days: z.number().int().min(1).max(365).default(90),
    }),
  },
  /**
   * Re-run LLM extraction for one interaction from the IMMUTABLE ledger —
   * no re-ingestion, no provider API calls. Appends a new extraction
   * version; history is never rewritten.
   */
  "ledger/interaction.replay": {
    data: z.object({
      tenantId: z.string().uuid(),
      interactionId: z.string().uuid(),
    }),
  },
  /**
   * Generic "this tenant has due outbox rows" nudge for the reconciler —
   * used by producers whose rows aren't tied to a fresh extraction
   * (calendar risk flags, staleness sweep, drain cron).
   */
  "sync/outbox.ready": {
    data: z.object({
      tenantId: z.string().uuid(),
    }),
  },
};
