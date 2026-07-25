/**
 * Preflight doctor — checks everything that can be verified from outside a
 * browser, so the manual setup guide only contains steps that genuinely
 * need a human clicking in a console.
 *
 *   npm run doctor              # check local .env / current shell
 *   npm run doctor -- --prod    # stricter: requires https APP_URL, RLS role
 *
 * It never writes anything. Every failure prints the exact fix.
 * Exit code 0 = ready, 1 = something needs attention.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import postgres from "postgres";

const PROD = process.argv.includes("--prod");

type Level = "ok" | "warn" | "fail";
const results: { level: Level; label: string; detail?: string; fix?: string }[] = [];

function record(level: Level, label: string, detail?: string, fix?: string) {
  results.push({ level, label, detail, fix });
  const icon = level === "ok" ? "✓" : level === "warn" ? "!" : "✗";
  console.log(`${icon} ${label}${detail ? ` — ${detail}` : ""}`);
  if (fix && level !== "ok") console.log(`    → ${fix}`);
}

const EXPECTED_MIGRATIONS = 6; // drizzle/0000 … 0005

/** Tables that must have RLS enabled by migration 0005. */
const RLS_TABLES = [
  "raw_events",
  "interactions",
  "extractions",
  "sync_outbox",
  "sync_log",
  "identity_map",
  "connections",
  "field_mappings",
  "competitive_intel",
  "invites",
];

// ---------------------------------------------------------------------------
// 1. Environment
// ---------------------------------------------------------------------------

function checkEnv(): void {
  console.log("\n── Environment ──");

  const required = [
    ["DATABASE_URL", "Postgres owner connection string"],
    ["ANTHROPIC_API_KEY", "Anthropic API key for extraction"],
    ["AUTH_SECRET", "Auth.js session signing secret"],
    ["TOKEN_ENCRYPTION_KEY", "AES-256-GCM key for tenant credentials"],
    ["APP_URL", "Public origin, e.g. https://app.example.com"],
  ] as const;

  for (const [name, what] of required) {
    if (!process.env[name]) {
      record("fail", name, "missing", `Set ${name} (${what}).`);
    } else {
      record("ok", name, "set");
    }
  }

  // DATABASE_URL_RLS: optional in dev, mandatory in prod or RLS is inert.
  if (!process.env.DATABASE_URL_RLS) {
    record(
      PROD ? "fail" : "warn",
      "DATABASE_URL_RLS",
      "not set — request queries would run as the table OWNER, so RLS enforces nothing",
      "Create the app_rls role (scripts/sql/create-rls-role.sql) and set DATABASE_URL_RLS to its connection string.",
    );
  } else if (process.env.DATABASE_URL_RLS === process.env.DATABASE_URL) {
    record(
      "fail",
      "DATABASE_URL_RLS",
      "identical to DATABASE_URL — the owner bypasses RLS",
      "Point it at the non-owner app_rls role instead.",
    );
  } else {
    record("ok", "DATABASE_URL_RLS", "set to a distinct role");
  }

  // Encryption key must decode to exactly 32 bytes, and round-trip.
  const rawKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (rawKey) {
    const key = Buffer.from(rawKey, "base64");
    if (key.length !== 32) {
      record(
        "fail",
        "TOKEN_ENCRYPTION_KEY",
        `decodes to ${key.length} bytes, needs exactly 32`,
        "Regenerate with: openssl rand -base64 32",
      );
    } else if (!cryptoRoundTrips(key)) {
      record("fail", "TOKEN_ENCRYPTION_KEY", "failed an encrypt/decrypt round-trip");
    } else {
      record("ok", "TOKEN_ENCRYPTION_KEY", "32 bytes, round-trips");
    }
  }

  if (process.env.APP_URL && PROD && !process.env.APP_URL.startsWith("https://")) {
    record(
      "fail",
      "APP_URL",
      "must be https in production — OAuth redirects and webhook URLs derive from it",
    );
  }

  // Feature-gating vars: absence disables a plane rather than breaking the app.
  const google = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GMAIL_PUBSUB_TOPIC",
    "PUBSUB_PUSH_SERVICE_ACCOUNT",
    "PUBSUB_PUSH_AUDIENCE",
  ];
  const missingGoogle = google.filter((v) => !process.env[v]);
  if (missingGoogle.length === 0) {
    record("ok", "Google Workspace vars", "all 5 set");
  } else {
    record(
      "warn",
      "Google Workspace vars",
      `missing ${missingGoogle.join(", ")}`,
      "Email/calendar ingestion stays dormant until these are set (see docs/SETUP_GUIDE.md step 4).",
    );
  }

  const pipedrive = ["PIPEDRIVE_CLIENT_ID", "PIPEDRIVE_CLIENT_SECRET"];
  const missingPd = pipedrive.filter((v) => !process.env[v]);
  if (missingPd.length === 0) {
    record("ok", "Pipedrive OAuth vars", "set");
  } else {
    record(
      "fail",
      "Pipedrive OAuth vars",
      `missing ${missingPd.join(", ")}`,
      "Without these no tenant can connect a CRM — nothing gets written anywhere (guide step 5).",
    );
  }
}

