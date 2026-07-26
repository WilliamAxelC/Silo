

# Silo Local Inference Architecture and Engineering Handoff

## Executive Summary

Silo is a React Native + Expo Android application with a hybrid architecture that combines conventional mobile finance application features with an embedded local AI stack. The application now includes a device-resident inference pathway for offline chat and grounded finance question answering, backed by a custom Android native module, JNI bindings, and a bundled C++ inference runtime. The current implementation supports lazy local runtime initialization, model provisioning, warmup and health gating, chat-oriented pseudo-streaming, cancellation hooks, runtime/event logging, and device-level diagnostics.

The architecture is fundamentally split across five layers:
1. **React Native application/UI layer** for screens, navigation, state, and user-facing AI interactions.
2. **Application service layer** for AI orchestration, chat/prompt composition, runtime readiness checks, and provisioning control.
3. **State and persistence layer** for runtime status, event logs, provisioning state, and SQLite-backed finance data.
4. **Android native bridge layer** exposing local inference operations to JavaScript through a custom package/module.
5. **Native inference runtime layer** implemented in C++ and packaged into the APK as an `arm64-v8a` shared library, with Android-side loading and JNI mediation.

Operationally, the app is now capable of launching, installing, and loading the primary inference shared library on a Poco F5-class Android 14 device. Device diagnostics indicate that the main remaining risks are not baseline ABI compatibility or immediate native library resolution, but rather debug-time Metro connectivity fragility, lifecycle timing sensitivity, model lifecycle robustness, storage pressure, and downstream runtime behavior after startup.

---

# 1. Current Application Architecture

## 1.1 Architectural Overview

The application is a mobile finance app built on Expo-managed React Native, with a custom native Android extension for local large-language-model inference. The most important end-to-end architectural paths are:

- **Finance application flow**: user enters/manages transactions, categories, budgets, and reports using SQLite-backed local data.
- **AI grounded query flow**: JavaScript services derive local financial context from SQLite and generate grounded prompts/responses.
- **AI chat flow**: user opens the chatbot screen, which lazily triggers local runtime preparation, then invokes device-local generation through a native module.
- **Provisioning/runtime flow**: JavaScript state and model lifecycle management determine whether the model is installed, verified, warm, healthy, and ready for inference.
- **Native execution flow**: JavaScript calls into a native bridge; the bridge delegates into JNI; JNI forwards into a C++ inference engine based on a bundled `llama.cpp`-style runtime.

The result is a hybrid system where most product logic remains in TypeScript, but the heavy compute path is delegated to Android-native code.

## 1.2 Top-Level Layers and Responsibilities

### React Native / Expo layer
The React Native layer is responsible for:
- screen composition and UI behavior
- navigation between finance, settings, and chatbot surfaces
- state-driven rendering of model/runtime health
- optimistic message updates in chat
- pseudo-streaming UX and cancellation affordances
- configuration and theme adaptation
- log presentation and system log surfacing

Relevant areas strongly implied by prior work include:
- [`App.tsx`](App.tsx:7)
- [`index.ts`](index.ts:1)
- [`src/navigation/AppNavigator.tsx`](src/navigation/AppNavigator.tsx:89)
- [`src/navigation/types.ts`](src/navigation/types.ts:15)
- [`src/screens/ChatbotScreen.tsx`](src/screens/ChatbotScreen.tsx:15)
- [`src/screens/SettingsScreen.tsx`](src/screens/SettingsScreen.tsx:23)
- [`src/screens/SystemLogsScreen.tsx`](src/screens/SystemLogsScreen.tsx)

### Application service / orchestration layer
This layer coordinates AI-related behavior and acts as the control plane between UI and native inference.

Responsibilities include:
- determining whether local inference can run
- ensuring runtime readiness
- triggering provisioning/model setup if needed
- constructing prompts and grounded retrieval context
- invoking local generation
- performing pseudo-stream replay after final response return
- cancellation handling
- logging runtime events and failures

Relevant files:
- [`src/services/ai/agent.ts`](src/services/ai/agent.ts:488)
- [`src/services/ai/modelLifecycle.ts`](src/services/ai/modelLifecycle.ts:363)
- [`src/services/ai/localInferenceBridge.ts`](src/services/ai/localInferenceBridge.ts:94)
- [`src/services/ai/localInferenceTypes.ts`](src/services/ai/localInferenceTypes.ts:24)
- [`src/services/ai/config.ts`](src/services/ai/config.ts:75)

