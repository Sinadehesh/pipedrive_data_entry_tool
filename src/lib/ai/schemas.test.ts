import { describe, expect, it } from "vitest";

import {
  AUTO_WRITE_CONFIDENCE_FLOOR,
  overallConfidence,
  type CallExtraction,
  type Signal,
} from "./schemas";

/**
 * overallConfidence decides whether an extraction auto-syncs or waits in
 * the review queue. Its central subtlety: an honest "not discussed" (null)
 * must NOT drag the score down, or every short call would be quarantined.
 */
function signal(value: string | null, confidence: number): Signal {
  return { value, confidence, evidence: value ? "quote" : null };
}

function extraction(bant: Partial<CallExtraction["bant"]>): CallExtraction {
  return {
    summary: "s",
    bant: {
      budget: signal("b", 0.9),
      authority: signal("a", 0.9),
      need: signal("n", 0.9),
      timeline: { ...signal("t", 0.9), shifted: false, previousTimeline: null },
      ...bant,
    },
    objections: [],
    competitors: [],
    nextSteps: [],
    dealSignals: { stageChangeSuggested: null, riskFlags: [] },
  };
}

describe("overallConfidence", () => {
  it("takes the weakest ASSERTED signal", () => {
    const e = extraction({ need: signal("n", 0.42) });
    expect(overallConfidence(e)).toBe(0.42);
  });

  it("ignores null signals rather than scoring them as zero", () => {
    // Budget never came up; the other three were stated clearly. This must
    // stay auto-approvable.
    const e = extraction({ budget: signal(null, 0) });
    expect(overallConfidence(e)).toBe(0.9);
    expect(overallConfidence(e)).toBeGreaterThanOrEqual(
      AUTO_WRITE_CONFIDENCE_FLOOR,
    );
  });

  it("returns 1 when nothing was discussed at all", () => {
    // Nothing asserted means nothing to be wrong about; the note is still
    // written, and there are no field values to gate.
    const e = extraction({
      budget: signal(null, 0),
      authority: signal(null, 0),
      need: signal(null, 0),
      timeline: { ...signal(null, 0), shifted: false, previousTimeline: null },
    });
    expect(overallConfidence(e)).toBe(1);
  });

  it("sends a single hedged signal to review", () => {
    const e = extraction({ authority: signal("maybe the VP", 0.5) });
    expect(overallConfidence(e)).toBeLessThan(AUTO_WRITE_CONFIDENCE_FLOOR);
  });
});
