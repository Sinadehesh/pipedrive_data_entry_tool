import { OAuth2Client } from "google-auth-library";

import { db } from "@/lib/db/client";
import { rawEvents } from "@/lib/db/schema";
import { googleEnv } from "@/lib/google/auth";
import { inngest } from "@/inngest/client";

/**
 * Google Cloud Pub/Sub push endpoint for Gmail notifications.
 *
 * The notification is a thin ping — {emailAddress, historyId}, NO message
 * content — so this handler stays dumb: verify the OIDC token, persist the
 * raw envelope, enqueue, 200. Pub/Sub redelivers on slow or non-2xx
 * responses, which is exactly why nothing heavy may run here.
 *
 * Push subscription setup (one-time, GCP console or terraform):
 *   - topic: GMAIL_PUBSUB_TOPIC, with gmail-api-push@system.gserviceaccount.com
 *     granted roles/pubsub.publisher
 *   - push endpoint: this route's URL
 *   - authentication: OIDC token as PUBSUB_PUSH_SERVICE_ACCOUNT with
 *     audience PUBSUB_PUSH_AUDIENCE
 */
const verifier = new OAuth2Client();

export async function POST(req: Request) {
  // 1. Verify the push OIDC token: signature, audience, and that the caller
  //    is OUR subscription's service account — not just any Google token.
  const authorization = req.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return new Response("missing bearer token", { status: 401 });
  }

  const { pushAudience, pushServiceAccount } = googleEnv();
  let claimsEmail: string | undefined;
  try {
    const ticket = await verifier.verifyIdToken({
      idToken: authorization.slice("Bearer ".length),
      audience: pushAudience,
    });
    const claims = ticket.getPayload();
    if (claims?.email_verified) claimsEmail = claims.email;
  } catch {
    return new Response("invalid token", { status: 401 });
  }
  if (claimsEmail !== pushServiceAccount) {
    return new Response("wrong service account", { status: 403 });
  }

  // 2. Decode the envelope. Gmail packs {emailAddress, historyId} as
  //    base64 JSON in message.data.
  let envelope: PubSubPush;
  try {
    envelope = (await req.json()) as PubSubPush;
  } catch {
    return new Response("malformed body", { status: 400 });
  }
  const message = envelope?.message;
  if (!message?.data || !message.messageId) {
    // Ack malformed pushes — retrying them can never succeed.
    return new Response(null, { status: 200 });
  }

  let notification: { emailAddress?: string; historyId?: number | string };
  try {
    notification = JSON.parse(
      Buffer.from(message.data, "base64").toString("utf8"),
    );
  } catch {
    return new Response(null, { status: 200 });
  }
  if (!notification.emailAddress || notification.historyId == null) {
    return new Response(null, { status: 200 });
  }

  // 3. Persist the raw envelope before enqueueing (replay source of last
  //    resort). Pub/Sub's messageId dedupes redeliveries: on conflict we've
  //    already enqueued this ping once, so ack without re-sending.
  const [inserted] = await db
    .insert(rawEvents)
    .values({
      source: "gmail",
      externalId: message.messageId,
      payload: { message: { ...message, data: undefined }, notification },
    })
    .onConflictDoNothing()
    .returning({ id: rawEvents.id });

  if (inserted) {
    await inngest.send({
      name: "google/gmail.notified",
      data: {
        emailAddress: notification.emailAddress.toLowerCase(),
        notifiedHistoryId: String(notification.historyId),
      },
    });
  }

  return new Response(null, { status: 200 });
}

type PubSubPush = {
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
  };
  subscription?: string;
};