### State and persistence layer
The state layer centralizes AI runtime state, provisioning progress, logs, and chat history. This allows UI and orchestration logic to coordinate asynchronous native runtime work without directly binding screens to low-level bridge calls.

Responsibilities include:
- chat history state
- per-message status tracking
- runtime availability state
- generation request tracking
- streaming response buffer state
- active status label and phase start time
- provisioning progress and transfer metrics
- event log capture

Relevant files:
- [`src/store/useAIStore.ts`](src/store/useAIStore.ts:236)
- [`src/store/useTransactionStore.ts`](src/store/useTransactionStore.ts:55)
- [`src/store/useSettingsStore.ts`](src/store/useSettingsStore.ts)

Persistence includes:
- local SQLite finance data via [`src/db/index.ts`](src/db/index.ts:1)
- schema/views via [`src/db/schema.ts`](src/db/schema.ts:38)
- app-private model/runtime files inferred from the model lifecycle manager and app-private directories

### Android native bridge layer
This layer exposes a custom module into React Native and mediates JS/native interaction.

Responsibilities include:
- availability checks
- runtime info retrieval
- model load/register entrypoints
- warmup entrypoint
- health check entrypoint
- generation/cancellation entrypoints
- dispatch from Kotlin into JNI/native C++

Relevant files:
- [`android/app/src/main/java/com/will/silo/ai/SiloLocalInferenceModule.kt`](android/app/src/main/java/com/will/silo/ai/SiloLocalInferenceModule.kt:41)
- [`android/app/src/main/java/com/will/silo/ai/SiloLocalInferencePackage.kt`](android/app/src/main/java/com/will/silo/ai/SiloLocalInferencePackage.kt:8)
- [`src/services/ai/localInferenceBridge.ts`](src/services/ai/localInferenceBridge.ts:15)
- [`android/app/src/main/java/com/will/silo/MainApplication.kt`](android/app/src/main/java/com/will/silo/MainApplication.kt:24)

### Native inference runtime layer
This is the compute engine itself.

Responsibilities include:
- native model loading
- tokenization/prompt execution
- response generation
- health checks
- cancellation handling
- low-level memory and context management
- architecture-specific runtime configuration via CMake

Relevant files:
- [`android/app/src/main/cpp/CMakeLists.txt`](android/app/src/main/cpp/CMakeLists.txt:1)
- [`android/app/src/main/cpp/SiloLocalInferenceJni.cpp`](android/app/src/main/cpp/SiloLocalInferenceJni.cpp:166)
- [`android/app/src/main/cpp/gguf_runner.cpp`](android/app/src/main/cpp/gguf_runner.cpp:187)
- [`android/app/src/main/cpp/gguf_runner.h`](android/app/src/main/cpp/gguf_runner.h:7)
- bundled third-party runtime under [`android/app/src/main/cpp/third_party/llama.cpp`](android/app/src/main/cpp/third_party/llama.cpp)

## 1.3 Data and Control Flow

### App startup flow
Probable startup flow is:
1. Expo/React Native boots from [`index.ts`](index.ts:1) into [`App.tsx`](App.tsx:7).
2. Navigation initializes via [`AppNavigator`](src/navigation/AppNavigator.tsx:89).
3. General app state, settings, and SQLite initialization occur.
4. AI runtime is no longer eagerly initialized globally; instead, lazy ownership was moved to the chat screen.
5. The native module is available to React Native through manual package injection in [`MainApplication`](android/app/src/main/java/com/will/silo/MainApplication.kt:24).

### Chat entry flow
When the user navigates to [`ChatbotScreen`](src/screens/ChatbotScreen.tsx:15):
1. The screen reads AI runtime/provisioning state from [`useAIStore`](src/store/useAIStore.ts:236).
2. If chat mode requires local runtime and the runtime is not yet ready, the screen requests lazy initialization.
3. [`ensureLocalRuntimeReady()`](src/services/ai/agent.ts:243) coordinates runtime readiness checks.
4. [`QModelLifecycleManager`](src/services/ai/modelLifecycle.ts:363) initializes state and, if necessary, triggers provisioning/setup.
5. UI surfaces compact model/runtime status and logs.

### Inference request flow
When the user sends a message:
1. The screen optimistically appends a user message and placeholder assistant message.
2. [`askFinancialAgent()`](src/services/ai/agent.ts:488) is invoked.
3. Depending on mode, the service either:
   - uses grounded local data, or
   - builds a chat prompt from history and system prompts.
