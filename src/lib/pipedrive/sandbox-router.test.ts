import { describe, expect, it } from "vitest";

import {
  SANDBOX_DEAL_FIELDS,
  routeSandboxCall,
  sandboxFieldKeyFor,
  stableId,
} from "./sandbox-router";

const GET = (path: string, query?: Record<string, string>) =>
  routeSandboxCall("GET", path, { query });
const POST = (path: string, body?: unknown) =>
  routeSandboxCall("POST", path, { body });

describe("sandbox id determinism", () => {
  it("returns the same id for the same key across calls", () => {
    expect(stableId("person", "jane@acme.com")).toBe(
      stableId("person", "jane@acme.com"),
    );
  });

  it("is case-insensitive, matching email normalization upstream", () => {
    expect(stableId("person", "Jane@Acme.com")).toBe(
      stableId("person", "jane@acme.com"),
    );
  });

  it("separates namespaces so a person and a deal never collide", () => {
    expect(stableId("person", "acme")).not.toBe(stableId("deal", "acme"));
  });

  it("stays in a plausible Pipedrive id range", () => {
    for (const key of ["a@b.com", "acme", "x", "a-very-long-key-here"]) {
      const id = stableId("person", key);
      expect(id).toBeGreaterThanOrEqual(100_000);
      expect(id).toBeLessThan(1_000_000);
    }
  });
});

describe("routing", () => {
  it("misses on person search so the create path is exercised", () => {
    expect(GET("/api/v2/persons/search", { term: "jane@acme.com" })).toBeNull();
  });

  it("creates a person whose id is derived from the primary email", () => {
    const body = { name: "Jane", emails: [{ value: "jane@acme.com" }] };
    expect(POST("/api/v2/persons", body)).toEqual({
      id: stableId("person", "jane@acme.com"),
    });
  });

  it("returns exactly one open deal derived from the person id", () => {
    const deals = GET("/api/v2/deals", {
      person_id: "424242",
      status: "open",
    }) as { id: number }[];
    expect(deals).toHaveLength(1);
    expect(deals[0].id).toBe(stableId("deal", "424242"));
  });

  it("returns no deals when no person is given", () => {
    expect(GET("/api/v2/deals", {})).toEqual([]);
  });

  it("reports sandbox deals as open so risk flags are not skipped", () => {
    expect(GET("/api/v2/deals/12345")).toEqual({ id: 12345, status: "open" });
  });

  it("accepts a custom field patch", () => {
    expect(
      routeSandboxCall("PATCH", "/api/v2/deals/12345", {
        body: { custom_fields: { abc: "x" } },
      }),
    ).toEqual({ id: 12345 });
  });

  it("serves deal fields covering every mappable signal", () => {
    const fields = GET("/api/v1/dealFields") as { key: string }[];
    expect(fields).toEqual(SANDBOX_DEAL_FIELDS);
    for (const signal of [
      "bant_budget",
      "bant_authority",
      "bant_need",
      "bant_timeline",
      "deal_risk",
    ]) {
      expect(fields.map((f) => f.key)).toContain(sandboxFieldKeyFor(signal));
    }
  });

  it("gives each signal a distinct field key", () => {
    const keys = SANDBOX_DEAL_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("throws on an unknown endpoint rather than returning a silent null", () => {
    expect(() => GET("/api/v2/activities")).toThrow(/unhandled Pipedrive call/);
  });
});
