import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "@/lib/env";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __db: ReturnType<typeof createDb> | undefined;
}

function createDb() {
  // Serverless-friendly: small pool, no prepared statements (pgbouncer-safe).
  const client = postgres(env().DATABASE_URL, { max: 5, prepare: false });
  return drizzle(client, { schema });
}

// Reuse the connection across hot reloads / warm invocations.
export const db = globalThis.__db ?? (globalThis.__db = createDb());
