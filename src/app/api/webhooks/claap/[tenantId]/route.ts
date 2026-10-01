import {
  CLAAP_SECRET_HEADER,
  parseRecordingAdded,
  verifyClaapSecret,
  type ClaapWebhookPayload,
} from "@/lib/claap/webhook";
import { getConnection } from "@/lib/connections";
import { db } from "@/lib/db/client";
import { rawEvents } from "@/lib/db/schema";
import { inngest } from "@/inngest/client";

/**
 * Tenant-scoped Claap webhook: each tenant registers
 * `/api/webhooks/claap/{tenantId}` in THEIR Claap workspace, and the
 * x-claap-webhook-secret header is checked against THAT tenant's stored
 * secret — so the path segment is only routing, never trust: a request for
 * tenant A carrying tenant B's secret is rejected.
 *
 * Still the "dumb edge": verify -> persist raw -> enqueue -> 200. The
 * verbatim payload is the source of the call's metadata (title, start
 * time, participants) — Claap's transcript endpoint returns segments only.
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

  if (
    !verifyClaapSecret(
      req.headers.get(CLAAP_SECRET_HEADER),
      claap.credential.webhookSecret,
    )
  ) {
    return new Response("invalid webhook secret", { status: 401 });
  }

  let payload: ClaapWebhookPayload;
  try {
    payload = JSON.parse(raw) as ClaapWebhookPayload;
  } catch {
    return new Response("malformed payload", { status: 400 });
  }

  const recording = parseRecordingAdded(payload);
  if (!recording) {
    // recording_updated and anything else: acknowledge so Claap doesn't
    // retry. Re-extracting on every edit would spam the CRM with notes.
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
      externalId: recording.eventId,
      payload,
    })
    .onConflictDoNothing()
    .returning({ id: rawEvents.id });

  if (inserted) {
    await inngest.send({
      name: "claap/recording.completed",
      data: {
        tenantId,
        recordingId: recording.recordingId,
        rawEventId: inserted.id,
      },
    });
  }

  return new Response(null, { status: 200 });
}
