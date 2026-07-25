# Setup Guide — what only you can do

This is the **human-only** list: every step here needs you in a browser,
signing up for something, clicking consent, or holding a credential. Anything
that could be automated has been, and is called out as `npm run …`.

Work top to bottom. After each numbered step, run:

```bash
npm run doctor
```

It checks env vars, database, migrations, RLS *enforcement* (not just that
it's switched on), watch health, outbox backlog, and — once deployed — that
your endpoints answer correctly. Every failure prints the fix.

**Time:** ~2–3 focused hours, except step 4c (Google verification) which is
weeks of waiting you should start on day one.

---

## Legend

| | |
|---|---|
| 🧍 | Only you can do it (console, signup, consent, payment) |
| 🤖 | Already automated — just run the command |
| ⏳ | Starts a clock you don't control |

---

## 1. 🧍 Accounts (~20 min)

Create these and keep the tabs open — later steps need values from each.

| Service | What for | Plan note |
|---|---|---|
| [Neon](https://neon.tech) or [Supabase](https://supabase.com) | Postgres | Free tier is fine for beta |
| [Vercel](https://vercel.com) | Hosting | Hobby works; Pro if you want longer function limits |
| [Inngest](https://inngest.com) | Background jobs | Free tier covers a small beta |
| [Anthropic Console](https://console.anthropic.com) | Extraction LLM | **Set a spend alert now** — see §7 |
| [Google Cloud](https://console.cloud.google.com) | Sign-in + Gmail/Calendar | Free |
| [Pipedrive developer sandbox](https://developers.pipedrive.com) | CRM OAuth app | Free |

**Also decide your domain now** (e.g. `app.yourcompany.com`). Every OAuth
redirect URI and webhook URL is derived from it, and changing it later means
re-editing every console above.

---

## 2. 🤖 Generate your two secrets

```bash
npm run gen:secrets
```

Copy both lines somewhere safe **now**:

- `AUTH_SECRET` — signs user sessions.
- `TOKEN_ENCRYPTION_KEY` — encrypts every tenant's Pipedrive/Google/Claap/Zoom
  credential at rest.

> ⚠️ **Losing `TOKEN_ENCRYPTION_KEY` is unrecoverable.** Every stored
> connection becomes undecryptable and all tenants must reconnect. Put it in
> a password manager, and never share one key between staging and production.

---

## 3. Database (~15 min)

### 3a. 🧍 Create the Postgres instance

In Neon/Supabase, create a project and copy the **connection string**. Use the
*pooled* one if offered — the app is configured for it (`prepare: false`).

Set it locally:

```bash
echo 'DATABASE_URL=postgres://...' >> .env
```

### 3b. 🤖 Apply migrations

```bash
npm run db:migrate
```

Creates all tables and — in migration `0005` — switches on row level
security with fail-closed tenant isolation policies.

### 3c. 🧍 Create the RLS role

RLS does **not** apply to a table's owner, so the app needs a second,
non-owner role for request-path queries. The SQL is written for you:

```bash
psql "$DATABASE_URL" -v pw="'pick-a-strong-password'" \
     -f scripts/sql/create-rls-role.sql
```

*(Neon/Supabase both have a SQL editor in the dashboard if you'd rather paste
the file's contents than install psql.)*

Then add to `.env` — same host and database, different user:

```bash
DATABASE_URL_RLS=postgres://app_rls:pick-a-strong-password@<same-host>/<same-db>
```

### 3d. 🤖 Prove isolation actually works

```bash
npm run doctor
```

Look for these two lines specifically — they are the difference between real
isolation and decorative policies:

```
✓ fail-closed — no tenant context ⇒ 0 rows visible
✓ cross-tenant write blocked — WITH CHECK rejected a foreign tenant_id
```

If instead you see *"N rows visible with NO tenant context"*, your
`DATABASE_URL_RLS` is still an owner role — redo 3c.

---

## 4. Google Cloud (~40 min + ⏳ weeks)

### 4a. 🧍 Project, consent screen, OAuth client

1. Create a GCP project.
2. **APIs & Services → Enable APIs**: enable **Gmail API**, **Google Calendar
   API**, and **Cloud Pub/Sub API**.
3. **OAuth consent screen** → External. Add scopes:
   - `openid`, `email`
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/calendar.readonly`
4. Add every beta user's Google address under **Test users**.
5. **Credentials → Create OAuth client ID → Web application.** Add **both**
   redirect URIs (they are different flows — sign-in vs. data access):

   ```
   https://app.yourcompany.com/api/auth/callback/google
   https://app.yourcompany.com/api/oauth/google
   ```

   Copy the client ID and secret → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

### 4b. 🧍 Pub/Sub for Gmail push

1. **Pub/Sub → Create topic**, e.g. `gmail-push`. Full name goes in
   `GMAIL_PUBSUB_TOPIC` as `projects/<project-id>/topics/gmail-push`.
2. On that topic → **Permissions → Add principal**:
   - Principal: `gmail-api-push@system.gserviceaccount.com`
   - Role: **Pub/Sub Publisher**

   > Skipping this is the single most common setup failure. Without it
   > `users.watch()` fails and every Google connect lands in the
   > `warn=watches` state.
3. **Create subscription** on the topic:
   - Delivery type: **Push**
   - Endpoint: `https://app.yourcompany.com/api/webhooks/google/gmail`
   - **Enable authentication** → create/pick a service account →
     that address goes in `PUBSUB_PUSH_SERVICE_ACCOUNT`
   - **Audience**: paste the same endpoint URL → `PUBSUB_PUSH_AUDIENCE`

   The webhook verifies the token's audience *and* that the caller is exactly
   this service account, so both values must match what you entered.

### 4c. ⏳ Submit for verification — do this on day one

`gmail.readonly` is a **restricted** scope. Until your app is verified:

- **100 test users maximum** (hard cap), and
- **refresh tokens expire after 7 days** — meaning every beta user
  re-authorizes Google weekly or their ingestion silently stops.

Verification requires Google's OAuth review **plus a CASA Tier 2 security
assessment**; it takes weeks to months and costs money. **Submit now, even
though you aren't ready to launch** — it runs in the background.

**Recommended in the meantime:** launch the beta on Claap/Zoom calls only
(no verification, no cap, no expiry) and switch Google on per tenant as
verification clears. If you do that, raise the staleness threshold for
calls-only tenants so the sweep doesn't cry wolf:

```sql
UPDATE tenants SET staleness_days = 30 WHERE id = '<tenant-id>';
```

---

## 5. 🧍 Pipedrive OAuth app (~15 min)

In your Pipedrive developer sandbox, create a **Marketplace app**:

- **Callback URL:** `https://app.yourcompany.com/api/oauth/pipedrive`
- **Scopes:** deals (read+write), persons (read+write), organizations
  (read+write), activities (write), and **deal fields (read)** — the settings
  screen calls `GET /v1/dealFields` to build the mapping table.

Copy → `PIPEDRIVE_CLIENT_ID`, `PIPEDRIVE_CLIENT_SECRET`.

> Without these, no tenant can connect a CRM and nothing is ever written
> anywhere. `npm run doctor` treats them as a hard failure for that reason.

---

## 6. Deploy (~20 min)

### 6a. 🧍 Vercel project + env

Import the repo in Vercel, then add every variable under
**Settings → Environment Variables** (Production *and* Preview):

```
DATABASE_URL                  DATABASE_URL_RLS
ANTHROPIC_API_KEY             AUTH_SECRET
TOKEN_ENCRYPTION_KEY          APP_URL
GOOGLE_CLIENT_ID              GOOGLE_CLIENT_SECRET
GMAIL_PUBSUB_TOPIC            PUBSUB_PUSH_SERVICE_ACCOUNT
PUBSUB_PUSH_AUDIENCE          PIPEDRIVE_CLIENT_ID
PIPEDRIVE_CLIENT_SECRET       INNGEST_EVENT_KEY
INNGEST_SIGNING_KEY
```

`APP_URL` must be the real origin — every redirect URI and per-tenant webhook
URL is built from it.

### 6b. 🧍 Point your domain at the deployment

Add `app.yourcompany.com` in Vercel → Domains and follow its DNS instructions.

### 6c. 🧍 Connect Inngest

In the Inngest dashboard, add your app with URL
`https://app.yourcompany.com/api/inngest`, then hit **Sync**. Inngest's Vercel
integration sets `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` automatically.

### 6d. 🤖 Verify the deployment

```bash
APP_URL=https://app.yourcompany.com npm run doctor -- --prod
```

You want:

```
✓ Inngest endpoint — 13 functions registered (expected 13)
✓ Claap webhook — rejects unsigned POST with 404
✓ Zoom webhook — rejects unsigned POST with 404
✓ Gmail push webhook — rejects unsigned POST with 401
```

Then in the Inngest dashboard confirm three crons are scheduled:
`renew-watches` (every 6h — the ingestion heartbeat), `staleness-dispatch`
(nightly 03:00), `drain-outbox` (every 5 min).

### 6e. 🧍 Fix CI (2 min)

`.github/workflows/nextjs.yml` still needs replacing with the corrected
version (it currently isn't valid YAML for Actions). Paste the file provided
in chat via GitHub's web editor — a fine-grained PAT can't push workflow
files without the `workflow` scope.

---

## 7. 🧍 Cost + safety rails (~10 min)

1. **Anthropic spend alert.** Console → Usage/Limits. Backfill is the spike:
   roughly **$20–60 per user, one time** at the current 14-day window on
   Opus, plus ongoing per-call cost.
2. **Inngest failure notifications → Slack/email.** The single most important
   alert is `renew-watches` failing: a lapsed Google watch stops ingestion
   *silently*.
3. **Leave field mappings empty.** A tenant with no mappings writes
   **notes only** — append-only and safe. Don't pre-configure mappings for
   beta users; let them read a week of notes first, then enable one field.
   This is already the default; the instruction is to *not* change it.

---

## 8. Dogfood on your own tenant (~45 min)

Do the entire customer journey yourself, against a **Pipedrive sandbox**,
before anyone else sees it.

### 8a. 🧍 Sign in and connect

1. Visit `https://app.yourcompany.com`, sign in with Google. This creates
   your tenant and makes you owner.
2. `/settings/sync` → **Connect Pipedrive** → approve.
3. Confirm the field-mapping table lists *your* Pipedrive deal fields.
   **Leave every row on "Don't sync".**

### 8b. 🤖 Prove the pipeline end-to-end without waiting for a real call

Connect Claap on `/settings/sync` (any API key; pick a webhook secret), then:

```bash
npm run seed:call -- \
  --tenant <your-tenant-id> \
  --secret <the-claap-webhook-secret-you-just-saved> \
  --url https://app.yourcompany.com
```

Your tenant ID is the last path segment of the webhook URL shown on the Claap
card. The script fires a correctly signed webhook carrying a sample
transcript with known BANT signals (50k budget, CFO named Marcus, March QBR
deadline, security-review objection, Gong as competitor) and prints the SQL
to follow the row through every stage.

Check the extraction matched what the transcript actually said — this is your
first real read on quality.

### 8c. 🧍 The real thing

Record an actual short call with an external participant in Claap or Zoom,
then confirm: `raw_events` → `interactions` → `extractions` → `sync_outbox`
(completed) → `sync_log` → **a note on the right deal in Pipedrive**.

> ⚠️ The Claap API response mapping in `src/lib/claap/client.ts` has never run
> against a live workspace. If the transcript fetch fails here, that file's
> field paths need adjusting — it's isolated to one file. This is the most
> likely thing to break on first contact.

### 8d. 🧍 Exercise the human loop

- Find a low-confidence extraction in `/review`; check the evidence quotes are
  verbatim; approve it and watch the field write flow through.
- Hit **↻ Replay** on any item — a *new* extraction version should appear,
  with the old one retained.
- Now map **one** field (Timeline or Need), run another call, confirm it lands
  in the right Pipedrive custom field with a `sync_log` row proving it.
- Generate a team invite, accept it from a second Google account, confirm it
  joins your tenant and the link can't be reused.

---

## 9. 🧍 Onboard beta customer #1

- Onboard **one** customer, **live on a call** — not by emailing a link.
- Leave their field mappings empty for the first week. Notes only.
- After a week, review the notes together. If they trust them, enable one
  field. Expand from there.
- Check their `/review` queue with them: large means the 0.8 confidence floor
  needs tuning for their call style; empty *and* inaccurate means it's too low.
- Only then onboard customers #2–5.

---

## Daily driver commands

| Command | What it does |
|---|---|
| `npm run doctor` | Full preflight: env, DB, migrations, RLS enforcement, watches, outbox |
| `npm run doctor -- --prod` | Stricter — requires https and a real RLS role |
| `npm run seed:call -- --tenant … --secret …` | Fire a synthetic signed call through the whole pipeline |
| `npm run gen:secrets` | Generate `AUTH_SECRET` + `TOKEN_ENCRYPTION_KEY` |
| `npm test` | 31 tests over the logic that decides what reaches a CRM |
| `npm run lint` / `npm run typecheck` | Static checks |
| `npm run db:migrate` | Apply migrations |
| `npm run dev` + `npm run inngest:dev` | Local app + local Inngest |

## When something breaks

| Symptom | Almost always |
|---|---|
| Gmail ingestion stopped silently | Watch expired — `renew-watches` failing or not scheduled (6d, 7.2) |
| Google connect shows `warn=watches` | Pub/Sub publisher permission missing (4b step 2) |
| Dashboard pages are empty | Query not wrapped in `withTenant()`, or `DATABASE_URL_RLS` misconfigured — run `npm run doctor` |
| Notes appear, fields never update | Working as designed: no field mappings, or confidence below the floor |
| Claap transcript fetch fails | `src/lib/claap/client.ts` field paths vs. your workspace's API version (8c) |
