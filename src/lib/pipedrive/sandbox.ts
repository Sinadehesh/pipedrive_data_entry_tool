import { db } from "@/lib/db/client";
import { sandboxWrites } from "@/lib/db/schema";
import { routeSandboxCall } from "./sandbox-router";

/**
 * A deterministic, offline stand-in for the Pipedrive API.
 *
 * WHY: every stage downstream of ingestion — identity resolution, the
 * confidence-gated write policy, the outbox reconciler — is only meaningful
 * if something answers on the other end of `pipedrive()`. Waiting on a paid
 * Pipedrive seat to find out whether the extraction pipeline works is the
 * wrong order of operations. A tenant whose connection has
 * `kind: "sandbox"` gets served from here instead, and every write is
 * appended to `sandbox_writes` so a human can read back exactly what would
 * have hit the CRM.
 *
 * The routing/id logic lives in ./sandbox-router (pure, unit tested); this
 * module is only the recording side effect.
 *
 * WRITES ARE RECORDED, READS ARE NOT: sandbox_writes answers "what would we
 * have changed?", and filling it with lookups would bury that.
 */
export async function simulatePipedrive(
  tenantId: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  opts: { query?: Record<string, string>; body?: unknown },
): Promise<unknown> {
  const response = routeSandboxCall(method, path, opts);

  if (method !== "GET") {
    await db.insert(sandboxWrites).values({
      tenantId,
      method,
      path,
      requestBody: (opts.body ?? null) as never,
      responseBody: (response ?? null) as never,
    });
  }

  return response;
}

export {
  SANDBOX_DEAL_FIELDS,
  sandboxFieldKeyFor,
} from "./sandbox-router";
