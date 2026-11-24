# Silo handoff

## Last updated
2026-11-24 by Claude Code (Opus 5.5). Branch `feat/multi-currency` (also `test`). `prod` = `v1.3.4` @ `0f7ba8c`.

## Current state
- **Live:** 1.3.4 (versionCode 11) at https://cuang.dev/projects/silo/, signed with Silo's private key.
  Split Bill, Chat mode answering from the user's records, an AI accuracy notice, and a larger Reports toggle.
  1.3.3 phones update in the app (`version.json` has the apk url + sha256 + size). Phones on 1.3.2 or older need the
  one-time back up / uninstall / install / restore (download page `#upgrade`).
- **Live web pages:** Privacy Policy and Terms (EN + ID, the ID versions prevail) under /projects/silo/privacy/ and /terms/.
  Privacy updated 2026-11-24 for Split Bill. Contact: william@cuang.dev. Source: `docs/legal/` (see its README first).
- **Ticket system:** in-app reports go to the relay `silo-tickets` (docker-host :8131) and on to Discord #silo
  (Fix / Reject). The dispatcher on orca (`tools/ticket-dispatcher/run.sh`, cron @reboot) runs Antigravity and
  auto-merges passing fixes into `test`; ticket agents add a CHANGELOG line.
- 864 jest tests pass; `npx tsc --noEmit` is clean. Emulator upgrade 1.3.3 to 1.3.4 verified (DB 20 to 21, data kept).

## In progress
- Nothing unreleased.

## Next steps
- Watch the first real in-app update on the user's phone (1.3.3 to 1.3.4) and the first real Split Bill use.
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
