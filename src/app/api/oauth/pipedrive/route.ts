import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { encryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { connections, type PipedriveCredential } from "@/lib/db/schema";
import { exchangeCode } from "@/lib/pipedrive/oauth";

/**
 * Pipedrive OAuth callback: verify state -> exchange code -> encrypt tokens
 * -> upsert the tenant's connection -> back to settings.
 *
 * The tenant comes from the SESSION (the signed-in user completing the
 * flow), never from the query string. The state cookie proves this browser
 * initiated the flow, so a forged callback link can't attach an attacker's
 * Pipedrive account to a victim's tenant.
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
  const expectedState = jar.get("pd_oauth_state")?.value;
  jar.delete("pd_oauth_state");

  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.redirect(settingsUrl("error=pipedrive_state_mismatch"));
  }

  let credential: PipedriveCredential;
  try {
    const tokens = await exchangeCode(code);
    credential = {
      kind: "oauth",
      domain: tokens.domain,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    };
  } catch {
    return NextResponse.redirect(settingsUrl("error=pipedrive_exchange_failed"));
  }

  // (provider, account_ref) is globally unique: if another tenant already
  // connected this Pipedrive company, refuse rather than silently re-home
  // the account.
  const [existing] = await db
    .select({ id: connections.id, tenantId: connections.tenantId })
    .from(connections)
    .where(
      and(
        eq(connections.provider, "pipedrive"),
        eq(connections.accountRef, credential.domain),
      ),
    )
    .limit(1);
  if (existing && existing.tenantId !== tenantId) {
    return NextResponse.redirect(settingsUrl("error=pipedrive_already_claimed"));
  }

  const values = {
    tenantId,
    provider: "pipedrive" as const,
    accountRef: credential.domain,
    credentialCiphertext: encryptSecret(JSON.stringify(credential)),
    status: "active" as const,
    lastError: null,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(connections).set(values).where(eq(connections.id, existing.id));
  } else {
    await db.insert(connections).values(values);
  }

  return NextResponse.redirect(settingsUrl("connected=pipedrive"));
}

function settingsUrl(query: string): string {
  const base = process.env.APP_URL || "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/settings/sync?${query}`;
}
