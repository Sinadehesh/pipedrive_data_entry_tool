import { RetryAfterError } from "inngest";

/**
 * Gmail and Calendar enforce per-user, per-MINUTE quotas. Hitting one
 * returns 403 ("Quota exceeded … per minute per user", reason
 * rateLimitExceeded / userRateLimitExceeded) or 429.
 *
 * Inngest's default backoff retries within seconds — still inside the same
 * minute — so a handful of quick retries can exhaust a function's budget
 * and fail a whole import over a limit that clears on its own. Converting
 * these into RetryAfterError makes the step wait out the window instead.
 * Steps are idempotent (ledger dedupe), so re-running a partial batch is
 * safe.
 */
const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
]);

export function isGoogleRateLimit(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: number | string;
    status?: number;
    message?: string;
    errors?: { reason?: string }[];
  };
  const status = Number(e.status ?? e.code);
  if (status === 429) return true;
  if (status !== 403) return false;
  if (e.errors?.some((x) => x.reason && RATE_LIMIT_REASONS.has(x.reason))) {
    return true;
  }
  return /quota exceeded|rate limit/i.test(e.message ?? "");
}

/** Rethrow Google rate limits as "retry in a minute"; anything else as-is. */
export function rethrowGoogleRateLimit(err: unknown): never {
  if (isGoogleRateLimit(err)) {
    throw new RetryAfterError(
      "Google API per-minute quota exceeded; retrying after the window resets",
      "65s",
      { cause: err },
    );
  }
  throw err;
}
