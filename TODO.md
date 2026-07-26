# Silo Local LLM Inference — TODO

## Current State

Silo already uses `llama.rn` (v0.12.1), which is the **industry standard** for
local LLM inference in React Native as of 2026. The library provides:

- Direct C++ (`llama.cpp`) bindings via JSI — no bridge overhead.
- Real-time `onToken` streaming callbacks.
- GPU layer offloading, CPU thread tuning, memory-mapped model loading.
- Warmup, health-check, and cancellation primitives.

The `GenerationService` and `LlamaRnAdapter` already implement this correctly.

However, the codebase still contains a **complete parallel legacy inference
pathway** that is fully dead code. This pathway was the original custom
Kotlin → JNI → C++ (`gguf_runner`) bridge built before `llama.rn` was adopted.

---

## Cleanup Steps (implemented in this commit)

### 1. Remove legacy `localInferenceBridge.ts`
- [x] Delete `src/services/ai/localInferenceBridge.ts` — the entire
  `NativeLocalInferenceBridge` class and `NativeModules`-based bridge that
  called into the custom Kotlin `SiloLocalInferenceModule`.

### 2. Remove legacy bridge imports from `useAIStore.ts`
- [x] Replace the `getNativeLocalInferenceBridge()` import and usage in
  `useAIStore.ts` with a simple Platform-based availability check, since
  `llama.rn` handles all actual native interactions.

### 3. Remove legacy bridge imports from `agent.ts`
- [x] Remove `getNativeLocalInferenceBridge` and
  `isLocalInferenceBackendAvailable` imports. Replace
  `hasUsableLocalInferenceBackend()` with a Platform check.

### 4. Remove legacy bridge imports from `modelLifecycle.ts`
- [x] Remove `getNativeLocalInferenceBridge` import and replace bridge
  availability checks with Platform-based checks.

### 5. Remove dead legacy code paths in `generationService.ts`
- [x] Remove `USE_LLAMA_RN` toggle and all `if (!USE_LLAMA_RN)` branches.
- [x] Remove `ensureLegacyChatRuntimeReady()` method.
- [x] Remove `startLegacyGeneration()` method.
- [x] Remove `askFinancialAgent` and `cancelActiveLocalGeneration` imports
  from `./agent` (only keep `buildPromptForMode` and `buildRetrievedContext`).
- [x] Remove the legacy `ensureLocalRuntimeReady` import.

### 6. Clean up stale config constants
- [x] Remove `LOCAL_INFERENCE_BACKEND`, `LOCAL_INFERENCE_BACKEND_FAMILY`,
  `LOCAL_INFERENCE_PRIMARY_RUNTIME`, `LOCAL_INFERENCE_ONNX_ENABLED` — these
  described the old custom native bridge and are not referenced by `llama.rn`.

### 7. Clean up `localInferenceTypes.ts`
- [x] Remove `LocalInferenceBackendBridge` interface — it described the
  contract for the legacy bridge that no longer exists.

---

## Future Improvements (not in this commit)

### Native Android C++/JNI code removal
- [ ] Remove `android/.../ai/SiloLocalInferenceModule.kt` and
  `SiloLocalInferencePackage.kt` — these are the Kotlin modules that
  registered the custom native bridge.
- [ ] Remove `android/.../cpp/SiloLocalInferenceJni.cpp` and
  `gguf_runner.cpp` / `gguf_runner.h` — these are the C++ JNI wrappers.
- [ ] Remove `libsilo_local_inference.so` build target from `CMakeLists.txt`.
- [ ] Remove manual package registration from `MainApplication.kt`.

  > **Note**: These Android native changes require a full native rebuild and
  > on-device testing. They are tracked separately to avoid breaking the
  > build in a TypeScript-only cleanup commit.

### Model provisioning hardening
- [ ] Implement Android `WorkManager` for background model downloads that
  survive app termination.
- [ ] Add pre-download storage health checks.

### Context window management
- [ ] Implement sliding-window conversation summarization to prevent
  KV-cache exhaustion on long chat sessions.
- [ ] Add explicit token counting before dispatching completions.

### Memory telemetry
- [ ] Surface real-time PSS heap usage in the developer diagnostics screen.
- [ ] Add automatic quantization fallback (`Q4_K_M` → `Q2_K`) on repeated
  out-of-memory failures.
