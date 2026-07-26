# Silo Application Implementation TODO & Engineering Roadmap

This document catalogs technical debt, architectural improvements, bug fixes, and feature enhancements required across Silo's local LLM implementation, financial core, and Android platform integrations.

---

## 1. Local LLM & Inference Implementation Issues (High Priority)

### [LLM-01] Unify Inference Pathways & Deprecate Legacy Bridge
- **Status**: Open
- **Area**: AI Runtime / Native Code
- **Context**: The application currently maintains two parallel local inference implementations: the modern `llama.rn` integration (active when `USE_LLAMA_RN = true` in [generationService.ts](file:///d:/Project/Silo/silo-app/src/services/ai/generationService.ts)) and a bespoke Kotlin/JNI/C++ bridge ([SiloLocalInferenceModule.kt](file:///d:/Project/Silo/silo-app/android/app/src/main/java/com/will/silo/ai/SiloLocalInferenceModule.kt) and [gguf_runner.cpp](file:///d:/Project/Silo/silo-app/android/app/src/main/cpp/gguf_runner.cpp)).
- **Action Items**:
  - [ ] Audit all call sites to confirm `llama.rn` covers 100% of required functionality (warmup, cancellation, grounded RAG, health checks).
  - [ ] Remove `ensureLegacyChatRuntimeReady()` and related fallback branching in [generationService.ts](file:///d:/Project/Silo/silo-app/src/services/ai/generationService.ts).
  - [ ] Deprecate and excise unused native C++ code ([gguf_runner.cpp](file:///d:/Project/Silo/silo-app/android/app/src/main/cpp/gguf_runner.cpp), [SiloLocalInferenceJni.cpp](file:///d:/Project/Silo/silo-app/android/app/src/main/cpp/SiloLocalInferenceJni.cpp)) and custom Kotlin packaging to significantly reduce APK size and simplify CMake build scripts.

### [LLM-02] Hardened Background OTA Provisioning & OS Termination Resilience
- **Status**: Open
- **Area**: AI Model Lifecycle / OTA
- **Context**: Model provisioning in [modelLifecycle.ts](file:///d:/Project/Silo/silo-app/src/services/ai/modelLifecycle.ts) relies on `expo-file-system/legacy` resumable downloads. While it recovers gracefully across foreground sessions and app relaunches via `AI_TRANSFER_MANIFEST_FILE`, downloads are suspended if the OS force-terminates the app process during backgrounding.
- **Action Items**:
  - [ ] Implement an Android native `WorkManager` or Foreground Service task with persistent notifications for multi-gigabyte GGUF model downloads.
  - [ ] Decouple download progress persistence from the JavaScript runtime so downloads continue even when React Native is suspended.
  - [ ] Add pre-download disk fragmentation checks and automatic cleanup of stale temporary `.tmp` download chunks in `ensureFreeSpace()`.

### [LLM-03] True Native Token Streaming & Cancellation Synchronization
- **Status**: Open
- **Area**: AI Generation / UX
- **Context**: The current UI generation flow in [agent.ts](file:///d:/Project/Silo/silo-app/src/services/ai/agent.ts) and [generationService.ts](file:///d:/Project/Silo/silo-app/src/services/ai/generationService.ts) simulates streaming via `pseudoStreamResponse()`, slicing completed text chunks after synchronous or semi-synchronous native execution.
- **Action Items**:
  - [ ] Transition all chat generation call sites to use `LlamaRnAdapter`'s real-time `onToken` streaming callback directly into [useAIStore.ts](file:///d:/Project/Silo/silo-app/src/store/useAIStore.ts).
  - [ ] Harden cancellation semantics (`cancelActiveLocalGeneration`) to ensure interruption signals propagate immediately to the native C++ thread, halting computation without leaving orphan request IDs or racing message completion states.
  - [ ] Ensure control token sanitization (`sanitizeStreamingGeneratedText`) operates seamlessly over real-time token boundaries without flickering or partial tag rendering.

### [LLM-04] Context Window Budgeting & Sliding-Window Summarization
- **Status**: Open
- **Area**: AI Prompt Engineering / Memory
- **Context**: Long conversational exchanges risk exceeding `QWEN_MODEL_PREFERRED_MAX_CONTEXT_TOKENS` (defaulting to 2k–4k effective tokens), leading to KV-cache memory exhaustion or abrupt truncation during prompt formatting.
- **Action Items**:
  - [ ] Implement an automated sliding-window conversation summarization utility in [agent.ts](file:///d:/Project/Silo/silo-app/src/services/ai/agent.ts).
  - [ ] Dynamically compress older chat turns into a brief historical summary token block before appending recent turns and RAG context.
  - [ ] Add explicit token counting validation prior to calling `context.completion()` in [llamaRnAdapter.ts](file:///d:/Project/Silo/silo-app/src/services/ai/llamaRnAdapter.ts).

### [LLM-05] Native Memory Telemetry & Watchdog Timers
- **Status**: Open
- **Area**: AI Runtime / Stability
- **Context**: Loading 2B INT4 models and executing `runWarmup()` can cause sharp Proportional Set Size (PSS) memory spikes, risking Low Memory Killer (LMK) process termination on 6GB RAM devices.
- **Action Items**:
  - [ ] Integrate real-time native memory monitoring (PSS heap tracking) into [hardware.ts](file:///d:/Project/Silo/silo-app/src/services/ai/hardware.ts) and expose warnings when memory headroom drops below critical thresholds.
  - [ ] Add strict watchdog timers and automatic recovery/restart logic if `initLlama` or `runWarmup` hangs or fails to respond within bounded timeframes.
  - [ ] Implement configurable fallback modes (e.g., automatically switching from `Q4_K_M` to smaller quantizations like `Q2_K` or disabling GPU layers on persistent out-of-memory errors).

### [LLM-06] Local Vector RAG & Reranking Migration
- **Status**: In Progress
- **Area**: RAG / Retrieval
- **Context**: As outlined in [local-qwen-migration-plan.md](file:///d:/Project/Silo/silo-app/plans/local-qwen-migration-plan.md), the target architecture replaces basic SQLite string retrieval with a local vector embedding pipeline.
- **Action Items**:
  - [ ] Integrate a lightweight local embedding model (e.g., `bge-small-en-v1.5` or `multilingual-e5-small`) running as a local sidecar or native background service.
  - [ ] Migrate SQLite financial record indexing to use `sqlite-vec` or LanceDB for fast cosine similarity similarity searches.
  - [ ] Build an asynchronous background indexing worker that computes embeddings for new transactions and category modifications without blocking the UI thread.

---

## 2. Financial Domain & Data Model Issues (Medium Priority)

### [FIN-01] Complete Split Category Migration & Budget Model Alignment
- **Status**: In Progress
- **Area**: Database / Core Finance
- **Context**: As documented in [settings-category-architecture.md](file:///d:/Project/Silo/silo-app/plans/settings-category-architecture.md), category management is migrating from a flat string list to a typed relational model separating `expense` and `income` categories.
- **Action Items**:
  - [ ] Finalize the database migration in [schema.ts](file:///d:/Project/Silo/silo-app/src/db/schema.ts) establishing the `categories` table (`id`, `name`, `type`, `isSystem`).
  - [ ] Update transaction entry and editing flows ([mappers.ts](file:///d:/Project/Silo/silo-app/src/features/transactions/mappers.ts)) to enforce type-aware category selection (expense transactions can only select expense categories, income select income).
  - [ ] Migrate `budgets` table linkage from category `name` (string) to category `id` (integer foreign key) to support category renaming without breaking historical budget tracking.

### [FIN-02] Settings Persistence & Store Hydration
- **Status**: In Progress
- **Area**: Settings / Stores
- **Context**: [useSettingsStore.ts](file:///d:/Project/Silo/silo-app/src/store/useSettingsStore.ts) needs to transition from ephemeral or basic AsyncStorage state to a backed SQLite key-value settings table.
- **Action Items**:
  - [ ] Implement seamless hydration of preferences (`themeMode`, `currencyCode`, `useThousandsSeparator`, `dateFormat`, `showIncomeInReportsFirst`) from SQLite on app startup.
  - [ ] Ensure theme adjustments (`system | light | dark`) propagate immediately across navigation stacks without screen re-inflation flicker.

### [FIN-03] Offline OCR Receipt Scanning Hardening
- **Status**: Open
- **Area**: OCR / Transactions
- **Context**: Receipt scanning relies on on-device ML Kit text recognition to extract merchant names, dates, and itemized amounts offline.
- **Action Items**:
  - [ ] Improve parsing heuristics for diverse international receipt formats and multi-currency symbols.
  - [ ] Add automatic image compression and contrast enhancement pre-processing before passing images to ML Kit to improve optical character recognition accuracy in low-light conditions.

---

## 3. Platform, Diagnostics & DevOps Issues (Lower Priority / Polish)

### [DEV-01] Release Build Verification & Debug Metro Decoupling
- **Status**: Open
- **Area**: Build / DevOps
- **Context**: On-device diagnostics (e.g., Poco F5 testing documented in [silo-handoff.md](file:///d:/Project/Silo/silo-app/silo-handoff.md)) revealed that debug app startup failures are frequently caused by Metro bundler websocket (`localhost:8081`) timing sensitivity rather than native C++/JNI crashes.
- **Action Items**:
  - [ ] Establish an automated CI pipeline generating standalone release APK/AAB builds with `extractNativeLibs=false` and verified `arm64-v8a` packaging.
  - [ ] Conduct formal startup latency and stress testing on release builds across high-end (Snapdragon 7+/8 Gen series) and low-end ARM64 Android 14 devices without ADB/Metro connected.

### [DEV-02] In-App Developer Diagnostics Overlay
- **Status**: Open
- **Area**: Observability / UI
- **Context**: Current debugging relies heavily on ADB command-line logs (`logcat`, `dumpsys meminfo`).
- **Action Items**:
  - [ ] Enhance [SystemLogsScreen.tsx](file:///d:/Project/Silo/silo-app/src/screens/SystemLogsScreen.tsx) with a real-time developer diagnostics heads-up display (HUD).
  - [ ] Surface live metrics: PSS RAM usage, active inference backend (`llama.rn` GPU vs CPU fallback), configured GPU layers, context token saturation percentage, and OTA transfer throughput.
  - [ ] Provide one-tap developer actions: "Reset LLM Runtime", "Purge Model Cache & Re-provision", and "Export System Logs to Clipboard/File".

### [DEV-03] Android 13/14 Scoped Permissions & OEM ROM Compat
- **Status**: Open
- **Area**: Platform / Android
- **Context**: Stricter Android 13/14 ROMs (HyperOS, MIUI, One UI) enforce rigid permission boundaries for storage, camera, and audio.
- **Action Items**:
  - [ ] Audit permission request flows for receipt scanning (Camera), file import/export (Read/Write Storage), and voice prompting (Audio Record).
  - [ ] Implement graceful fallback UI explaining exact permission requirements when OEM ROMs silently reject or revoke background capabilities.
