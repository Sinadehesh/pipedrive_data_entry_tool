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
};
