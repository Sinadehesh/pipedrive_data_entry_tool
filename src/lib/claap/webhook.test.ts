import { describe, expect, it } from "vitest";

import { transcriptText } from "./client";
import {
  parseRecordingAdded,
  verifyClaapSecret,
  type ClaapWebhookPayload,
} from "./webhook";

/**
 * Fixtures follow Claap's DOCUMENTED shapes:
 *  - webhook:    help.claap.io → "Claap Webhooks Documentation"
 *  - transcript: docs.claap.io → GET /v1/recordings/{id}/transcript
 * If Claap changes either, update the fixture from their docs first and
 * let these tests say what broke.
 */
const RECORDING_ADDED: ClaapWebhookPayload = {
  eventId: "evt_123",
  event: {
    type: "recording_added",
    recording: {
      id: "rec_abc",
      title: "Acme <> Us — discovery",
      createdAt: "2025-01-09T10:45:00Z",
      meeting: {
        startingAt: "2025-01-09T10:00:00Z",
        endingAt: "2025-01-09T10:30:00Z",
        participants: [
          { id: "p1", email: "Jane.Doe@Acme.com", name: "Jane Doe" },
          { id: "p2", name: "Dial-in guest" }, // email is optional
          { id: "p3", email: "rep@us.com", name: "Rep" }, // also the recorder
        ],
      },
      recorder: { id: "u1", email: "rep@us.com", name: "Rep", attended: true },
    },
  },
};

describe("verifyClaapSecret", () => {
  it("accepts the exact stored secret", () => {
    expect(verifyClaapSecret("s3cret", "s3cret")).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(verifyClaapSecret(null, "s3cret")).toBe(false);
  });

  it("rejects a wrong or differently-sized secret", () => {
    expect(verifyClaapSecret("s3crex", "s3cret")).toBe(false);
    expect(verifyClaapSecret("s3cret-and-more", "s3cret")).toBe(false);
  });

  it("never accepts when no secret is stored", () => {
    expect(verifyClaapSecret("", "")).toBe(false);
  });
});

describe("parseRecordingAdded", () => {
  it("extracts id, title, start time and the dedupe key", () => {
    const r = parseRecordingAdded(RECORDING_ADDED)!;
    expect(r.recordingId).toBe("rec_abc");
    expect(r.eventId).toBe("evt_123");
    expect(r.title).toBe("Acme <> Us — discovery");
    expect(r.occurredAt).toBe("2025-01-09T10:00:00Z");
  });

  it("marks the recorder as host, lowercases, dedupes, and drops email-less guests", () => {
    const r = parseRecordingAdded(RECORDING_ADDED)!;
    expect(r.participants).toEqual([
      { email: "rep@us.com", name: "Rep", isHost: true },
      { email: "jane.doe@acme.com", name: "Jane Doe", isHost: undefined },
    ]);
  });

  it("ignores recording_updated so edits never re-write CRM notes", () => {
    expect(
      parseRecordingAdded({
        ...RECORDING_ADDED,
        event: { ...RECORDING_ADDED.event, type: "recording_updated" },
      }),
    ).toBeNull();
  });

  it("ignores the shape our old code wrongly expected", () => {
    expect(
      parseRecordingAdded({
        id: "evt",
        type: "recording.completed",
        data: { recording_id: "rec" },
      } as unknown as ClaapWebhookPayload),
    ).toBeNull();
  });

  it("falls back to createdAt, then a recording-scoped dedupe key", () => {
    const r = parseRecordingAdded({
      event: {
        type: "recording_added",
        recording: { id: "rec_x", createdAt: "2025-02-01T09:00:00Z" },
      },
    })!;
    expect(r.occurredAt).toBe("2025-02-01T09:00:00Z");
    expect(r.eventId).toBe("recording_added:rec_x");
    expect(r.title).toBeNull();
  });
});

describe("transcriptText", () => {
  it("renders documented segments as Speaker: text lines", () => {
    expect(
      transcriptText({
        result: {
          transcript: {
            languageCode: "en",
            segments: [
              { speaker: "Rep", text: " Where are you with the evaluation? " },
              { speaker: "Jane Doe", text: "We're also looking at Gong." },
              { speaker: "Jane Doe", text: "   " },
              { speaker: "", text: "Background noise" },
            ],
          },
        },
      }),
    ).toBe(
      "Rep: Where are you with the evaluation?\n" +
        "Jane Doe: We're also looking at Gong.\n" +
        "Unknown: Background noise",
    );
  });

  it("throws on an unexpected shape instead of extracting an empty call", () => {
    expect(() =>
      transcriptText({ recording: {}, segments: [] } as never),
    ).toThrow(/result\.transcript\.segments/);
  });
});
