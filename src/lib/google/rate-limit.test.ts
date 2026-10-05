import { RetryAfterError } from "inngest";
import { describe, expect, it } from "vitest";

import { isGoogleRateLimit, rethrowGoogleRateLimit } from "./rate-limit";

describe("isGoogleRateLimit", () => {
  it("matches the per-minute quota 403 seen in production", () => {
    expect(
      isGoogleRateLimit({
        status: 403,
        code: 403,
        message:
          "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'",
      }),
    ).toBe(true);
  });

  it("matches 403s by reason and any 429", () => {
    expect(isGoogleRateLimit({ code: 403, errors: [{ reason: "userRateLimitExceeded" }] })).toBe(true);
    expect(isGoogleRateLimit({ status: 429 })).toBe(true);
  });

  it("does not treat a permission 403 or other errors as rate limits", () => {
    expect(isGoogleRateLimit({ status: 403, message: "Insufficient Permission", errors: [{ reason: "insufficientPermissions" }] })).toBe(false);
    expect(isGoogleRateLimit({ status: 404 })).toBe(false);
    expect(isGoogleRateLimit(new Error("boom"))).toBe(false);
    expect(isGoogleRateLimit(null)).toBe(false);
  });
});

describe("rethrowGoogleRateLimit", () => {
  it("converts a rate limit into a RetryAfterError", () => {
    expect(() => rethrowGoogleRateLimit({ status: 429 })).toThrow(RetryAfterError);
  });

  it("rethrows other errors unchanged", () => {
    const original = new Error("boom");
    expect(() => rethrowGoogleRateLimit(original)).toThrow(original);
  });
});
