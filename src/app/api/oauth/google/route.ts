import { and, eq } from "drizzle-orm";
import { OAuth2Client } from "google-auth-library";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { encryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import {
  connections,
  watchChannels,
  type GoogleCredential,
} from "@/lib/db/schema";
import { env } from "@/lib/env";
import { googleEnv, type GoogleConnection } from "@/lib/google/auth";
import { startCalendarWatch } from "@/lib/google/calendar";
import { startWatch as startGmailWatch } from "@/lib/google/gmail";

/**
 * Google Workspace OAuth callback: verify state -> exchange code -> encrypt
 * the refresh token -> upsert the connection -> ARM BOTH WATCHES (this is
 * the moment the renewal cron takes over the lifecycle) -> back to settings.
 *
 * Tenant comes from the session; the mailbox identity comes from Google's
 * verified id_token — never from anything the client typed. Watch-arming
 * failures (e.g. Pub/Sub topic missing) don't lose the grant: the
 * connection is saved with the error recorded, visible on the settings
 * page, and the renewal cron retries every 6 hours.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.tenantId) {
    return NextResponse.redirect(settingsUrl("error=signin_required"));
  }
  const tenantId = session.tenantId;

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const jar = await cookies();
  const expectedState = jar.get("google_oauth_state")?.value;
  jar.delete("google_oauth_state");
  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.redirect(settingsUrl("error=google_state_mismatch"));
  }

  // Exchange the code and identify the mailbox from the verified id_token.
  const { clientId, clientSecret } = googleEnv();
  const oauth = new OAuth2Client(clientId, clientSecret, redirectUri());
  let refreshToken: string;
  let email: string;
  try {
    const { tokens } = await oauth.getToken(code);
    if (!tokens.refresh_token || !tokens.id_token) {
      return NextResponse.redirect(settingsUrl("error=google_no_refresh_token"));
    }
    const ticket = await oauth.verifyIdToken({
      idToken: tokens.id_token,
      audience: clientId,
    });
    const claims = ticket.getPayload();
    if (!claims?.email || !claims.email_verified) {
      return NextResponse.redirect(settingsUrl("error=google_no_email"));
    }
    refreshToken = tokens.refresh_token;
    email = claims.email.toLowerCase();
  } catch {
    return NextResponse.redirect(settingsUrl("error=google_exchange_failed"));
  }

  // (provider, account_ref) is globally unique — a mailbox already claimed
  // by another tenant is refused, never silently re-homed.
  const [existing] = await db
    .select({ id: connections.id, tenantId: connections.tenantId })
    .from(connections)
    .where(
      and(eq(connections.provider, "google"), eq(connections.accountRef, email)),
    )
    .limit(1);
  if (existing && existing.tenantId !== tenantId) {
    return NextResponse.redirect(settingsUrl("error=google_already_claimed"));
  }

  const credential: GoogleCredential = { refreshToken };
  const values = {
    tenantId,
    provider: "google" as const,
    accountRef: email,
    credentialCiphertext: encryptSecret(JSON.stringify(credential)),
    status: "active" as const,
    lastError: null,
    updatedAt: new Date(),
  };
  let connectionId: string;
  if (existing) {
    await db.update(connections).set(values).where(eq(connections.id, existing.id));
    connectionId = existing.id;
  } else {
    const [row] = await db
      .insert(connections)
      .values(values)
      .returning({ id: connections.id });
    connectionId = row.id;
  }

  // Arm both watches now; the 6-hourly renewal cron owns them from here.
  const conn: GoogleConnection = {
    id: connectionId,
    accountRef: email,
    credentialCiphertext: values.credentialCiphertext,
  };
  const watchErrors: string[] = [];

  try {
    const gmail = await startGmailWatch(conn);
    await upsertChannel(connectionId, "gmail", {
      cursor: gmail.historyId, // initial cursor only — renewals never touch it
      expiresAt: gmail.expiresAt,
    });
  } catch (err) {
    watchErrors.push(`gmail: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const cal = await startCalendarWatch(conn);
    await upsertChannel(connectionId, "gcal", {
      externalChannelId: cal.channelId,
      externalResourceId: cal.resourceId,
      expiresAt: cal.expiresAt,
      // cursor stays null: the first notification runs the bounded initial
      // sync and seeds the syncToken.
    });
  } catch (err) {
    watchErrors.push(`gcal: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (watchErrors.length > 0) {
    await db
      .update(connections)
      .set({
        status: "error",
        lastError: `watch setup failed — retried by renewal cron: ${watchErrors.join("; ")}`,
        updatedAt: new Date(),
      })
      .where(eq(connections.id, connectionId));
    return NextResponse.redirect(settingsUrl("connected=google&warn=watches"));
  }

  return NextResponse.redirect(settingsUrl("connected=google"));
}

async function upsertChannel(
  connectionId: string,
  kind: "gmail" | "gcal",
  set: {
    cursor?: string;
    externalChannelId?: string;
    externalResourceId?: string;
    expiresAt: Date;
  },
): Promise<void> {
  await db
    .insert(watchChannels)
    .values({ connectionId, kind, ...set })
    .onConflictDoUpdate({
      target: [watchChannels.connectionId, watchChannels.kind],
      // Re-connect: refresh channel identity/expiry but PRESERVE an
      // existing delta cursor (same rule as the renewal cron).
      set: {
        ...(set.externalChannelId
          ? {
              externalChannelId: set.externalChannelId,
              externalResourceId: set.externalResourceId,
            }
          : {}),
        expiresAt: set.expiresAt,
        lastError: null,
        updatedAt: new Date(),
      },
    });
}

function settingsUrl(query: string): string {
  const base = env().APP_URL || "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/settings/sync?${query}`;
}

function redirectUri(): string {
  const base = env().APP_URL || "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/api/oauth/google`;
}
