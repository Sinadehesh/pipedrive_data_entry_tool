# CRM Intelligence Tool — System Architecture

**Status:** Proposed (v1)
**Stack:** Next.js (App Router) · Inngest · Postgres (Drizzle) · Vercel AI SDK · Pipedrive API v2 · Google Workspace APIs

---

## 1. The Problem, Restated as an Engineering Contract

Sales reps will never update Pipedrive. Therefore the system must guarantee:

1. **Completeness** — every touchpoint (call, email, meeting) becomes CRM data.
2. **Freshness** — data lands in Pipedrive within minutes of the interaction.
3. **Zero rep effort** — no browser extension to click, no bot to invite, no form to fill.
4. **Trustworthiness** — an LLM writing to your CRM autonomously must never silently corrupt it.

Requirement 4 is the one the baseline architecture under-weights, and it drives the biggest design change below.

---

## 2. Architecture Review: Baseline vs. Amendments

The baseline (Next.js webhook ingestion → Inngest background jobs → LLM extraction → Pipedrive + Postgres → dashboard) is **directionally correct and is retained as the skeleton**. Four amendments, in order of importance:

### Amendment A — The Interaction Ledger: Postgres is the source of truth; Pipedrive is a projection

The baseline treats Pipedrive as the destination and Postgres as a side-channel for competitive intel. That coupling is fragile: if an LLM extraction is wrong, or a Pipedrive write partially fails, or Pipedrive rate-limits you mid-batch, you have no record of intended state and no way to replay.

Instead, model the pipeline as event sourcing:

```
raw event  →  interactions ledger (immutable, Postgres)
           →  extractions (versioned LLM output, linked to interaction)
           →  sync outbox (desired Pipedrive state)
           →  reconciler (idempotent writer, rate-limit aware)
           →  Pipedrive
```

Every inbound artifact (email, calendar event, transcript) is persisted as an immutable **interaction** row *before* any LLM touches it. Extractions are versioned rows referencing the interaction. Pipedrive writes go through an **outbox + reconciler** loop rather than fire-and-forget calls.

What this buys you:

- **Replay** — re-run extraction with a better prompt/model over the entire history without re-ingesting anything.
- **Idempotency** — the reconciler keys every Pipedrive mutation on the ledger event ID; webhook redeliveries and job retries can't create duplicate notes or activities.
- **Confidence gating** — low-confidence extractions divert to a human review queue instead of writing garbage into deal fields (see §6.4).
- **Never clobber humans** — the reconciler compares against last-synced state and refuses to overwrite a field a human edited in Pipedrive.

### Amendment B — Google ingestion is *pull-on-notify*, not webhooks

The baseline says "OAuth webhooks from Google Workspace." That primitive does not exist, and designing as if it does is the most common failure mode in Gmail/Calendar integrations:

- **Gmail** push notifications go through **Google Cloud Pub/Sub**. The notification payload contains only `{emailAddress, historyId}` — *no message content*. You must call `users.history.list(startHistoryId=lastSeen)` to fetch the delta, then `messages.get` for each new message.
- **Calendar** push channels similarly deliver an empty ping; you fetch deltas with `events.list(syncToken=...)`.
- **Both watches expire** — Gmail after 7 days, Calendar channels per their TTL — and expiry is silent. Without active renewal, ingestion just stops and nobody notices.

So the ingestion layer needs three sub-systems the baseline lacks: **watch lifecycle management** (cron renewal), **delta cursors** (`historyId` / `syncToken` per connection, persisted), and **resync handling** (Gmail returns 404 for stale historyIds; Calendar returns 410 GONE for stale sync tokens → drop cursor, full resync). Full detail in §7.

### Amendment C — Dumb edge, durable core

Webhook route handlers do exactly three things: verify the signature, persist the raw payload, emit an Inngest event. They return 200 in under a second. **No fetching, no parsing, no LLM, no Pipedrive calls in a route handler — ever.** All real work happens in durable Inngest functions where every step is checkpointed, retried, and observable. This is what makes the 20–60s+ LLM problem a non-problem (§5).

### Amendment D — Rate-limit-aware Pipedrive client as a shared budget

