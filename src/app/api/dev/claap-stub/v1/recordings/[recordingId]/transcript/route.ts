import { NextResponse } from "next/server";

/**
 * A local stand-in for Claap's transcript endpoint, so the call pipeline
 * can be exercised end to end with no Claap workspace.
 *
 * Mirrors the DOCUMENTED contract — same path, same X-Claap-Key header,
 * same `{ result: { transcript: { segments } } }` body — so the real
 * client code is what gets exercised. If Claap's API changes, this stub
 * must change with it, or offline runs will validate a shape that
 * production no longer receives.
 *
 * It is STATELESS: `scripts/seed-call.ts --offline` encodes the transcript
 * text into the recording id as base64url ("offline-<b64>"). Call metadata
 * travels in the webhook payload, exactly as with real Claap.
 *
 * Enable with ALLOW_DEV_STUBS=1 and point CLAAP_API_BASE here:
 *   CLAAP_API_BASE=http://localhost:3000/api/dev/claap-stub
 *
 * Guarded twice (NODE_ENV and an explicit opt-in) because a route that
 * fabricates CRM-bound content must never answer in production.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ recordingId: string }> },
) {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.ALLOW_DEV_STUBS !== "1"
  ) {
    return new NextResponse("not found", { status: 404 });
  }

  if (!req.headers.get("x-claap-key")) {
    return NextResponse.json({ error: "missing X-Claap-Key" }, { status: 401 });
  }

  const { recordingId } = await params;
  if (!recordingId.startsWith("offline-")) {
    return NextResponse.json(
      { error: "stub only serves ids of the form offline-<base64url>" },
      { status: 404 },
    );
  }

  let text: string;
  try {
    text = Buffer.from(recordingId.slice("offline-".length), "base64url").toString(
      "utf8",
    );
  } catch {
    return NextResponse.json({ error: "undecodable id" }, { status: 400 });
  }

  return NextResponse.json({
    result: {
      transcript: {
        languageCode: "en",
        segments: text
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line, i) => {
            const idx = line.indexOf(":");
            return {
              startedAt: i * 10,
              endedAt: i * 10 + 9,
              languageCode: "en",
              speaker: idx === -1 ? "Unknown" : line.slice(0, idx).trim(),
              text: idx === -1 ? line.trim() : line.slice(idx + 1).trim(),
            };
          }),
      },
    },
  });
}