4. The service invokes local generation through [`runLocalGeneration()`](src/services/ai/agent.ts:415).
5. [`NativeLocalInferenceBridge.generate()`](src/services/ai/localInferenceBridge.ts:169) calls into the Android module.
6. Kotlin bridge forwards into native JNI/C++.
7. C++ runtime performs generation and returns a completed response.
8. JavaScript performs pseudo-stream playback from the final response into the chat store for UX smoothness.
9. The placeholder assistant bubble is updated in place and later marked complete.

### Logging and diagnostics flow
Event logs are appended to AI state and surfaced in two places:
- compact recent/verbose sections in [`SettingsScreen`](src/screens/SettingsScreen.tsx:23)
- dedicated runtime/system view in [`SystemLogsScreen`](src/screens/SystemLogsScreen.tsx)

Native/device-level diagnostics were additionally performed through ADB, including package state, process state, memory, ABI, SoLoader behavior, and filtered launch logs.

---

# 2. How Local Inference Works

## 2.1 Runtime Entry and Availability Model

The local inference stack appears to use a layered readiness model rather than a simple installed/not-installed flag.

Based on the store and lifecycle code, readiness likely depends on:
- whether a usable native backend is compiled into the build
- whether the model artifact exists and is considered valid
- whether the model has completed runtime registration/loading
- whether warmup completed
- whether a health check succeeded
- whether the runtime is not currently busy/provisioning

This logic is exposed to the UI through runtime availability helpers such as [`getAIRuntimeAvailability()`](src/store/useAIStore.ts:125).

## 2.2 Model Provisioning and Installation

The model lifecycle manager in [`src/services/ai/modelLifecycle.ts`](src/services/ai/modelLifecycle.ts:363) appears to control:
- persisted model location discovery
- download/provision decisions
- filesystem layout creation
- verification/finalization of downloaded artifacts
- runtime registration
- warmup
- health checks
- optional local indexing step

From prior modifications and comments, the provisioning behavior was hardened to be **atomic** and to avoid treating partial downloads as installed. This is significant because large local models are prone to partial-file corruption, interrupted installs, and stale state after app restarts.

Likely stages include:
1. queued
2. downloading
3. verifying
4. unpacking/moving into final location
5. registering with the runtime
6. warming
7. indexing / finalizing
8. ready

These states are reflected through UI messaging and compact loader status in [`ChatbotScreen`](src/screens/ChatbotScreen.tsx:219).

## 2.3 Native Library Loading

The packaged inference engine is built as a shared library via [`CMakeLists.txt`](android/app/src/main/cpp/CMakeLists.txt:53), producing [`libsilo_local_inference.so`](android/app/src/main/cpp/CMakeLists.txt:53).

Device diagnostics confirmed the following runtime behavior on Poco F5:
- app package primary ABI is `arm64-v8a`
- the APK exposes `base.apk!/lib/arm64-v8a`
- SoLoader prepares both direct-apk and extracted app library sources
- native loader successfully loads [`libsilo_local_inference.so`](android/app/src/main/cpp/CMakeLists.txt:53)

This means the base launch path can resolve the shared library successfully on at least one Android 14 Poco F5-class device.

## 2.4 ABI and Packaging Considerations

The APK is configured with ABI filters in [`android/app/build.gradle`](android/app/build.gradle:109):
- `arm64-v8a`
- `armeabi-v7a`
- `x86_64`

The Poco F5 device reports `arm64-v8a`, matching the package’s primary ABI.

The package dump also reported:
- `extractNativeLibs=false`
- `primaryCpuAbi=arm64-v8a`

This means the package is likely relying on direct APK loading for native libraries rather than legacy extraction, which is consistent with modern Android packaging and SoLoader behavior.

## 2.5 JNI Boundary and Bridge Flow

The bridging path likely looks like this:

1. JS calls a typed wrapper in [`localInferenceBridge.ts`](src/services/ai/localInferenceBridge.ts:94).
2. That wrapper calls methods on [`NativeModules`](src/services/ai/localInferenceBridge.ts:28).
3. Android routes the call to [`SiloLocalInferenceModule`](android/app/src/main/java/com/will/silo/ai/SiloLocalInferenceModule.kt:41).
4. Kotlin marshals request data and invokes JNI methods such as native generate/load/health-check functions.
5. JNI in [`SiloLocalInferenceJni.cpp`](android/app/src/main/cpp/SiloLocalInferenceJni.cpp:166) converts to C++ structures and calls the underlying runner.
6. [`gguf_runner.cpp`](android/app/src/main/cpp/gguf_runner.cpp:338) handles execution and returns results back through JNI → Kotlin → JS.

