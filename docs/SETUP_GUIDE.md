# Setup Guide

Two tracks. **Track A** gets the app running and provably doing data entry
today, with no Pipedrive account, no Google review, and nothing to pay for.
**Track B** is the long-pole work to point it at a real CRM and real
mailboxes.

Do Track A first. It is ~30 minutes and it answers the only question that
matters right now: *does the extraction pipeline actually produce correct
CRM writes?*

| | |
|---|---|
| 🧍 | Only you can do it — an account, a password, a billing decision |
| 🤖 | A command I wrote. Run it; don't hand-verify it |
| ⏳ | A clock you don't control |

---

## About the Pipedrive trial

Your trial ended, so you cannot connect a real Pipedrive. That does not
block you. Three options, in the order I'd take them:

1. **Sandbox mode (Track A).** Ships in this repo. Every CRM write is
   simulated and recorded so you can read back exactly what would have been
   written. Free, instant, and it exercises the real code path — the
   reconciler, the identity resolver and the confidence gate do not know
   they're in a sandbox.
2. **A Pipedrive developer sandbox account.** Pipedrive's Developer Hub
   offers free, non-expiring sandbox accounts for building Marketplace
   apps. Sign up at <https://developers.pipedrive.com/>, create a developer
   sandbox, and you get a real API against a real (empty) CRM at no cost.
   This is what you want before onboarding a customer. ⏳ Approval is
   usually quick but is not instant.
3. **Pay for one seat.** ~$15–25/month for the cheapest plan. Only worth it
   once a customer is actually waiting.

Option 1 today, option 2 in parallel. Don't pay for option 3 yet.

---

# Track A — prove it works (no accounts, ~30 min)

## A0. 🤖 Does the AI part work? (2 minutes — do this first)

The extraction is the product. Everything else is plumbing around it. This
runs the real prompt on a sample call with known answers and scores it —
no database, no servers, nothing but an API key:

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm run try:extract
```

You get the summary, BANT with confidence and evidence, competitors,
objections, next steps, and a scorecard. Two kinds of checks:

- **Every evidence quote must appear verbatim in the transcript.** A quote
  that doesn't is a hallucination that would otherwise land in a
  customer's CRM as "evidence". This check works on any transcript.
- **Ground truth for the built-in sample** — budget, authority, timeline,
  the Gong competitor, the security objection, the SOC 2 next step.

Then run it on real calls you have access to (export the transcript as
`Speaker: text` lines):

```bash
npm run try:extract -- --transcript my-call.txt
```

**If the scorecard fails or the output reads wrong, stop here and fix the
prompt** in `src/lib/ai/prompts/call-extraction.ts`. Nothing downstream
can compensate for a wrong extraction. A run costs a few cents.

## A1. 🧍 Get a Postgres database

You need one connection string. Cheapest paths, either is fine:

- **Neon** (<https://neon.tech>) — free tier, serverless, no card.
- **Local** — `docker run -e POSTGRES_PASSWORD=pw -p 5432:5432 -d postgres:16`

Copy the connection string.

## A2. 🤖 Generate secrets and write `.env.local`

```bash
npm install
npm run gen:secrets
```

Put this in `.env.local`:

```bash
DATABASE_URL=postgres://...            # from A1
AUTH_SECRET=...                        # from gen:secrets
TOKEN_ENCRYPTION_KEY=...               # from gen:secrets
ANTHROPIC_API_KEY=sk-ant-...           # console.anthropic.com
AUTH_URL=http://localhost:3000

# Track A only — lets the local Claap stub serve transcripts.
ALLOW_DEV_STUBS=1
CLAAP_API_BASE=http://localhost:3000/api/dev/claap-stub
```

`ANTHROPIC_API_KEY` is the only thing here that costs money. A seeded call
is a few cents.

## A3. 🤖 Create the schema

```bash
npm run db:migrate
```

## A4. 🤖 Create a sandbox tenant

```bash
npm run sandbox:connect -- --name "Acme Inc" --domain acme.com
```

This creates the tenant, connects Pipedrive **in sandbox mode**, connects
Claap so the webhook accepts posts, and wires all five signal→field
mappings. It prints a tenant id and a webhook secret — keep both.

## A5. 🤖 Run the app and fire a call through it

Two terminals:

```bash
npm run dev            # terminal 1
npm run inngest:dev    # terminal 2 — the durable job runner
```

Then:

```bash
npm run seed:call -- --tenant <TENANT_ID> --secret <SECRET> --offline --internal acme.com
```

`--offline` encodes a sample transcript (with clear BANT signals and a
competitor mention) into the recording id, which the local stub decodes
back. Claap's real fetch-and-map code still runs; only the network hop is
replaced.

## A6. 🤖 Read what it would have written

```bash
npm run sandbox:report -- --tenant <TENANT_ID>
```

You should see the extracted BANT signals with confidence scores, then the
simulated Pipedrive writes — the rendered note body, the custom-field patch
and the deal it attached to.

**This is the moment of truth.** If the signals are right and the note
reads well, the product works and everything after this is plumbing. If
they're wrong, fix the prompt in `src/lib/ai/prompts/call-extraction.ts`
and re-run A5 — that loop costs cents and needs no third party.

> Signals below 0.8 confidence are held in `/review` rather than written.
> That is the design, not a failure. `sandbox:report` will show an outbox
> row that completed with "no signal cleared its confidence floor".

---

# Track B — point it at the real world

Start B1 **today** even though the rest can wait. It is the only step with
a multi-week clock on it.

## B1. ⏳ Google verification — start now, finish in weeks

Gmail and Calendar ingestion need `gmail.readonly`, which Google classes as
a restricted scope. Until verification completes you are capped at **100
test users** and refresh tokens **expire every 7 days** — meaning email
ingestion breaks weekly. You cannot charge for the freshness guarantee
until this clears.

🧍 In <https://console.cloud.google.com>:

1. New project. Enable **Gmail API**, **Google Calendar API**, **Pub/Sub**.
2. **OAuth consent screen** → External. Fill in app name, support email,
   logo, privacy policy URL, terms URL. These are required for submission,
   so write them now rather than twice.
3. **Credentials → OAuth client ID → Web application.** Redirect URI:
   `https://<your-domain>/api/auth/callback/google`.
