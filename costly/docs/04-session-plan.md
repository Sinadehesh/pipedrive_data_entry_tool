# Session sequence (5 days)

## Ship Sentence

> "A user can set their rate and product anchor, open Instagram, watch
> a live meter eat their product-percent, hit a session lockout, and
> receive a weekly villain report — on an Android device, in 5 days."

(5 days, not 3 — this build has native-permission work BOLD didn't
have.)

## Day 1 — the eyes

- **S1: scaffold, prebuild config, theme, tabs.** ✅ DONE — this repo
  state. Expo prebuild config with Android permissions + minSdk 26,
  design tokens in `src/theme/tokens.ts`, 3-tab shell
  (Burn / Ledger / You) in `app/`.
- **S2: native layer** — Usage Access permission flow + foreground
  service polling foreground app every 5s, writing raw sessions to
  SQLite.
- ✅ **Gate**: open Instagram for 2 min → a session row exists with
  correct duration. This is the riskiest build item; if Fable can't
  produce the native module by end of Day 1, STOP and solve it together
  before anything else gets built.

## Day 2 — the meter

- **S3: burn math** (rate × seconds → € → product-percent, cap logic,
  window logic) as a pure tested module.
- **S4: overlay bubble** + ticking digits + session window + lock
  overlay with confirm gate.
- ✅ **Gate**: watch the meter tick live inside Instagram; hit window;
  see the mocking confirm.

## Day 3 — the world

- **S5: onboarding flow 1–6.**
- **S6: Burn tab** with product-fill graphic + status states.
- ✅ **Gate**: fresh install → armed and metering in <4 minutes.

## Day 4 — the villain

- **S7: Ledger + settlement flow** + thank-you note + defeat states +
  Stripe link plumbing (static link, amount shown in copy).
- **S8: notifications** (session-end, cap-warning at 80%, settlement
  day) + villain copy pass on every string.
- ✅ **Gate**: force a settlement with fake data → both emotional
  endings land.

## Day 5 — the safety + ship

- **S9: You tab**, asymmetric rate friction, self-exclusion path (kind
  mode), quiet hours, edge states (uninstalled vice app, permission
  revoked mid-week).
- **S10: APK**, install on clean device, run the Ship Sentence
  end-to-end, send the witness the link.

## Sacrifice order (pre-decided, if behind)

1. product-fill graphic → simple bar
2. villain typing animation → static text
3. per-app chips → total only
4. quiet hours → cut

**Never cut**: native tracking accuracy, cap-lockout, confirm gates,
self-exclusion, defeat states.
