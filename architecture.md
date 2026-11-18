# Silo Application Architecture & System Design

## 1. Executive Summary

**Silo** is a high-performance, privacy-first mobile personal finance application built on **React Native** and **Expo (Android)**. Unlike traditional cloud-dependent finance tools, Silo employs a **hybrid architecture** that seamlessly unites conventional financial management (transactions, budgets, categories, and analytical reporting) with an **embedded, on-device Large Language Model (LLM) inference stack**.

The application is engineered to operate **completely offline by default**. All user financial records are persisted locally in SQLite, and artificial intelligence capabilities—such as conversational financial querying, grounded Retrieval-Augmented Generation (RAG), and receipt OCR—execute directly on the user's mobile device. This is achieved by orchestrating local quantized GGUF models (specifically **Qwen 3.5 2B Q4_K_M**, ~1.28 GB) via the native `llama.rn` C++ JSI runtime, ensuring zero external data exfiltration and deterministic offline functionality.

---

## 2. Top-Level Architectural Layers

The system is fundamentally organized into five decoupled layers, separating presentation from heavy computation and state management:

```
+-----------------------------------------------------------------------------------+
|                        1. PRESENTATION & UI LAYER                                 |
|   React Native Screens, Optimistic Chat UX, Theme Adaptation, FlatList Messages   |
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
|   Zustand Stores, SecureStore Secrets, SQLite / Drizzle ORM Schema, FTS5 Index    |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
|                     4. NATIVE BRIDGE & ADAPTATION LAYER                           |
|   LlamaRnAdapter (llama.rn direct JSI binding)                                    |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
|                    5. NATIVE INFERENCE & COMPUTE LAYER                            |
|   llama.rn / llama.cpp Shared Lib                                                 |
+-----------------------------------------------------------------------------------+
```

