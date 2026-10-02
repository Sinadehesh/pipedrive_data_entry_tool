import { generateObject } from "ai";

import {
  CALL_EXTRACTION_SYSTEM,
  chunkPrompt,
  mergePrompt,
} from "./prompts/call-extraction";
import {
  EMAIL_EXTRACTION_SYSTEM,
  threadPrompt,
} from "./prompts/email-extraction";
import {
  MEETING_EXTRACTION_SYSTEM,
  meetingPrompt,
} from "./prompts/meeting-extraction";
import { extractionModel, llmModelId } from "./model";
import { CallExtractionSchema, type CallExtraction } from "./schemas";

/**
 * The model id recorded on each extraction row. Provider and model are
 * chosen by env (LLM_PROVIDER / LLM_MODEL) — see ./model.ts.
 */
export const EXTRACTION_MODEL_ID = llmModelId();

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
    model: extractionModel(),
    schema: CallExtractionSchema,
    system: CALL_EXTRACTION_SYSTEM,
    prompt: chunkPrompt(chunk, meta),
  });
  return object;
}

/**
 * Thread-level email extraction: one call over the WHOLE thread (threads
 * fit a single context comfortably — the debounce upstream is what keeps
 * this to one call per burst of replies, not one per message).
 */
export async function extractEmailThread(
  messages: {
    from: string;
    date: string;
    subject: string | null;
    body: string;
  }[],
): Promise<CallExtraction> {
  const { object } = await generateObject({
    model: extractionModel(),
    schema: CallExtractionSchema,
    system: EMAIL_EXTRACTION_SYSTEM,
    prompt: threadPrompt(messages),
  });
  return object;
}

/** Meeting extraction: thin source, single call, mostly-null output. */
export async function extractMeeting(input: {
  title: string | null;
  description: string;
  startAt: string;
  attendees: { email: string; name?: string }[];
}): Promise<CallExtraction> {
  const { object } = await generateObject({
    model: extractionModel(),
    schema: CallExtractionSchema,
    system: MEETING_EXTRACTION_SYSTEM,
    prompt: meetingPrompt(input),
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
    model: extractionModel(),
    schema: CallExtractionSchema,
    system: CALL_EXTRACTION_SYSTEM,
    prompt: mergePrompt(partials, meta),
  });
  return object;
}
