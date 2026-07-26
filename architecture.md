# Silo Application Architecture & System Design

## 1. Executive Summary

**Silo** is a high-performance, privacy-first mobile personal finance application built on **React Native** and **Expo (Android)**. Unlike traditional cloud-dependent finance tools, Silo employs a **hybrid architecture** that seamlessly unites conventional financial management (transactions, budgets, categories, and analytical reporting) with an **embedded, on-device Large Language Model (LLM) inference stack**.

The application is engineered to operate **completely offline by default**. All user financial records are persisted locally in SQLite, and artificial intelligence capabilities—such as conversational financial querying, grounded Retrieval-Augmented Generation (RAG), and receipt OCR—execute directly on the user's mobile device. This is achieved by orchestrating local quantized GGUF models (primarily **Qwen 3.5 2B INT4**) via native C++ inference runtimes (`llama.rn` and custom JNI bindings), ensuring zero external data exfiltration and deterministic offline functionality.

---

## 2. Top-Level Architectural Layers

The system is fundamentally organized into five decoupled layers, separating presentation from heavy computation and state management:

```
+-----------------------------------------------------------------------------------+
|                        1. PRESENTATION & UI LAYER                                 |
|   React Native Screens, Optimistic Chat UX, Theme Adaptation, Pseudo-Streaming    |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
|                  2. APPLICATION SERVICE & ORCHESTRATION LAYER                     |
|   GenerationService, QModelLifecycleManager, RAG Prompt Builder, OCR Scanner      |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
|                      3. STATE & PERSISTENCE LAYER                                 |
|   Zustand Stores (useAIStore, useTransactionStore), SQLite / Drizzle ORM Schema   |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
|                     4. NATIVE BRIDGE & ADAPTATION LAYER                           |
|   LlamaRnAdapter, SiloLocalInferenceBridge, Kotlin Native Module Medition         |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
|                    5. NATIVE INFERENCE & COMPUTE LAYER                            |
|   llama.rn / llama.cpp Shared Lib (libsilo_local_inference.so), GGUF Runner       |
+-----------------------------------------------------------------------------------+
```

