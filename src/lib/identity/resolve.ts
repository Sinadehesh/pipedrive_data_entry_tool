import { eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { identityMap, type Participant } from "@/lib/db/schema";
import { internalDomains } from "@/lib/env";
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
 * Resolve call participants to a Pipedrive person/org/deal.
 *
 * The email address is the join key across every source (call participants,
 * email correspondents, calendar attendees). Resolution is cache-first
 * against identity_map so deduplication doesn't cost a Pipedrive search call
 * per event — protecting the API token budget.
 *
 * Order: cache -> persons/search by email -> create (org from domain, then
 * person). Deal attachment picks the person's most recently updated open
 * deal. Runs inside a durable step, so partial progress is retried safely —
 * every write path is idempotent (search-before-create + unique email cache).
 */
export async function resolveIdentity(
  participants: Participant[],
): Promise<ResolvedIdentity | null> {
  const internal = internalDomains();
  const externals = participants.filter((p) => {
    const domain = p.email.split("@")[1]?.toLowerCase();
    return domain && !internal.has(domain);
  });

  for (const participant of externals) {
    const resolved = await resolveOne(participant);
    if (resolved) return resolved;
  }
  return null;
}

async function resolveOne(
  participant: Participant,
): Promise<ResolvedIdentity | null> {
  const email = normalizeEmail(participant.email);
  const domain = email.split("@")[1];

  // 1. Cache hit — free.
  const [cached] = await db
    .select()
    .from(identityMap)
    .where(eq(identityMap.email, email))
    .limit(1);
  if (cached?.personId) {
    return {
      email,
      personId: cached.personId,
      orgId: cached.orgId,
      dealId: cached.dealId,
    };
  }

  // 2. Search Pipedrive by exact email.
  let person = await searchPersonByEmail(email);
  let orgId = person?.org_id ?? null;
  let resolution = "search";

  // 3. Not found — create org (corporate domains only) then person.
  if (!person) {
    if (domain && !FREE_MAIL_DOMAINS.has(domain)) {
      const orgName = domain.split(".")[0];
      const existingOrg = await searchOrgByName(orgName);
      orgId = existingOrg?.id ?? (await createOrg(orgName)).id;
    }
    person = await createPerson({
      name: participant.name ?? email,
      email,
      orgId,
    });
    resolution = "created";
  }

  const deal = await findOpenDealForPerson(person.id);

  await db
    .insert(identityMap)
    .values({
      email,
      personId: person.id,
      orgId,
      dealId: deal?.id ?? null,
      resolution,
    })
    .onConflictDoUpdate({
      target: identityMap.email,
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