This is a classic React Native custom-module architecture with a JavaScript wrapper, Kotlin module, JNI adapter, and C++ runtime.

## 2.6 Model Initialization Flow

The most probable cold-start sequence for local inference is:
1. detect native backend availability
2. locate or provision model artifact
3. initialize filesystem layout
4. register/load model into native runtime
5. run a warmup prompt
6. run a health check prompt/request
7. mark runtime healthy and model loaded
8. enable chat mode send flow

This sequence is supported by prior code readings of [`registerWarmupAndIndex()`](src/services/ai/modelLifecycle.ts:861) and the store fields tracking:
- `modelLoaded`
- `generationHealthy`
- `runtimeState`
- `activeGenerationRequestId`
- `activeStatusLabel`
- `activePhaseStartedAt`

## 2.7 Inference Execution and Result Delivery

The currently implemented result path is **not native token streaming**. Instead:
- native bridge returns a completed generation result
- JS pseudo-streams the final text in chunks for UI responsiveness

This matters operationally:
- the real generation still blocks until native compute returns
- user-perceived streaming is simulated afterward
- cancellation exists both for native request cancellation and for JS playback interruption semantics

Relevant elements include:
- [`chunkResponseText()`](src/services/ai/agent.ts:348)
- [`pseudoStreamResponse()`](src/services/ai/agent.ts:354)
- [`cancelActiveLocalGeneration()`](src/services/ai/agent.ts:377)
- [`runLocalGeneration()`](src/services/ai/agent.ts:415)

## 2.8 Memory Implications

Local model inference has significant memory implications:
- the model artifact itself is large and storage-heavy
- model registration/load likely allocates large native heaps and context buffers
- warmup and generation create additional temporary allocations
- health checks and indexing may create extra memory churn at startup

ADB meminfo during app idle/runtime showed moderate app memory at baseline (~80 MB PSS), but this does not capture peak model-load or generation pressure. The real memory pressure will occur during:
- model load/register
- prompt tokenization
- context creation
- generation loop
- multi-thread compute work

Potential memory hazards include:
- low-memory kills on constrained devices
- fragmentation in native heap
- large prompt/history growth
- repeated warmup/register cycles if lifecycle gating is unstable

## 2.9 Threading and Execution Characteristics

At minimum, the local inference system likely spans:
- Android UI thread
- React Native JS thread
- native module background executor thread(s)
- JNI/native inference execution thread(s)
- file I/O / download callback threads

This is discussed in detail in the threading section below, but the important point here is that local inference correctness depends on not doing model load or generation work on the UI thread.

## 2.10 Cold Start vs Warm Run Behavior

### Cold start behavior
Cold start is likely dominated by:
- package/app startup
- JS runtime boot
- lazy chat runtime initialization
- model registration/load
- warmup
- health checks
- optional index/retrieval prep

This is the slowest path and is explicitly surfaced in UI now via compact loading state, elapsed timers, and event logs.

### Warm run behavior
Once the runtime is already registered, warm, and healthy:
- chat screen can open faster
- prompt build is mostly JS-side work
- native generation can begin sooner
- the app skips provisioning/register/warmup phases

### Failure surfaces during cold start
Cold start is also where most failures will appear:
- missing or partial model files
- storage exhaustion
- path resolution problems
- runtime health check failure
- native load failure
- permissions or file access constraints
- thread starvation or ANR if orchestration is incorrect

---

# 3. Potential Issues

## 3.1 Operational and Packaging Risks

### ABI / native packaging risk
Although current diagnostics ruled out a simple Poco F5 ABI mismatch, the architecture still carries ABI risks:
- any future split-APK mispackaging could omit `arm64-v8a`
- changes to `abiFilters` in [`android/app/build.gradle`](android/app/build.gradle:109) could silently break specific devices
- extracted vs direct-apk native loading differences can behave differently across OS versions and vendors

### Native library load-order risk
The presence of SoLoader, app-private library directories, and direct APK loading means that changes in:
- packaging
- namespace resolution
- dependent shared libraries
- STL linkage
could create launch-time failures that would present as `UnsatisfiedLinkError`, `dlopen failed`, or early process death.

