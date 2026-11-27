# Publishing Silo on Google Play

Checklist for the Play Console, written 2026-11-28 for 1.3.14. The Play build is the same app as the cuang.dev APK
with self-updating turned off (`SILO_DISTRIBUTION=play`, see `app.config.js` and `src/services/distribution.ts`).
The answers below are recommendations based on the code. The Play Console owner confirms them, using Google's own
definitions.

## Build

- Build box: `~/silo-build/build_play.sh` (clones `silo.bundle`, `SILO_DISTRIBUTION=play` prebuild,
  `bundleRelease` for arm64-v8a + x86_64, then an x86_64 APK of the same variant for the emulator).
- Output: `apks/play.aab`, signed with Silo's release key, which acts as the **upload key**.
- Version: shares `versionName` / `versionCode` with the cuang.dev APK. Every upload needs a higher `versionCode`.

## App signing (decide before the first upload; it can't be changed later)

- **Recommended: upload Silo's existing signing key** ("Use a different app signing key", then export it with PEPK).
  Play then delivers APKs signed with the same key as cuang.dev, so a phone can move between the two without
  reinstalling and losing data.
- Or let Google generate a new key. Then the Play app and the cuang.dev app can't update each other, and switching
  needs back up, uninstall, install, restore.

## Store listing

- **App name:** Silo
- **Short description (80 max):** Private expense tracker: scan receipts, budgets and split bills, all on your phone.
- **Full description:**

  Silo is a money tracker that keeps your records on your phone.

  • Scan receipts, or share photos from any app. Silo reads the total, date, shop and items on the phone.
  • Cashflow and calendar views, reports by category, budgets with plans, savings goals and recurring transactions.
  • Accounts in 57 currencies, with exchange rates for net worth.
  • Split a bill with friends, track who paid, and send reminders.
  • Silo AI: ask about your spending. It runs on your phone after a one-time model download, or with your own AI service.
  • App Lock, hide your totals with one tap, colour themes and pure black dark mode.
  • Back up to a file or your own Google Drive, and export CSV.

  No account and no ads. Nothing is uploaded unless you turn on a feature that needs it, and the in-app Privacy page
  lists each of those features.

- **Category:** Finance. **Tags:** budget, expense tracker. **Contact email:** william@cuang.dev
- **Privacy policy URL:** https://cuang.dev/projects/silo/privacy/
- **Screenshots:** at least 2 phone screenshots (Cashflow, Reports, receipt scan, Settings themes). Use demo data, not
  real receipts.

## App content

- **Ads:** none. **App access:** everything works without signing in.
- **Target audience:** 18+ (finance app with an AI chat).
- **Content rating:** utility or productivity; no violence, sexual content, gambling or user-to-user sharing.
- **Financial features:** personal finance (budgeting and expense tracking) only. No loans, payments, banking or
  crypto.
- **AI-generated content:** Silo AI answers have a **Report** button. It opens the in-app report form with the question
  and answer filled in, and the report goes to the developer.
- **Foreground service (dataSync):** declare two uses.
  1. Downloading the on-device AI model (about 0.7 GB), which the user starts with Download, with a progress
     notification.
  2. Reading a stack of scanned receipts in the background, which the user starts by scanning or sharing several
     photos.
  Google asks for a short screen recording of each.
- **Permissions to explain if asked:**
  - Camera: scanning receipts.
  - Contacts: optional, to pick people for split bills; contacts stay on the phone.
  - Notifications: the daily reminder and download progress.
  - Biometric: App Lock.

## Data safety (recommended answers)

Encrypted in transit: **yes** (HTTPS only). Users can request deletion: **yes**, by email to william@cuang.dev.
Reports are deleted 12 months after their last activity.

| Data | Collected? | Why / notes |
| --- | --- | --- |
| Bug and feature reports (title, description, device model, Android and app version; optional error log and screenshot) | Yes, optional, user-initiated | App functionality / developer communications. Sent only when the user taps Send. |
| App info and performance: diagnostics | Yes (by Google ML Kit / Play services SDKs) | Google's SDKs send technical diagnostics (see the ML Kit data disclosure). |
| Financial info, photos | Optional, only with the user's own external AI service or Google Drive | Not received by the developer. Declare as shared if you read "transmitted off the device" strictly. |
| Contacts | No | Read on the phone for split bills, never sent. |
| Location, ad IDs, web browsing | No | |

Not collected by the developer:
- Exchange-rate requests send only the home currency code.
- The AI model download sends nothing about the user.

## Before submitting

- Install the AAB on a test track (internal testing) first and walk through: Terms, add, scan, the Report button,
  More shows "Updates come from Google Play", and there is no install-apps prompt anywhere.
- Check that the pre-launch report shows no crashes.
