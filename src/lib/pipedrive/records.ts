import { pipedrive, type PipedriveAccount } from "./client";

/** Typed helpers over the Pipedrive endpoints, per-tenant via `account`. */

type SearchItems<T> = { items: { item: T }[] } | null;

export async function searchPersonByEmail(
  account: PipedriveAccount,
  email: string,
): Promise<{ id: number; org_id?: number | null } | null> {
  const data = await pipedrive<
    SearchItems<{ id: number; organization?: { id: number } | null }>
  >(account, "GET", "/api/v2/persons/search", {
    query: { term: email, fields: "email", exact_match: "true", limit: "1" },
  });
  const item = data?.items?.[0]?.item;
  if (!item) return null;
  return { id: item.id, org_id: item.organization?.id ?? null };
}

export async function searchOrgByName(
  account: PipedriveAccount,
  name: string,
): Promise<{ id: number } | null> {
  const data = await pipedrive<SearchItems<{ id: number }>>(
    account,
    "GET",
    "/api/v2/organizations/search",
    { query: { term: name, exact_match: "true", limit: "1" } },
  );
  return data?.items?.[0]?.item ?? null;
}

export async function createOrg(
  account: PipedriveAccount,
  name: string,
): Promise<{ id: number }> {
  return pipedrive<{ id: number }>(account, "POST", "/api/v2/organizations", {
    body: { name },
  });
}

export async function createPerson(
  account: PipedriveAccount,
  input: {
    name: string;
    email: string;
    orgId?: number | null;
  },
): Promise<{ id: number }> {
  return pipedrive<{ id: number }>(account, "POST", "/api/v2/persons", {
    body: {
      name: input.name,
      emails: [{ value: input.email, primary: true }],
      ...(input.orgId ? { org_id: input.orgId } : {}),
    },
  });
}

export async function findOpenDealForPerson(
  account: PipedriveAccount,
  personId: number,
): Promise<{ id: number } | null> {
  const deals = await pipedrive<{ id: number }[] | null>(
    account,
    "GET",
    "/api/v2/deals",
    {
      query: {
        person_id: String(personId),
        status: "open",
        sort_by: "update_time",
        sort_direction: "desc",
        limit: "1",
      },
    },
  );
  return deals?.[0] ?? null;
}

export async function updateDealCustomFields(
  account: PipedriveAccount,
  dealId: number,
  customFields: Record<string, string>,
): Promise<void> {
  await pipedrive(account, "PATCH", `/api/v2/deals/${dealId}`, {
    body: { custom_fields: customFields },
  });
}

/** Notes have no v2 endpoint yet — this is the one v1 call in the codebase. */
export async function createNote(
  account: PipedriveAccount,
  input: {
    content: string; // HTML
    dealId?: number | null;
    personId?: number | null;
  },
): Promise<{ id: number }> {
  return pipedrive<{ id: number }>(account, "POST", "/api/v1/notes", {
    body: {
      content: input.content,
      ...(input.dealId ? { deal_id: input.dealId } : {}),
      ...(input.personId ? { person_id: input.personId } : {}),
    },
  });
}

/**
 * Lists the tenant's deal custom fields — used by the settings UI so a
 * tenant maps our signals to fields by picking from THEIR schema, and by
 * connection-time validation of field_mappings.
 */
export async function listDealFields(
  account: PipedriveAccount,
): Promise<{ key: string; name: string; field_type: string }[]> {
  const data = await pipedrive<
    { key: string; name: string; field_type: string }[] | null
  >(account, "GET", "/api/v1/dealFields", { query: { limit: "500" } });
  return data ?? [];
}
