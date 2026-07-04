import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";

import { CallExtractionSchema, type CallExtraction } from "./schemas";

export const EXTRACTION_MODEL_ID = "claude-opus-4-8";

const model = anthropic(EXTRACTION_MODEL_ID);

const SYSTEM = `You are a sales-intelligence analyst. You extract structured CRM
data from sales call transcripts.

Rules:
- Never invent information. If a topic was not discussed, set value to null
  and confidence to 0.
- Evidence quotes must be verbatim from the transcript.
- Confidence reflects how explicitly the prospect stated the fact: a direct
  statement ("our budget is $50k") is >0.9; an inference from tone is <0.5.
- Objections include hesitations and soft pushback, not only hard "no"s.`;

/**
 * Map step: extract from one transcript chunk. Called once per chunk inside
 * its own Inngest step, so each LLM call gets its own retry budget and its
 * own serverless invocation.
 */
export async function extractChunk(
  chunk: string,
  meta: { title: string | null; chunkIndex: number; chunkCount: number },
): Promise<CallExtraction> {
  const { object } = await generateObject({
    model,
    schema: CallExtractionSchema,
    system: SYSTEM,
    prompt: [
      `Call: ${meta.title ?? "(untitled)"}`,
      `This is chunk ${meta.chunkIndex + 1} of ${meta.chunkCount}. Extract only what appears in this chunk.`,
      "",
      "<transcript_chunk>",
      chunk,
      "</transcript_chunk>",
    ].join("\n"),
  });
  return object;
}

/**
 * Reduce step: merge per-chunk extractions into one coherent record.
 * A single-chunk call skips the LLM round trip entirely.
 */
export async function mergeExtractions(
  partials: CallExtraction[],
  meta: { title: string | null },
): Promise<CallExtraction> {
  if (partials.length === 1) return partials[0];

  const { object } = await generateObject({
    model,
    schema: CallExtractionSchema,
    system: SYSTEM,
    prompt: [
      `Below are partial extractions from consecutive chunks of one sales call (${meta.title ?? "untitled"}).`,
      "Merge them into a single record:",
      "- Write one summary covering the whole call.",
      "- For each BANT signal, keep the highest-confidence asserted value; prefer later chunks when the prospect revised an earlier statement (and mark timeline.shifted accordingly).",
      "- Deduplicate objections, competitors, and next steps.",
      "",
      "<partial_extractions>",
      JSON.stringify(partials, null, 2),
      "</partial_extractions>",
    ].join("\n"),
  });
  return object;
}
