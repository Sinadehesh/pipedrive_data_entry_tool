import { describe, expect, it } from "vitest";

import { inngestSigningKey, resolveEnvKey } from "./keys";

describe("resolveEnvKey", () => {
  it("prefers the exact name", () => {
    expect(
      resolveEnvKey("INNGEST_EVENT_KEY", {
        INNGEST_EVENT_KEY: "exact",
        CRM_INNGEST_EVENT_KEY: "prefixed",
      }),
    ).toBe("exact");
  });

  it("accepts a single prefixed variant (Vercel integration prefix)", () => {
    expect(resolveEnvKey("INNGEST_EVENT_KEY", { CRM_INNGEST_EVENT_KEY: "k" })).toBe("k");
    expect(resolveEnvKey("INNGEST_EVENT_KEY", { CRMINNGEST_EVENT_KEY: "k" })).toBe("k");
  });

  it("refuses to guess between different prefixed values", () => {
    expect(
      resolveEnvKey("INNGEST_EVENT_KEY", { A_INNGEST_EVENT_KEY: "a", B_INNGEST_EVENT_KEY: "b" }),
    ).toBeUndefined();
  });

  it("allows duplicates that agree", () => {
    expect(
      resolveEnvKey("INNGEST_EVENT_KEY", { A_INNGEST_EVENT_KEY: "same", B_INNGEST_EVENT_KEY: "same" }),
    ).toBe("same");
  });

  it("never mistakes the fallback signing key for the primary", () => {
    expect(inngestSigningKey({ CRM_INNGEST_SIGNING_KEY_FALLBACK: "old" })).toBeUndefined();
    expect(
      inngestSigningKey({
        CRM_INNGEST_SIGNING_KEY: "new",
        CRM_INNGEST_SIGNING_KEY_FALLBACK: "old",
      }),
    ).toBe("new");
  });

  it("ignores empty values", () => {
    expect(resolveEnvKey("INNGEST_EVENT_KEY", { INNGEST_EVENT_KEY: "", CRM_INNGEST_EVENT_KEY: "k" })).toBe("k");
  });
});