## 3.2 Runtime and Lifecycle Risks

### Debug launch instability vs production startup
Device diagnostics strongly suggest that at least one observed “launch failure” on Poco F5 was actually a **debug-mode Metro connectivity/lifecycle problem**, not a base native crash.

Evidence pattern included:
- no fatal Java exception
- no immediate native fatal signal
- app process starts and remains alive
- repeated [`ReactNativeJNI`](android) websocket errors to `localhost:8081`
- eventual successful [`Running "main"`](index.ts:1)

This means debug startup can be confounded by:
- missing [`adb reverse`](android)
- transient ADB transport loss
- Metro startup timing
- app force-stop/relaunch timing

### Activity visibility/lifecycle timing risk
Earlier diagnostics showed cases where:
- [`MainActivity`](android/app/src/main/java/com/will/silo/MainActivity.kt:14) existed in task history
- but launcher remained resumed
- activity was paused/invisible

This indicates lifecycle timing sensitivity during launch/relaunch. While not necessarily a persistent production issue, it is a real debugging hazard and could mask actual startup issues.

### Lazy-init lifecycle race risk
Moving runtime ownership into the chat screen improved startup responsiveness, but creates race conditions if not carefully managed:
- repeated enters/exits of chat screen
- unmount while runtime init still in flight
- toggling chat/grounded modes while setup is incomplete
- stale request IDs or streaming state surviving navigation transitions

## 3.3 Storage and Filesystem Risks

### High storage usage on device
Poco F5 diagnostics showed storage usage near 94% on the checked storage path. Large local model workflows are especially vulnerable to:
- failed downloads
- insufficient temporary space for verification/moves
- cache pressure
- filesystem fragmentation
- partial install rollback issues

### Model path and persistence risks
Model lifecycle code likely handles app-private directories and path normalization. Risks remain around:
- moved/invalid file paths after reinstall/update
- partial cleanup leaving stale state
- differences between app-private and shared storage behavior across Android versions
- file-system APIs that load large files into JS memory if misused

## 3.4 Memory and Compute Risks

### Native heap pressure
Large model load and generation can spike native heap use. Risks include:
- low-memory process death on older devices
- allocator fragmentation
- insufficient headroom for warmup + generation + app UI

### CPU/thermal throttling
Poco F5-class devices are powerful, but sustained inference can still trigger:
- thermal throttling
- battery drain
- inconsistent response latency
- vendor scheduler behavior affecting thread performance

### Architecture-specific optimization risks
[`CMakeLists.txt`](android/app/src/main/cpp/CMakeLists.txt:15) conditionally enables architecture-tuned settings for `arm64-v8a`, including CPU-specific optimizations. These can produce device-specific issues even if one ARM64 device works and another does not.

## 3.5 Threading and Synchronization Risks

Potential hazards include:
- blocking the React Native bridge with large result marshaling
- executing model load/generation on the wrong thread
- overlapping runtime init and generation requests
- racing cancellation vs response completion
- leaving stale `activeGenerationRequestId` state after edge-case failures

Pseudo-streaming adds another subtle risk: the user sees incremental output, but actual compute completed earlier. If state handling is imperfect, message completion/cancellation/error transitions can become inconsistent.

## 3.6 Permissions and Platform Risks

Poco F5 package inspection showed denied permissions for:
- camera
- read external storage
- write external storage
- record audio

These do not block core app launch, but they can impact:
- OCR/image import paths
- file-based model import/export if ever added
- any attachment/media-driven workflows

On Android 13/14 and HyperOS-like environments, storage behavior is stricter and legacy assumptions can fail.

## 3.7 Logging and Observability Risks

Although in-app runtime/event logs now exist, there are still observability gaps:
- native crash breadcrumbs may not correlate cleanly with JS logs
- model load timing and memory peaks are not fully surfaced in-app
- launch diagnostics still depend heavily on ADB/logcat/manual inspection
- repeated Metro/debug-only failures can obscure production-relevant issues

---

# 4. Further Improvements

## 4.1 Priority 0: Production Launch Validation

### Build and validate a real release/preview build
The debug app’s dependency on Metro makes launch behavior ambiguous. Priority should be:
1. produce a real release-like APK
2. validate startup on Poco F5 and at least one lower-end device
3. separate debug-only issues from actual application/runtime issues

