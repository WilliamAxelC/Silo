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

## Completed Architecture & Cleanup Steps

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

### 8. Output Formatting & Stream Sanitization
- [x] Strip internal chain-of-thought reasoning blocks (`<think>...</think>`) from instruct/reasoning models (such as Qwen 2.5/3.5) during both live token streaming and completion.
- [x] Filter out all ChatML conversation control markers (`<|im_start|>assistant`, `<|im_end|>`, `<|endoftext|>`, etc.).
- [x] Hold back unclosed `<think>` tags during live streaming so the chat UI displays the `Thinking…` loading indicator cleanly without raw XML leakage.

### 9. Native Android Legacy Code Removal
- [x] Remove `android/.../ai/SiloLocalInferenceModule.kt` and `SiloLocalInferencePackage.kt` — the Kotlin modules that registered the custom native bridge.
- [x] Remove `android/.../cpp/SiloLocalInferenceJni.cpp` and `gguf_runner.cpp` / `gguf_runner.h` — the C++ JNI wrappers.
- [x] Remove `libsilo_local_inference.so` build target from `CMakeLists.txt`.
- [x] Remove manual package registration from `MainApplication.kt`.

### 10. External API / Cloud Inference Pathway
- [x] Implement dual inference mode switching (`on-device` vs. `external API`) in Settings and chat store.
- [x] Add provider presets (OpenAI, Ollama, Custom API) with configurable endpoint URL, model name, and API key.
- [x] Integrate real-time XHR streaming (`data: ...` Server-Sent Events) for external chat completions with automatic reasoning block and ChatML sanitization.

### 11. Model Provisioning Hardening
- [x] Implement Android background download sessions (`FileSystemSessionType.BACKGROUND`) for model downloads that survive app backgrounding/termination.
- [x] Add pre-download disk storage health checks (`checkDiskStorageHealth`) with actionable low-storage warnings and critical error states.

### 12. Context Window Management
- [x] Implement sliding-window conversation summarization (`manageContextWindow`) to prevent KV-cache exhaustion on long chat sessions.
- [x] Add explicit token counting and context token budgeting before dispatching chat completions.

### 13. Memory Telemetry & Diagnostics
- [x] Record and surface memory telemetry snapshots (`pssBytes`, `totalRamBytes`, `activeQuantization`, `fallbackTriggered`) in the store and developer diagnostics.

---

## Future Improvements

### External API Enhancements
- [ ] Add support for additional authentication schemes and custom headers (e.g., Anthropic Claude API, Google Gemini API).
- [ ] Implement automatic failover from local on-device inference to External API when device RAM or battery is critically low.
- [ ] Allow customizable system prompts per inference mode in user settings.

### Advanced RAG & Grounding Capabilities
- [ ] Implement full-text SQLite indexing (FTS5) or vector embeddings for semantic search across transaction histories and receipt OCR text.
- [ ] Enable multi-turn conversational follow-ups on grounded RAG financial queries.
- [ ] Support interactive data visualizations and chart rendering directly within chat response bubbles.

### Model Provisioning & Storage Management
- [x] Add an interactive model management UI in Settings allowing users to delete downloaded weights or switch between different GGUF quantization tiers (e.g., `Q4_K_M`, `Q2_K`, `INT4`) on demand.
- [x] Support Wi-Fi-only download restrictions for OTA model provisioning.
- [x] Add automatic quantization fallback (`Q4_K_M` → `Q2_K`) on repeated out-of-memory failures during model initialization.

- [ ] Add some test cases for LLM inference.
- [x] Implement Local Bill OCR Capabilities, be it by MLKit or PaddleOCR. The results of the OCR will then have the data extracted by an LLM to automatically create transactions.