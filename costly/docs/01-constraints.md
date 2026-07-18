# Hard reality constraints (read before prompting Fable)

1. **Android-first, Android-only for MVP.** The meter requires knowing
   which app is foregrounded. Android allows this via the Usage Access
   permission (`UsageStatsManager`) + a foreground service. iOS requires
   Apple's Family Controls entitlement (application + approval weeks) →
   iOS is v2. Do not let Fable pretend otherwise.

2. **This cannot run in Expo Go.** It needs a dev build / prebuild with
   native modules (usage stats, overlay, foreground service). Tell Fable
   explicitly: Expo prebuild or bare React Native,
   `react-native-usage-stats`-class module or a small custom native
   module.

3. **No real money moves in MVP.** Payments = Stripe + legal + refund
   policy — that's v2, after the mechanic proves it changes behavior.
   MVP runs a **Debt Ledger**: burns accumulate as real owed euros,
   settlement happens weekly via a Stripe Payment Link (manual, no
   backend). The psychology is intact (the meter, the product-percent,
   the thank-you note); the rails come later. This also keeps you out of
   Play Store financial-app review hell on day one.

4. **The ethical spec is product spec, not decoration.** Hard weekly cap
   → lockout (not billing). Session windows with re-purchase confirm
   gates. Asymmetric friction on rate changes. Self-exclusion path.
   These ship in v1 or the app doesn't.