### 2.1 Presentation & UI Layer
Responsible for screen composition, navigation, responsive layout, and visual feedback during CPU/GPU intensive tasks.
- **Entry & Navigation**: Bootstrapped via [`index.ts`](file:///home/agent/orca/Silo/index.ts) and [`App.tsx`](file:///home/agent/orca/Silo/App.tsx) (wrapped with a top-level [`ErrorBoundary.tsx`](file:///home/agent/orca/Silo/src/components/ErrorBoundary.tsx) to prevent white-screen crashes), routing through [`AppNavigator.tsx`](file:///home/agent/orca/Silo/src/navigation/AppNavigator.tsx) using React Navigation bottom tabs and native stacks with deep linking (`silo://`).
- **Chat & AI Interaction**: [`ChatbotScreen.tsx`](file:///home/agent/orca/Silo/src/screens/ChatbotScreen.tsx) manages conversational interfaces with `FlatList` message virtualization, rendering optimistic message bubbles, real-time token streaming with automatic spinner display during chain-of-thought reasoning (`Thinking…`), interactive [`ChatChart.tsx`](file:///home/agent/orca/Silo/src/components/ChatChart.tsx) visual responses, compact model provisioning progress bars, and user-actionable error/status states.
- **Financial Screens & Forms**: [`CashflowScreen.tsx`](file:///home/agent/orca/Silo/src/screens/CashflowScreen.tsx) surfaces user-facing error banners and pull-to-refresh; [`AddTransactionScreen.tsx`](file:///home/agent/orca/Silo/src/screens/AddTransactionScreen.tsx) decomposes receipt line items ([`ReceiptItemsEditor.tsx`](file:///home/agent/orca/Silo/src/components/ReceiptItemsEditor.tsx)), category picking ([`CategorySelectorModal.tsx`](file:///home/agent/orca/Silo/src/components/CategorySelectorModal.tsx)), and source selection ([`SourceSelectorModal.tsx`](file:///home/agent/orca/Silo/src/components/SourceSelectorModal.tsx)).
- **Settings & Diagnostics**: [`SettingsScreen.tsx`](file:///home/agent/orca/Silo/src/screens/SettingsScreen.tsx) and [`SystemLogsScreen.tsx`](file:///home/agent/orca/Silo/src/screens/SystemLogsScreen.tsx) (virtualized via `FlatList`) expose runtime health, active backend status (`llama.rn` vs external API), and real-time event logs.

### 2.2 Application Service & Orchestration Layer
Acts as the control plane between user intent and low-level data/inference engines.
- **AI Orchestration & Generation**: [`generationService.ts`](file:///home/agent/orca/Silo/src/services/ai/generationService.ts) and [`agent.ts`](file:///home/agent/orca/Silo/src/services/ai/agent.ts) coordinate chat readiness, mode switching (general chat vs. grounded financial Q&A), prompt synthesis, and token sanitization (stripping internal chain-of-thought reasoning blocks `<think>...</think>` and ChatML control tokens). Includes a structured-output programmatic seam (`systemPrompt`, `jsonSchema`, `disableThinking`) for receipt extraction and automated tool flows.
- **Runtime Preloading**: [`chatRuntimePreloadService.ts`](file:///home/agent/orca/Silo/src/services/ai/chatRuntimePreloadService.ts) manages background preloading and initialization of the native chat runtime so the model is warmed up and ready without blocking the UI thread.
- **Model Lifecycle & OTA Provisioning**: [`modelLifecycle.ts`](file:///home/agent/orca/Silo/src/services/ai/modelLifecycle.ts) (`QModelLifecycleManager`) handles on-demand Over-The-Air (OTA) downloading of model weights, resumable transfer persistence, Wi-Fi-only restrictions, cancellation token races, two-stage checksum integrity verification (size + MD5), active directory placement, and warmup execution.
- **Hardware Profile & Budgets**: [`hardware.ts`](file:///home/agent/orca/Silo/src/services/ai/hardware.ts) evaluates device RAM, computes safe memory budgets (`buildMemoryBudget`), and resolves recommended CPU threads and GPU layer offloading rules.
- **Domain Services**: Coordinates transaction calculation, category mapping, currency parsing ([`amount.ts`](file:///home/agent/orca/Silo/src/features/transactions/amount.ts)), and receipt image OCR processing ([`MlKitEngine.ts`](file:///home/agent/orca/Silo/src/services/ocr/MlKitEngine.ts)).

### 2.3 State & Persistence Layer
Centralizes asynchronous runtime state and relational financial data to decouple UI rendering from blocking background tasks.
- **In-Memory State (Zustand)**:
  - [`useAIStore.ts`](file:///home/agent/orca/Silo/src/store/useAIStore.ts): Tracks runtime availability, active request IDs, streaming buffers, OTA download progress metrics (`downloadedBytes`, `totalBytes`, `throughput`), and structured event logs.
  - [`useTransactionStore.ts`](file:///home/agent/orca/Silo/src/store/useTransactionStore.ts): Maintains cached financial transactions and categories, with transactional multi-table mutations and observable error state.
  - [`useSettingsStore.ts`](file:///home/agent/orca/Silo/src/store/useSettingsStore.ts): Manages user preferences (theme, currency, formatting) and orchestrates secure credential storage.
- **Secure Hardware Storage (Expo SecureStore)**:
  - External API credentials (`externalApiKey`, `externalApiCustomHeaders`) are saved in hardware-backed `expo-secure-store`, with automatic migration and deletion from legacy plaintext SQLite `app_settings`.
- **Relational Storage (SQLite + Drizzle ORM)**:
  - [`index.ts`](file:///home/agent/orca/Silo/src/db/index.ts) and [`schema.ts`](file:///home/agent/orca/Silo/src/db/schema.ts): Defines local SQLite tables for transactions, transaction items, budgets, app settings (key-value store), and type-aware categories. Includes indexed columns (`idx_transactions_date`, etc.) and SQLite FTS5 full-text indexing (`transactions_fts`) with automatic triggers for grounded context search.

### 2.4 Native Bridge & Adaptation Layer
Provides idiomatic TypeScript interfaces for native Android capabilities.
- **Llama.rn Adapter**: [`llamaRnAdapter.ts`](file:///home/agent/orca/Silo/src/services/ai/llamaRnAdapter.ts) wraps the third-party `llama.rn` module, managing native context initialization (`initLlama`), warmup execution (`runWarmup`), completion dispatch, and graceful fallback from GPU to CPU execution.
- **Legacy Custom Inference Bridge (Pruned)**: All legacy JS, Kotlin, and C++ bridge files have been completely removed from the project in favor of `llama.rn`.

### 2.5 Native Inference & Compute Layer
The high-performance C++/JNI compute engine responsible for LLM execution on ARM64 mobile hardware.
- **Llama.rn JSI Core**: Direct C++ bindings to `llama.cpp` via React Native JSI for zero-overhead token streaming and memory-mapped model execution.
- **Hardware Acceleration**: Automatically evaluates Vulkan/GPU availability and falls back to CPU multi-threading with ARMNEON optimizations when VRAM is constrained.

---

## 3. Key Architectural Workflows

### 3.1 Lazy App Boot & Runtime Initialization
To ensure sub-second app launch times and avoid unnecessary RAM consumption, the LLM runtime is **never eagerly loaded** at application startup.
1. Application boots into [`App.tsx`](file:///home/agent/orca/Silo/App.tsx) and initializes SQLite, FTS5 indices, and general settings.
2. [`QModelLifecycleManager`](file:///home/agent/orca/Silo/src/services/ai/modelLifecycle.ts) performs a lightweight background check for existing model manifests and resumable transfers based on the active model config (`getActiveModelConfig()`).
3. When the user opens [`ChatbotScreen.tsx`](file:///home/agent/orca/Silo/src/screens/ChatbotScreen.tsx), `GenerationService.ensureChatRuntimeReady()` and [`chatRuntimePreloadService.ts`](file:///home/agent/orca/Silo/src/services/ai/chatRuntimePreloadService.ts) coordinate to initialize the runtime on demand.
4. [`LlamaRnAdapter`](file:///home/agent/orca/Silo/src/services/ai/llamaRnAdapter.ts) evaluates device RAM against `buildMemoryBudget()`.
5. The GGUF model is loaded into native memory (attempting GPU layer offload first, falling back to CPU threads if VRAM/initialization fails), followed by an automatic warmup completion prompt (`QWEN_MODEL_WARMUP_PROMPT`).
6. **Runtime Resilience**: Memory budget thresholds evaluate available RAM to determine safe context sizing and GPU offloading parameters before model initialization.

### 3.2 Over-The-Air (OTA) Model Provisioning & Management Lifecycle
Silo standardizes on an offline quantized model (**Qwen 3.5 2B Q4_K_M**, 1.28 GB) defined in `MODEL_CATALOG`. Silo implements an atomic OTA provisioning state machine in [`modelLifecycle.ts`](file:///home/agent/orca/Silo/src/services/ai/modelLifecycle.ts):
```
[not-installed] ---> [queued] ---> [downloading] <---> [paused / interrupted]
                                        |
                                        v
[ready] <--- [indexing/warming] <--- [registering] <--- [verifying & unpacking]
```
- **Wi-Fi Only Provisioning**: When `aiWifiOnlyDownload` is enabled in settings, the transfer manager checks active network connections via `expo-network` (`checkWifiRequirement`) and pauses/defers downloads when on cellular data.
- **Resumable Transfers**: Progress and session identifiers are persisted to `AI_TRANSFER_MANIFEST_FILE`. If the app is closed or backgrounded, `restorePersistedState()` reconciles partial downloads upon relaunch.
- **Race-Free Cancellation**: Download cancellation leverages monotonic cancellation tokens (`downloadToken`) to safely abort background downloads and discard stale transfer events.
- **Atomic Placement & Integrity Verification**: Downloaded artifacts are placed in a temporary directory (`getAiTempDirectory()`). Only after passing two-stage validation (exact file size matching `sizeBytes` and MD5 checksum matching `md5`) are they atomically moved to the active model directory, preventing corrupted weights from breaking inference.
- **Model Deletion Management**: Users can delete downloaded model weights directly from Settings (`deleteInstalledModel()`), which cancels in-flight downloads, disposes the native runtime, and wipes model directories to reclaim storage.

### 3.3 Grounded RAG Financial Query Flow
When a user asks a domain-specific question (e.g., *"How much did I spend on groceries this month?"*):
1. **Context Retrieval**: [`agent.ts`](file:///home/agent/orca/Silo/src/services/ai/agent.ts) queries local SQLite using FTS5 match queries (`transactions_fts`) complemented by fuzzy keyword token scoring to extract relevant transaction records and category budgets.
2. **Prompt Synthesis**: The retrieved facts are formatted into a structured prompt (`buildRetrievedContext`) bounded by `QWEN_MODEL_MAX_GROUNDED_OUTPUT_TOKENS`, conversation history, and system instructions.
3. **Inference Execution**: The prompt is dispatched to [`LlamaRnAdapter`](file:///home/agent/orca/Silo/src/services/ai/llamaRnAdapter.ts) or external API.
4. **Stream Sanitization & Playback**: During live token streaming and upon completion, `sanitizeStreamingGeneratedText()` and `sanitizeGeneratedText()` filter out Qwen conversation control markers (`<|im_start|>`, `<|im_end|>`, etc.) and strip internal chain-of-thought reasoning blocks (`<think>...</think>`). When an unclosed `<think>` tag is detected during live reasoning, streaming text is held back so the UI cleanly displays the loading indicator (`Thinking…`) without leaking raw XML tags into the chat bubble.

### 3.4 Receipt Scanning Pipeline
Silo incorporates an on-device receipt scanning pipeline designed for instant processing and offline privacy:
1. **Local ML Kit OCR**: [`MlKitEngine.ts`](file:///home/agent/orca/Silo/src/services/ocr/MlKitEngine.ts) leverages `@react-native-ml-kit/text-recognition` to extract bounding-box grouped text from camera captures or gallery images entirely on-device with zero network overhead.
2. **Local AI Structured Extraction**: In [`agent.ts`](file:///home/agent/orca/Silo/src/services/ai/agent.ts) (`analyzeReceiptImage`), raw OCR text is filtered via `filterReceiptOcrTextForAi` down to high-signal lines (≤35 lines, stripping headers/footers) and passed to the local Qwen 3.5 2B model using assistant JSON prefill (`{"merchantName":`), thinking disabled (`disableThinking`), temperature 0.1, and an 80-token cap to extract `merchantName`, `totalAmount`, `category`, `date`, and `lineItemsText`. The model runtime is kept resident for 5 minutes (`scheduleModelUnload(300_000)`) to ensure instant response on consecutive receipt scans.
3. **Deterministic Heuristic Fallback**: If local LLM inference fails, times out, or the model is not provisioned, the pipeline immediately falls back to regex-based deterministic parsing (`parseReceiptTextHeuristic`), guaranteeing instant, failure-free extraction.
4. **End-to-End Benchmark Suite (`bench/`)**: The receipt extraction accuracy and latency are formally evaluated using a benchmark suite of 197 Indonesian receipt and payment photos (CORD v2 dataset, synthetic degraded variants, and Wikimedia Commons payment documents); see [`bench/README.md`](file:///home/agent/orca/Silo/bench/README.md) and [`bench/results/REPORT.md`](file:///home/agent/orca/Silo/bench/results/REPORT.md).

---

## 4. Hybrid & Dynamic AI Inference Architecture

Silo provides a flexible inference architecture that adapts to user preferences and device capabilities:
1. **On-Device Local Inference (`llama.rn`)**: The default, offline-first engine powered by direct React Native JSI bindings to `llama.cpp`. Operates using the catalog quantized model (**Qwen 3.5 2B Q4_K_M**) with memory-aware hardware offloading and zero network dependency.
2. **Cloud / External API Providers**: For users preferring cloud-scale models or zero on-device storage, Silo supports switching to external providers (OpenAI, DeepSeek, Groq, Together AI, Ollama, or Custom API endpoints) in Settings. Uses standard OpenAI-compatible `/chat/completions` REST endpoints with Bearer authentication or custom JSON headers, incorporating real-time Server-Sent Events (SSE) streaming via XHR and automated stream sanitization.

---

## 5. Threading & Concurrency Model

To prevent Application Not Responding (ANR) dialogs and UI stutter, execution domains are strictly segregated:
- **UI / Main Android Thread**: Restricted exclusively to activity lifecycle, view inflation, touch event handling, and 60fps animations. **Never executes file I/O, GGUF parsing, or inference generation.**
- **React Native JS Thread**: Handles store state transitions, prompt assembly, stream chunk sanitization, and navigation logic.
- **Native Module Background Workers**: Kotlin background executors isolate bridge marshaling and serialization from the JS bridge.
- **JNI / OpenMP Compute Threads**: Dedicated C++ worker threads perform matrix multiplication and token evaluation during inference, utilizing ARMNEON instructions without saturating all CPU cores.

---

## 6. Storage & Memory Budgets

- **RAM Budgeting**: [`hardware.ts`](file:///home/agent/orca/Silo/src/services/ai/hardware.ts) enforces strict RAM thresholds. On devices with less than 6GB RAM, GPU layer offloading is disabled or reduced, and context windows are clamped to prevent low-memory process termination by the Android ActivityManager.
- **Storage Paths**: Models reside in app-private document directories (`expo-file-system/legacy`), exempt from scoped storage permission prompts while remaining protected from unauthorized external access.

---

## 7. Security & Privacy

Silo is architected with strict privacy and defensive security guarantees:
- **Hardware-Backed Secrets (SecureStore)**: Sensitive external API keys (`externalApiKey`) and custom request headers (`externalApiCustomHeaders`) are encrypted in hardware-backed `expo-secure-store`. An automatic startup migration transfers and purges any legacy plaintext rows from SQLite `app_settings`.
- **Disabled OS Backups (`allowBackup=false`)**: Configured in [`AndroidManifest.xml`](file:///home/agent/orca/Silo/android/app/src/main/AndroidManifest.xml) and [`app.json`](file:///home/agent/orca/Silo/app.json) to prevent financial databases, transaction history, and stored API keys from leaking through unencrypted ADB backups or cloud OS backup sync.
- **Privacy-Safe External Failover**: Failover from local on-device inference to an external API occurs only when the local model is unavailable AND the user has explicitly configured external API credentials (or specified a local/LAN endpoint). Under default settings, the app refuses failover to avoid exfiltrating transaction data to third-party endpoints.
- **Model Integrity Verification**: OTA model provisioning verifies both expected byte size and MD5 hash in temporary storage before atomically moving weights into the active model directory, preventing corrupted, partial, or tampered GGUF files from loading.
