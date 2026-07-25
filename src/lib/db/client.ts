import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * Two pools, one security model (see drizzle/0005_enable_rls.sql):
 *
 *   `db`        — the OWNER pool (DATABASE_URL). Bypasses RLS by ownership.
 *                 Used by migrations, Auth.js tenant resolution, webhook
 *                 routing, and the Inngest pipeline — paths whose tenant
 *                 ids come from server-side state (verified events, ledger
 *                 rows), never from a user session. Every query still
 *                 filters tenant_id explicitly.
 *
 *   `withTenant` — the REQUEST-PATH entry point, running on the RLS pool
 *                 (DATABASE_URL_RLS, a non-owner role). It pins
 *                 app.tenant_id for the duration of ONE TRANSACTION, so
 *                 Postgres itself rejects any row outside that tenant —
 *                 the fail-safe against a missed WHERE clause. Dashboard
 *                 pages and server actions must do all their reads/writes
 *                 through it.
 *
 * Why transaction-local (`set_config(..., true)`) and never SET SESSION:
 * under pooled connections (pgbouncer/Neon transaction pooling) a session
 * GUC survives on the server connection and leaks to whichever client
 * borrows it next — a cross-tenant hole. SET LOCAL dies with the
 * transaction, which is the only pooling-safe scope.
 *
 * In development, DATABASE_URL_RLS may be unset and falls back to
 * DATABASE_URL (owner ⇒ policies not enforced). Production MUST set it to
 * the app_rls role or the fail-safe is inert — the console warning below
 * exists so that misconfiguration is loud.
 */
declare global {
  var __db: PostgresJsDatabase<typeof schema> | undefined;
  var __rlsDb: PostgresJsDatabase<typeof schema> | undefined;
}

function createPool(url: string) {
  // Serverless-friendly: small pool, no prepared statements (pgbouncer-safe).
  const client = postgres(url, { max: 5, prepare: false });
  return drizzle(client, { schema });
}

export const db =
  globalThis.__db ?? (globalThis.__db = createPool(env().DATABASE_URL));

function rlsDb(): PostgresJsDatabase<typeof schema> {
  if (!globalThis.__rlsDb) {
    const url = env().DATABASE_URL_RLS || env().DATABASE_URL;
    if (!env().DATABASE_URL_RLS && process.env.NODE_ENV === "production") {
      console.warn(
        "[db] DATABASE_URL_RLS is not set — request-path queries are running " +
          "on the owner role and Postgres RLS is NOT enforcing tenant isolation.",
      );
    }
    globalThis.__rlsDb = createPool(url);
  }
  return globalThis.__rlsDb;
}

/** The handle request-path code queries through inside withTenant(). */
export type TenantTx = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

/**
 * Run `fn` with app.tenant_id pinned for exactly one transaction on the
 * RLS pool. tenantId must come from the caller's SESSION (never a form or
 * query param) — the same rule as everywhere else, now backed by the
 * database: even if a query inside `fn` forgets its WHERE tenant_id,
 * policies return only this tenant's rows and reject foreign writes.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return rlsDb().transaction(async (tx) => {
    // 3rd arg `true` = transaction-local; resets on commit/rollback.
    await tx.execute(
      sql`select set_config('app.tenant_id', ${tenantId}, true)`,
    );
    return fn(tx);
  });
}
