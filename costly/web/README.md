# Costly — web app

Next.js (App Router) + Prisma + PostgreSQL + Stripe.

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL + Stripe keys
npx prisma migrate dev
npm run dev
```

The expiry sweep is scheduled in `vercel.json` (every 10 min). On Vercel's
Hobby plan crons are limited to once daily — if that's too coarse, point any
plain scheduler (system cron, GitHub Actions schedule) at
`GET /api/jobs/expire-holds` with `Authorization: Bearer $CRON_SECRET`.

## API routes

```
src/app/api/
├── onboarding/route.ts                    POST  create user, derive income-indexed
│                                                rate, create Stripe customer
├── stripe/
│   ├── setup-intent/route.ts              POST  SetupIntent (usage: off_session)
│   │                                            → frontend saves the card
│   └── webhook/route.ts                   POST  Stripe events: saves payment
│                                                method, reconciles session state,
│                                                idempotent via WebhookEvent
├── sessions/
│   ├── start/route.ts                     POST  device: blocked app foregrounded;
│   │                                            refuses to arm w/o saved card
│   └── [sessionId]/
│       ├── heartbeat/route.ts             POST  device: billable-seconds delta
│       │                                        (idle-filtered); replies running
│       │                                        total + capReached
│       └── end/route.ts                   POST  THE financial moment: burn PI
│                                                (20%, captured) + purgatory PI
│                                                (80%, manual-capture hold) +
│                                                RedemptionTask (2:1, 24h)
├── redemptions/
│   └── [taskId]/sync/route.ts             POST  walking minutes (cumulative);
│                                                goal met in time → cancel hold
│                                                → RELEASED
└── jobs/
    └── expire-holds/route.ts              GET   scheduled sweep (Vercel Cron /
                                                 any cron): past-deadline
                                                 PENDING → capture hold →
                                                 CAPTURED/FAILED
```

## Session lifecycle

```
device: vice app opened
  → POST /api/sessions/start                          Session ACTIVE
  → POST /api/sessions/:id/heartbeat (every ~30s)     accumulate billable time
      idle ≥60s? device sends delta=0 (timer paused)
      capReached? device force-closes the app
  → POST /api/sessions/:id/end                        Session HOLD
      burn PI      20%  capture_method: automatic  → charged now
      purgatory PI 80%  capture_method: manual     → pre-auth hold
      RedemptionTask: required = 2 × scroll minutes, deadline = +24h

then, one of two endings:
  walk completed in time
  → POST /api/redemptions/:taskId/sync                goal met
      stripe.paymentIntents.cancel(purgatory)         Session RELEASED ✓
  deadline passes
  → cron → GET /api/jobs/expire-holds
      stripe.paymentIntents.capture(purgatory)        Session CAPTURED ✗
```

Why two PaymentIntents: Stripe cannot capture 20% of a hold and keep the
other 80% authorized — partial capture releases the remainder. Splitting
into a burn intent and a purgatory intent is the only clean way to get
"20% gone now, 80% redeemable" semantics.

## Money

Integer cents everywhere (`monthlyIncomeCents`, `penaltyRateCentsPerMin`,
…). Pure math lives in `src/lib/penalty.ts` — no IO, unit-test it hard.
