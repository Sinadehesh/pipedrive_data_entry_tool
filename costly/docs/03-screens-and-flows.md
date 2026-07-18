# Screens & flows (MVP surface)

## Onboarding (one session's work, order matters psychologically)

1. **Hook: "What do you actually want?"** → user enters 3 products +
   prices (<100 / <500 / <1000 tiers, with suggestions). Store name +
   price + optional emoji.
2. **"What's your time worth?"** → monthly income slider (private,
   local) → app computes hourly → proposes rate ladder
   (€0.10 / €0.25 / €0.50 / €1 / €2 per min) with the income-anchored
   option pre-selected. Copy: "Pick the first number that makes your
   stomach tighten."
3. **Weekly cap picker** (proposed = 10× the per-minute rate × 15,
   editable) with the plain sentence: "At the cap, we stop charging and
   start locking."
4. **Vice app picker**: list installed apps (queryable on Android),
   user selects targets; presets for the usual suspects.
5. **Permission walk**: Usage Access → Overlay → Notifications, each
   with a one-line villain justification ("We can't bill what we can't
   see.").
6. **Contract screen**: full terms in one card — rate, cap, session
   window, where money goes ("to us; we're the anti-charity — your
   hatred funds development") — requires typing "I'm done wasting my
   life" to activate. Screenshot-worthy by design.

## Burn (home tab)

This week's burn as a product-fill graphic (the PlayStation silhouette
filling with red, percent counter in mono), € equivalent small
underneath, cap progress bar, per-app breakdown chips, today's villain
line, and the CURRENT STATUS banner (armed / in session /
locked-for-week).

## Live overlay (the product)

Floating bubble while a vice app is foregrounded — mono digits ticking
product-percent + elapsed time; tap → expands to show session window
remaining + "End session" button. At window end → full-screen lock
overlay with the re-purchase confirm gate. Overlay must survive app
switches within the session.

## Session end (auto modal in Costly)

"Session: 14 min. Cost: 3.2% of AirPods (€3.50). Ledger updated."
One button: "Noted." No essays.

## Ledger tab

Running week table (sessions, app, minutes, %/€), settlement history,
and Settlement Day flow: weekly summary → if burns > 0: the thank-you
note ("Thank you for buying 62% of our… sorry, YOUR AirPods.
Sincerely, Costly.") + Stripe Payment Link button ("Settle up") +
honor-tracking of paid/unpaid. If burns = 0: the defeat state (gold,
grudging: "Nothing. You gave us NOTHING this week. Disgusting.
Streak: 2 weeks.").

## You tab

Rate & cap (with the asymmetric-friction flows), product anchors
(editable, but burned % carries), vice list, quiet hours, notification
prefs, self-exclusion ("I need this to stop"), and the villain's
ledger — lifetime totals both directions: "You've fed us €41. You've
starved us of ~€230 (est.)." That second number is the retention hook:
make avoidance visible and cumulative.
