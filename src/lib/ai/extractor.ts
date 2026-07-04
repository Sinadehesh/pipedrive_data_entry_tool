import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";

import {
  CALL_EXTRACTION_SYSTEM,
  chunkPrompt,
  mergePrompt,
} from "./prompts/call-extraction";
import { CallExtractionSchema, type CallExtraction } from "./schemas";

export const EXTRACTION_MODEL_ID = "claude-opus-4-8";

const model = anthropic(EXTRACTION_MODEL_ID);

/**
 * Map step: extract from one transcript chunk. Called once per chunk inside
 * its own Inngest step, so each LLM call gets its own retry budget and its
 * own serverless invocation. generateObject validates the response against
 * the Zod schema and retries on parse failure.
 */
export async function extractChunk(
  chunk: string,
  meta: { title: string | null; chunkIndex: number; chunkCount: number },
): Promise<CallExtraction> {
  const { object } = await generateObject({
    model,
    schema: CallExtractionSchema,
    system: CALL_EXTRACTION_SYSTEM,
    prompt: chunkPrompt(chunk, meta),
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
    system: CALL_EXTRACTION_SYSTEM,
    prompt: mergePrompt(partials, meta),
  });
  return object;
}
