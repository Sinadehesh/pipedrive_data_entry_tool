# COSTLY

**A high-stakes habit-reversal app that makes doomscrolling expensive —
then makes you walk it off.**

Costly charges you real money per minute of doomscrolling (Instagram,
TikTok, …) at a rate indexed to your income, frames every loss as a
percentage of a product you're actually saving for ("You have burned 2%
of your AirPods"), and lets you earn 80% of it back through verified
physical exercise: 2 minutes of walking for every minute scrolled,
within 24 hours.

## Architecture (v2 — ACTIVE)

Mobile-first **Next.js web app** + Android companion service.

- Next.js (App Router) + Tailwind · Prisma + PostgreSQL · Stripe
  pre-auth holds & captures · Android AccessibilityService for scroll
  detection · Health Connect/HealthKit for walking verification ·
  Vercel Cron (or any plain cron) for the expiry sweep.
- **20/80 split**: session ends → 20% captured permanently, 80% held in
  purgatory for 24h; released on walking-goal success, captured on
  expiry. Two PaymentIntents per session (Stripe can't partial-capture
  and keep the rest held).
- Full architecture: `docs/06-architecture-v2.md`.

## Repo map

- `web/` — the app: `prisma/schema.prisma`, API routes
  (`web/README.md` has the route table + session lifecycle diagram).
- `docs/` — `06-architecture-v2.md` is current; docs 01–05 are the v1
  local-first Android plan, kept as the parking lot (villain voice &
  ethics specs there still inform v2 copy).
- `mobile-native/` — parked v1 Expo scaffold; will be reworked into the
  Android companion service (AccessibilityService + heartbeat client).
- `CLAUDE.md` — v1 master prompt (superseded where it conflicts with
  `docs/06-architecture-v2.md`).

## Status

| Piece | State |
| --- | --- |
| Prisma schema (User / Session / RedemptionTask / WebhookEvent) | ✅ |
| API routes: onboarding, setup-intent, session lifecycle, redemption sync, expiry job, webhook | ✅ scaffolded |
| UI: onboarding flow, live meter, purgatory dashboard | ⬜ next |
| Android companion service (AccessibilityService) | ⬜ |
| Expiry sweep schedule (`web/vercel.json` cron) | ✅ |
| Companion app → health-minutes push wiring | ⬜ |