This is especially relevant because pending work still includes release APK generation and configuration verification.

## 4.2 Priority 1: Strengthen Startup and Runtime Diagnostics

### Add explicit startup stage logging
Startup logs should clearly separate:
- app process start
- React root creation
- JS runtime start
- store initialization
- DB initialization
- AI runtime backend availability probe
- model lifecycle manager init
- first chat-screen lazy init

### Add native runtime event tagging
Native module and JNI should log:
- library load start/end
- model load start/end
- warmup start/end
- health check start/end
- generate start/end/cancel
- exceptions and timing

### Add on-screen debug diagnostics toggle
A developer-facing diagnostics panel could show:
- RN architecture mode
- Metro connectivity state (debug only)
- backend availability
- primary ABI
- current runtime status
- model path
- generation request ID

## 4.3 Priority 2: Harden Model Lifecycle Robustness

### Persist and validate model state more defensively
Recommended improvements:
- explicit model manifest with checksum and ABI/runtime metadata
- startup self-check that distinguishes “installed” vs “usable” vs “verified”
- strict recovery path if registration/warmup dies mid-cycle

### Separate provisioning from runtime activation
Current flow appears coupled. Consider splitting into:
- artifact install state
- runtime activation state
- warmup/health state
- retrieval/index readiness state

This improves recoverability and makes UI clearer.

## 4.4 Priority 3: Improve Thread and Work Scheduling

### Isolate heavyweight operations more explicitly
Recommendations:
- dedicated single-thread executor for model load/unload transitions
- separate worker queue for generation requests
- explicit cancellation tokens propagated across JS → Kotlin → JNI → C++
- avoid sharing mutable runtime state across multiple executor contexts without clear serialization

### Add timeouts and watchdogs
Model load, warmup, and health checks should have bounded failure behavior so the UI cannot remain indefinitely in a semi-busy state.

## 4.5 Priority 4: Performance and Memory Hardening

### Instrument peak memory during critical phases
Capture telemetry for:
- model registration memory peak
- warmup peak
- generation peak
- prompt size vs latency vs memory

### Bound chat context size
Prompt history summarization or truncation should be explicit and measurable. Otherwise:
- tokenization cost grows
- generation latency rises
- memory churn increases

### Make warmup configurable
For weaker devices, consider:
- lighter warmup prompts
- deferred warmup
- optional no-warmup fallback after repeated failures

## 4.6 Priority 5: UX and Failure Recovery

### Better fallback states
Recommended UX additions:
- explicit “debug/Metro unavailable” state in debug builds
- explicit “model installed but runtime unhealthy” state
- one-tap runtime reset
- one-tap clear model artifacts and reprovision
- clearer storage pressure warnings before large downloads

### Improve cancellation semantics
Current cancel flow exists, but production hardening should ensure:
- cancel is idempotent
- cancel after native completion is harmless
- UI cannot get stuck in streaming/busy state

## 4.7 Testing Recommendations

### Device matrix
At minimum test across:
- Android 14 flagship ARM64 (e.g. Poco F5 class)
- older ARM64 device
- lower-RAM Android device
- clean install and reinstall states
- offline/no-Metro conditions for release-like builds

### Test categories
- cold app start
- first chat entry with no model installed
- first chat entry with model installed but not warmed
- generation success
- generation cancel
- interrupted provisioning
- low-storage provisioning failure
- app kill during load/generation
- app relaunch with partially initialized runtime state

---

# 5. Threading Model

## 5.1 Current Threading Overview

The system likely operates across the following execution domains:

1. **Android main/UI thread**
2. **React Native JavaScript thread**
3. **React Native bridge/native module dispatch thread(s)**
4. **Native module background executor**
5. **JNI/native inference execution thread(s)**
6. **Download/filesystem callback threads**

The architecture is workable, but only if heavyweight work is never allowed to block UI-affecting threads.

## 5.2 Android Main/UI Thread

### Responsibilities
- app/activity lifecycle handling
- view inflation and window attach/detach
- rendering and input handling
- navigation transitions
- keyboard/layout behavior
- bridge/module registration at startup

### Must not happen here
The following must not run on the main thread:
- model load/register
- GGUF parsing
- warmup generation
- health check generation
- full inference generation
- large file copy/verification
- checksum over large model artifacts

### Risks
If any of these bleed onto the main thread, likely outcomes are:
- frozen launch
- ANR
- dropped frames
- OEM launcher returning to home due to unresponsive startup