Pipedrive's API uses **token-budget rate limiting** (a daily token pool per company, plus burst limits). Naive parallel jobs will exhaust the budget in bursts and starve the rest of the day. The reconciler therefore runs behind Inngest **throttle + concurrency controls** (single shared key for the Pipedrive account), uses **API v2 endpoints** (cheaper token cost), and batches reads through a local **identity map cache** so deduplication doesn't cost a search call per event (§6.3).

### Explicitly rejected "clever" alternatives

| Idea | Verdict | Why |
|---|---|---|
| React Chrome extension scraping Gmail/Pipedrive in-browser | ❌ Reject | Requires per-rep install and a running browser — violates "zero rep effort" and "100% capture." Misses everything that happens while the browser is closed. DOM scraping breaks on every Gmail UI change. Server-side OAuth capture is strictly more reliable *and* avoids rate limits better (delta APIs are cheap). |
| Vercel AI SDK streaming to bypass timeouts | ❌ Reject | Streaming keeps a response alive **for a waiting client**. Webhooks have no waiting client — Claap/Google want a fast 200 and hang up. Streaming gives you no durability, retries, or replay. It's the right tool for the dashboard's interactive AI features, not the pipeline. |
| Skip the job framework, rely on Vercel Fluid compute's long `maxDuration` | ❌ Reject as sole strategy | Longer timeouts don't give you retries, checkpoints, back-pressure, fan-out, or a dead-letter queue. A transient Anthropic 529 at second 55 would lose the whole job. We *do* raise `maxDuration` as headroom, but durability comes from Inngest steps (§5). |
| Trigger.dev instead of Inngest | ⚖️ Either works | Inngest is chosen for first-class **event fan-out** (one Gmail ping → N message jobs), declarative **throttle/concurrency keys** (exactly what the Pipedrive budget needs), and cron in the same primitive. Trigger.dev is a fine substitute; nothing below is Inngest-proprietary in shape. |

---

## 3. System Overview

```
                       ┌────────────────────────────────────────────────┐
                       │                 NEXT.JS APP (Vercel)           │
                       │                                                │
  Claap/Zoom ──POST──▶ │ /api/webhooks/claap        (verify+enqueue)    │
  Google Pub/Sub ─────▶│ /api/webhooks/google/gmail (verify+enqueue)    │
  Calendar channel ───▶│ /api/webhooks/google/calendar                  │
  Pipedrive ──────────▶│ /api/webhooks/pipedrive    (human-edit events) │
                       │ /api/inngest               (job executor)      │
                       │ /(dashboard)               (React UI)          │
                       └───────────────┬────────────────────────────────┘
                                       │ events
                                       ▼
                       ┌────────────────────────────────────────────────┐
                       │                  INNGEST (durable jobs)        │
                       │  ingest/*   fetch deltas, transcripts          │
                       │  extract/*  LLM structured extraction          │
                       │  sync/*     identity resolution, reconciler    │
                       │  cron/*     watch renewal, reconcile, staleness│
                       └───────┬───────────────────────────┬────────────┘
                               ▼                           ▼
                     ┌──────────────────┐        ┌──────────────────────┐
                     │  POSTGRES        │        │  PIPEDRIVE           │
                     │  interactions    │        │  persons / orgs      │
                     │  extractions     │  sync  │  deals / activities  │
                     │  identity_map    │ ─────▶ │  notes / custom      │
                     │  sync_outbox     │ ◀───── │  fields (BANT)       │
                     │  competitive_intel        │  (webhooks back for  │
                     │  review_queue    │        │   human edits)       │
                     └──────────────────┘        └──────────────────────┘
```

Data routing rule of thumb:

- **Pipedrive gets CRM facts**: persons, orgs, deals, activities (calls/meetings/emails as activity records), notes (summaries), and custom fields for BANT + last-touch metadata. This is what reps and managers see in their existing workflow.
- **Postgres keeps everything else**: raw interactions, full extraction payloads, competitive intelligence, objection taxonomy, confidence scores, sync audit log. This feeds the analytics dashboard and enables replay.

---

## 4. Folder Structure

Single Next.js App Router project (no monorepo needed at this scale):

