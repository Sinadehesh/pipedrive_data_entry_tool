import { describe, expect, it } from "vitest";

import type { CallExtraction, Signal } from "@/lib/ai/schemas";
import { buildDealFieldUpdate, type FieldMapping } from "./write-policy";

/**
 * These tests guard the single most dangerous code path in the product:
 * deciding which AI-extracted values get written into a customer's live
 * CRM. A regression here silently corrupts real sales pipelines, so the
 * rules are pinned explicitly.
 */

function signal(overrides: Partial<Signal> = {}): Signal {
  return { value: "50k approved", confidence: 0.95, evidence: "we have 50k", ...overrides };
}

function extraction(bant: Partial<CallExtraction["bant"]> = {}): CallExtraction {
  return {
    summary: "s",
    bant: {
      budget: signal(),
      authority: signal(),
      need: signal(),
      timeline: { ...signal(), shifted: false, previousTimeline: null },
      ...bant,
    },
    objections: [],
    competitors: [],
    nextSteps: [],
    dealSignals: { stageChangeSuggested: null, riskFlags: [] },
  };
}

const budgetMapping: FieldMapping = {
  signal: "bant_budget",
  pipedriveFieldKey: "cf_budget",
  minConfidence: null,
};

describe("buildDealFieldUpdate", () => {
  it("writes a mapped, high-confidence signal", () => {
    const fields = buildDealFieldUpdate(extraction(), [budgetMapping]);
    expect(fields).toEqual({ cf_budget: "50k approved" });
  });

  it("writes NOTHING when the tenant has no mappings (the safe default)", () => {
    // A brand-new tenant configures no mappings; they must get notes only.
    expect(buildDealFieldUpdate(extraction(), [])).toEqual({});
  });

  it("never writes an unmapped signal even at full confidence", () => {
    const fields = buildDealFieldUpdate(extraction(), [budgetMapping]);
    expect(fields).not.toHaveProperty("cf_need");
    expect(Object.keys(fields)).toEqual(["cf_budget"]);
  });

  it("blocks a value below the 0.8 default floor", () => {
    const low = extraction({ budget: signal({ confidence: 0.79 }) });
    expect(buildDealFieldUpdate(low, [budgetMapping])).toEqual({});
  });

  it("admits a value exactly at the floor", () => {
    const at = extraction({ budget: signal({ confidence: 0.8 }) });
    expect(buildDealFieldUpdate(at, [budgetMapping])).toEqual({
      cf_budget: "50k approved",
    });
  });

  it("honours a per-mapping confidence override, both directions", () => {
    const value = extraction({ budget: signal({ confidence: 0.65 }) });
    const lenient = { ...budgetMapping, minConfidence: 0.6 };
    const strict = { ...budgetMapping, minConfidence: 0.9 };

    expect(buildDealFieldUpdate(value, [lenient])).toEqual({
      cf_budget: "50k approved",
    });
    expect(buildDealFieldUpdate(value, [strict])).toEqual({});
  });

  it("never writes a null value, however confident the model claims to be", () => {
    // "Not discussed" must not overwrite whatever the rep already has.
    const absent = extraction({ budget: signal({ value: null, confidence: 1 }) });
    expect(buildDealFieldUpdate(absent, [budgetMapping])).toEqual({});
  });

  it("maps each BANT signal to its own configured field", () => {
    const fields = buildDealFieldUpdate(extraction(), [
      budgetMapping,
      { signal: "bant_authority", pipedriveFieldKey: "cf_auth", minConfidence: null },
      { signal: "bant_need", pipedriveFieldKey: "cf_need", minConfidence: null },
      { signal: "bant_timeline", pipedriveFieldKey: "cf_time", minConfidence: null },
    ]);
    expect(fields).toEqual({
      cf_budget: "50k approved",
      cf_auth: "50k approved",
      cf_need: "50k approved",
      cf_time: "50k approved",
    });
  });

  it("ignores deal_risk here — it is written by its own outbox op", () => {
    const fields = buildDealFieldUpdate(extraction(), [
      { signal: "deal_risk", pipedriveFieldKey: "cf_risk", minConfidence: null },
    ]);
    expect(fields).toEqual({});
  });
});
