import { createHmac, timingSafeEqual } from "node:crypto";

import { db } from "@/lib/db/client";
import { rawEvents } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { inngest } from "@/inngest/client";

/**
 * The "dumb edge": verify → persist raw → enqueue → 200. No transcript
 * fetching, no LLM, no Pipedrive calls. Everything heavy happens in durable
 * Inngest functions, so this handler always answers in well under a second
 * and Claap never sees a timeout.
 */
export async function POST(req: Request) {
  const raw = await req.text();

  const signature = req.headers.get("x-claap-signature");
  if (!verifySignature(raw, signature)) {
    return new Response("invalid signature", { status: 401 });
  }

  let event: ClaapWebhookEvent;
  try {
    event = JSON.parse(raw) as ClaapWebhookEvent;
  } catch {
    return new Response("malformed payload", { status: 400 });
  }

  if (event.type !== "recording.completed" || !event.data?.recording_id) {
    // Acknowledge events we don't care about so Claap doesn't retry them.
    return new Response(null, { status: 200 });
  }

  // Persist the verbatim payload BEFORE enqueueing: even a total job-layer
  // outage loses nothing — events are re-emittable from raw_events.
  // The unique (source, external_id) index makes webhook redelivery a no-op.
  const [inserted] = await db
    .insert(rawEvents)
    .values({
      source: "claap",
      externalId: event.id,
      payload: event,
    })
    .onConflictDoNothing()
    .returning({ id: rawEvents.id });

  if (inserted) {
    await inngest.send({
      name: "claap/recording.completed",
      data: {
        recordingId: event.data.recording_id,
        rawEventId: inserted.id,
      },
    });
  }

  return new Response(null, { status: 200 });
}

type ClaapWebhookEvent = {
  id: string;
  type: string;
  data?: { recording_id?: string };
};

function verifySignature(rawBody: string, signature: string | null): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", env().CLAAP_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