```
crm-intelligence/
├── src/
│   ├── app/
│   │   ├── (dashboard)/                      # Route group: authed UI
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx                      # Pipeline health overview
│   │   │   ├── deals/
│   │   │   │   ├── page.tsx                  # Deal intel list
│   │   │   │   └── [dealId]/page.tsx         # Timeline + BANT + objections
│   │   │   ├── intel/page.tsx                # Competitive intelligence
│   │   │   ├── review/page.tsx               # Human review queue (low-confidence)
│   │   │   └── settings/
│   │   │       ├── connections/page.tsx      # Google / Claap / Pipedrive OAuth status
│   │   │       └── sync/page.tsx             # Sync log, replay controls
│   │   ├── api/
│   │   │   ├── auth/[...nextauth]/route.ts   # Auth.js (Google OAuth, offline access)
│   │   │   ├── inngest/route.ts              # serve() — all Inngest functions
│   │   │   └── webhooks/
│   │   │       ├── claap/route.ts            # verify sig → persist raw → enqueue
│   │   │       ├── google/
│   │   │       │   ├── gmail/route.ts        # Pub/Sub push endpoint
│   │   │       │   └── calendar/route.ts     # Calendar channel endpoint
│   │   │       └── pipedrive/route.ts        # human-edit events → mark fields protected
│   │   ├── layout.tsx
│   │   └── globals.css
│   │
│   ├── inngest/
│   │   ├── client.ts                         # Inngest client + typed event schemas
│   │   ├── events.ts                         # zod schemas for every event payload
│   │   └── functions/
│   │       ├── ingest/
│   │       │   ├── gmail-history.ts          # notify → history.list → fan out messages
│   │       │   ├── calendar-delta.ts         # notify → events.list(syncToken)
│   │       │   ├── fetch-transcript.ts       # Claap/Zoom recording → transcript → ledger
│   │       │   └── backfill.ts               # initial import on new connection
│   │       ├── extract/
│   │       │   ├── extract-call.ts           # transcript → chunked map/reduce → BANT etc.
│   │       │   ├── extract-email-thread.ts   # thread-level, debounced
│   │       │   └── extract-meeting.ts        # calendar event enrichment
│   │       ├── sync/
│   │       │   ├── resolve-identity.ts       # email → person/org/deal (cache-first)
│   │       │   ├── reconcile-pipedrive.ts    # outbox drain; throttled, idempotent
│   │       │   └── route-intel.ts            # competitive intel → Postgres tables
│   │       └── cron/
│   │           ├── renew-watches.ts          # every 6h: re-arm Gmail/Calendar watches
│   │           ├── reconcile-sweep.ts        # hourly: catch missed notifications
│   │           ├── staleness-sweep.ts        # nightly: flag deals gone quiet
│   │           └── drain-outbox.ts           # every 5m: retry deferred Pipedrive writes
│   │
│   ├── lib/
│   │   ├── db/
│   │   │   ├── schema.ts                     # Drizzle schema (tables in §6.1)
│   │   │   ├── client.ts
│   │   │   └── queries/                      # typed query modules per domain
│   │   ├── pipedrive/
│   │   │   ├── client.ts                     # v2 API, token-budget aware, retries
│   │   │   ├── persons.ts / orgs.ts / deals.ts / activities.ts / notes.ts
│   │   │   ├── fields.ts                     # custom field key mapping (BANT fields)
│   │   │   └── write-policy.ts               # clobber protection rules
│   │   ├── google/
│   │   │   ├── auth.ts                       # token refresh, encrypted storage
│   │   │   ├── gmail.ts                      # history.list, messages.get, MIME parse
│   │   │   ├── calendar.ts                   # events.list w/ syncToken
│   │   │   └── watches.ts                    # watch/channel lifecycle
│   │   ├── claap/client.ts
│   │   ├── ai/
│   │   │   ├── schemas.ts                    # zod: BANT, objections, competitors...
│   │   │   ├── extractor.ts                  # generateObject wrappers
│   │   │   ├── chunking.ts                   # transcript segmentation
│   │   │   └── prompts/
│   │   │       ├── call-extraction.ts
│   │   │       ├── email-extraction.ts
│   │   │       └── reduce-merge.ts
│   │   ├── identity/resolve.ts               # cross-source identity resolution
│   │   ├── crypto.ts                         # AES-GCM for OAuth tokens at rest
│   │   └── env.ts                            # zod-validated env vars
│   │
│   ├── components/                           # dashboard UI (timeline, BANT cards,
│   │   └── ...                               #   review-queue diff view, sync log)
│   └── middleware.ts                         # auth guard for (dashboard)
│
├── drizzle/                                  # migrations
├── drizzle.config.ts
├── ARCHITECTURE.md
├── next.config.ts
└── package.json
```

