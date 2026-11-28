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
- **Short and full descriptions (EN and ID):** `docs/play/listing/` (`short-en.txt` 80 chars, `short-id.txt`,
  `full-en.txt`, `full-id.txt`). They lead with "works offline"; keep that true: anything new that goes online must
  be listed in the in-app Privacy page and in the "Works offline" paragraph.

- **Category:** Finance. **Tags:** budget, expense tracker. **Contact email:** william@cuang.dev
- **Privacy policy URL:** https://cuang.dev/projects/silo/privacy/
- **Graphics (ready):** https://cuang.dev/projects/silo/play/ has the 512 px icon, the 1024 x 500 feature graphic,
  8 phone screenshots (1080 x 1920, made-up data) and a zip of all of them. Sources: `docs/play/assets/icon-512.png`;
  the screenshots were taken on emulator 5554 with the chat benchmark's fictional dataset
  (`src/services/ai/chatBench/fixture.ts` seeded into a DB file and copied in as `silo.db`).

## App content

- **Ads:** none. **App access:** everything works without signing in.
- **Target audience:** 18+ (finance app with an AI chat).
- **Content rating:** utility or productivity; no violence, sexual content, gambling or user-to-user sharing.
- **Financial features:** personal finance (budgeting and expense tracking) only. No loans, payments, banking or
  crypto.
- **AI-generated content:** Silo AI answers have a **Report** button. It opens the in-app report form with the question
  and answer filled in, and the report goes to the developer.
- **Foreground service (dataSync):** declare two uses, each with a video link.
  1. Network processing, Other: downloading the on-device AI model (532 MB), which the user starts with Download
     Model, with a progress notification (Pause, Cancel). Video:
     https://cuang.dev/projects/silo/play/silo-fgs-datasync.mp4
  2. Local processing, Other: reading imported or scanned receipts on the phone (text recognition plus the on-device
     AI), which the user starts from Receipt Inbox, with a "Reading receipts: n of m" notification. Video:
     https://cuang.dev/projects/silo/play/silo-fgs-receipts.mp4
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

## Automating releases (optional)

Uploads can be scripted with the Google Play Developer API once the app exists and the first AAB was uploaded by
hand: a Google Cloud service account with the Android Publisher API enabled, invited in Play Console (Users and
permissions) with release rights for Silo. Its JSON key stays off the repo (like the signing key). A script can then
upload `play.aab` to a track (internal first) with release notes: `tools/play-publish/publish_play.py`
(standard library plus `openssl`; the key file's path goes in `SILO_PLAY_KEY`, never in the repo).

```
python3 tools/play-publish/publish_play.py check
python3 tools/play-publish/publish_play.py upload silo-1.3.14-play.aab --notes tools/play-publish/notes-1.3.14.json --dry-run
python3 tools/play-publish/publish_play.py upload silo-1.3.14-play.aab --notes tools/play-publish/notes-1.3.14.json
```

After each release, add it to `docs/play/releases.json` (newest first, with sha256 and size), copy the .aab and
.apk to the site's `play/releases/`, and rebuild the page: `python3 tools/play-publish/play_page.py <site>/play`.

It refuses to roll out straight to production; use `--track production --status draft` and press Release in Play
Console.

## Before submitting

- Install the AAB on a test track (internal testing) first and walk through: Terms, add, scan, the Report button,
  More shows "Updates come from Google Play", and there is no install-apps prompt anywhere.
- Check that the pre-launch report shows no crashes.
