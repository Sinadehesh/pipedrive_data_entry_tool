# Costly v2 — Architecture (ACTIVE)

> Supersedes the v1 local-first Android plan (docs 01–05, kept as the
> parking lot). v2 is a mobile-first **web app** with real money moving
> through Stripe, plus an Android companion service for detection.

## Stack

- **Frontend**: Next.js (App Router), React, Tailwind CSS
- **Backend/DB**: Next.js API routes, Prisma ORM, PostgreSQL
- **Payments**: Stripe — pre-authorization holds & captures
- **Device**: Android AccessibilityService (scroll detection),
  Health Connect / HealthKit (verified walking minutes)
- **Scheduling**: Vercel Cron (or any plain cron) hitting
  `/api/jobs/expire-holds` — no automation platform

## Mechanics

1. **Income-indexed rate** — monthly income → hourly wage → per-minute
   penalty rate, so the loss stings equally regardless of wealth.
2. **Product anchor ("the hostage")** — losses displayed as % of a real
   item the user is saving for, not raw euros.
3. **Vice meter + idle detection** — AccessibilityService watches
   `TYPE_VIEW_SCROLLED`; 60s without a scroll pauses the timer (no
   charging sleepers). Hard cap per session (default €30) terminates
   the session — no catastrophic chargebacks.
4. **20/80 split** — session ends → 20% permanently captured ("the
   burn"), 80% held in purgatory for 24h.
5. **Sweat equity, 2:1** — every scroll-minute owes 2 verified walking
   minutes. Goal met in 24h → hold released. Deadline missed → hold
   captured.

## Stripe design decisions (engineering, not negotiable wishes)

- **Two PaymentIntents per session, not one.** Stripe cannot partially
  capture a PaymentIntent and keep the remainder on hold — a partial
  capture auto-releases the rest. So: burn PI (20%, automatic capture)
  + purgatory PI (80%, `capture_method: manual`). Redemption success →
  `paymentIntents.cancel`; expiry → `paymentIntents.capture`.
- **Off-session charges require a saved card**: SetupIntent with
  `usage: "off_session"` at onboarding; the meter refuses to arm
  without a saved payment method. SCA (3DS) can still decline
  off-session confirms → sessions need a "settle up" fallback state.
- **Auth holds live ~7 days** on most cards, so the 24h window is safe.
- **Integer cents everywhere.** No float euros anywhere in the system.
- **Webhook reconciliation** is the source of truth backstop, with an
  idempotency ledger (`WebhookEvent`) so retried deliveries never
  double-capture.

## Known platform risks (tracked, not blocking)

- **Google Fit REST API is deprecated** (sunset announced; Health
  Connect is the Android path). Health Connect is on-device only —
  nothing server-side can poll it — so the companion app must push
  walking minutes to `/api/redemptions/:id/sync`. HealthKit likewise
  has no server API; iOS needs on-device sync when it lands.
- **AccessibilityService for non-accessibility purposes** is restricted
  by Play Store policy; distribution may need to be sideload/APK first,
  Play review argued later (or a UsageStats fallback with coarser idle
  detection).

## Data model

See `web/prisma/schema.prisma` — User, Session (ACTIVE → HOLD →
RELEASED | CAPTURED), RedemptionTask (PENDING → SUCCESS | FAILED),
WebhookEvent.

## API surface

See `web/README.md` for the full route table and the session lifecycle
sequence.

## UI surfaces (to scaffold next)

1. **Onboarding flow** — income input → rate reveal → anchor selection
   → card save (SetupIntent).
2. **Live meter** — ticking elapsed time, euro amount, anchor-% burned.
3. **Purgatory dashboard** — active holds, 24h countdown, walking
   progress bar (completed vs required minutes).
