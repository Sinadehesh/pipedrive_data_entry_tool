import { OAuth2Client } from "google-auth-library";
import { google, type gmail_v1 } from "googleapis";

import { decryptSecret } from "@/lib/crypto";
import type { connections, GoogleCredential } from "@/lib/db/schema";
import { env } from "@/lib/env";

/**
 * A tenant's Google connection row. `credentialCiphertext` decrypts to a
 * GoogleCredential ({refreshToken}) at the moment a client is built — the
 * plaintext never leaves this module and is never returned from an Inngest
 * step.
 */
export type GoogleConnection = Pick<
  typeof connections.$inferSelect,
  "id" | "accountRef" | "credentialCiphertext"
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
 * OAuth client bound to one mailbox's refresh token (our single OAuth app
 * serves every tenant; the refresh token is what scopes it to a mailbox).
 * google-auth-library transparently mints/refreshes access tokens per
 * request, so callers never see token expiry.
 */
export function oauthClientFor(connection: GoogleConnection): OAuth2Client {
  const { clientId, clientSecret } = googleEnv();
  const credential = JSON.parse(
    decryptSecret(connection.credentialCiphertext),
  ) as GoogleCredential;
  const client = new OAuth2Client(clientId, clientSecret);
  client.setCredentials({ refresh_token: credential.refreshToken });
  return client;
}

export function gmailFor(connection: GoogleConnection): gmail_v1.Gmail {
  return google.gmail({ version: "v1", auth: oauthClientFor(connection) });
}