### 2.1 Presentation & UI Layer
Responsible for screen composition, navigation, responsive layout, and visual feedback during CPU/GPU intensive tasks.
- **Entry & Navigation**: Bootstrapped via [index.ts](file:///d:/Project/Silo/silo-app/index.ts) and [App.tsx](file:///d:/Project/Silo/silo-app/App.tsx), routing through [AppNavigator.tsx](file:///d:/Project/Silo/silo-app/src/navigation/AppNavigator.tsx) using React Navigation bottom tabs and native stacks.
- **Chat & AI Interaction**: [ChatbotScreen.tsx](file:///d:/Project/Silo/silo-app/src/screens/ChatbotScreen.tsx) manages conversational interfaces, rendering optimistic message bubbles, pseudo-streaming text playback, and compact model provisioning progress bars.
- **Settings & Diagnostics**: [SettingsScreen.tsx](file:///d:/Project/Silo/silo-app/src/screens/SettingsScreen.tsx) and [SystemLogsScreen.tsx](file:///d:/Project/Silo/silo-app/src/screens/SystemLogsScreen.tsx) expose runtime health, active backend status (`llama.rn` vs CPU fallback), and real-time event logs.

### 2.2 Application Service & Orchestration Layer
Acts as the control plane between user intent and low-level data/inference engines.
- **AI Orchestration & Generation**: [generationService.ts](file:///d:/Project/Silo/silo-app/src/services/ai/generationService.ts) and [agent.ts](file:///d:/Project/Silo/silo-app/src/services/ai/agent.ts) coordinate chat readiness, mode switching (general chat vs. grounded financial Q&A), prompt synthesis, and token sanitization (removing control tokens like `<|im_start|>`, `<|im_end|>`, and `<|endoftext|>`).
- **Model Lifecycle & OTA Provisioning**: [modelLifecycle.ts](file:///d:/Project/Silo/silo-app/src/services/ai/modelLifecycle.ts) (`QModelLifecycleManager`) handles on-demand Over-The-Air (OTA) downloading of model weights, resumable transfer persistence, checksum integrity verification, active directory placement, and warmup execution.
- **Hardware Profile & Budgets**: [hardware.ts](file:///d:/Project/Silo/silo-app/src/services/ai/hardware.ts) evaluates device RAM, computes safe memory budgets (`buildMemoryBudget`), and resolves recommended CPU threads and GPU layer offloading rules.
- **Domain Services**: Coordinates transaction calculation, category mapping ([mappers.ts](file:///d:/Project/Silo/silo-app/src/features/transactions/mappers.ts)), and receipt image OCR processing.

### 2.3 State & Persistence Layer
Centralizes asynchronous runtime state and relational financial data to decouple UI rendering from blocking background tasks.
- **In-Memory State (Zustand)**:
  - [useAIStore.ts](file:///d:/Project/Silo/silo-app/src/store/useAIStore.ts): Tracks runtime availability, active request IDs, streaming buffers, OTA download progress metrics (`downloadedBytes`, `totalBytes`, `throughput`), and structured event logs.
  - [useTransactionStore.ts](file:///d:/Project/Silo/silo-app/src/store/useTransactionStore.ts): Maintains cached financial transactions and categories.
  - [useSettingsStore.ts](file:///d:/Project/Silo/silo-app/src/store/useSettingsStore.ts): Manages user preferences (theme, currency, formatting).
- **Relational Storage (SQLite + Drizzle ORM)**:
  - [index.ts](file:///d:/Project/Silo/silo-app/src/db/index.ts) and [schema.ts](file:///d:/Project/Silo/silo-app/src/db/schema.ts): Defines local SQLite tables for transactions, transaction items, budgets, app settings (key-value store), and type-aware categories (split income vs. expense model).

### 2.4 Native Bridge & Adaptation Layer
Provides idiomatic TypeScript interfaces for native Android capabilities.
- **Llama.rn Adapter**: [llamaRnAdapter.ts](file:///d:/Project/Silo/silo-app/src/services/ai/llamaRnAdapter.ts) wraps the third-party `llama.rn` module, managing native context initialization (`initLlama`), warmup execution (`runWarmup`), completion dispatch, and graceful fallback from GPU to CPU execution.
- **Legacy Custom Inference Bridge**: [localInferenceBridge.ts](file:///d:/Project/Silo/silo-app/src/services/ai/localInferenceBridge.ts) interfaces with custom native Android modules ([SiloLocalInferenceModule.kt](file:///d:/Project/Silo/silo-app/android/app/src/main/java/com/will/silo/ai/SiloLocalInferenceModule.kt) and [SiloLocalInferencePackage.kt](file:///d:/Project/Silo/silo-app/android/app/src/main/java/com/will/silo/ai/SiloLocalInferencePackage.kt)), registered in [MainApplication.kt](file:///d:/Project/Silo/silo-app/android/app/src/main/java/com/will/silo/MainApplication.kt).

### 2.5 Native Inference & Compute Layer
The high-performance C++/JNI compute engine responsible for LLM execution on ARM64 mobile hardware.
- **Native JNI Core**: [SiloLocalInferenceJni.cpp](file:///d:/Project/Silo/silo-app/android/app/src/main/cpp/SiloLocalInferenceJni.cpp) and [gguf_runner.cpp](file:///d:/Project/Silo/silo-app/android/app/src/main/cpp/gguf_runner.cpp) implement direct GGUF model loading, tokenization, multi-threaded evaluation, and cancellation polling.
- **Build & Linkage**: Configured via [CMakeLists.txt](file:///d:/Project/Silo/silo-app/android/app/src/main/cpp/CMakeLists.txt), producing the `libsilo_local_inference.so` shared library packaged for `arm64-v8a` architectures with optional CPU-specific ARMNEON optimizations.

---

## 3. Key Architectural Workflows

### 3.1 Lazy App Boot & Runtime Initialization
To ensure sub-second app launch times and avoid unnecessary RAM consumption, the LLM runtime is **never eagerly loaded** at application startup.
1. Application boots into [App.tsx](file:///d:/Project/Silo/silo-app/App.tsx) and initializes SQLite and general settings.
2. [QModelLifecycleManager](file:///d:/Project/Silo/silo-app/src/services/ai/modelLifecycle.ts) performs a lightweight background check for existing model manifests and resumable transfers.
3. When the user opens [ChatbotScreen.tsx](file:///d:/Project/Silo/silo-app/src/screens/ChatbotScreen.tsx), `GenerationService.ensureChatRuntimeReady()` is invoked.
4. If `USE_LLAMA_RN` is active, [LlamaRnAdapter](file:///d:/Project/Silo/silo-app/src/services/ai/llamaRnAdapter.ts) evaluates device RAM against `buildMemoryBudget()`.
5. The GGUF model is loaded into native memory (attempting GPU layer offload first, falling back to CPU threads if VRAM/initialization fails), followed by an automatic warmup completion prompt (`QWEN_MODEL_WARMUP_PROMPT`).

### 3.2 Over-The-Air (OTA) Model Provisioning Lifecycle
Because 2B INT4 GGUF models are 1.5GB–2.5GB in size, bundling them directly into the APK is impractical. Silo implements an atomic OTA provisioning state machine in [modelLifecycle.ts](file:///d:/Project/Silo/silo-app/src/services/ai/modelLifecycle.ts):
```
[not-installed] ---> [queued] ---> [downloading] <---> [paused / interrupted]
                                        |
                                        v
[ready] <--- [indexing/warming] <--- [registering] <--- [verifying & unpacking]
```
- **Resumable Transfers**: Progress and session identifiers are persisted to `AI_TRANSFER_MANIFEST_FILE`. If the app is closed or backgrounded, `restorePersistedState()` reconciles partial downloads upon relaunch.
- **Atomic Placement & Rollback**: Downloaded artifacts are placed in a temporary directory during verification. Only after passing integrity checks are they atomically moved to the active model root, preventing corrupt partial files from breaking inference.

### 3.3 Grounded RAG Financial Query Flow
When a user asks a domain-specific question (e.g., *"How much did I spend on groceries this month?"*):
1. **Context Retrieval**: [agent.ts](file:///d:/Project/Silo/silo-app/src/services/ai/agent.ts) queries local SQLite via Drizzle ORM to extract relevant financial records, category budgets, and recent transaction summaries.
2. **Prompt Synthesis**: The retrieved facts are formatted into a structured prompt (`buildRetrievedContext`) bounded by `QWEN_MODEL_MAX_GROUNDED_OUTPUT_TOKENS` and system instructions.
3. **Inference Execution**: The prompt is dispatched to [LlamaRnAdapter](file:///d:/Project/Silo/silo-app/src/services/ai/llamaRnAdapter.ts).
4. **Stream Sanitization & Playback**: As generation completes, `sanitizeStreamingGeneratedText()` strips Qwen conversation control markers (`<|im_start|>`, `<|im_end|>`). The UI renders tokens smoothly via pseudo-streaming or real-time callbacks into [useAIStore](file:///d:/Project/Silo/silo-app/src/store/useAIStore.ts).

---

## 4. Dual Inference Pathway Architecture

Silo currently contains two distinct native inference integrations:
1. **Modern Pathway (`llama.rn`)**: Enabled via `USE_LLAMA_RN = true` in [generationService.ts](file:///d:/Project/Silo/silo-app/src/services/ai/generationService.ts). Leverages the `@llama.rn` third-party module for robust context management, hardware acceleration, and standard GGUF handling.
2. **Legacy Custom Bridge (`SiloLocalInferenceModule`)**: A bespoke Kotlin/JNI/C++ pipeline ([gguf_runner.cpp](file:///d:/Project/Silo/silo-app/android/app/src/main/cpp/gguf_runner.cpp)) originally engineered for on-device inference before the adoption of `llama.rn`.

*(Note: See [TODO.md](file:///d:/Project/Silo/silo-app/TODO.md) for architectural consolidation plans regarding these pathways.)*

---

## 5. Threading & Concurrency Model

To prevent Application Not Responding (ANR) dialogs and UI stutter, execution domains are strictly segregated:
- **UI / Main Android Thread**: Restricted exclusively to activity lifecycle, view inflation, touch event handling, and 60fps animations. **Never executes file I/O, GGUF parsing, or inference generation.**
- **React Native JS Thread**: Handles store state transitions, prompt assembly, stream chunk sanitization, and navigation logic.
- **Native Module Background Workers**: Kotlin background executors isolate bridge marshaling and serialization from the JS bridge.
- **JNI / OpenMP Compute Threads**: Dedicated C++ worker threads perform matrix multiplication and token evaluation during inference, utilizing ARMNEON instructions without saturating all CPU cores.

---

## 6. Storage & Memory Budgets

- **RAM Budgeting**: [hardware.ts](file:///d:/Project/Silo/silo-app/src/services/ai/hardware.ts) enforces strict RAM thresholds. On devices with less than 6GB RAM, GPU layer offloading is disabled or reduced, and context windows are clamped to prevent low-memory process termination by the Android ActivityManager.
- **Storage Paths**: Models reside in app-private document directories (`expo-file-system/legacy`), exempt from scoped storage permission prompts while remaining protected from unauthorized external access.
