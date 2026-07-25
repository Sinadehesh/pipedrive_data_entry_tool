import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseVtt, urlValidationResponse, verifyZoomSignature } from "./client";

const SECRET = "zoom-secret-token";

function sign(body: string, timestamp: string, secret = SECRET): string {
  return `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
}

describe("verifyZoomSignature", () => {
  const body = JSON.stringify({ event: "recording.transcript_completed" });
  const now = () => String(Math.floor(Date.now() / 1000));

  it("accepts a correctly signed, fresh request", () => {
    const ts = now();
    expect(verifyZoomSignature(body, sign(body, ts), ts, SECRET)).toBe(true);
  });

  it("rejects a signature made with another tenant's secret", () => {
    const ts = now();
    const forged = sign(body, ts, "someone-elses-secret");
    expect(verifyZoomSignature(body, forged, ts, SECRET)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const ts = now();
    const sig = sign(body, ts);
    expect(verifyZoomSignature(body + " ", sig, ts, SECRET)).toBe(false);
  });

  it("rejects replays outside the 5-minute window", () => {
    const old = String(Math.floor(Date.now() / 1000) - 600);
    expect(verifyZoomSignature(body, sign(body, old), old, SECRET)).toBe(false);
  });

  it("rejects missing or unparseable headers", () => {
    const ts = now();
    expect(verifyZoomSignature(body, null, ts, SECRET)).toBe(false);
    expect(verifyZoomSignature(body, sign(body, ts), null, SECRET)).toBe(false);
    expect(verifyZoomSignature(body, sign(body, ts), "abc", SECRET)).toBe(false);
  });
});

describe("urlValidationResponse", () => {
  it("echoes the plain token and HMACs it with the tenant's secret", () => {
    const { plainToken, encryptedToken } = urlValidationResponse("abc123", SECRET);
    expect(plainToken).toBe("abc123");
    expect(encryptedToken).toBe(
      createHmac("sha256", SECRET).update("abc123").digest("hex"),
    );
  });
});

describe("parseVtt", () => {
  it("reduces a Zoom VTT to speaker-prefixed lines", () => {
    const vtt = [
      "WEBVTT",
      "",
      "1",
      "00:00:01.000 --> 00:00:04.000",
      "Jane Doe: We have about 50k approved for this.",
      "",
      "2",
      "00:00:04.500 --> 00:00:07.000",
      "Rep: That works with our mid tier.",
      "",
    ].join("\n");

    expect(parseVtt(vtt)).toBe(
      "Jane Doe: We have about 50k approved for this.\nRep: That works with our mid tier.",
    );
  });

  it("strips NOTE metadata and handles CRLF transcripts", () => {
    const vtt = "WEBVTT\r\n\r\nNOTE recording\r\n\r\n1\r\n00:00:01.000 --> 00:00:02.000\r\nRep: Hello.\r\n";
    expect(parseVtt(vtt)).toBe("Rep: Hello.");
  });

  it("returns empty string for an empty transcript", () => {
    expect(parseVtt("WEBVTT\n\n")).toBe("");
  });
});
