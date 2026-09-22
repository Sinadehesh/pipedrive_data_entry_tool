/**
 * The pure half of sandbox mode: how a simulated Pipedrive answers.
 *
 * Kept free of DB and Inngest imports so it can be unit tested directly —
 * `sandbox.ts` adds the recording side effect on top. The determinism
 * guarantee this file makes (same natural key ⇒ same id, forever) is what
 * lets a replayed transcript resolve to the same contact instead of
 * silently duplicating it, so it is worth testing on its own.
 */

/** FNV-1a. Small, stable, and dependency-free — not a security hash. */
export function stableId(namespace: string, key: string): number {
  let h = 0x811c9dc5;
  for (const ch of `${namespace}:${key.toLowerCase()}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Keep it in a range that reads like a real Pipedrive id.
  return (h % 900_000) + 100_000;
}

/** Synthetic custom-field keys, shaped like Pipedrive's 40-char hashes. */
export function sandboxFieldKeyFor(signal: string): string {
  return stableId("field", signal).toString(16).padStart(8, "0").repeat(5);
}

/**
 * The deal-field schema a sandbox tenant appears to have. Mirrors the five
 * mappable signals so `npm run sandbox:connect` can wire real field
 * mappings and the auto-write path (not just the note fallback) gets
 * exercised.
 */
export const SANDBOX_DEAL_FIELDS: {
  key: string;
  name: string;
  field_type: string;
}[] = [
  {
    key: sandboxFieldKeyFor("bant_budget"),
    name: "Budget (AI)",
    field_type: "varchar",
  },
  {
    key: sandboxFieldKeyFor("bant_authority"),
    name: "Authority (AI)",
    field_type: "varchar",
  },
  {
    key: sandboxFieldKeyFor("bant_need"),
    name: "Need (AI)",
    field_type: "varchar",
  },
  {
    key: sandboxFieldKeyFor("bant_timeline"),
    name: "Timeline (AI)",
    field_type: "varchar",
  },
  {
    key: sandboxFieldKeyFor("deal_risk"),
    name: "Risk Flag (AI)",
    field_type: "varchar",
  },
];

/**
 * Answer one Pipedrive call. Returns the payload the real client would
 * have unwrapped from `{ data: ... }`, so records.ts needs no awareness
 * that it is talking to a simulator.
 */
export function routeSandboxCall(
  method: "GET" | "POST" | "PATCH",
  path: string,
  opts: { query?: Record<string, string>; body?: unknown },
): unknown {
  const body = (opts.body ?? {}) as Record<string, unknown>;
  const query = opts.query ?? {};

  // --- Lookups: always miss, so the create path is what gets tested. ---
  if (path === "/api/v2/persons/search") return null;
  if (path === "/api/v2/organizations/search") return null;

  if (method === "POST" && path === "/api/v2/organizations") {
    return { id: stableId("org", String(body.name ?? "unknown")) };
  }

  if (method === "POST" && path === "/api/v2/persons") {
    const emails = body.emails as { value: string }[] | undefined;
    const email = emails?.[0]?.value ?? String(body.name ?? "unknown");
    return { id: stableId("person", email) };
  }

  // Open deals for a person: one, deterministically derived from the person.
  if (method === "GET" && path === "/api/v2/deals") {
    const personId = query.person_id;
    if (!personId) return [];
    return [{ id: stableId("deal", personId) }];
  }

  // Single deal fetch — sandbox deals are always open, so risk flags and
  // field writes both proceed rather than being skipped as won/lost.
  const dealMatch = /^\/api\/v2\/deals\/(\d+)$/.exec(path);
  if (dealMatch) {
    const id = Number(dealMatch[1]);
    if (method === "GET") return { id, status: "open" };
    if (method === "PATCH") return { id };
  }

  if (method === "POST" && path === "/api/v1/notes") {
    return { id: stableId("note", JSON.stringify(body).slice(0, 200)) };
  }

  if (method === "GET" && path === "/api/v1/dealFields") {
    return SANDBOX_DEAL_FIELDS;
  }

  // An unrouted path means records.ts grew a call the simulator doesn't
  // know about. Fail loudly — a silent null here would look like a real
  // "not found" and quietly change pipeline behaviour under sandbox.
  throw new Error(
    `sandbox: unhandled Pipedrive call ${method} ${path} — add it to src/lib/pipedrive/sandbox-router.ts`,
  );
}
