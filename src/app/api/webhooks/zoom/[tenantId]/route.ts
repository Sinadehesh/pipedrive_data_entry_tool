import { getConnection } from "@/lib/connections";
import { db } from "@/lib/db/client";
import { rawEvents } from "@/lib/db/schema";
import {
  urlValidationResponse,
  verifyZoomSignature,
  type ZoomRecordingWebhook,
} from "@/lib/zoom/client";
import { inngest } from "@/inngest/client";

/**
 * Tenant-scoped Zoom webhook, the sibling of the Claap route: each tenant
 * registers `/api/webhooks/zoom/{tenantId}` in THEIR Zoom app, and the
 * signature is verified against THAT tenant's stored webhook secret token
 * — the path segment is routing, never trust.
 *
 * Tenant-scoped (rather than one global route keyed on account_id) because
 * Zoom's endpoint.url_validation handshake carries no account identity:
 * answering it requires knowing whose secret to HMAC with, which only the
 * path can tell us. Zoom expects the answer within 3 seconds — another
 * reason this stays a dumb edge.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ tenantId: string }> },
) {
  const { tenantId } = await params;
  const raw = await req.text();

  const zoom = await getConnection(tenantId, "zoom");
  if (!zoom) {
    return new Response("unknown webhook", { status: 404 });
  }
  const secret = zoom.credential.webhookSecretToken;

  if (
    !verifyZoomSignature(
      raw,
      req.headers.get("x-zm-signature"),
      req.headers.get("x-zm-request-timestamp"),
      secret,
    )
  ) {
    return new Response("invalid signature", { status: 401 });
  }

  let event: ZoomRecordingWebhook;
  try {
    event = JSON.parse(raw) as ZoomRecordingWebhook;
  } catch {
    return new Response("malformed payload", { status: 400 });
  }

  // Zoom's endpoint activation handshake.
  if (event.event === "endpoint.url_validation") {
    const plainToken =
      event.payload?.plainToken ?? event.payload?.plain_token ?? "";
    return Response.json(urlValidationResponse(plainToken, secret));
  }

  // Transcript-ready is the trigger; other recording events are acked.
  if (
    event.event !== "recording.transcript_completed" ||
    !event.payload?.object?.uuid
  ) {
    return new Response(null, { status: 200 });
  }

  // Verbatim payload into raw_events — including the short-lived
  // download_token the fetch job needs (read from Postgres, never carried
  // through Inngest state). Dedupe on event+uuid absorbs redelivery.
  const [inserted] = await db
    .insert(rawEvents)
    .values({
      tenantId,
      source: "zoom",
      externalId: `${event.event}:${event.payload.object.uuid}`,
      payload: event,
    })
    .onConflictDoNothing()
    .returning({ id: rawEvents.id });

  if (inserted) {
    await inngest.send({
      name: "zoom/recording.ready",
      data: { tenantId, rawEventId: inserted.id },
    });
  }

  return new Response(null, { status: 200 });
}