4. Add scopes: `gmail.readonly`, `calendar.readonly`, plus `openid`,
   `email`, `profile`.
5. **Submit for verification.** Expect a demo video request and a
   **CASA Tier 2** security assessment (a four-figure cost via an approved
   vendor). This is the single longest lead time in the project.

Into `.env.local` / Vercel: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`.

## B2. 🧍 Pub/Sub for Gmail push

1. Create topic `gmail-push`.
2. Grant `gmail-api-push@system.gserviceaccount.com` the
   **Pub/Sub Publisher** role on it.
3. Create a **push subscription** to
   `https://<your-domain>/api/webhooks/gmail`.
4. Set `GOOGLE_PUBSUB_TOPIC=projects/<project>/topics/gmail-push`.

## B3a. 🧍 Real Claap (your call source)

1. Claap → API settings: create an **API key**.
2. Claap → Webhooks: create a webhook for **`recording_added`** pointing at
   the URL shown on `/settings/sync` (`https://<your-domain>/api/webhooks/claap/<tenant-id>`).
3. Paste the API key and **that webhook's secret** into `/settings/sync`.
4. Record a short real call. Within a few minutes `raw_events` should hold
   the delivery and `/review` or Pipedrive should show the result.

The integration is built and tested against Claap's published docs but has
never received a real delivery. If step 4 doesn't produce an interaction,
the verbatim payload is in `raw_events` — that is what to fix it from.

## B3b. 🧍 Real Pipedrive

Once you have a developer sandbox (or a paid account):

- **API token** (simplest): Pipedrive → Personal preferences → API. Paste
  it on `/settings/sync`.
- **OAuth** (needed for Marketplace distribution): create the app in the
  Developer Hub, callback
  `https://<your-domain>/api/oauth/pipedrive`, set
  `PIPEDRIVE_CLIENT_ID` / `PIPEDRIVE_CLIENT_SECRET`.

Then re-map fields on `/settings/fields` against your real deal fields —
the sandbox keys from A4 are synthetic and will not match.

## B4. 🧍 Deploy

1. Import the repo on Vercel; set every env var from A2 plus B1–B3, with
   `AUTH_URL` at your real domain.
2. Add **Inngest** (Vercel integration or `INNGEST_SIGNING_KEY` +
   `INNGEST_EVENT_KEY`), then sync the app so it discovers
   `/api/inngest`.
3. Run the RLS role setup against your production database:
   ```bash
   psql "$DATABASE_URL" -v pw="'<strong-password>'" -f scripts/sql/create-rls-role.sql
   ```
   Set `DATABASE_URL_RLS` to that role. **Without this, RLS is inert** —
   the owner role bypasses every policy.
4. 🤖 Verify everything at once:
   ```bash
   npm run doctor
   ```
   It checks env vars, migrations, that RLS actually *enforces* (connects as
   `app_rls` and proves zero cross-tenant visibility), watch health, outbox
   backlog, and that the deployment registered all 13 Inngest functions.

## B5. 🧍 Cost rails

- Set a monthly spend limit on the Anthropic console.
- Backfill is bounded to 14 days per connected user. Widening it multiplies
  onboarding cost — leave it alone.

---

## Daily commands

```bash
npm run try:extract                     # does the AI work? (key only)
npm run doctor                          # full health check
npm run sandbox:connect -- --name X --domain x.com
npm run seed:call -- --tenant <id> --secret <s> --offline
npm run sandbox:report -- --tenant <id> # what would have hit the CRM
npm run dev / npm run inngest:dev
npm test && npm run lint && npm run typecheck
```

## When something breaks

| Symptom | Look at |
|---|---|
| Webhook 401 | `x-claap-webhook-secret` doesn't match the secret saved on `/settings/sync` |
| Webhook 404 | No connection for that tenant/provider |
| Nothing extracts | Is `npm run inngest:dev` running? |
| Extraction lands in `/review` | Below the 0.8 floor — working as designed |
| No simulated writes | `select * from sync_outbox` — check `last_error` |
| Gmail silently stops | Watch expired; `renew-watches` cron. `npm run doctor` |
| RLS check fails | `DATABASE_URL_RLS` unset, or role not created |
