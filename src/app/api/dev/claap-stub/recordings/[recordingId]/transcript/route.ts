import { NextResponse } from "next/server";

/**
 * A local stand-in for Claap's transcript endpoint, so the call pipeline
 * can be exercised end to end with no Claap workspace.
 *
 * It is STATELESS: `scripts/seed-call.ts --offline` encodes the whole
 * recording (participants, title, transcript) into the recording id as
 * base64url JSON, and this route decodes it back. Claap recording ids are
 * opaque strings, so nothing downstream can tell the difference — the
 * webhook, the ledger write and the extraction all run their real code.
 *
 * Enable with ALLOW_DEV_STUBS=1 and point CLAAP_API_BASE here:
 *   CLAAP_API_BASE=http://localhost:3000/api/dev/claap-stub
 *
 * Guarded twice (NODE_ENV and an explicit opt-in) because a route that
 * fabricates CRM-bound content must never answer in production.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ recordingId: string }> },
) {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.ALLOW_DEV_STUBS !== "1"
  ) {
    return new NextResponse("not found", { status: 404 });
  }

  const { recordingId } = await params;
  const encoded = recordingId.startsWith("offline-")
    ? recordingId.slice("offline-".length)
    : null;
  if (!encoded) {
    return NextResponse.json(
      { error: "stub only serves ids of the form offline-<base64url>" },
      { status: 404 },
    );
  }

  let decoded: {
    title?: string;
    occurredAt?: string;
    participants?: { email: string; name?: string; isHost?: boolean }[];
    text?: string;
  };
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return NextResponse.json({ error: "undecodable id" }, { status: 400 });
  }

  // Shaped exactly like the real Claap response so getTranscript()'s
  // mapping code is what runs, not a bypass of it.
  return NextResponse.json({
    recording: {
      id: recordingId,
      title: decoded.title ?? "Untitled (stub)",
      started_at: decoded.occurredAt ?? new Date().toISOString(),
      participants: (decoded.participants ?? []).map((p) => ({
        email: p.email,
        name: p.name,
        is_host: p.isHost,
      })),
    },
    segments: (decoded.text ?? "")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const idx = line.indexOf(":");
        return idx === -1
          ? { speaker: "Unknown", text: line.trim() }
          : {
              speaker: line.slice(0, idx).trim(),
              text: line.slice(idx + 1).trim(),
            };
      }),
  });
}
