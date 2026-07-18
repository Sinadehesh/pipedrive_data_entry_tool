# COSTLY — Master Prompt

> ⚠️ **ARCHITECTURE PIVOT (v2):** the active build is now a Next.js web
> app + Android companion service with real Stripe holds and walking
> redemption — see `docs/06-architecture-v2.md` and `web/README.md`.
> Where this file conflicts with the v2 doc, v2 wins. The villain
> voice, design tokens, and ethics rules below still apply.

PROJECT: COSTLY — an Android app that makes doomscrolling expensive.
The user picks apps they want to quit, sets a per-minute rate anchored
to their income, and names 3 real products they want to buy (<€100,
<€500, <€1000). While they use a vice app, a live meter burns money —
displayed as % of their chosen product, not euros. Burns accumulate in
a Debt Ledger settled weekly. A sarcastic villain persona narrates
everything: it profits when you scroll, and it can LOSE when you don't.

## STACK — never violate

- React Native + TypeScript, Expo prebuild (dev build, NOT Expo Go).
- Native requirements: Usage Access (UsageStatsManager polling via
  foreground service, 5s interval), SYSTEM_ALERT_WINDOW overlay bubble,
  local notifications. Android only. minSdk 26.
- Local-first: SQLite. No backend, no auth, no payment SDK in MVP.
- 3 tabs max: Burn (home) / Ledger / You. Plus overlay + modals.

## PRODUCT RULES — these are law

- Meter displays PRODUCT-PERCENT primarily, euros secondary.
- Sessions are windowed: default 15 min, then HARD LOCK overlay;
  continuing requires tapping through a mocking confirm
  ("Reopen Instagram: another 4% of your PlayStation. Confirm?").
- Weekly hard cap (user-set at onboarding): when reached, vice apps
  lock outright for the rest of the week. Cap converts money-bleed
  into lockout. Never bill past cap.
- Rate changes: raising = instant. Lowering = 24h cooldown + user must
  type a reason, which the villain mocks on the confirm screen.
- Burned product-percent NEVER resets by itself. It persists until the
  week settles. No forgiveness animations.
- Self-exclusion: settings contains "I need this to stop" → wipes
  stakes, converts app to a plain free blocker, no dark-pattern exit
  friction on THIS path specifically.
- The villain can lose: a zero-burn day and an under-cap week trigger
  loud, grudging defeat states. Winning must feel as designed as losing.

## VOICE

Sarcastic, theatrical, money-hungry, secretly rooting for you.
Thanks the user sincerely for failures ("Thank you for 31% of a
PlayStation. We're touched."). Never guilt-trips about self-worth —
mocks the BEHAVIOR and celebrates the spite. Never mocks on the
self-exclusion path; there it drops the act completely and is kind.

## DESIGN TOKENS

bg #0B0D0A · surface #151812 · accent MONEY-GREEN #2EDB6A ·
burn RED-ORANGE #FF3B2F (meter only) · gold #F5B940 (defeat states —
user victories) · text #F2F4EF / secondary #98A090 · radius 16 ·
font: monospace for ALL numbers (meter must feel like a taxi meter /
stock ticker), Inter for text. Dark only. Motion: meter digits tick
like an odometer; villain messages type themselves out.

Tokens live in `src/theme/tokens.ts`. Use them; never hardcode colors.

If ambiguous, choose the simpler build. Anything not in the current
session block goes unbuilt.

## Repo orientation

- `docs/` — full product spec: constraints, screens & flows, the 5-day
  session plan (with per-day ship gates and the sacrifice order), and
  the parked-for-v2 list. Read `docs/04-session-plan.md` to find the
  current session block before building anything.
- `app/` — expo-router routes (3 tabs: Burn / Ledger / You).
- `src/` — everything else (theme, and as sessions land: core burn
  math, db, native wrappers).
- Native projects are generated with `npx expo prebuild` (CNG) and are
  NOT committed. Custom native code (usage stats service, overlay)
  ships as a local Expo module under `modules/` when S2/S4 build it.
