# Local On-Device Qwen3.5-2B INT4 OTA Provisioning Plan

## Scope implemented in this phase

This phase introduces a production-oriented offline model provisioning foundation for **Qwen3.5-2B INT4** that is acquired after install instead of bundled into the base app package.

Implemented code paths:
- [`src/services/ai/config.ts`](../src/services/ai/config.ts)
- [`src/store/useAIStore.ts`](../src/store/useAIStore.ts)
- [`src/services/ai/modelLifecycle.ts`](../src/services/ai/modelLifecycle.ts)
- [`src/services/ai/agent.ts`](../src/services/ai/agent.ts)
- [`src/navigation/AppNavigator.tsx`](../src/navigation/AppNavigator.tsx)
- [`src/screens/ChatbotScreen.tsx`](../src/screens/ChatbotScreen.tsx)
- [`src/screens/SettingsScreen.tsx`](../src/screens/SettingsScreen.tsx)

## Architecture update

### Provisioning model lifecycle

The app now uses a dedicated lifecycle manager in [`QModelLifecycleManager`](../src/services/ai/modelLifecycle.ts:202) to coordinate:
- first eligible launch provisioning
- OTA download state transitions
- local storage path management
- integrity verification
- warmup and registration flow
- initialization/indexing hooks
- pause/resume/cancel behavior
- restart recovery through manifest persistence
- telemetry-style local event logging

### State model

[`useAIStore`](../src/store/useAIStore.ts) now tracks local runtime state instead of remote API-only state. It persists runtime-facing concepts in memory and exposes structured provisioning metadata such as:
- `status`
- `progress`
- `downloadedBytes`
- `totalBytes`
- `modelPath`
- `lastError`
- `pausedReason`
- `retryCount`
- `updateAvailable`
- persisted transfer metadata in `transfer.resumeData`, `transfer.sessionId`, and throughput timestamps

The supported lifecycle states are defined in [`AIProvisioningStatus`](../src/services/ai/config.ts:17):
- `not-installed`
- `queued`
- `downloading`
- `paused`
- `verifying`
- `unpacking`
- `registering`
- `warming`
- `indexing`
- `ready`
- `failed`
- `update-available`

## OTA provisioning flow

### First run / first eligible launch

[`initialize()`](../src/services/ai/modelLifecycle.ts:214) schedules provisioning after app startup using a short delayed background kickoff.

### Download storage layout

The model manager uses app document storage under paths derived from [`AI_ROOT_DIRECTORY`](../src/services/ai/modelLifecycle.ts:100):
- model root
- active version directory
- temp download directory
- ready manifest file
- transfer manifest file

### Persisted resumable transfers

The implementation now persists resumable download state into [`AI_TRANSFER_MANIFEST_FILE`](../src/services/ai/modelLifecycle.ts:104) so the app can:
- restore partial download progress after relaunch
- detect stale interrupted transfers
- resume when `resumeData` is still valid
- reconcile incomplete transfers that can no longer resume

The restoration path lives in [`restorePersistedState()`](../src/services/ai/modelLifecycle.ts:474).

### Integrity and rollback

The flow in [`verifyAndFinalizeInstalledModel()`](../src/services/ai/modelLifecycle.ts:403) supports:
- existence validation
- checksum verification hook
- active-model directory placement
- rollback rename if replacing an existing model fails

### Resume after app restart

[`resumeDownload()`](../src/services/ai/modelLifecycle.ts:281) now recreates the resumable transfer from persisted manifest data and continues the OTA download whenever resumable state is available.

### Progress persistence and throughput

[`handleProgressUpdate()`](../src/services/ai/modelLifecycle.ts:361) now:
- persists progress snapshots at an interval
- records last progress timestamps
- estimates transfer throughput
- keeps enough metadata to reconcile interrupted sessions defensively

## Current tradeoffs and limitations

### Background execution reality in Expo / React Native

The current implementation keeps provisioning asynchronous and non-blocking **while the app process remains alive or later returns to foreground**, and now restores resumable state across relaunches when Expo provides valid resume data.

It still does **not** guarantee full OS-managed background downloading after the app is force-terminated.

#### Practical behavior now
- If the app is backgrounded and later foregrounded, provisioning resumes or reconciles automatically.
- If the app is relaunched after interruption, the transfer manifest is inspected and the session resumes when valid `resumeData` exists.
- If the OS discards resumable state, the app surfaces a safe recovery path and requires retry.

