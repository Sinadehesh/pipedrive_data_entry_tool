import { createHmac, timingSafeEqual } from "node:crypto";

import { getConnection } from "@/lib/connections";
import { db } from "@/lib/db/client";
import { rawEvents } from "@/lib/db/schema";
import { inngest } from "@/inngest/client";

/**
 * Tenant-scoped Claap webhook: each tenant registers
 * `/api/webhooks/claap/{tenantId}` in THEIR Claap workspace, and the
 * signature is verified against THAT tenant's stored webhook secret — so
 * the path segment is only routing, never trust: a request for tenant A
 * signed with tenant B's secret fails verification.
 *
 * Still the "dumb edge": verify -> persist raw -> enqueue -> 200.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ tenantId: string }> },
) {
  const { tenantId } = await params;
  const raw = await req.text();

  const claap = await getConnection(tenantId, "claap");
  if (!claap) {
    // Unknown tenant or no Claap connection — don't reveal which.
    return new Response("unknown webhook", { status: 404 });
  }

  const signature = req.headers.get("x-claap-signature");
  if (!verifySignature(raw, signature, claap.credential.webhookSecret)) {
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
  // outage loses nothing — events are re-emittable from raw_events. The
  // tenant-scoped unique (tenant, source, external_id) index makes webhook
  // redelivery a no-op.
  const [inserted] = await db
    .insert(rawEvents)
    .values({
      tenantId,
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
        tenantId,
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

function verifySignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
