import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { identityMap, type Participant } from "@/lib/db/schema";
import type { PipedriveAccount } from "@/lib/pipedrive/client";
import {
  createOrg,
  createPerson,
  findOpenDealForPerson,
  searchOrgByName,
  searchPersonByEmail,
} from "@/lib/pipedrive/records";

export type ResolvedIdentity = {
  email: string;
  personId: number;
  orgId: number | null;
  dealId: number | null;
};

const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
]);

/**
 * Resolve participants to a person/org/deal in the TENANT's Pipedrive.
 *
 * Fully tenant-scoped: the cache lookup, the Pipedrive API calls (via the
 * tenant's own account), and the cache write all carry tenantId — the same
 * prospect email legitimately maps to different person ids in different
 * tenants' CRMs, and one tenant's cache can never leak into another's.
 *
 * Order: cache -> persons/search by email -> create (org from domain, then
 * person). Deal attachment picks the person's most recently updated open
 * deal. Runs inside a durable step, so partial progress is retried safely —
 * every write path is idempotent (search-before-create + tenant-scoped
 * unique email cache).
 */
export async function resolveIdentity(
  tenantId: string,
  account: PipedriveAccount,
  participants: Participant[],
  internalDomainSet: Set<string>,
): Promise<ResolvedIdentity | null> {
  const externals = participants.filter((p) => {
    const domain = p.email.split("@")[1]?.toLowerCase();
    return domain && !internalDomainSet.has(domain);
  });

  for (const participant of externals) {
    const resolved = await resolveOne(tenantId, account, participant);
    if (resolved) return resolved;
  }
  return null;
}

async function resolveOne(
  tenantId: string,
  account: PipedriveAccount,
  participant: Participant,
): Promise<ResolvedIdentity | null> {
  const email = normalizeEmail(participant.email);
  const domain = email.split("@")[1];

  // 1. Cache hit — free (no Pipedrive token spend).
  const [cached] = await db
    .select()
    .from(identityMap)
    .where(
      and(eq(identityMap.tenantId, tenantId), eq(identityMap.email, email)),
    )
    .limit(1);
  if (cached?.personId) {
    return {
      email,
      personId: cached.personId,
      orgId: cached.orgId,
      dealId: cached.dealId,
    };
  }

  // 2. Search the tenant's Pipedrive by exact email.
  let person = await searchPersonByEmail(account, email);
  let orgId = person?.org_id ?? null;
  let resolution = "search";

  // 3. Not found — create org (corporate domains only) then person.
  if (!person) {
    if (domain && !FREE_MAIL_DOMAINS.has(domain)) {
      const orgName = domain.split(".")[0];
      const existingOrg = await searchOrgByName(account, orgName);
      orgId = existingOrg?.id ?? (await createOrg(account, orgName)).id;
    }
    person = await createPerson(account, {
      name: participant.name ?? email,
      email,
      orgId,
    });
    resolution = "created";
  }

  const deal = await findOpenDealForPerson(account, person.id);

  await db
    .insert(identityMap)
    .values({
      tenantId,
      email,
      personId: person.id,
      orgId,
      dealId: deal?.id ?? null,
      resolution,
    })
    .onConflictDoUpdate({
      target: [identityMap.tenantId, identityMap.email],
      set: {
        personId: person.id,
        orgId,
        dealId: deal?.id ?? null,
        resolution,
        resolvedAt: new Date(),
      },
    });

  return { email, personId: person.id, orgId, dealId: deal?.id ?? null };
}

function normalizeEmail(email: string): string {
  const lower = email.trim().toLowerCase();
  // Strip plus-addressing: jane+demo@acme.com === jane@acme.com
  const [local, domain] = lower.split("@");
  return `${local.split("+")[0]}@${domain}`;
}
