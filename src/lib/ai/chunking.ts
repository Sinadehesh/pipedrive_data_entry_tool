/**
 * Split a transcript into chunks that each fit comfortably in a single
 * sub-minute LLM call. ~24k characters ≈ 6-8k tokens: large enough for
 * conversational context, small enough that one map step never threatens an
 * invocation timeout.
 *
 * Chunking MUST be deterministic — Inngest re-invokes the surrounding
 * function after each step, and the chunk list is recomputed from the
 * memoized transcript on every re-invocation. Same input, same chunks.
 */
const MAX_CHUNK_CHARS = 24_000;

export function chunkTranscript(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];

  const lines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const line of lines) {
    if (currentLen + line.length + 1 > MAX_CHUNK_CHARS && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += line.length + 1;
  }
  if (current.length > 0) chunks.push(current.join("\n"));

  return chunks;
}
