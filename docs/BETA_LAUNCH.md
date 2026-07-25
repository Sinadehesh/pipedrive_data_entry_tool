# Beta Launch Runbook

Everything between "code is written" and "beta customers are safely using it."
Work top to bottom; Phase 0 contains decisions that change what you provision,
so don't skip it.

**Status legend:** ☐ not started · ◐ in progress · ☑ done

---

## Phase 0 — Decisions to make before provisioning

These four change the shape of the launch. Settle them first.

### 0.1 ☐ Google verification: start it TODAY, it is the long pole

`gmail.readonly` is a **restricted** scope. That means:

| Publishing status | User cap | Refresh token lifetime | Verification needed |
|---|---|---|---|
| Testing (External) | **100 test users, hard cap** | **7 days** | No |
| Production (External) | Unlimited | Indefinite | **Yes — OAuth verification + CASA Tier 2 security assessment** |
| Internal (Workspace org) | Your org only | Indefinite | No |

The 7-day refresh-token expiry in Testing mode is the killer: every beta
user would have to re-consent weekly or ingestion silently stops (they'd
land in `connections.status = 'error'`, visible on the settings page, but
that is still a terrible beta experience).

**Pick a path:**

- **(A) Calls-first beta, Google in parallel — recommended.** Ship the beta
  on Claap + Zoom (no verification, no user cap, no token expiry) while the
  Google verification runs. Turn Google on per-tenant as verification lands.
  The architecture already supports this: a tenant with no Google connection
  simply has those planes dormant.
  - Caveat you already identified: staleness sweeps see calls only for those
    tenants. Mitigate by raising `tenants.staleness_days` for calls-only
    tenants (default 14 → e.g. 30) so the sweep is conservative rather than
    noisy.
- **(B) Full multi-source beta in Testing mode.** ≤100 users, and you tell
  them up front they'll re-authorize Google weekly. Acceptable for a
  10-person design-partner beta, painful beyond that.
- **(C) Internal-only pilot.** If your first tenants are inside your own
  Google Workspace org, set user type Internal — no verification, no expiry.
  Rarely applicable to a real B2B beta.

Verification takes weeks-to-months and CASA has a cost. **Submit before you
need it.**

### 0.2 ☐ Decide the backfill window — it writes to real CRMs retroactively

On Google connect, `backfill.ts` imports 90 days and every ingested thread /
meeting flows through extraction → `create_note` → the tenant's Pipedrive.
A new beta customer could see **hundreds of notes appear retroactively on
live deals**. That is a trust-destroying first impression if unexpected.

Options (pick one before the first external connect):

1. **Shorten the window.** `src/app/api/oauth/google/route.ts` → `days: 90`
   → `days: 14`. One-line change, lowest risk, still populates the ledger
   enough for the staleness sweep to be honest.
2. **Suppress notes for backfilled rows.** Have `backfill.ts` mark
   interactions (e.g. a `backfilled` flag) and have `persistAndEnqueue` skip
   the `create_note` op for them — ledger + intel + freshness still work,
   nothing is written to the CRM retroactively.
3. **Ship 90 days as-is and warn the user on the connect screen.**

Recommended for beta: **(1) + explicit copy on the Google card**, or (2) if
you have time to implement it.

### 0.3 ☐ Confirm the extraction model / cost per tenant

`EXTRACTION_MODEL_ID = "claude-opus-4-8"` (`src/lib/ai/extractor.ts`).

Rough backfill cost per user, 90-day window: a busy rep's mailbox can yield
several hundred qualifying threads; at ~8k input tokens each that is a few
million input tokens — order **$20–60 per user, one time**, plus ongoing
per-call/thread costs. Levers:

- Shorter backfill window (0.2) cuts this proportionally.
- `claude-sonnet-5` for email/meeting extraction (thin sources) while calls
  stay on Opus — meaningful savings, small quality cost.
- Set a **spend alert** on the Anthropic account before the first backfill.

### 0.4 ☐ Set the beta cohort size and the safety default

Start with **3–5 design partners**, not 50. Reasons: every tenant's Pipedrive
is production data; the Claap payload mapping is still unverified against a
live workspace (see 8.1); and per-tenant Pipedrive rate budgets behave
differently at real volume.

**Safety default — leave it alone:** a tenant with **no `field_mappings`
rows writes no CRM fields at all**, only append-only notes. That is already
the out-of-box behavior. Do not pre-configure mappings for beta tenants;
let them opt in on `/settings/sync` after they have read a few notes and
trust the extractions.

---

## Phase 1 — Provision infrastructure

- [ ] **Postgres** (Neon or Supabase; both fine — Neon's pooled connection
      string works because the client uses `prepare: false`).
