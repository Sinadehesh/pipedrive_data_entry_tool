/**
 * Provision a tenant whose Pipedrive connection is a SANDBOX: every CRM
 * write is simulated and recorded to `sandbox_writes` instead of being
 * sent. No Pipedrive account, trial, or seat required.
 *
 * It also creates a Claap connection (so the call webhook accepts posts)
 * and wires field mappings for all five mappable signals against the
 * sandbox's synthetic deal fields — which means the AUTO-WRITE path gets
 * exercised, not just the notes fallback.
 *
 * Usage:
 *   npm run sandbox:connect -- --name "Acme Inc" --domain acme.com
 *   npm run sandbox:connect -- --tenant <existing-uuid>
 *
 * Prints the tenant id and Claap webhook secret you need for seed:call.
 */
import { randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { encryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import {
  connections,
  fieldMappings,
  tenants,
  type ClaapCredential,
  type PipedriveCredential,
} from "@/lib/db/schema";
import {
  SANDBOX_DEAL_FIELDS,
  sandboxFieldKeyFor,
} from "@/lib/pipedrive/sandbox-router";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const MAPPABLE = [
  "bant_budget",
  "bant_authority",
  "bant_need",
  "bant_timeline",
  "deal_risk",
] as const;

async function main(): Promise<void> {
  const existingTenant = arg("tenant");
  const name = arg("name") ?? "Sandbox Workspace";
  const domain = (arg("domain") ?? "example.com").toLowerCase();

  // 1. Tenant.
  let tenantId: string;
  if (existingTenant) {
    const [row] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, existingTenant))
      .limit(1);
    if (!row) throw new Error(`no tenant ${existingTenant}`);
    tenantId = row.id;
    console.log(`• using existing tenant ${tenantId}`);
  } else {
    const [row] = await db
      .insert(tenants)
      .values({ name, internalDomains: [domain] })
      .returning({ id: tenants.id });
    tenantId = row.id;
    console.log(`✓ tenant created: ${tenantId} (${name}, internal: ${domain})`);
  }

  // 2. Sandbox Pipedrive connection. accountRef is globally unique, so it
  //    is namespaced per tenant — two sandbox tenants must not collide.
  const pipedriveCredential: PipedriveCredential = {
    kind: "sandbox",
    domain: `sandbox-${tenantId.slice(0, 8)}`,
  };
  await upsertConnection(
    tenantId,
    "pipedrive",
    `sandbox:${tenantId}`,
    JSON.stringify(pipedriveCredential),
  );
  console.log("✓ pipedrive connected in SANDBOX mode (no CRM will be touched)");

  // 3. Claap connection — the webhook route requires one to accept posts.
  //    The API key is unused when seeding with --offline.
  const webhookSecret = arg("secret") ?? randomBytes(24).toString("hex");
  const claapCredential: ClaapCredential = {
    apiKey: "unused-in-offline-mode",
    webhookSecret,
  };
  await upsertConnection(
    tenantId,
    "claap",
    `sandbox-claap:${tenantId}`,
    JSON.stringify(claapCredential),
  );
  console.log("✓ claap connected (webhook will accept signed posts)");

  // 4. Field mappings against the sandbox's synthetic deal fields.
  for (const signal of MAPPABLE) {
    await db
      .insert(fieldMappings)
      .values({
        tenantId,
        signal,
        pipedriveFieldKey: sandboxFieldKeyFor(signal),
      })
      .onConflictDoNothing();
  }
  console.log(
    `✓ ${MAPPABLE.length} field mappings wired to sandbox deal fields:`,
  );
  for (const f of SANDBOX_DEAL_FIELDS) {
    console.log(`    ${f.name.padEnd(16)} ${f.key.slice(0, 16)}…`);
  }

  console.log("\nNext:");
  console.log(
    "  1. Run the app with ALLOW_DEV_STUBS=1 and\n" +
      "     CLAAP_API_BASE=http://localhost:3000/api/dev/claap-stub",
  );
  console.log(
    `  2. npm run seed:call -- --tenant ${tenantId} \\\n` +
      `       --secret ${webhookSecret} --offline --internal ${domain}`,
  );
  console.log(`  3. npm run sandbox:report -- --tenant ${tenantId}`);
  console.log(`\nClaap webhook secret: ${webhookSecret}`);
}

async function upsertConnection(
  tenantId: string,
  provider: "pipedrive" | "claap",
  accountRef: string,
  credentialJson: string,
): Promise<void> {
  const [existing] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.tenantId, tenantId),
        eq(connections.provider, provider),
      ),
    )
    .limit(1);

  const credentialCiphertext = encryptSecret(credentialJson);
  if (existing) {
    await db
      .update(connections)
      .set({
        accountRef,
        credentialCiphertext,
        status: "active",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(connections.id, existing.id));
  } else {
    await db
      .insert(connections)
      .values({ tenantId, provider, accountRef, credentialCiphertext });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
