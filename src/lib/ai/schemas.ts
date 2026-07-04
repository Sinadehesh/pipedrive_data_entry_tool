import { z } from "zod";

/**
 * Every signal carries a confidence score and a verbatim evidence quote.
 * Evidence is what makes low-confidence review fast for humans and makes
 * hallucinated field updates detectable after the fact.
 */
export const SignalSchema = z.object({
  value: z
    .string()
    .nullable()
    .describe("The extracted value, or null if not discussed."),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("0-1. Use 0 when the value is null."),
  evidence: z
    .string()
    .nullable()
    .describe("Verbatim quote from the transcript supporting the value."),
});

export const CallExtractionSchema = z.object({
  summary: z
    .string()
    .describe("3-6 sentence summary of the call for a CRM note."),
  bant: z.object({
    budget: SignalSchema,
    authority: SignalSchema.describe(
      "Who the decision maker is and whether they were on the call.",
    ),
    need: SignalSchema,
    timeline: SignalSchema.extend({
      shifted: z
        .boolean()
        .describe("True if the timeline moved vs. what was previously stated."),
      previousTimeline: z.string().nullable(),
    }),
  }),
  objections: z.array(
    z.object({
      category: z.enum([
        "price",
        "timing",
        "competitor",
        "integration",
        "security",
        "internal_buy_in",
        "other",
      ]),
      quote: z.string().describe("Verbatim quote of the objection."),
      resolved: z
        .boolean()
        .describe("True if the rep addressed it to the prospect's satisfaction."),
    }),
  ),
  competitors: z.array(
    z.object({
      name: z.string(),
      context: z.string(),
      sentiment: z.enum(["favored", "neutral", "losing"]),
    }),
  ),
  nextSteps: z.array(
    z.object({
      owner: z.string().describe("Who committed to the action."),
      action: z.string(),
      due: z.string().nullable().describe("ISO date if a date was mentioned."),
    }),
  ),
  dealSignals: z.object({
    stageChangeSuggested: z
      .string()
      .nullable()
      .describe("Suggested pipeline stage, or null if no change warranted."),
    riskFlags: z.array(z.string()),
  }),
});

export type CallExtraction = z.infer<typeof CallExtractionSchema>;
export type Signal = z.infer<typeof SignalSchema>;

/**
 * Overall confidence gates automatic Pipedrive field writes: the weakest
 * *asserted* BANT signal decides. Null signals (topic never came up) don't
 * drag the score down — an honest "not discussed" is not a low-quality
 * extraction.
 */
export function overallConfidence(extraction: CallExtraction): number {
  const asserted = [
    extraction.bant.budget,
    extraction.bant.authority,
    extraction.bant.need,
    extraction.bant.timeline,
  ].filter((s) => s.value !== null);
  if (asserted.length === 0) return 1;
  return Math.min(...asserted.map((s) => s.confidence));
}

export const AUTO_WRITE_CONFIDENCE_FLOOR = 0.8;
