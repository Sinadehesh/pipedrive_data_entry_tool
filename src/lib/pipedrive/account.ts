import { eq } from "drizzle-orm";

import { requireConnection } from "@/lib/connections";
import { encryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { connections, type PipedriveCredential } from "@/lib/db/schema";
import { refreshTokens } from "./oauth";
import type { PipedriveAccount } from "./client";

/** Refresh when the access token has less than this long to live. */
const REFRESH_SKEW_MS = 2 * 60 * 1000;

/**
 * Materialize a callable PipedriveAccount for a tenant, refreshing OAuth
 * access tokens transparently (and persisting the rotated credential —
 * Pipedrive refresh tokens are single-use).
 *
 * Call this INSIDE the code that makes Pipedrive requests (a step executor,
 * a server component) and let the plaintext die with the closure — never
 * return it from an Inngest step.
 */
export async function pipedriveAccountFor(
  tenantId: string,
): Promise<PipedriveAccount> {
  const conn = await requireConnection(tenantId, "pipedrive");
  const credential = conn.credential;

  if (credential.kind === "api_token") {
    return {
      domain: credential.domain,
      auth: { type: "api_token", token: credential.apiToken },
    };
  }

  const msLeft = new Date(credential.expiresAt).getTime() - Date.now();
  if (msLeft > REFRESH_SKEW_MS) {
    return {
      domain: credential.domain,
      auth: { type: "bearer", token: credential.accessToken },
    };
  }

  // Expired or about to: rotate. On failure the tenant's grant is likely
  // revoked — flag the connection so the dashboard shows it.
  try {
    const rotated = await refreshTokens(credential.refreshToken);
    const next: PipedriveCredential = {
      kind: "oauth",
      domain: rotated.domain || credential.domain,
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      expiresAt: rotated.expiresAt,
    };
    await db
      .update(connections)
      .set({
        credentialCiphertext: encryptSecret(JSON.stringify(next)),
        status: "active",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(connections.id, conn.connectionId));
    return {
      domain: next.domain,
      auth: { type: "bearer", token: next.accessToken },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(connections)
      .set({
        status: "error",
        lastError: `token refresh failed: ${message}`,
        updatedAt: new Date(),
      })
      .where(eq(connections.id, conn.connectionId));
    throw err;
  }
}
