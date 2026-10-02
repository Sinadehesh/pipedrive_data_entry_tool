/**
 * Fire a synthetic Claap recording_added webhook at a running instance —
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
 *   --offline           Encode the transcript into the recording id and
 *                       let the local stub serve it back, so NO Claap
 *                       workspace is needed. Requires the app running with
 *                       ALLOW_DEV_STUBS=1 and
 *                       CLAAP_API_BASE=<url>/api/dev/claap-stub
 *
 * Combined with a sandbox Pipedrive connection (npm run sandbox:connect),
 * `--offline` runs the entire pipeline with no third-party account at all:
 *
 *   npm run sandbox:connect -- --name "Acme" --domain acme.com
 *   npm run seed:call -- --tenant <id> --secret <secret> --offline
 *   npm run sandbox:report -- --tenant <id>
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { SAMPLE_TRANSCRIPT } from "./fixtures/sample-call";


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

  const offline = process.argv.includes("--offline");
  const internal = arg("internal") ?? "example.com";

  // Offline: the recording id carries the transcript text, which the local
  // stub decodes back — so extract-call's real Claap fetch + parse runs.
  const recordingId = offline
    ? `offline-${Buffer.from(transcript, "utf8").toString("base64url")}`
    : `seed-${randomUUID()}`;

  // Shaped like Claap's documented recording_added delivery
  // (help.claap.io → "Claap Webhooks Documentation").
  const body = JSON.stringify({
    eventId: `evt-${randomUUID()}`,
    event: {
      type: "recording_added",
      recording: {
        id: recordingId,
        title: "Discovery call (seeded)",
        createdAt: new Date().toISOString(),
        meeting: {
          type: "external",
          startingAt: new Date().toISOString(),
          endingAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          participants: [{ email, name: "Jane Doe" }],
        },
        recorder: {
          id: "rep-1",
          email: `rep@${internal}`,
          name: "Rep",
          attended: true,
        },
      },
    },
  });

  const url = `${baseUrl}/api/webhooks/claap/${tenantId}`;

  console.log(`→ POST ${url}`);
  const res = await fetch(url, {
    method: "POST",
    // Claap authenticates with the static webhook secret in a header.
    headers: { "content-type": "application/json", "x-claap-webhook-secret": secret },
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
    console.log("  → then look for the note on the deal in Pipedrive,");
    console.log("    or run `npm run sandbox:report -- --tenant <id>` if this");
    console.log("    tenant is on a sandbox Pipedrive connection.");
    console.log("\nIf the extraction lands below 0.8 confidence it will be");
    console.log("waiting in /review instead — that is working as designed.");
  } else if (res.status === 401) {
    console.error("✗ 401 — webhook secret rejected. --secret must match the value");
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