## 5.3 React Native JavaScript Thread

### Responsibilities
- screen logic
- state transitions in stores
- chat prompt composition
- pseudo-streaming playback
- orchestration decisions
- log/event writes

### Current likely load profile
JS is currently doing:
- chat history updates
- runtime status updates
- loading/provisioning UI decisions
- pseudo-stream chunk replay after native completion

This is acceptable, but JS can still become overloaded if:
- log volume becomes excessive
- pseudo-stream chunk cadence is too aggressive
- long synchronous prompt assembly or DB work is added

### Risks
- UI appears frozen if JS is blocked even when native is healthy
- state races between runtime callbacks and user navigation
- stale pending assistant message references

## 5.4 Native Module Background Worker Thread(s)

### Likely responsibilities
[`SiloLocalInferenceModule`](android/app/src/main/java/com/will/silo/ai/SiloLocalInferenceModule.kt:41) appears to dispatch work on background executors rather than doing expensive work inline. Likely responsibilities:
- library availability checks
- dispatching load/generate/cancel to native
- marshalling request/response payloads
- isolating bridge calls from UI thread

### Risks
- multiple concurrent requests against a single runtime without serialization
- cancellation arriving while response marshaling is in progress
- thread starvation if provisioning and generation share the same limited executor

## 5.5 JNI / Native Inference Thread(s)

### Responsibilities
- actual model context lifecycle
- tokenization
- generation loop
- cancellation flag checks
- health check and warmup prompt execution

### Contention risks
- model load and generation overlapping unsafely
- cancellation flag synchronization mistakes
- shared context usage without sufficient locking
- thread oversubscription when OpenMP/native compute threads compete with Android scheduler

### Performance hazards
On modern ARM64 devices, compute libraries may use multiple worker threads aggressively. Risks include:
- thermal spikes
- poor foreground responsiveness if CPU saturation is excessive
- latency jitter across devices

## 5.6 Filesystem / Provisioning Threads

### Responsibilities
- download progress callbacks
- temp file creation
- verification/move/finalization
- manifest/state persistence
- app-state resume/recovery checks

### Risks
- filesystem mutation while runtime tries to load the same artifact
- interrupted move leaving invalid state
- UI state divergence if progress persists but runtime activation fails

## 5.7 Synchronization Boundaries

The system has several critical synchronization boundaries:

### JS store ↔ native runtime state
The JS store tracks a representation of runtime status, but the actual truth lives partly in native code. Any mismatch can cause:
- send enabled when runtime is actually unavailable
- stuck busy UI when native is already idle
- lost cancellation state

### Provisioning state ↔ runtime activation state
These should be serialized carefully. A model should not be treated as ready merely because the file exists.

### Generation request ID ↔ message placeholder state
Pseudo-streaming and cancellation rely on consistent request/message mapping. If that link breaks:
- wrong assistant bubble may be updated
- duration metrics may attach to wrong message
- stale streaming text may appear after cancel

## 5.8 Where ANRs or Races Could Emerge

### Potential ANR sources
- native load/generate accidentally touching UI thread
- too much synchronous JS work during startup or chat send
- large filesystem work on main thread
- blocking bridge waits from JS into native

### Potential race conditions
- chat screen unmount during runtime init
- send pressed while runtime state flips from ready → busy
- cancel pressed while native returns success
- provisioning resume after app returns foreground while chat screen is also requesting runtime init
- old request ID lingering after generation failure

## 5.9 Recommended Threading Improvements

- dedicate a **single serialized runtime-control executor** for load/unload/register/warmup/health transitions
- keep **generation execution** on a separate controlled worker path
- use explicit state-machine transitions rather than loosely coupled booleans
- add defensive checks before updating JS message placeholders after async completions
- introduce structured trace logging with thread names / request IDs

---

# 6. Android Device Diagnostics Interpretation

## 6.1 What was inspected
Prior diagnostics covered:
- ADB connection and authorization
- device identity, Android version, CPU ABI, fingerprint
- battery and storage state
- package installation and launcher resolution
- package dump including CPU ABI and extraction behavior
- process existence via `pidof`
- runtime memory via `top` and `dumpsys meminfo`
- SoLoader/native load behavior
- force-stop and relaunch cycles
- filtered logcat for `ReactNativeJS`, `Expo`, `SoLoader`, `UnsatisfiedLinkError`, `dlopen`, `linker`, `fatal signal`, and activity lifecycle lines
- activity/task visibility state via `dumpsys activity activities`

