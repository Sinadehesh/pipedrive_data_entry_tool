/**
 * Fire a synthetic, correctly-signed Claap webhook at a running instance —
 * the fastest way to watch the whole data-entry pipeline actually run:
 *
 *   webhook -> raw_events -> interactions -> chunked LLM extraction
 *           -> extractions -> sync_outbox -> reconciler -> Pipedrive note
 *
 * You need a Claap connection saved in /settings/sync (any API key works
 * for this script — the transcript is served locally, see below), plus a
 * connected Pipedrive account.
 *
 * Usage:
 *   npx tsx scripts/seed-call.ts --tenant <tenantId> [options]
 *
 * Options:
 *   --tenant   <uuid>   REQUIRED. From /settings/sync (it is in your
 *                       webhook URL) or `select id from tenants`.
 *   --secret   <str>    Claap webhook secret you saved in settings.
 *                       Defaults to $CLAAP_WEBHOOK_SECRET.
 *   --url      <url>    App origin. Default http://localhost:3000
 *   --email    <email>  External participant to attach the deal to.
 *                       Use a real prospect email that exists in your
 *                       Pipedrive, or one will be created.
 *   --transcript <path> Custom transcript file. Defaults to a built-in
 *                       sample containing clear BANT signals.
 *
 * NOTE: extract-call fetches the transcript from Claap's API using the
 * recording id. For a fully offline dry run, point CLAAP_API_BASE at a
 * local stub, or use this script against a real Claap recording id.
 */
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const SAMPLE_TRANSCRIPT = `Rep: Thanks for making time. Where are you with the evaluation?
Jane Doe: We're fairly far along. I'll be honest, we're also looking at Gong.
Rep: Understood. What's driving the timeline?
Jane Doe: Our QBR is the second week of March, and I want this in place before then.
Rep: That's tight but doable. Who else needs to sign off?
Jane Doe: I can approve up to fifty thousand. Above that it goes to our CFO, Marcus.
Rep: Good news, you'd be well under that.
Jane Doe: The main worry is our security review — last vendor took six weeks.
Rep: We have a SOC 2 report I can send today, that usually shortens it.
Jane Doe: If that's true, send it over and I'll start the review this week.
Rep: Done. I'll also put together a rollout plan for your team of thirty reps.
Jane Doe: Perfect. Honestly the reason we're leaning your way over Gong is the Pipedrive integration.`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const tenantId = arg("tenant");
  const secret = arg("secret") ?? process.env.CLAAP_WEBHOOK_SECRET;
  const baseUrl = (arg("url") ?? "http://localhost:3000").replace(/\/$/, "");
  const email = arg("email") ?? "jane.doe@example-prospect.com";
  const transcriptPath = arg("transcript");

  if (!tenantId) {
    console.error("Missing --tenant <uuid>. See the header of this file.");
    process.exit(1);
  }
  if (!secret) {
    console.error(
      "Missing --secret (or CLAAP_WEBHOOK_SECRET). Must match the webhook\n" +
        "secret you saved on /settings/sync for this tenant.",
    );
    process.exit(1);
  }

  const transcript = transcriptPath
    ? readFileSync(transcriptPath, "utf8")
    : SAMPLE_TRANSCRIPT;

  const recordingId = `seed-${randomUUID()}`;
  const body = JSON.stringify({
    id: `evt-${randomUUID()}`,
    type: "recording.completed",
    data: {
      recording_id: recordingId,
      // Included for reference; extract-call re-fetches from Claap's API.
      _seed_participants: [email],
      _seed_transcript_preview: transcript.slice(0, 120),
    },
  });

  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const url = `${baseUrl}/api/webhooks/claap/${tenantId}`;

  console.log(`→ POST ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-claap-signature": signature },
    body,
  });

  if (res.status === 200) {
    console.log(`✓ Accepted (recording ${recordingId})`);
    console.log("\nWatch it flow through:");
    console.log("  1. Inngest dev UI (http://localhost:8288) → extract-call run");
    console.log("  2. select * from raw_events order by received_at desc limit 1;");
    console.log("  3. select * from interactions order by created_at desc limit 1;");
    console.log("  4. select status, overall_confidence from extractions order by created_at desc limit 1;");
    console.log("  5. select op, status, last_error from sync_outbox order by created_at desc limit 5;");
    console.log("  6. select * from sync_log order by created_at desc limit 5;");
    console.log("  → then look for the note on the deal in Pipedrive.");
    console.log("\nIf the extraction lands below 0.8 confidence it will be");
    console.log("waiting in /review instead — that is working as designed.");
  } else if (res.status === 401) {
    console.error("✗ 401 — signature rejected. --secret must match the value");
    console.error("  saved on /settings/sync for this tenant.");
    process.exit(1);
  } else if (res.status === 404) {
    console.error("✗ 404 — no Claap connection for that tenant. Connect Claap");
    console.error("  on /settings/sync first.");
    process.exit(1);
  } else {
    console.error(`✗ ${res.status} — ${await res.text()}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
