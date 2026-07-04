import { OAuth2Client } from "google-auth-library";
import { google, type gmail_v1 } from "googleapis";

import { decryptSecret } from "@/lib/crypto";
import type { connections } from "@/lib/db/schema";
import { env } from "@/lib/env";

export type Connection = Pick<
  typeof connections.$inferSelect,
  "id" | "email" | "refreshTokenCiphertext"
>;

export function googleEnv() {
  const e = env();
  for (const k of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GMAIL_PUBSUB_TOPIC",
    "PUBSUB_PUSH_SERVICE_ACCOUNT",
    "PUBSUB_PUSH_AUDIENCE",
  ] as const) {
    if (!e[k]) throw new Error(`${k} is required for Google ingestion`);
  }
  return {
    clientId: e.GOOGLE_CLIENT_ID,
    clientSecret: e.GOOGLE_CLIENT_SECRET,
    pubsubTopic: e.GMAIL_PUBSUB_TOPIC,
    pushServiceAccount: e.PUBSUB_PUSH_SERVICE_ACCOUNT,
    pushAudience: e.PUBSUB_PUSH_AUDIENCE,
  };
}

/**
 * OAuth client bound to one mailbox's refresh token. google-auth-library
 * transparently mints/refreshes access tokens per request, so callers never
 * see token expiry.
 */
export function oauthClientFor(connection: Connection): OAuth2Client {
  const { clientId, clientSecret } = googleEnv();
  const client = new OAuth2Client(clientId, clientSecret);
  client.setCredentials({
    refresh_token: decryptSecret(connection.refreshTokenCiphertext),
  });
  return client;
}

export function gmailFor(connection: Connection): gmail_v1.Gmail {
  return google.gmail({ version: "v1", auth: oauthClientFor(connection) });
}