---

## 5. Timeout Strategy — Long-Running LLM Work Without Dropped Requests

The core principle: **no HTTP request ever waits on an LLM.** Latency-sensitive surfaces (webhooks) and long-running work (extraction) are fully decoupled.

### 5.1 The edge: sub-second webhook handlers

Every webhook route does only:

```ts
// /api/webhooks/claap/route.ts — the entire pattern
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifySignature(raw, req.headers)) return new Response(null, { status: 401 });

  const event = parse(raw);
  await db.insert(rawEvents).values({ source: "claap", externalId: event.id, payload: event });
  await inngest.send({ name: "claap/recording.completed", data: { recordingId: event.id } });

  return new Response(null, { status: 200 }); // < 1s, always
}
```

Raw payload persistence *before* enqueueing means even a total job-layer outage loses nothing — events are re-emittable from the `raw_events` table. Google Pub/Sub, Claap, and Zoom all retry on non-2xx, giving a second safety net.

### 5.2 The core: Inngest steps as checkpoints

An Inngest function is re-invoked as a fresh serverless call after each `step.run()` completes; finished steps are memoized and skipped. So a 3-minute logical job is executed as a series of short invocations, none of which individually approaches the platform timeout:

```ts
export const extractCall = inngest.createFunction(
  { id: "extract-call", retries: 3, concurrency: { limit: 5 } },
  { event: "claap/recording.completed" },
  async ({ event, step }) => {
    const transcript = await step.run("fetch-transcript", () =>
      claap.getTranscript(event.data.recordingId));            // ~2s

    const interaction = await step.run("write-ledger", () =>
      ledger.recordCall(transcript));                          // ~100ms, idempotent

    const chunks = chunkTranscript(transcript);                // deterministic, in-band

    // Map: each chunk is its own checkpointed step → its own invocation,
    // its own retry budget. A 90-min call becomes ~6 × 25s LLM calls.
    const partials = await Promise.all(chunks.map((c, i) =>
      step.run(`extract-chunk-${i}`, () => extractChunk(c))));

    const merged = await step.run("reduce-merge", () =>
      mergeExtractions(partials));                             // 1 LLM call, ~20s

    await step.run("persist-extraction", () =>
      extractions.save(interaction.id, merged));

    await step.sendEvent("enqueue-sync", {
      name: "sync/extraction.ready",
      data: { extractionId: merged.id },
    });
  }
);
```

Failure semantics, layer by layer:

| Failure | What happens |
|---|---|
| Anthropic 429/529 mid-extraction | Only that step retries (exponential backoff). Completed chunks are memoized — no recomputation, no double-billing. |
| Vercel invocation killed | Inngest re-invokes; memoized steps skip; execution resumes at the incomplete step. |
| All retries exhausted | `onFailure` handler writes to `review_queue` + alerts. The interaction stays in the ledger — replayable after the bug is fixed. Nothing is lost. |
| Webhook delivered twice | Ledger insert is keyed on `(source, external_id)` — second delivery is a no-op. |

### 5.3 Sizing rules

- `maxDuration = 300` on `/api/inngest` (Vercel Fluid compute) — generous headroom, but **no single step is designed to need more than ~60s**. If a step might, split it.
- Transcript chunking targets ~8–10k tokens per chunk so each map step's LLM call stays well under a minute.
- Vercel AI SDK `generateObject` with a Zod schema (non-streaming) for all pipeline extraction — schema-validated structured output, retried on parse failure. Streaming is reserved for interactive dashboard features where a human is watching.

### 5.4 Back-pressure

