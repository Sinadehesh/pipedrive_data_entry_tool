/**
 * Thin fetch wrapper over the Pipedrive API, parameterized per tenant.
 *
 * Every call takes a `PipedriveAccount` (the tenant's own domain + API
 * token, decrypted from `connections` at call time) — there is no global
 * Pipedrive credential.
 *
 * Rate limiting is Pipedrive's token-budget model (a daily pool PER COMPANY
 * plus burst limits), so budgets are isolated per tenant and protected at
 * two layers:
 *   1. The reconciler runs behind Inngest concurrency + throttle KEYED BY
 *      TENANT — one writer per tenant, paced per tenant, and one noisy
 *      tenant can never starve another.
 *   2. A 429 here raises PipedriveRateLimitError carrying retry-after; the
 *      reconciler defers the outbox row instead of dropping it.
 *
 * v2 endpoints are used wherever they exist (cheaper token cost than v1);
 * notes are still v1-only.
 */
export type PipedriveAccount = {
  domain: string; // {domain}.pipedrive.com
  apiToken: string;
};

export class PipedriveRateLimitError extends Error {
  constructor(public retryAfterSeconds: number) {
    super(`Pipedrive rate limited; retry after ${retryAfterSeconds}s`);
    this.name = "PipedriveRateLimitError";
  }
}

export class PipedriveApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    path: string,
  ) {
    super(`Pipedrive ${status} on ${path}: ${body.slice(0, 300)}`);
    this.name = "PipedriveApiError";
  }
}

export async function pipedrive<T>(
  account: PipedriveAccount,
  method: "GET" | "POST" | "PATCH",
  path: string, // e.g. "/api/v2/persons/search"
  opts: { query?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const url = new URL(`https://${account.domain}.pipedrive.com${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    method,
    headers: {
      "x-api-token": account.apiToken,
      ...(opts.body ? { "content-type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "10");
    throw new PipedriveRateLimitError(
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 10,
    );
  }
  if (!res.ok) {
    throw new PipedriveApiError(res.status, await res.text(), path);
  }

  const json = (await res.json()) as { data: T };
  return json.data;
}
