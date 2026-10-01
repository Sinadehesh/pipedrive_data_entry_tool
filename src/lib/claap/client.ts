import type { ClaapCredential } from "@/lib/db/schema";

/**
 * Claap transcript fetch, per the documented endpoint:
 * https://docs.claap.io/api-reference/endpoint/get_recording_transcript
 *
 *   GET {base}/v1/recordings/{recordingId}/transcript
 *   X-Claap-Key: <tenant's API key>
 *   -> { result: { transcript: { segments: [{ speaker, text, ... }] } } }
 *
 * The response carries segments ONLY. Title, start time and participants
 * come from the recording_added webhook payload (see ./webhook.ts), which
 * the pipeline keeps verbatim in raw_events.
 */

/**
 * Overridable so a local stub can stand in for Claap (see
 * src/app/api/dev/claap-stub). Production leaves it unset.
 */
const BASE_URL = process.env.CLAAP_API_BASE ?? "https://api.claap.io";

export type ClaapTranscriptResponse = {
  result?: {
    transcript?: {
      segments?: { speaker?: string; text?: string }[];
      languageCode?: string;
    };
  };
};

/** Plain-text transcript, one utterance per line: "Speaker: text". */
export function transcriptText(body: ClaapTranscriptResponse): string {
  const segments = body.result?.transcript?.segments;
  if (!Array.isArray(segments)) {
    // A shape change on Claap's side must fail loudly — an empty string
    // here would extract "nothing discussed" and write that to the CRM.
    throw new Error(
      "Claap transcript response missing result.transcript.segments",
    );
  }
  return segments
    .filter((s) => (s.text ?? "").trim().length > 0)
    .map((s) => `${s.speaker?.trim() || "Unknown"}: ${s.text!.trim()}`)
    .join("\n");
}

export async function getTranscriptText(
  credential: ClaapCredential,
  recordingId: string,
): Promise<string> {
  const res = await fetch(
    `${BASE_URL}/v1/recordings/${encodeURIComponent(recordingId)}/transcript`,
    { headers: { "X-Claap-Key": credential.apiKey } },
  );
  if (!res.ok) {
    // Thrown inside a durable step: Inngest retries with backoff, which
    // also covers a transcript that isn't quite ready when the webhook
    // lands.
    throw new Error(
      `Claap transcript fetch failed for ${recordingId}: ${res.status} ${await res.text()}`,
    );
  }
  return transcriptText((await res.json()) as ClaapTranscriptResponse);
}
