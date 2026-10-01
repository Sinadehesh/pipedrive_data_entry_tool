import { timingSafeEqual } from "node:crypto";

import type { Participant } from "@/lib/db/schema";

/**
 * Claap's webhook contract, as documented at
 * https://help.claap.io/en/articles/10335261-claap-webhooks-documentation
 *
 * Kept free of DB and framework imports so the parsing — the part most
 * likely to drift from what Claap actually sends — is unit tested against
 * fixtures shaped like the documented payload.
 *
 * Authentication is a STATIC shared secret, not a signature: Claap sends
 * the webhook's secret verbatim in `x-claap-webhook-secret` on every
 * delivery. We compare it in constant time against the tenant's stored
 * secret. (There is no body HMAC to verify, so TLS is what protects the
 * secret in transit — the endpoint must only ever be served over https.)
 */

export const CLAAP_SECRET_HEADER = "x-claap-webhook-secret";

/** The only event that means "a finished, transcribed call exists". */
export const CLAAP_RECORDING_ADDED = "recording_added";

export type ClaapWebhookPayload = {
  eventId?: string;
  event?: {
    type?: string;
    recording?: ClaapRecording;
  };
};

type ClaapRecording = {
  id?: string;
  title?: string;
  createdAt?: string;
  meeting?: {
    startingAt?: string;
    endingAt?: string;
    participants?: { id?: string; email?: string; name?: string }[];
  };
  recorder?: { id?: string; email?: string; name?: string; attended?: boolean };
};

/** Everything the pipeline needs from a recording_added delivery. */
export type ClaapRecordingAdded = {
  eventId: string;
  recordingId: string;
  title: string | null;
  occurredAt: string; // ISO
  participants: Participant[];
};

export function verifyClaapSecret(
  received: string | null,
  stored: string,
): boolean {
  if (!received || !stored) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Returns the recording if this delivery is a usable recording_added
 * event, or null for anything we should acknowledge and ignore
 * (recording_updated, unknown types, payloads missing an id).
 *
 * Metadata comes from HERE, not the transcript endpoint: Claap's
 * transcript response carries segments only — no title, start time or
 * participants.
 */
export function parseRecordingAdded(
  payload: ClaapWebhookPayload,
): ClaapRecordingAdded | null {
  const recording = payload.event?.recording;
  if (payload.event?.type !== CLAAP_RECORDING_ADDED || !recording?.id) {
    return null;
  }

  const participants: Participant[] = [];
  const seen = new Set<string>();
  const add = (email: string | undefined, name?: string, isHost?: boolean) => {
    const normalized = email?.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    participants.push({ email: normalized, name, isHost });
  };

  // The recorder is the rep who owns the recording — mark them as host so
  // identity resolution never mistakes them for the prospect.
  add(recording.recorder?.email, recording.recorder?.name, true);
  for (const p of recording.meeting?.participants ?? []) {
    add(p.email, p.name);
  }

  return {
    // eventId is the redelivery key; fall back to the recording id so a
    // payload without one still dedupes per recording.
    eventId: payload.eventId ?? `recording_added:${recording.id}`,
    recordingId: recording.id,
    title: recording.title ?? null,
    occurredAt:
      recording.meeting?.startingAt ??
      recording.createdAt ??
      new Date().toISOString(),
    participants,
  };
}
