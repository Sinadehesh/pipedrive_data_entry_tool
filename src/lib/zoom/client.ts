import { createHmac, timingSafeEqual } from "node:crypto";

import type { Participant } from "@/lib/db/schema";

/**
 * Zoom integration built entirely on webhook-delivered artifacts: the
 * recording webhook carries a short-lived `download_token` scoped to that
 * recording's files, so no server-to-server OAuth app is needed. The
 * verbatim webhook body (token included) lives in raw_events — the fetch
 * job reads it from there, never from Inngest state.
 */

/** Shape of the `recording.transcript_completed` webhook body we rely on. */
export type ZoomRecordingWebhook = {
  event: string;
  event_ts?: number;
  download_token?: string;
  payload?: {
    account_id?: string;
    plain_token?: string; // url_validation only (snake in some payloads)
    plainToken?: string; // url_validation only
    object?: {
      uuid?: string;
      topic?: string;
      start_time?: string;
      host_email?: string;
      recording_files?: {
        file_type?: string; // "TRANSCRIPT" is the VTT we want
        file_extension?: string;
        download_url?: string;
      }[];
    };
  };
};

/**
 * Zoom signs webhooks as `v0=` + HMAC-SHA256(secretToken,
 * `v0:{timestamp}:{rawBody}`), with a replay window on the timestamp.
 */
export function verifyZoomSignature(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  secretToken: string,
): boolean {
  if (!signature || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return false; // outside the 5-minute replay window
  }
  const expected = `v0=${createHmac("sha256", secretToken)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Response body for Zoom's endpoint.url_validation handshake. */
export function urlValidationResponse(
  plainToken: string,
  secretToken: string,
): { plainToken: string; encryptedToken: string } {
  return {
    plainToken,
    encryptedToken: createHmac("sha256", secretToken)
      .update(plainToken)
      .digest("hex"),
  };
}

export type ZoomTranscript = {
  meetingUuid: string;
  topic: string | null;
  occurredAt: string; // ISO
  participants: Participant[];
  text: string;
};

/**
 * Download and flatten the VTT transcript referenced by a recording
 * webhook. Returns null when the payload has no transcript file (some
 * recordings never produce one).
 *
 * Known limitation, documented for identity resolution: recording webhooks
 * carry only the HOST's email, not attendee emails — so Zoom calls
 * currently attach to a deal only when the transcript's participants are
 * already resolvable some other way. Pairing with the calendar ledger by
 * time window is the planned improvement.
 */
export async function fetchZoomTranscript(
  webhook: ZoomRecordingWebhook,
): Promise<ZoomTranscript | null> {
  const object = webhook.payload?.object;
  const file = object?.recording_files?.find(
    (f) => f.file_type === "TRANSCRIPT" && f.download_url,
  );
  if (!object?.uuid || !file?.download_url || !webhook.download_token) {
    return null;
  }

  const res = await fetch(file.download_url, {
    headers: { authorization: `Bearer ${webhook.download_token}` },
  });
  if (!res.ok) {
    throw new Error(
      `Zoom transcript download failed for ${object.uuid}: ${res.status}`,
    );
  }

  return {
    meetingUuid: object.uuid,
    topic: object.topic ?? null,
    occurredAt: object.start_time ?? new Date().toISOString(),
    participants: object.host_email
      ? [{ email: object.host_email.toLowerCase(), isHost: true }]
      : [],
    text: parseVtt(await res.text()),
  };
}

/**
 * WebVTT -> "Speaker: text" lines. Zoom cues already carry the speaker as
 * a "Name: text" prefix; we strip cue numbers, timestamps, and metadata.
 */
export function parseVtt(vtt: string): string {
  const lines: string[] = [];
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line === "WEBVTT") continue;
    if (/^\d+$/.test(line)) continue; // cue index
    if (line.includes("-->")) continue; // timestamps
    if (line.startsWith("NOTE")) continue;
    lines.push(line);
  }
  return lines.join("\n");
}
