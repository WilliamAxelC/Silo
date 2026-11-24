# Silo handoff

## Last updated
2026-11-24 by Claude Code (Opus 5.5). Branch `feat/multi-currency` @ `0f7ba8c` (also `test`). `prod` = `v1.3.3` @ `ac5b4ea`.

## Current state
- **Live:** 1.3.3 (versionCode 10) at https://cuang.dev/projects/silo/, the first build signed with Silo's private key.
  Users on 1.3.2 or older must back up, uninstall, install and restore once (the download page explains it).
  1.3.3 and later update in the app from `version.json` (`apk` url + sha256 + size).
- **Live web pages:** Privacy Policy and Terms (EN + ID, the ID versions prevail) under /projects/silo/privacy/ and /terms/.
  Contact: william@cuang.dev. Source: `docs/legal/` (see its README before changing them).
- **Ticket system:** in-app reports go to the relay `silo-tickets` (docker-host :8131) and on to Discord #silo
  (Fix / Reject). The dispatcher on orca (`tools/ticket-dispatcher/run.sh`, cron @reboot) runs Antigravity and
  auto-merges passing fixes into `test`.
- 864 jest tests pass; `npx tsc --noEmit` is clean.

## In progress
- **1.3.4 release** (Split Bill, Chat mode uses your records, AI accuracy notice, Reports toggle). Commit `0f7ba8c`
  is being built on ai-renderer (`~/silo-build/build_134.log`). Remaining steps:
  1. Check the APK: signer SHA-1 `ddca7c...32e1`, versionCode 11, READ_CONTACTS present, WRITE_CONTACTS absent.
  2. Emulator: install over 1.3.3 (DB 20 to 21, data kept) and open Split Bills.
  3. Publish the APK, `index-134.html` (prepared in the session scratchpad; otherwise edit the live index.html),
     `version.json` with the new apk sha/size, and the updated `docs/legal/privacy*.html` to /privacy/ and /privacy/id/.
  4. Tag `v1.3.4`, move `prod`, update CHANGELOG (already written for 1.3.4).

## Next steps
- Watch the first real in-app update (the user's phone, 1.3.3 to 1.3.4).
- The user's first real test of Connect Google Drive (needs the Google Cloud Android client, SHA-1 above).

## Waiting on the user
- Whether to push branches to GitHub (never approved; everything is local).
- Optional: a dedicated contact alias (silo@cuang.dev as a Zoho alias) instead of william@cuang.dev.

## Build, test, deploy
- Tests: `npx jest` and `npx tsc --noEmit` in this repo.
- Build: `git bundle create <scratch>/silo.bundle HEAD feat/multi-currency`, scp to `agent@10.20.20.194:~/silo-build/silo.bundle`,
  then `bash ~/silo-build/uxpass_build.sh` (arm64 `apks/head.apk` + x86_64 `apks/emu-x86_64.apk`, ~15 min).
  A quick emulator-only rebuild: `cd ~/silo-build/app && git fetch ../silo.bundle feat/multi-currency && git checkout -f FETCH_HEAD && bash ~/silo-build/build_emu.sh`.
- Emulator: `~/silo-build/sdk/platform-tools/adb -s emulator-5554` (ai-renderer).
- Publish: copy files to docker-host `/home/agent/orca/learnings/projects-cuang-dev/html/projects/silo/`, then
  `docker cp` into `projects-cuang-nginx:/usr/share/nginx/html/projects/silo/`; remove the old APK; verify the live sha.
- Release notes go in `version.json` (`notes`, plain text, no em dashes) and CHANGELOG.md.

## Gotchas
- `android/` is gitignored, but `android/app/build.gradle` and 3 other files are tracked. `git add` with an ignored
  path aborts the whole add, so add them with `git add -f` separately and check `git log` before bundling.
- Release signing: `plugins/withReleaseSigning.js` plus `SILO_RELEASE_SIGNING` on the build box (key in
  `~/silo-build/keys`, backup at orca `~/.local/share/silo-release`). Losing the key means no more updates.
- Never `pkill -f <pattern>` over ssh (it kills its own shell); use a script that skips its own PID.
- Every reported bug gets a `regression:` test that fails on the old code.
- The Privacy Policy makes promises the code enforces (retention, no IP logs, erase scope): change it first.
- More detail: Claude memory files in `~/.claude/projects/-home-agent-orca-Silo/memory/`.
