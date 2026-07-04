import type { ClaapCredential, Participant } from "@/lib/db/schema";

export type ClaapTranscript = {
  recordingId: string;
  title: string | null;
  occurredAt: string; // ISO
  participants: Participant[];
  /** Plain-text transcript, one utterance per line: "Speaker: text". */
  text: string;
};

const BASE_URL = "https://api.claap.io/v1";

/**
 * Fetch the transcript for a finished recording, authenticated with the
 * TENANT's Claap API key (decrypted from their connections row). Called
 * from a durable step, so a transient failure here is retried by Inngest.
 *
 * Response mapping follows Claap's public API; adjust the field paths if a
 * workspace is on a different API version.
 */
export async function getTranscript(
  credential: ClaapCredential,
  recordingId: string,
): Promise<ClaapTranscript> {
  const res = await fetch(`${BASE_URL}/recordings/${recordingId}/transcript`, {
    headers: { Authorization: `Bearer ${credential.apiKey}` },
  });
  if (!res.ok) {
    throw new Error(
      `Claap transcript fetch failed for ${recordingId}: ${res.status} ${await res.text()}`,
    );
  }

  const body = (await res.json()) as {
    recording: {
      id: string;
      title?: string;
      started_at: string;
      participants?: { email?: string; name?: string; is_host?: boolean }[];
    };
    segments: { speaker: string; text: string }[];
  };

  return {
    recordingId: body.recording.id,
    title: body.recording.title ?? null,
    occurredAt: body.recording.started_at,
    participants: (body.recording.participants ?? [])
      .filter((p): p is { email: string; name?: string; is_host?: boolean } =>
        Boolean(p.email),
      )
      .map((p) => ({
        email: p.email.toLowerCase(),
        name: p.name,
        isHost: p.is_host,
      })),
    text: body.segments.map((s) => `${s.speaker}: ${s.text}`).join("\n"),
  };
}
