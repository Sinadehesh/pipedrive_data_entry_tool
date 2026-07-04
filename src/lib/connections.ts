import { and, eq } from "drizzle-orm";

import { decryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import {
  connections,
  type ClaapCredential,
  type GoogleCredential,
  type PipedriveCredential,
} from "@/lib/db/schema";

/**
 * Typed access to per-tenant provider credentials.
 *
 * SECURITY RULE: call these INSIDE the code that uses the credential (a
 * step's executor, a request handler) and let the plaintext die with the
 * closure. Never return a decrypted credential from an Inngest `step.run` —
 * step returns are persisted in Inngest's run state.
 */

type ProviderCredential = {
  google: GoogleCredential;
  pipedrive: PipedriveCredential;
  claap: ClaapCredential;
};

export async function getConnection<P extends keyof ProviderCredential>(
  tenantId: string,
  provider: P,
): Promise<
  | {
      connectionId: string;
      accountRef: string;
      credential: ProviderCredential[P];
    }
  | null
> {
  const [row] = await db
    .select({
      id: connections.id,
      accountRef: connections.accountRef,
      credentialCiphertext: connections.credentialCiphertext,
    })
    .from(connections)
    .where(
      and(
        eq(connections.tenantId, tenantId),
        eq(connections.provider, provider),
        eq(connections.status, "active"),
      ),
    )
    .limit(1);

  if (!row) return null;
  return {
    connectionId: row.id,
    accountRef: row.accountRef,
    credential: JSON.parse(
      decryptSecret(row.credentialCiphertext),
    ) as ProviderCredential[P],
  };
}

export class MissingConnectionError extends Error {
  constructor(tenantId: string, provider: string) {
    super(`tenant ${tenantId} has no active ${provider} connection`);
    this.name = "MissingConnectionError";
  }
}

export async function requireConnection<P extends keyof ProviderCredential>(
  tenantId: string,
  provider: P,
) {
  const conn = await getConnection(tenantId, provider);
  if (!conn) throw new MissingConnectionError(tenantId, provider);
  return conn;
}