## 6.2 What diagnostics established
### Established facts
- [`com.will.silo`](android/app/build.gradle:92) is installed
- launch activity resolves
- app process starts
- app can remain alive after launch
- native library resolution succeeds for `arm64-v8a`
- no obvious launch-time `FATAL EXCEPTION` or `UnsatisfiedLinkError` was captured in the filtered runs

### Important contextual signal
One observed launch problem on Poco F5 aligned more closely with a **debug Metro connectivity / lifecycle timing issue** than with a native packaging crash. The presence of [`ReactNativeJS: Running "main"`](index.ts:1) after transport recovery strongly suggests that the JS runtime can initialize successfully once the debug path is healthy.

This is significant because it narrows launch instability from “mysterious native crash” toward “debug startup infrastructure and lifecycle timing.”

---

# 7. Recommended Near-Term Engineering Plan

## 7.1 Immediate next actions
1. Produce and validate a real release-like build on Poco F5.
2. Add startup-stage instrumentation in JS, Kotlin, and JNI.
3. Log runtime transitions with request IDs and wall-clock durations.
4. Add a developer diagnostics panel in-app.
5. Stress test model lifecycle under low storage and app-kill scenarios.

## 7.2 Medium-term actions
1. Refactor runtime readiness into a stricter state machine.
2. Separate artifact install state from native activation state.
3. Improve cancellation and idempotent cleanup semantics.
4. Bound history/prompt growth and capture memory/latency telemetry.
5. Add automated device-matrix validation for install, launch, and first-generation paths.

## 7.3 Longer-term hardening
1. Evaluate moving from bridge-style native module toward a New Architecture-compatible typed module path.
2. Improve persistent runtime health recovery after crashes or interrupted provisioning.
3. Introduce structured native telemetry and optional crash breadcrumb persistence.
4. Consider a dedicated release/preview pipeline that is independent of Metro/debug constraints for QA and field validation.

---

# 8. Risk Register

| ID | Risk | Area | Likelihood | Impact | Evidence / Rationale | Recommended Mitigation |
|---|---|---|---|---|---|---|
| R1 | Debug launch appears broken due to Metro/ADB reverse instability | Dev workflow | High | Medium | Prior Poco F5 diagnostics showed startup sensitivity tied to debug transport and `localhost:8081` behavior | Validate with release-like builds; automate debug setup; improve startup diagnostics |
| R2 | Model provisioning fails under low storage | Storage / lifecycle | High | High | Device diagnostics showed high storage usage; model artifacts are large and multi-stage | Preflight storage checks, fail-fast messaging, cleanup tooling |
| R3 | Runtime state diverges from actual native state | Orchestration | Medium | High | JS store mirrors native readiness through async operations and multiple phases | Introduce stricter runtime state machine and reconciliation |
| R4 | Native memory pressure during model load/generation | Runtime / native | Medium | High | Large local models imply heavy native heap/context allocation | Add memory telemetry, reduce model/context footprint, tune warmup |
| R5 | Device-specific ARM64 optimization path causes instability | Native compatibility | Medium | High | `arm64-v8a` path uses optimized native configuration; device behavior can vary | Add device-matrix testing, fallback runtime flags, native diagnostics |
| R6 | Cancellation/generation race corrupts UI message state | UX / async control | Medium | Medium | Pseudo-streaming, request IDs, and async completion/cancel overlap | Strengthen request/message correlation and idempotent transitions |
| R7 | Launch-time ANR or invisible activity due to lifecycle/thread blocking | Startup / UI | Medium | High | Prior activity/task inspection showed paused/invisible states during problematic launches | Ensure no heavy work on main thread; instrument startup timing |
| R8 | Permissions assumptions break OCR/media/file flows on Android 13/14 | Platform / permissions | Medium | Medium | Camera/storage/audio permissions were denied on device | Request permissions contextually; add capability/fallback checks |
| R9 | Partial or stale model artifacts create false-ready state | Provisioning | Medium | High | Large downloads and interrupted flows are inherently fragile | Keep atomic install semantics; verify artifacts before activation |
| R10 | Limited native observability slows production triage | Diagnostics | Medium | Medium | Current diagnostics rely heavily on manual ADB/logcat inspection | Add structured logs, event IDs, runtime traces, and in-app diagnostics |