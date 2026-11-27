# Silo handoff

## Last updated
2026-11-27 by Claude Code (Opus 5.5). Branch `feat/multi-currency` (pushed 2026-11-27 with `prod` and tags up to `v1.3.12`). `prod` = `v1.3.12` @ `9babfe6`.

## Current state
- **Live:** 1.3.12 (versionCode 19, sha256 `d63dbeca…6eba`): package id `dev.cuang.silo` (was `com.LCSdev.silo`; all
  the user's apps use `dev.cuang.*`) and developer name Cuang (was CDev) in the app, legal pages and download page;
  `TERMS_VERSION` 2026-11-27. Android treats it as a new app, so its `version.json` has **no `apk` field** and 1.3.11
  opens the download page `#upgrade` (back up, install, restore, uninstall; checked on emulator 5554). **Put `apk`
  back from 1.3.13 on**, otherwise 1.3.12 won't update in the app. Google Drive's Android OAuth client (not set up
  yet) must use `dev.cuang.silo`. Before that 1.3.11 (versionCode 18, sha256 `0e5c8606…e4dc`): AI model downloads run in a foreground service with a
  progress notification (Pause/Resume/Cancel), resume from the partial file, SHA-256 checked. Before that 1.3.10
  (versionCode 17): new receipt item reader (names and prices on
  different rows, options as notes, discounts folded in; OCR items preferred over the AI's). Checked on emulator 5554:
  upgrade over 1.3.9, then a shared skewed FamilyMart photo gave all 5 items, sum = total. Before that 1.3.9
  (versionCode 16): 57 currencies with a searchable picker (More…) for
  home currency, accounts and budgets; TWD and a few others without decimals. Before that 1.3.8 (versionCode 15): Remove split on the expense page (trash next to
  Split) and the split page; logged repayment income is kept unless the user picks Delete income too.
  Before that 1.3.7 (versionCode 14): one Silo AI mode, worked-out numbers for advice and
  planning, guard retry. Before that 1.3.6 (versionCode 13) at https://cuang.dev/projects/silo/, signed with Silo's private key,
  apk sha256 `ff8bf0a4…408d`. 1.3.6: offline AI chat fixes (most spent category, follow-ups, no past answers in the
  prompt, reply guard against invented amounts and wrong over-budget answers) plus the chat benchmark
  (`bench/chat/README.md`). 1.3.5: the split page shows the result with Mark paid / share per person, the setup folds away, and Cashflow
  shows a split badge (amber pending, green all paid). 1.3.4 added Split Bill, Chat with records, the AI notice.
  1.3.3+ phones update in the app (`version.json` has the apk url + sha256 + size). Phones on 1.3.2 or older need the
  one-time back up / uninstall / install / restore (download page `#upgrade`).
- **Live web pages:** Privacy Policy and Terms (EN + ID, the ID versions prevail) under /projects/silo/privacy/ and /terms/.
  Privacy updated 2026-11-24 for Split Bill and both pages on 2026-11-27 for the Cuang name and new package id. Contact: william@cuang.dev. Source: `docs/legal/` (see its README first).
- **Ticket system:** in-app reports go to the relay `silo-tickets` (docker-host :8131) and on to Discord #silo
  (Fix / Reject). The dispatcher on orca (`tools/ticket-dispatcher/run.sh`, cron @reboot) runs Antigravity and
  auto-merges passing fixes into `test`; ticket agents add a CHANGELOG line.
- 986 jest tests pass (1 skipped: the model benchmark); `npx tsc --noEmit` is clean. Emulator (5554): 1.3.5 to 1.3.6 upgrade and
  Silo AI chat verified with the 0.8B model copied in from emulator 5556 (`~/silo-build/chat-bench/ask.sh` style).

## In progress
- Nothing unreleased or unpushed.
- Background model downloads: `modules/receipt-normalize/.../ModelDownloadService.kt` (foreground service, dataSync,
  notification 4108, HTTP Range resume, SHA-256), JS adapter `src/services/ai/nativeModelDownload.ts`, wired into
  `modelLifecycle.ts` (transfer manifest `resumeData: 'native-range'`; `handleExternalStop` for an attached download,
  `handleUnattachedNativeEvent` for notification taps on a paused one). Tests:
  `src/services/ai/__tests__/nativeModelDownload.test.ts`. Emulator-checked on 1.3.11: progress notification, pause
  on a stalled connection (instant), Resume/Cancel from the shade with Silo open or killed, auto-resume at launch
  after a kill, full background download to install. Not checked on a real phone or Android 14+ yet.

## Next steps
- Watch the user's first real model download on 1.3.11 (Android 13+ asks for notification permission first).
- Watch the user's phone update to 1.3.6 and their real Silo AI questions; add any miss to `BENCH_CASES` first.
- The user is fine with Silo AI as a somewhat useful gimmick (2026-11-25): no more AI tuning unless they report a problem.
- AI chat: Qwen thinking mode was tested and does not work (loops until the 2048-token context is full); keep it off.
  Remaining 0.8B misses: Indonesian advice, "make me a budget" often ends in the facts fallback on real data. On the x86 emulator replies take 25-70s; that is the emulator, not phones.
- Watch real Split Bill use.
- Receipt items: the user wants items read with no user input (2026-11-26). Reader done; tap-to-mark was offered
  and not chosen. Next misses to look at are listed in `bench/eval/README.md`.
- Receipt reading: the private eval set exists (bench/data, 16 labelled receipts, gitignored) and real ML Kit output is
  measured on the emulator (`bench/mlkit-harness/run_on_emulator.sh`); the rule-based fallback is ~74% on totals (benchmark), ceiling ~89%.
- The user's first real test of Connect Google Drive (needs the Google Cloud Android client, SHA-1 above).

## Waiting on the user
- Optional: a dedicated contact alias (silo@cuang.dev as a Zoho alias) instead of william@cuang.dev.

## Build, test, deploy
- Tests: `npx jest` and `npx tsc --noEmit` in this repo.
- AI chat benchmark (model half): `bench/chat/README.md` (llama-server on ai-renderer :8090 via
  `~/silo-build/chat-bench/serve.sh 0.8B|2B`, ssh tunnel, ~4 min). Emulator 5554 has the 0.8B model installed.
- Build: `git bundle create <scratch>/silo.bundle HEAD feat/multi-currency`, scp to `agent@10.20.20.194:~/silo-build/silo.bundle`,
  then `bash ~/silo-build/uxpass_build.sh` (arm64 `apks/head.apk` + x86_64 `apks/emu-x86_64.apk`, ~15 min).
  A quick emulator-only rebuild: `cd ~/silo-build/app && git fetch ../silo.bundle feat/multi-currency && git checkout -f FETCH_HEAD && bash ~/silo-build/build_emu.sh`.
- Emulator: `~/silo-build/sdk/platform-tools/adb -s emulator-5554` (ai-renderer). `~/silo-build/ui.sh dump` lists
  on-screen text/labels; `~/silo-build/ui.sh '<regex>'` taps the first match (uiautomator).
- Publish: copy files to docker-host `/home/agent/orca/learnings/projects-cuang-dev/html/projects/silo/`, then
  `docker cp` into `projects-cuang-nginx:/usr/share/nginx/html/projects/silo/`; remove the old APK; verify the live sha.
- Emulator share test (API 30): adb-pushed photos belong to another app and an adb grant can't open them. Temporarily
  `pm grant dev.cuang.silo android.permission.READ_EXTERNAL_STORAGE`, share with `am start -a android.intent.action.SEND
  -t image/jpeg --eu android.intent.extra.STREAM content://media/external/images/media/<id> -n dev.cuang.silo/.MainActivity`,
  then revoke it and delete the photo.
- Release notes go in `version.json` (`notes`, plain text, no em dashes) and CHANGELOG.md.

## Gotchas
- **github.com/WilliamAxelC/Silo is PUBLIC.** `feat/multi-currency`, `prod` and tags v1.3.1-v1.3.11 are pushed
  (last 2026-11-26). Never commit infrastructure weaknesses, tokens or personal data, HANDOFF.md included; private
  notes go in Claude memory. History was rewritten once before that push (HANDOFF.md only); local
  `backup/pre-scrub-1.3.6` and tag `backup/v1.3.6-pre-scrub` hold the old commits: never push them.
- `android/` is gitignored, but `android/app/build.gradle` and 3 other files are tracked. `git add` with an ignored
  path aborts the whole add, so add them with `git add -f` separately and check `git log` before bundling.
- Release signing: `plugins/withReleaseSigning.js` plus `SILO_RELEASE_SIGNING` on the build box (key in
  `~/silo-build/keys`, backup at orca `~/.local/share/silo-release`). Losing the key means no more updates.
- Never `pkill -f <pattern>` over ssh (it kills its own shell, even `[b]racket` patterns if the same command line
  mentions the name again); kill by PID. Wait on a build with `while kill -0 <pid>; do sleep 20; done`.
- Model download test on emulator 5554: move `files/ai/models/qwen3.5-0.8b/*.gguf` and `files/ai/model-manifest.json`
  aside (adb root), download from Settings. `adb emu network speed umts|edge|full` stalls or slows it for pause tests.
- Every reported bug gets a `regression:` test that fails on the old code.
- The local chat model is tiny: any prompt wording change can swing the chat benchmark by 10 points. Rerun the
  model half after touching `DEFAULT_LOCAL_SYSTEM_PROMPT` or fact wording in `buildRetrievedContext`.
- The Privacy Policy makes promises the code enforces (retention, no IP logs, erase scope): change it first.
- More detail: Claude memory files in `~/.claude/projects/-home-agent-orca-Silo/memory/`.