- [ ] **Vercel project** connected to the repo.
- [ ] **Inngest account** + app created (Vercel integration is easiest).
- [ ] **Anthropic API key** with a spend alert configured (0.3).
- [ ] **Domain** for the app, e.g. `app.yourdomain.com` — needed before you
      register any OAuth redirect URI, so do it now, not later.

Generate the two secrets you control:

```bash
openssl rand -base64 32   # AUTH_SECRET
openssl rand -base64 32   # TOKEN_ENCRYPTION_KEY  (must be exactly 32 bytes)
```

> ⚠️ `TOKEN_ENCRYPTION_KEY` encrypts every tenant credential at rest. If you
> lose or rotate it, **every stored connection becomes undecryptable** and
> all tenants must reconnect. Back it up in a password manager now, and
> never let staging and production share one.

---

## Phase 2 — Database and RLS

- [ ] **2.1 Run migrations** (owner role):

```bash
DATABASE_URL="postgres://owner:...@host/db" npx drizzle-kit migrate
```

Applies `0000` → `0005`; the last one enables RLS with the fail-closed
`tenant_isolation` policies.

- [ ] **2.2 Create the RLS role.** RLS does not bite for the table owner, so
      request-path queries must use a separate non-owner role:

```sql
CREATE ROLE app_rls LOGIN PASSWORD '<strong-password>';
GRANT USAGE ON SCHEMA public TO app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rls;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rls;
```

- [ ] **2.3 Set `DATABASE_URL_RLS`** to that role's connection string.
      If it is unset in production the app logs a loud warning and silently
      runs request queries on the owner pool — **isolation would be off.**

- [ ] **2.4 Prove isolation before real customer data lands.** Connect
      *as `app_rls`* and confirm both directions:

```sql
-- No tenant context: must return 0 rows (fail-closed).
SELECT count(*) FROM interactions;

-- Scoped to tenant A: only A's rows.
BEGIN;
SELECT set_config('app.tenant_id', '<tenant-A-uuid>', true);
SELECT count(*) FROM interactions;                       -- A's count
SELECT count(*) FROM interactions WHERE tenant_id = '<tenant-B-uuid>'; -- must be 0
-- Cross-tenant write must be rejected by WITH CHECK:
INSERT INTO interactions (tenant_id, source, external_id, kind, occurred_at, participants, content)
VALUES ('<tenant-B-uuid>', 'claap', 'rls-probe', 'call', now(), '[]'::jsonb, 'probe');
-- expect: new row violates row-level security policy
ROLLBACK;
```

If the first query returns rows, you are still connected as the owner —
fix before proceeding.

---

## Phase 3 — Third-party applications

### 3.1 ☐ Google Cloud (sign-in + Gmail/Calendar ingestion)

1. Create a GCP project.
2. **OAuth consent screen** — External; add the scopes `openid`, `email`,
   `gmail.readonly`, `calendar.readonly`; add your beta users as test users;
   **submit for verification now** (Phase 0.1).
3. **OAuth client (Web application)** → gives `GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET`. Authorized redirect URIs — add **both**:
   - `https://app.yourdomain.com/api/auth/callback/google` *(Auth.js sign-in)*
   - `https://app.yourdomain.com/api/oauth/google` *(data-access connect)*
4. **Pub/Sub topic** for Gmail push → `GMAIL_PUBSUB_TOPIC` in the form
   `projects/{project}/topics/{topic}`.
5. Grant Gmail permission to publish to it:
   `gmail-api-push@system.gserviceaccount.com` → role
   **Pub/Sub Publisher** on that topic. *(Skipping this makes
   `users.watch()` fail and every Google connect land in `warn=watches`.)*
6. **Push subscription** on that topic:
   - Delivery type: Push, endpoint
     `https://app.yourdomain.com/api/webhooks/google/gmail`
   - Enable authentication → pick/create a service account →
     `PUBSUB_PUSH_SERVICE_ACCOUNT`
   - Audience → `PUBSUB_PUSH_AUDIENCE` (use the same endpoint URL)

   The webhook verifies the OIDC token's audience **and** that the caller is
   exactly this service account, so both values must match reality.

### 3.2 ☐ Pipedrive Marketplace app

1. Create a Marketplace OAuth app in your Pipedrive developer sandbox.
2. Callback URL: `https://app.yourdomain.com/api/oauth/pipedrive`
3. Scopes: deals (read/write), persons (read/write), organizations
   (read/write), activities/notes (write), and `dealFields` read — the
   settings mapping screen calls `GET /v1/dealFields`.
4. → `PIPEDRIVE_CLIENT_ID` / `PIPEDRIVE_CLIENT_SECRET`.

### 3.3 ☐ Claap / Zoom — nothing platform-level