### Why this tradeoff exists

For true resilient background transfers after app termination:
- **Android** typically needs `WorkManager` or a foreground service.
- **iOS** typically needs background `URLSession` support.
- Expo-managed JavaScript resumable downloads can be made robust across foreground sessions and relaunches, but not equivalent to dedicated native background transfer services.

This limitation is called out inline in [`watchAppState()`](../src/services/ai/modelLifecycle.ts:534).

## Production recommendations for native hardening

### Android
To move from Expo resumable restoration to full production background reliability, add native support for:
- `WorkManager`
- foreground service notifications for long downloads
- resumable file transfer in native code
- persistent download tasks independent from the JS runtime
- storage quota checks before enqueueing

### iOS
For production-grade reliability on iOS, add native support for:
- background `URLSession`
- app relaunch handling for transfer completion callbacks
- background modes configuration
- file move and integrity verification after background completion

## Storage and permissions considerations

### Storage location
The model is stored in app-private document storage via [`expo-file-system/legacy`](../src/services/ai/modelLifecycle.ts:1), avoiding extra user-visible storage permissions in common cases.

### Low storage handling
[`ensureFreeSpace()`](../src/services/ai/modelLifecycle.ts:171) checks free disk space before provisioning and pauses setup with a clear reason if insufficient storage is available.

### Integrity configuration
The checksum in [`QWEN_MODEL_SHA256`](../src/services/ai/config.ts:4) is now used directly when non-empty.

### Download URL configuration
[`QWEN_MODEL_DOWNLOAD_URL`](../src/services/ai/config.ts:3) points to the current OTA artifact source and should still be treated as release-configurable.

## Local inference bootstrap path

The current implementation wires the bootstrap phases even though the native inference bridge is still a placeholder.

The flow is:
1. download artifact
2. persist transfer metadata
3. restore or resume across relaunch when possible
4. verify artifact
5. move into active model directory
6. register model with local runtime
7. run warmup prompt
8. initialize local indexing/cache hooks
9. mark runtime ready

These phases are represented in [`registerWarmupAndIndex()`](../src/services/ai/modelLifecycle.ts:456).

## Chatbot UX behavior

[`ChatbotScreen`](../src/screens/ChatbotScreen.tsx) now:
- removes remote API-key gating
- shows local provisioning state
- shows resumable/retry actions only when the current state can actually continue or recover
- only exposes pause during active download transfer, not during verification or runtime bootstrap phases
- differentiates runtime bootstrap messaging from download-in-progress messaging
- disables only AI message sending while the model is not truly runtime-ready
- keeps the rest of the app unaffected
- automatically enables chat once provisioning reaches `ready` and runtime bootstrap is complete

## Settings UX behavior

[`SettingsScreen`](../src/screens/SettingsScreen.tsx) now exposes:
- local model identity
- provisioning status and progress
- runtime readiness separated from bootstrap-in-progress phases
- transfer speed when known
- runtime-bootstrap helper messaging versus resumable-transfer messaging
- retry/resume controls only when the lifecycle manager reports a recoverable state
- pause only during active transfer, with cancel still available for active provisioning cleanup
- recent local AI event logs

## Agent behavior in this phase

[`askFinancialAgent()`](../src/services/ai/agent.ts:106) continues to:
- wait for the local runtime readiness path
- rely on lifecycle re-bootstrap when an installed model exists but runtime readiness must be re-established on launch
- return a clear provisioning message when the model is not yet ready
- support structured offline responses using the local SQLite database

## Recommended next implementation step

To complete true on-device inference, the next phase should add:
- a native Qwen runner bridge, likely via custom module / prebuild
- actual GGUF or engine-specific model loading
- token streaming callbacks into React Native
- stronger native background transfer support if terminated-app continuity is a hard requirement
- optional indexed RAG corpus initialization and persisted retrieval store

## Release checklist before shipping

1. Validate the checksum and artifact compatibility in [`config.ts`](../src/services/ai/config.ts:1)
2. Add a real inference runtime behind [`LocalInferenceAdapter`](../src/services/ai/modelLifecycle.ts:82)
3. Device-test relaunch resume behavior on Android and iOS
4. Add native background transfer support if force-terminated download continuation is required
5. Run storage-pressure, interruption, retry, and rollback testing on real devices