function cryptoRoundTrips(key: Buffer): boolean {
  try {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([c.update("probe", "utf8"), c.final()]);
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(c.getAuthTag());
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8") === "probe";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 2. Database + migrations
// ---------------------------------------------------------------------------

async function checkDatabase(): Promise<void> {
  console.log("\n── Database ──");
  if (!process.env.DATABASE_URL) {
    record("fail", "database", "skipped, DATABASE_URL not set");
    return;
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    await sql`select 1`;
    record("ok", "connection (owner)", "reachable");

    // Migrations applied?
    const applied = await sql<{ count: string }[]>`
      select count(*)::text from drizzle.__drizzle_migrations
    `.catch(() => null);

    if (!applied) {
      record(
        "fail",
        "migrations",
        "no migration table found",
        "Run: npm run db:migrate",
      );
    } else {
      const n = Number(applied[0].count);
      if (n < EXPECTED_MIGRATIONS) {
        record(
          "fail",
          "migrations",
          `${n} applied, expected ${EXPECTED_MIGRATIONS}`,
          "Run: npm run db:migrate",
        );
      } else {
        record("ok", "migrations", `${n} applied`);
      }
    }

    // RLS enabled + policy present on every tenant-scoped table?
    const rls = await sql<{ relname: string; relrowsecurity: boolean; policies: string }[]>`
      select c.relname,
             c.relrowsecurity,
             (select count(*)::text from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any(${RLS_TABLES})
    `;
    const byName = new Map(rls.map((r) => [r.relname, r]));
    const notEnabled = RLS_TABLES.filter((t) => !byName.get(t)?.relrowsecurity);
    const noPolicy = RLS_TABLES.filter((t) => Number(byName.get(t)?.policies ?? 0) === 0);

    if (notEnabled.length > 0) {
      record(
        "fail",
        "RLS enabled",
        `not enabled on: ${notEnabled.join(", ")}`,
        "Migration 0005 has not been applied. Run: npm run db:migrate",
      );
    } else {
      record("ok", "RLS enabled", `all ${RLS_TABLES.length} tenant tables`);
    }
    if (noPolicy.length > 0) {
      record("fail", "RLS policies", `missing on: ${noPolicy.join(", ")}`);
    } else {
      record("ok", "RLS policies", "tenant_isolation present on every table");
    }

    // Tenancy snapshot — useful context, never a failure.
    const [{ count: tenantCount }] = await sql<{ count: string }[]>`
      select count(*)::text from tenants
    `;
    const conns = await sql<{ provider: string; status: string; count: string }[]>`
      select provider, status, count(*)::text from connections group by 1,2 order by 1,2
    `;
    record("ok", "tenants", `${tenantCount} in database`);
    if (conns.length === 0) {
      record(
        "warn",
        "connections",
        "none yet",
        "Expected before first onboarding. Connect Pipedrive + a call source in /settings/sync.",
      );
    } else {
      for (const c of conns) {
        record(
          c.status === "active" ? "ok" : "warn",
          `connection ${c.provider}`,
          `${c.count} × ${c.status}`,
          c.status !== "active"
            ? "Check connections.last_error — a tenant's ingestion is degraded."
            : undefined,
        );
      }
    }

    // Watch channels lapsing? This is how ingestion dies silently.
    const watches = await sql<{ kind: string; expires_at: Date; last_error: string | null }[]>`
      select kind, expires_at, last_error from watch_channels order by expires_at
    `;
    if (watches.length > 0) {
      const lapsed = watches.filter((w) => w.expires_at.getTime() < Date.now());
      if (lapsed.length > 0) {
        record(
          "fail",
          "watch channels",
          `${lapsed.length} expired`,
          "renew-watches cron is not running or is failing — check Inngest.",
        );
      } else {
        const soonest = watches[0].expires_at.toISOString().slice(0, 16);
        record("ok", "watch channels", `${watches.length} live, next expiry ${soonest}`);
      }
    }

    // Outbox backlog — the reconciler struggling shows up here first.
    const stuck = await sql<{ status: string; count: string }[]>`
      select status, count(*)::text from sync_outbox
      where status in ('pending','deferred','in_flight','failed') group by 1
    `;
    for (const s of stuck) {
      const n = Number(s.count);
      record(
        n > 50 || s.status === "failed" ? "warn" : "ok",
        `outbox ${s.status}`,
        `${n} rows`,
        s.status === "failed" ? "Inspect sync_outbox.last_error." : undefined,
      );
    }
  } catch (err) {
    record(
      "fail",
      "connection (owner)",
      err instanceof Error ? err.message.slice(0, 120) : String(err),
      "Check DATABASE_URL host, credentials, and IP allow-list.",
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ---------------------------------------------------------------------------
// 3. RLS actually enforces (the real proof, not just "enabled")
// ---------------------------------------------------------------------------

async function checkRlsEnforcement(): Promise<void> {
  console.log("\n── RLS enforcement (as app_rls) ──");
  const url = process.env.DATABASE_URL_RLS;
  if (!url || url === process.env.DATABASE_URL) {
    record("warn", "enforcement probe", "skipped — no distinct DATABASE_URL_RLS");
    return;
  }

  const sql = postgres(url, { max: 1, prepare: false });
  try {
    // (a) With no tenant context set, policies must match zero rows.
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text from interactions
    `;
    if (Number(count) === 0) {
      record("ok", "fail-closed", "no tenant context ⇒ 0 rows visible");
    } else {
      record(
        "fail",
        "fail-closed",
        `${count} rows visible with NO tenant context — RLS is not enforcing`,
        "DATABASE_URL_RLS is probably still an owner/superuser role. Recreate app_rls per scripts/sql/create-rls-role.sql.",
      );
    }

    // (b) A cross-tenant INSERT must be rejected by WITH CHECK.
    const tenantA = "11111111-1111-1111-1111-111111111111";
    const tenantB = "22222222-2222-2222-2222-222222222222";
    let rejected = false;
    try {
      await sql.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
        await tx`
          insert into interactions
            (tenant_id, source, external_id, kind, occurred_at, participants, content)
          values
            (${tenantB}, 'claap', 'doctor-probe', 'call', now(), '[]'::jsonb, 'probe')
        `;
        throw new Error("__rollback__");
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rejected = /row-level security/i.test(msg);
      if (!rejected && !msg.includes("__rollback__")) {
        record("warn", "cross-tenant write probe", msg.slice(0, 120));
      }
    }
    record(
      rejected ? "ok" : "fail",
      "cross-tenant write blocked",
      rejected ? "WITH CHECK rejected a foreign tenant_id" : "the write was NOT rejected",
      rejected ? undefined : "Verify the tenant_isolation policies include WITH CHECK.",
    );
  } catch (err) {
    record(
      "fail",
      "connection (app_rls)",
      err instanceof Error ? err.message.slice(0, 120) : String(err),
      "Check the app_rls credentials and that GRANTs were applied.",
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ---------------------------------------------------------------------------
// 4. Deployed app reachability
// ---------------------------------------------------------------------------

async function checkDeployment(): Promise<void> {
  const base = process.env.APP_URL?.replace(/\/$/, "");
  if (!base) return;
  console.log("\n── Deployed app ──");

  // Inngest's serve endpoint answers GET with function metadata.
  try {
    const res = await fetch(`${base}/api/inngest`, { method: "GET" });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as
        | { function_count?: number }
        | null;
      const n = body?.function_count;
      record(
        n === 13 ? "ok" : "warn",
        "Inngest endpoint",
        n != null ? `${n} functions registered (expected 13)` : "reachable",
        n != null && n !== 13
          ? "Re-sync the app in the Inngest dashboard."
          : undefined,
      );
    } else {
      record("warn", "Inngest endpoint", `HTTP ${res.status}`);
    }
  } catch (err) {
    record(
      "fail",
      "Inngest endpoint",
      err instanceof Error ? err.message.slice(0, 80) : String(err),
      `Is ${base} deployed and public?`,
    );
  }

  // Webhooks must reject unsigned posts — a cheap proof they are wired.
  const probes: { label: string; path: string; expect: number[] }[] = [
    {
      label: "Claap webhook",
      path: "/api/webhooks/claap/00000000-0000-0000-0000-000000000000",
      expect: [404],
    },
    {
      label: "Zoom webhook",
      path: "/api/webhooks/zoom/00000000-0000-0000-0000-000000000000",
      expect: [404],
    },
    { label: "Gmail push webhook", path: "/api/webhooks/google/gmail", expect: [401] },
  ];
  for (const { label, path, expect } of probes) {
    try {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      record(
        expect.includes(res.status) ? "ok" : "warn",
        label,
        `rejects unsigned POST with ${res.status}`,
      );
    } catch {
      record("warn", label, "unreachable");
    }
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    `CRM Intelligence — preflight doctor${PROD ? " (production mode)" : ""}`,
  );

  checkEnv();
  await checkDatabase();
  await checkRlsEnforcement();
  await checkDeployment();

  const fails = results.filter((r) => r.level === "fail");
  const warns = results.filter((r) => r.level === "warn");

  console.log("\n── Summary ──");
  console.log(
    `${results.filter((r) => r.level === "ok").length} ok · ${warns.length} warnings · ${fails.length} failures`,
  );

  if (fails.length > 0) {
    console.log("\nMust fix before onboarding anyone:");
    for (const f of fails) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ""}`);
    process.exit(1);
  }
  console.log(
    warns.length > 0
      ? "\nNo blockers. Review the warnings above, then continue with docs/SETUP_GUIDE.md."
      : "\nAll green — proceed to the dogfood pass (SETUP_GUIDE step 8).",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