Both are configured **per tenant** in-app (`/settings/sync`). Prepare a
short customer-facing doc telling a beta user how to:

- **Claap:** create an API key, choose a webhook signing secret, paste both
  into the app, then register the app's per-tenant webhook URL in Claap.
- **Zoom:** create a Server-to-Server or Webhook-only app, copy its
  **Secret Token** into the app, set the app's per-tenant URL as the event
  endpoint, subscribe to **`recording.transcript_completed`**, and click
  Validate (the app answers Zoom's `url_validation` challenge automatically).

---

## Phase 4 — Deploy

- [ ] **4.1 Set every env var in Vercel** (Production + Preview):

```
DATABASE_URL, DATABASE_URL_RLS, ANTHROPIC_API_KEY,
AUTH_SECRET, TOKEN_ENCRYPTION_KEY, APP_URL,
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
GMAIL_PUBSUB_TOPIC, PUBSUB_PUSH_SERVICE_ACCOUNT, PUBSUB_PUSH_AUDIENCE,
PIPEDRIVE_CLIENT_ID, PIPEDRIVE_CLIENT_SECRET,
INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY
```

`APP_URL` must be the real origin (`https://app.yourdomain.com`) — every
OAuth redirect URI and per-tenant webhook URL is derived from it.

- [ ] **4.2 Deploy** and confirm the domain serves the app.
- [ ] **4.3 Sync Inngest** — point your Inngest app at
      `https://app.yourdomain.com/api/inngest`. Confirm **13 functions**
      register:

  `extract-call`, `extract-zoom-call`, `extract-email-thread`,
  `extract-meeting`, `replay-extraction`, `gmail-history-sync`,
  `calendar-delta-sync`, `backfill-connection`, `reconcile-pipedrive`,
  `drain-outbox`, `renew-watches`, `staleness-dispatch`, `staleness-check`

- [ ] **4.4 Confirm the three crons are scheduled:**
  - `renew-watches` — `0 */6 * * *` (the ingestion heartbeat)
  - `staleness-dispatch` — `0 3 * * *`
  - `drain-outbox` — `*/5 * * * *`

- [ ] **4.5 Fix CI.** The GitHub Pages static-export deploy has been removed
      (good — it could never build this app). The current
      `.github/workflows/nextjs.yml` still needs four fixes; all were
      verified against the repo:

  1. **It is not a valid workflow file.** It begins at `steps:` with no
     top-level `name:` / `on:` / `jobs:` — GitHub rejects it with a syntax
     error and it never runs.
  2. **`npm run lint` does not exist.** `package.json` has no `lint` script
     and eslint is not a dependency. Use `npm run typecheck` (which does
     exist), or add eslint first.
  3. **The build fails with the env vars given.** `src/auth.ts` calls
     `env()` at module scope, so the zod schema is validated during page-data
     collection. `ANTHROPIC_API_KEY` (required, `min(1)`) is missing →
     *"Failed to collect page data for /api/oauth/pipedrive"*. Reproduced
     locally with exactly the workflow's env block.
  4. **`ENCRYPTION_KEY` is the wrong name** — the app reads
     `TOKEN_ENCRYPTION_KEY`. Harmless at build time (it is optional there),
     but misleading; rename it.

  A corrected file is provided alongside this runbook. Note the token used
  by this session cannot push `.github/workflows/**` (fine-grained PATs need
  the `workflow` scope), so apply it via GitHub's web editor or a scoped
  token.

---

## Phase 5 — Dogfood on your own tenant (before any customer)

Do the whole customer journey yourself, on a **Pipedrive sandbox**.

- [ ] **5.1** Sign in with Google → confirm a `tenants` row and an `owner`
      `memberships` row were created, and `internalDomains` was seeded from
      your email domain.
- [ ] **5.2** Connect Pipedrive → `connections` row, `status=active`.
- [ ] **5.3** Open `/settings/sync` → the field-mapping table lists *your*
      Pipedrive deal fields. **Leave mappings empty** (notes-only, per 0.4).
- [ ] **5.4 Call path:** connect Claap or Zoom, register the webhook, record
      a short real call with an external participant. Then verify the chain:
      `raw_events` → `interactions` → `extractions` → `sync_outbox`
      (`completed`) → `sync_log` → **a note on the right deal in Pipedrive**.
- [ ] **5.5 Confidence gate:** confirm a low-confidence extraction appears in
      `/review` with verbatim evidence quotes; approve it and watch the
      field write flow through the reconciler.
- [ ] **5.6 Replay:** hit ↻ Replay on a reviewed item; confirm a *new*
      extraction version is appended (old version retained, never mutated).
- [ ] **5.7 Google path** (if Phase 0.1 path B/C): connect Google, confirm
      `watch_channels` rows for `gmail` and `gcal` with future `expires_at`,
      the backfill job runs, and a new inbound prospect email produces a
      thread extraction within ~3 minutes (the debounce window).
- [ ] **5.8 Map one field** and confirm a high-confidence signal lands in
      the right Pipedrive custom field, with a `sync_log` row proving it.
- [ ] **5.9 Team invite:** generate a join link, accept it from a second
      Google account, confirm it lands in the same tenant and the token
      cannot be reused.

---

## Phase 6 — Observability and safety rails

The pipeline is durable but currently **quiet** — failures land in Inngest
run logs and DB columns, not in anyone's inbox. Before real customers:

- [ ] **6.1 Alert on watch-renewal failure.** `renew-watches` calls
      `logger.error` with the failing channels; this is the single most
      important alert, because a lapsed watch means ingestion stops
      *silently*. Wire Inngest failure notifications → Slack/PagerDuty.
- [ ] **6.2 Alert on function failures** generally — especially
      `reconcile-pipedrive` (CRM writes failing) and `extract-*`
      (`onFailure` writes a `failed` extraction version).
- [ ] **6.3 Watch these queries** (a tiny internal dashboard or a saved SQL):

```sql
-- Connections needing attention (dying integrations)
SELECT tenant_id, provider, account_ref, last_error
FROM connections WHERE status <> 'active';

-- Watches lapsing or already lapsed
SELECT connection_id, kind, expires_at, last_error, last_notified_at
FROM watch_channels ORDER BY expires_at;

-- Outbox backing up (rate limits, or a stuck tenant)
SELECT tenant_id, status, count(*) FROM sync_outbox
GROUP BY 1,2 HAVING count(*) > 20;

-- Review queue depth per tenant (is the confidence bar calibrated?)
SELECT tenant_id, count(*) FROM extractions
WHERE status = 'needs_review' GROUP BY 1;
```

- [ ] **6.4 Anthropic spend alert** (from 0.3) actually enabled.
- [ ] **6.5 Error tracking** (Sentry or equivalent) on the Next.js app —
      OAuth callbacks and server actions currently fail into redirect
      params, which users see but you don't.

---

## Phase 7 — Onboard beta tenant #1

- [ ] **7.1** Onboard **one** customer, live, on a call — watch it happen
      rather than emailing a link.
- [ ] **7.2** Confirm their first real call produces a note *they* agree is
      accurate before enabling any field mapping.
- [ ] **7.3** Leave field mappings off for the first week. Enable one field
      (usually Timeline or Need), watch it for a few days, then expand.
- [ ] **7.4** Check their review queue with them — if it is large, the 0.8
      floor may need tuning for their call style; if it is empty and the
      extractions are wrong, the floor is too low.
- [ ] **7.5** Only then onboard tenants #2–5.

---

## Phase 8 — Known gaps to watch during beta

These are understood limitations, not surprises. Track them.

1. **Claap payload mapping is unverified against a live workspace.**
   `src/lib/claap/client.ts` follows the documented API shape but has never
   run against real Claap data. Expect to adjust field paths on first
   contact — it is isolated to that one file. **Verify this in 5.4 before
   any customer sees it.**
2. **Zoom deal attachment is weak.** Zoom's recording webhook carries only
   the *host* email, not attendees, so a Zoom call attaches to a deal only
   if a participant is already in `identity_map`. Planned fix: pair the call
   with the calendar ledger by time window. Claap (which sends full
   participant lists) does not have this problem.
3. **Pipedrive token-budget behavior at real volume is untested.** The
   reconciler is single-writer + throttled per tenant and defers on 429, so
   the failure mode is slowness rather than data loss — but watch 6.3's
   outbox query during the first heavy week.
4. **No per-tenant usage limits.** Nothing caps a tenant's LLM spend. Fine
   for 5 design partners, needs work before self-serve.
5. **Invites are single-use and never emailed** — you or the tenant owner
   must deliver the link out of band. Acceptable for beta.
6. **`unstable_update`** (Auth.js v5 beta) backs tenant switching on invite
   accept; pin the `next-auth` version and re-test that flow on any upgrade.

---

## Quick reference — the four things that most commonly break

| Symptom | Almost always |
|---|---|
| Gmail ingestion silently stopped | Watch expired; `renew-watches` failing or never scheduled (4.4 / 6.1) |
| Google connect lands on `warn=watches` | Pub/Sub publisher permission missing (3.1 step 5) |
| Everything returns empty in the dashboard | `DATABASE_URL_RLS` set but tenant context missing — check the query runs inside `withTenant()` |
| Notes appear but deal fields never update | Working as designed: no `field_mappings` rows, or confidence below the floor (0.4) |