- `concurrency: { limit }` per extraction function caps parallel LLM spend.
- The Pipedrive reconciler runs with `concurrency: { key: "pipedrive", limit: 1 }` + `throttle` matched to the account's token budget — bursty mornings (10 calls end at 10:30) queue gracefully instead of tripping rate limits.
- If Pipedrive returns 429, the reconciler re-schedules the outbox item with `step.sleepUntil` — deferred, not dropped.

---

## 6. Data Model & Sync Semantics

### 6.1 Core tables (Postgres, Drizzle)

| Table | Purpose |
|---|---|
| `connections` | OAuth grants per rep (Google) + org-level (Claap, Pipedrive). Encrypted refresh tokens, scopes, status. |
| `watch_channels` | Active Gmail watches / Calendar channels: resource id, expiry, last cursor (`historyId` / `syncToken`). |
| `raw_events` | Every inbound webhook payload, verbatim. Replay source of last resort. |
| `interactions` | **The ledger.** One row per email / meeting / call. `(source, external_id)` unique. Immutable. |
| `extractions` | Versioned LLM output per interaction: BANT, objections, competitors, sentiment, next steps — each field with confidence + evidence quote. |
| `identity_map` | email ↔ `pipedrive_person_id` ↔ `org_id` ↔ active `deal_id`. Cache + resolution decisions log. |
| `sync_outbox` | Desired Pipedrive mutations: op, payload, idempotency key, status, attempt count. |
| `field_protection` | Fields a human edited in Pipedrive (learned via Pipedrive webhooks) → reconciler won't overwrite. |
| `competitive_intel` | Normalized competitor mentions, positioning, win/loss signals. Dashboard fuel. |
| `review_queue` | Low-confidence extractions + hard failures awaiting human approve/edit/discard. |
| `sync_log` | Append-only audit of every Pipedrive write: what, why, from which extraction. |

### 6.2 Extraction schema (the contract with the LLM)

```ts
const ExtractionSchema = z.object({
  summary: z.string(),
  bant: z.object({
    budget:    Signal, // { value, confidence: 0-1, evidence: verbatim quote }
    authority: Signal,
    need:      Signal,
    timeline:  Signal.extend({ shifted: z.boolean(), previousTimeline: z.string().nullable() }),
  }),
  objections: z.array(z.object({
    category: z.enum(["price","timing","competitor","integration","security","other"]),
    quote: z.string(), resolved: z.boolean(),
  })),
  competitors: z.array(z.object({
    name: z.string(), context: z.string(),
    sentiment: z.enum(["favored","neutral","losing"]),
  })),
  nextSteps: z.array(z.object({ owner: z.string(), action: z.string(), due: z.string().nullable() })),
  dealSignals: z.object({
    stageChangeSuggested: z.string().nullable(),
    riskFlags: z.array(z.string()),
  }),
});
```

Every signal carries **confidence and a verbatim evidence quote**. Evidence quotes are what make the review queue fast for humans and make hallucinated field updates detectable.

### 6.3 Identity resolution & deduplication

Join key across all three sources is the **email address** (call participants from Claap metadata, email correspondents, calendar attendees).

1. Normalize (lowercase, strip plus-addressing) → look up `identity_map` (cache hit ≈ free).
2. Miss → Pipedrive `persons/search` by email (v2). Found → cache it.
3. Still miss → derive org from domain (`acme.com` → search/create org) → create person → cache. Free-mail domains skip org derivation.
4. Deal attachment: person's open deals; if several, most recently active; if none, create per configurable policy (or queue for review — org-level setting).

All person/org creation flows through the outbox with idempotency keys, so two concurrent jobs discovering the same new contact produce one Pipedrive person, not two.

### 6.4 Write policy — the guardrails

- **Notes and activities are append-only** → always safe, written for every interaction (this alone delivers "100% data entry" visibly inside Pipedrive).
- **Custom field updates (BANT, timeline, last-touch)** require `confidence ≥ 0.8`; below → `review_queue`.
- **Never clobber humans:** Pipedrive webhooks (`*.updated` by a real user) mark fields in `field_protection`; the reconciler skips protected fields and logs the skip.
- Every write lands in `sync_log` with a link back to the evidence quote — full "why does this field say that?" traceability.

---

## 7. Holistic Freshness Strategy — Emails, Calendar, and Calls

