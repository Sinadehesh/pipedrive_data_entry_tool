import { z } from "zod";

/**
 * Typed event contracts. Every producer (webhook routes, steps, crons) and
 * every consumer (functions) share these schemas via the Inngest client.
 */
export const eventSchemas = {
  "claap/recording.completed": {
    data: z.object({
      recordingId: z.string(),
      rawEventId: z.string().uuid(),
    }),
  },
  "sync/extraction.ready": {
    data: z.object({
      interactionId: z.string().uuid(),
      extractionId: z.string().uuid(),
    }),
  },
  "google/gmail.notified": {
    data: z.object({
      /** The mailbox the notification is about — joins to connections.email. */
      emailAddress: z.string().email(),
      /**
       * historyId carried by the notification. Informational only: the sync
       * job always pulls from the CURSOR STORED in watch_channels, so missed
       * or out-of-order notifications can never skip messages.
       */
      notifiedHistoryId: z.string(),
    }),
  },
};