Three planes: **push** (seconds-fresh), **reconciliation** (self-healing), **backfill** (day-one completeness).

### 7.1 Push plane

**Calls (Claap/Zoom):** native webhook on `recording.completed` / transcript-ready → `fetch-transcript` job → ledger → extraction. Simplest source; minutes-fresh.

**Gmail — the pull-on-notify loop:**

1. On OAuth connect: `users.watch({ topicName })` registers the mailbox against a GCP Pub/Sub topic; store returned `historyId` as the cursor.
2. New mail → Pub/Sub pushes `{emailAddress, historyId}` to `/api/webhooks/google/gmail`. Route verifies the Pub/Sub OIDC token, enqueues, 200s immediately (Pub/Sub redelivers on slow/failed acks — another reason the handler must be dumb).
3. `gmail-history` job: `history.list(startHistoryId = storedCursor)` → new message IDs → `messages.get` each → **filter**: skip internal-only threads, newsletters/bulk (List-Unsubscribe header), non-CRM traffic; keep messages whose correspondents resolve via the identity map or belong to prospect domains → append to ledger → advance cursor (atomically, only after ledger write).
4. **Thread debouncing:** email extraction runs per-thread with a short `step.sleep` debounce, so a 5-reply back-and-forth is analyzed once with full context, not five times.
5. `history.list` returning **404** (cursor older than Gmail's ~1-week retention) → drop cursor, run bounded resync (last N days), re-watch.

**Calendar:** `events.watch` per connected calendar → empty-ping notification → `events.list(syncToken)` for the delta → external-attendee events into the ledger (created/updated/cancelled all matter — a cancelled demo is a deal signal). **410 GONE** → drop token, full re-list, new token.

**Pipedrive → us:** Pipedrive webhooks on person/deal/field updates feed `field_protection` (human-edit detection) and keep `identity_map` warm.

### 7.2 Reconciliation plane (assume push fails silently, because it will)

- **`renew-watches` (every 6h):** re-arm every Gmail watch expiring within 24h (hard 7-day expiry) and every Calendar channel nearing TTL. Renewal failures alert — this is the pipeline's heartbeat.
- **`reconcile-sweep` (hourly):** any connection with no notification in N hours gets a proactive delta pull using its stored cursor. Cursor-based pulls are cheap and idempotent (ledger dedupe), so sweeping aggressively costs almost nothing — this is the true 100%-capture guarantee; push is just the latency optimization.
- **`drain-outbox` (every 5m):** retries deferred/rate-limited Pipedrive writes.
- **`staleness-sweep` (nightly):** flags open deals with no interaction in X days → dashboard risk list + optional Pipedrive activity ("No touchpoint in 14 days"). Freshness isn't only *capturing* activity — it's *surfacing its absence*.

### 7.3 Backfill plane

New connection → `backfill` job imports a bounded window (e.g., 90 days of email threads with known prospect domains, 90 days of external meetings, available call library) through the identical ledger → extract → sync path. One pipeline, three entry tempos: real-time, hourly, once.

---

## 8. Security & Compliance Notes

- OAuth refresh tokens encrypted at rest (AES-256-GCM, key in env/KMS); never logged.
- Gmail scope: `gmail.readonly` — we never send or modify mail. Calendar: `calendar.readonly`.
- Google Pub/Sub push verified via OIDC token audience check; Claap/Zoom via HMAC signature; Pipedrive via webhook basic auth.
- Raw email bodies retained in `interactions` with a configurable retention window; extractions (derived data) retained indefinitely.
- LLM calls carry no PII beyond the interaction content itself; use a provider with zero-retention API terms (Anthropic API qualifies).

---

## 9. Delivery Phasing

1. **Phase 1 — Calls end-to-end:** Claap webhook → ledger → extraction → Pipedrive notes/activities + BANT fields. Proves the durable pipeline with the simplest source. Immediate visible value in Pipedrive.
2. **Phase 2 — Gmail:** watch lifecycle, history sync, thread debouncing, identity resolution at scale. The hardest source; the reconciliation plane matures here.
3. **Phase 3 — Calendar + staleness:** cheap once Gmail's watch/cursor machinery exists.
4. **Phase 4 — Dashboard depth:** competitive intel views, review queue UX, replay controls.
