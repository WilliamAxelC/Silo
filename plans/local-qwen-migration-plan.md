# Local-Only Qwen3.5-2B Migration and Implementation Plan

## 1. Current-State Assessment

The existing assistant flow is tightly coupled to Google Gemini and requires external network access at several layers:

- [`askFinancialAgent()`](../src/services/ai/agent.ts:65) instantiates [`GoogleGenerativeAI`](../src/services/ai/agent.ts:1) and sends prompts, tool calls, and final responses to a hosted API.
- [`analyzeReceiptImage()`](../src/services/ai/agent.ts:236) also depends on the hosted Gemini multimodal API.
- [`ChatbotScreen`](../src/screens/ChatbotScreen.tsx) performs API key verification against `https://generativelanguage.googleapis.com` in [`handleVerifyKey()`](../src/screens/ChatbotScreen.tsx:45), blocks usage when no key/model is configured, and presents remote model selection UI in [`availableModels.map()`](../src/screens/ChatbotScreen.tsx:200).
- [`useAIStore`](../src/store/useAIStore.ts:6) persists API-key-centric state: `apiKey`, `selectedModel`, and `availableModels`.

This means the current system is not offline-capable, not private by default, and not suitable for deterministic local inference.

## 2. Target Outcome

Replace all external AI dependencies with a fully local stack centered on **Qwen3.5-2B Instruct** for conversational generation and grounded RAG answer synthesis, while moving embeddings, indexing, reranking, orchestration, and retrieval to local components.

### Local-only principles

1. No outbound inference calls.
2. No API keys required.
3. All document ingestion, embeddings, indices, prompts, and chat history remain on-device or on a user-controlled local host.
4. The app talks only to a loopback/local LAN service such as `http://127.0.0.1:<port>` or a bundled native runtime.
5. Retrieval and answer generation must still work when the machine is disconnected from the internet.

## 3. Recommended Reference Architecture

```text
React Native App
  └── Local AI Client Adapter
        └── Local AI Gateway API
              ├── Chat Orchestrator
              ├── Tool Router / Finance Query Layer
              ├── RAG Retriever
              ├── Prompt Builder
              ├── Conversation Memory Manager
              ├── Embedding Service
              ├── Reranker
              ├── Indexing / Ingestion Workers
              ├── Local Vector Store
              └── Qwen3.5-2B Inference Runtime
                    └── GPU or CPU Execution Backend
```

## 4. Recommended Serving Strategy

### Preferred deployment split

For production readiness, use a **local sidecar service** instead of embedding all AI logic directly inside the React Native app.

#### Recommended components

- **Inference runtime**: [`llama.cpp`](https://github.com/ggerganov/llama.cpp) server or Ollama as the initial serving layer.
- **App-facing orchestration API**: lightweight local service in Node.js, Python FastAPI, or Rust.
- **Vector store**: SQLite + [`sqlite-vec`](https://github.com/asg017/sqlite-vec) or LanceDB for local persistence.
- **Embeddings**: local sentence embedding model served by the same sidecar.
- **Reranker**: optional local cross-encoder or lightweight LLM rerank prompt.

### Why this split is best

- Minimal mobile UI changes.
- Easier API compatibility with existing [`askFinancialAgent()`](../src/services/ai/agent.ts:65) pattern.
- Clear boundary for replacing Gemini while preserving app behavior.
- Better observability and lifecycle control.
- Enables background indexing and caching outside the UI thread.

### Recommended runtime choices

#### Option A: [`llama.cpp`](local/architecture.md:1) + custom gateway
Best for offline determinism, GGUF quantization flexibility, low memory footprint, and full local control.

#### Option B: Ollama + custom gateway
Best for simplicity and fast prototyping, but slightly more overhead and less fine-grained control.

#### Option C: ONNX Runtime / MLC / native mobile runtime
Best only if the model must run directly on the phone without a companion process. This is harder operationally and less flexible for RAG pipelines.

**Recommendation:** start with **[`llama.cpp`](local/architecture.md:1)** as the model server and a **custom local gateway** that exposes an app-stable API.

## 5. Model Selection and Scope

### Primary generation model
- **Qwen3.5-2B-Instruct** for chat and grounded answer generation.

### Important note
Qwen3.5-2B should generate answers, but it should **not** be the only model in the local stack.

Recommended auxiliary local models:
- **Embedding model**: [`bge-small-en-v1.5`](local/models.md:1), [`multilingual-e5-small`](local/models.md:1), or a multilingual MiniLM/E5 variant depending on language coverage.
- **Optional reranker**: [`bge-reranker-base`](local/models.md:1) if hardware permits; otherwise use embedding cosine similarity only.
- **OCR**: keep existing local ML Kit path for receipt text extraction rather than forcing Qwen to do vision offline.

## 6. Hardware Requirements and Quantization Guidance

### Baseline memory expectations for Qwen3.5-2B
Approximate operational ranges depend on backend and context size.

| Quantization | RAM / VRAM target | Typical use | Tradeoff |
|---|---:|---|---|
| Q2_K | ~1.5-2.5 GB | Lowest-end CPU fallback | Lower quality, faster load, weaker reasoning |
| Q4_K_M | ~2.0-3.5 GB | Best default | Good quality/latency balance |
| Q5_K_M | ~2.5-4.5 GB | Higher fidelity local desktop | More memory, modest quality gain |
| Q8_0 | ~4.5-6.5 GB | Strong desktop GPU/CPU | Better quality, slower and heavier |
| FP16 | ~6+ GB | Mostly GPU/server use | Highest memory cost |

### Recommended hardware tiers

#### Tier 1: Minimum viable offline desktop
- 4 CPU cores
- 8 GB system RAM
- SSD storage
- Qwen3.5-2B in `Q4_K_M`
- Small embedding model on CPU
- Expect higher latency under RAG + rerank

#### Tier 2: Recommended user workstation
- 8+ CPU cores
- 16 GB RAM
- Optional NVIDIA GPU with 6-8 GB VRAM
- Qwen3.5-2B in `Q4_K_M` or `Q5_K_M`
- Fast local embeddings and moderate concurrency

#### Tier 3: Best experience
- 16+ GB RAM
- GPU with 8-12 GB VRAM
- Qwen3.5-2B + reranker + embeddings fully local with lower latency

### Quantization recommendation
- Default production build: **Q4_K_M**
- High-memory option: **Q5_K_M**
- Fallback mode for low-resource hosts: **Q2_K** with reduced context and no reranker

## 7. Context Window and Prompt Budget Strategy

Even if the selected Qwen build supports a larger context window, practical local performance depends on KV-cache cost.

### Recommended operating budgets
- **Interactive chat without RAG**: 2k-4k tokens effective context
- **Grounded RAG answers**: 4k-8k tokens effective context
- **Avoid** very large contexts unless GPU memory is ample

### Budget allocation example for 8k context
- System prompt: 400-700 tokens
- Conversation summary: 200-500 tokens
- Recent turns: 500-1,500 tokens
- Retrieved evidence: 1,500-3,500 tokens
- Tool output / structured facts: 300-800 tokens
- Response budget: 400-900 tokens

### Tradeoffs
- Larger context improves recall but increases latency and memory.
- More retrieved chunks can degrade grounding if prompt quality drops.
- For Qwen3.5-2B, better retrieval selection generally beats brute-force large contexts.

## 8. Retrieval and Local Vector Stack Recommendations

### Recommended default
- **Storage + metadata**: SQLite
- **Vector search**: `sqlite-vec`
- **Lexical fallback**: SQLite FTS5
- **Hybrid retrieval**: weighted union of vector similarity + BM25/FTS

### Alternatives
- **LanceDB**: strong local developer ergonomics, easy filtering, larger artifact footprint.
- **Qdrant local mode**: good feature set, more operational overhead.
- **Chroma**: fine for prototyping, less preferred for strict production local packaging.

### Recommendation by scope
- For a mobile companion desktop/local-host architecture: **SQLite + sqlite-vec + FTS5**.
- For a desktop-only rich local service: **LanceDB** is also reasonable.

## 9. Ingestion and Indexing Pipeline Design

### Document sources
Support all locally available knowledge needed by the assistant:
- app finance schema and glossary
- user-exported statements or receipts
- budgeting rules and help docs
- indexed transaction snapshots
- OCR extracted receipt text
- structured finance facts derived from SQLite

### Pipeline stages
1. **Source discovery**
2. **Type detection**
3. **Parsing / normalization**
4. **Content cleaning**
5. **Chunking**
6. **Embedding generation**
7. **Metadata enrichment**
8. **Vector + lexical indexing**
9. **Versioning / deduplication**
10. **Background refresh**

### Metadata to persist per chunk
```json
{
  "doc_id": "receipt_2026_05_14_001",
  "chunk_id": "receipt_2026_05_14_001#03",
  "source_type": "receipt",
  "title": "Supermarket receipt",
  "created_at": "2026-05-14T10:20:00Z",
  "language": "en",
  "section": "items",
  "token_count": 182,
  "checksum": "sha256:...",
  "tags": ["finance", "grocery"],
  "attribution": {
    "uri": "local://receipts/2026/05/14/001",
    "display": "Receipt 14 May 2026"
  }
}
```

### Incremental indexing behavior
- Hash raw content and skip unchanged files.
- Re-embed only modified chunks.
- Soft-delete removed documents from active retrieval.
- Keep index schema versioned for future migrations.

## 10. Chunking Strategy

### Recommended defaults
Use **semantic paragraph-aware chunking** with overlap.

- Target chunk size: **250-450 tokens**
- Overlap: **40-80 tokens**
- Hard max: **600 tokens**

### Chunk by source type
- Receipts / OCR text: row-aware chunking, preserve merchant/date/total header with items.
- App docs / knowledge base: heading-aware chunks.
- Transaction facts: compact structured text summaries grouped by period or category.
- Policies / settings docs: section-based chunks.

### Why not larger chunks
Qwen3.5-2B benefits from concise, high-signal evidence. Large chunks waste context and reduce answer precision.

## 11. Retrieval Flow

### Recommended retrieval pipeline
1. Query rewrite for search intent normalization.
2. Generate local embedding for the user query.
3. Retrieve top-k vector matches, for example k=12.
4. Retrieve top-k FTS lexical matches, for example k=12.
5. Merge and deduplicate.
6. Optional metadata filtering.
7. Optional reranking to top 4-6 chunks.
8. Build grounded prompt with citations.

### Structured data path
For questions about balances, category totals, recent transactions, and date-bounded finance analytics, **prefer local structured tool execution first** instead of RAG.

This preserves the useful pattern already present in [`askFinancialAgent()`](../src/services/ai/agent.ts:117), but it must be implemented locally rather than through Gemini function calling.

## 12. Reranking Options

### Best option if hardware allows
- Local cross-encoder reranker such as `bge-reranker-base`.

### Lower-resource options
- Embedding-only cosine score.
- Heuristic rerank using metadata boosts:
  - exact date match
  - exact category match
  - source recency
  - source type priority
- LLM rerank prompt using Qwen only as fallback, not default.

### Recommendation
- Start with hybrid retrieval + heuristic rerank.
- Add cross-encoder reranker only after baseline latency is acceptable.

## 13. Conversation Memory Handling

### Recommended memory layers
1. **Recent turn buffer**: last 4-8 exchanges.
2. **Running summary**: local rolling summary updated every few turns.
3. **Structured session memory**: saved slots such as user goals, preferred currency, selected date range.
4. **No hidden cloud memory**.

### Memory persistence
Store in local SQLite:
- `chat_sessions`
- `chat_messages`
- `chat_summaries`
- `memory_slots`

### Memory policy
- Summarize after every 6-10 turns or when token budget exceeds threshold.
- Do not blindly replay full history.
- Keep sensitive memory opt-in and user-clearable.

## 14. Prompt Orchestration Design

### Chat-only prompt template
```text
System:
You are Silo, a private offline financial assistant running fully locally.
You must be concise, accurate, and transparent about uncertainty.
Never claim to have accessed external sources.
If you rely on local financial records, say so.
Format currency in Indonesian Rupiah unless configured otherwise.

Conversation summary:
{conversation_summary}

Relevant memory:
{memory_slots}

Recent conversation:
{recent_turns}

User:
{user_query}
```

### Grounded RAG prompt template
```text
System:
You are Silo, a private offline financial assistant.
Answer only from the supplied local evidence and structured tool results.
If the evidence is insufficient, say exactly what is missing.
Cite supporting evidence using [Sources] with chunk identifiers.
Do not invent records, balances, merchants, or dates.

Structured facts:
{tool_results}

Retrieved evidence:
{retrieved_chunks}

Conversation summary:
{conversation_summary}

Recent conversation:
{recent_turns}

User question:
{user_query}

Required response format:
1. Direct answer
2. Short explanation
3. [Sources]
```

### Tool-oriented planner prompt
```text
Classify the user request into one of:
- structured_finance_query
- retrieval_question
- general_chat
- unsupported
Return JSON only with fields:
intent, confidence, recommended_tools, filters
```

## 15. Citation and Attribution Behavior

### Recommended citation behavior
Every grounded answer should include local source attribution when RAG or retrieval is used.

Example:
```text
You spent Rp 425,000 on groceries in the last 30 days.
This is based on 8 matching local records and one indexed receipt summary.

[Sources]
- tx_view:2026-04-18..2026-05-14
- receipt_2026_05_02_003#02
- budget_help_v1#05
```

### Rules
- Structured SQL answers cite the query scope or source table view.
- Document answers cite chunk IDs and titles.
- If evidence conflicts, surface the conflict.
- If answer is inferred rather than directly stated, say so explicitly.

## 16. Security and Privacy Controls

### Required controls
- Disable all outbound network calls in the AI subsystem by configuration.
- Remove API key storage and Gemini endpoints from the app.
- Bind local AI gateway to `127.0.0.1` by default.
- Encrypt sensitive persisted chat history where platform support exists.
- Log prompts and results only when debug mode is enabled.
- Scrub secrets and personally identifiable information from logs.
- Enforce allowlisted tool execution only.
- Reject arbitrary SQL from the model in production.

### Critical redesign from current implementation
The current fallback SQL path in [`execute_sql_query`](../src/services/ai/agent.ts:39) and dynamic SQL execution in [`askFinancialAgent()`](../src/services/ai/agent.ts:185) should be removed or constrained behind a deterministic query planner because model-generated SQL is a local security risk even offline.

### Safer replacement
Use a server-side query planner:
- intent classification
- allowlisted query templates
- validated filter construction
- parameterized SQL only

## 17. API Compatibility Strategy

Minimize app changes by preserving a client contract similar to the current [`askFinancialAgent()`](../src/services/ai/agent.ts:65) usage.

### Existing app call shape
```ts
askFinancialAgent(userQuery, apiKey, selectedModel, aiMode, setLoadingStatus)
```

### Compatibility adaptation
Introduce a local adapter with the same high-level interface initially, but ignore deprecated remote-only parameters.

#### Transitional TypeScript contract
```ts
export type LocalAiMode = 'rag' | 'structured' | 'chat';

export async function askFinancialAgent(
  userPrompt: string,
  _apiKey: string | null,
  _modelName: string | null,
  mode: LocalAiMode,
  onStatusChange?: (status: string) => void,
): Promise<string>
```

This lets [`ChatbotScreen`](../src/screens/ChatbotScreen.tsx:73) keep working while the UI is migrated away from API key and remote model selection.

### End-state contract
```ts
export async function askFinancialAgent(
  request: LocalChatRequest,
  onStatusChange?: (status: string) => void,
): Promise<LocalChatResponse>
```

## 18. Example Local Gateway Endpoints

### Health
```http
GET /v1/health
```
Response:
```json
{
  "status": "ok",
  "models": {
    "generator": "qwen3.5-2b-instruct-q4_k_m",
    "embedder": "bge-small-en-v1.5"
  },
  "index": {
    "documents": 142,
    "chunks": 2841
  }
}
```

### Chat
```http
POST /v1/chat
Content-Type: application/json
```
Request:
```json
{
  "session_id": "session_123",
  "mode": "rag",
  "message": "How much did I spend on food in the last 30 days?",
  "use_memory": true,
  "max_output_tokens": 512,
  "temperature": 0.2
}
```
Response:
```json
{
  "answer": "You spent Rp 1,250,000 on food in the last 30 days.",
  "citations": [
    { "id": "tx_view:last_30_days:food", "title": "Transaction summary" }
  ],
  "debug": {
    "intent": "structured_finance_query",
    "latency_ms": 842,
    "retrieved": 0
  }
}
```

### Retrieve
```http
POST /v1/retrieve
```
Request:
```json
{
  "query": "budget rule for groceries",
  "top_k": 6,
  "filters": { "source_type": ["policy", "help"] }
}
```

### Ingest
```http
POST /v1/ingest
```
Request:
```json
{
  "sources": [
    { "type": "file", "path": "D:/SiloData/docs/budget-guide.md" },
    { "type": "sqlite_view", "name": "ai_transactions_view" }
  ],
  "reindex": false
}
```

### Session memory
```http
POST /v1/memory/summarize
POST /v1/memory/clear
```

## 19. Example Local Config Structure

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 11435,
    "allowLan": false,
    "requestTimeoutMs": 60000
  },
  "models": {
    "generator": {
      "id": "qwen3.5-2b-instruct",
      "quantization": "Q4_K_M",
      "contextWindow": 8192,
      "maxOutputTokens": 768,
      "temperature": 0.2,
      "topP": 0.9
    },
    "embedder": {
      "id": "bge-small-en-v1.5",
      "batchSize": 32
    },
    "reranker": {
      "enabled": false,
      "id": "bge-reranker-base"
    }
  },
  "retrieval": {
    "vectorStore": "sqlite-vec",
    "hybridSearch": true,
    "vectorTopK": 12,
    "lexicalTopK": 12,
    "finalTopK": 5,
    "chunkSizeTokens": 350,
    "chunkOverlapTokens": 60
  },
  "memory": {
    "recentTurns": 6,
    "summaryMaxTokens": 256,
    "persistHistory": true,
    "encryptAtRest": true
  },
  "security": {
    "disableOutboundNetwork": true,
    "logPrompts": false,
    "allowModelGeneratedSql": false
  },
  "features": {
    "structuredFinanceTools": true,
    "rag": true,
    "receiptOcr": true,
    "receiptVision": false
  }
}
```

## 20. Concrete App Refactor Guidance

### A. Decommission Gemini dependencies
Remove or replace the following behaviors:
- [`GoogleGenerativeAI`](../src/services/ai/agent.ts:1)
- remote model listing in [`handleVerifyKey()`](../src/screens/ChatbotScreen.tsx:45)
- setup gating in [`if (!apiKey || (!selectedModel && availableModels.length === 0))`](../src/screens/ChatbotScreen.tsx:90)
- API-key removal UI in [`handleClearApiKey()`](../src/screens/SettingsScreen.tsx:117)
- API-key-oriented Zustand state in [`useAIStore`](../src/store/useAIStore.ts:6)

### B. Replace [`useAIStore`](../src/store/useAIStore.ts:18)
Move from remote-service state to local-runtime state.

#### Recommended state shape
```ts
interface AIState {
  runtimeStatus: 'offline' | 'starting' | 'ready' | 'error';
  selectedMode: 'rag' | 'structured' | 'chat';
  localModel: string;
  chatHistory: Message[];
  lastHealthCheck?: string;
  addChatMessage: (msg: Message) => void;
  clearChatHistory: () => void;
  setRuntimeStatus: (status: AIState['runtimeStatus']) => void;
}
```

### C. Replace [`ChatbotScreen`](../src/screens/ChatbotScreen.tsx:45) setup flow
- Remove API key entry UI.
- Replace with local runtime health check.
- Show statuses like `Starting local engine`, `Indexing documents`, `Ready`, `Low memory mode`.
- Replace remote model picker with local profile selector only if multiple quantizations/profiles exist.

### D. Replace [`askFinancialAgent()`](../src/services/ai/agent.ts:65)
Refactor into a thin API client:
1. send request to local gateway
2. stream or poll progress
3. render citations and diagnostics

### E. Keep OCR local
The current local OCR entrypoint in [`recognizeReceiptText()`](../src/services/ocr/index.ts:10) is already aligned with offline-first design and should remain the first-stage receipt text extraction path.

## 21. Local Orchestration Logic

### Intent routing order
1. Health check and readiness validation
2. Prompt injection / abuse screening
3. Intent classification
4. If structured finance query -> deterministic local tool/query layer
5. If document knowledge query -> retrieval pipeline
6. If open chat -> direct Qwen chat prompt with memory
7. Answer post-processing, citations, and formatting

### Structured query layer
Replace model-generated SQL with typed functions such as:
- `get_total_balance(range?)`
- `get_category_spending(category, range)`
- `get_recent_transactions(limit, filter?)`
- `get_budget_status(category?)`
- `compare_period_spending(category?, periodA, periodB)`

These functions call parameterized SQLite queries against the local database and produce structured JSON that Qwen verbalizes.

## 22. Latency and Memory Tradeoffs

### Common latency contributors
- model load / cold start
- context size
- retrieval fan-out
- reranker use
- CPU-only token generation
- concurrent indexing

### Practical expectations
- Cold start: 2-20 seconds depending on backend and hardware
- Warm structured answer: often <1 second if mostly SQL and short generation
- Warm RAG answer: 1-6 seconds on CPU, faster on GPU
- Full reindex: highly dependent on corpus and embedding model

### Optimization levers
- keep the model loaded
- reduce final top-k retrieved chunks
- summarize chat history aggressively
- use Q4 quantization
- batch embeddings
- cache retrieval results for repeated queries

## 23. Evaluation Criteria

### Functional acceptance criteria
- Zero external network dependency for AI features
- Chat works offline after first local install
- RAG answers include citations
- Structured finance answers match database truth
- Memory survives app restarts if enabled
- Index rebuild succeeds deterministically

### Quality metrics
- answer correctness
- grounding fidelity
- citation precision
- hallucination rate
- latency p50 / p95
- token throughput
- retrieval recall@k
- structured query accuracy

### Security criteria
- no outbound calls under AI workflows
- no raw arbitrary SQL execution from model output
- prompt injection resistance for retrieval context
- logs do not leak secrets or sensitive data

## 24. Benchmarking Methodology

### Dataset creation
Build a local benchmark suite with:
- 100+ structured finance questions
- 100+ document-grounded RAG questions
- 25+ adversarial prompt injection tests
- 25+ ambiguous / insufficient-evidence cases
- representative receipts and OCR text

### Benchmark dimensions
- CPU-only vs GPU-assisted
- Q2 vs Q4 vs Q5 quantization
- 4k vs 8k context
- retrieval only vs retrieval + rerank
- cold vs warm start

### Measurements
- p50 / p95 latency
- memory RSS
- GPU VRAM usage
- tokens/sec
- retrieval hit rate
- factual accuracy by human-graded rubric
- citation correctness

### Acceptance targets
Example initial targets:
- structured answer accuracy >= 98%
- grounded RAG citation validity >= 95%
- hallucination rate <= 5%
- warm chat p95 <= 4s on recommended hardware

## 25. Failure Modes and Mitigations

| Failure mode | Symptom | Mitigation |
|---|---|---|
| Model not loaded | local gateway unhealthy | health endpoint, retry, preload at startup |
| Low memory / OOM | crashes or stalled generation | smaller quant, lower context, disable reranker |
| Retrieval misses evidence | vague or wrong grounded answer | hybrid retrieval, chunk tuning, metadata filtering |
| Hallucination | unsupported claims | grounded prompts, confidence gating, citation enforcement |
| Prompt injection in docs | model follows malicious retrieved text | wrap evidence as untrusted context, instruction separation |
| Index corruption | empty retrieval results | schema versioning, checksums, rebuild command |
| SQL mismatch | wrong numeric finance output | deterministic query templates, validation tests |
| OCR noise | bad receipt facts | confidence flags, human confirmation, preserve raw text |
| Cold start too slow | poor UX | preload model, background warmup, show progress |

## 26. Operational Monitoring

### Metrics to collect locally
- gateway up/down
- model load status
- request count by mode
- latency by stage: classify, retrieve, rerank, generate
- tokens generated
- memory usage
- index size and last refresh time
- retrieval empty-rate
- answer error-rate

### Logging guidance
- structured local logs only
- redact document content by default
- optional debug mode for prompt traces
- rotate logs locally

### Health probes
- `/v1/health`
- `/v1/ready`
- `/v1/index/status`
- `/v1/metrics`

## 27. Step-by-Step Rollout Plan

### Phase 0: Architecture freeze
1. Document Gemini dependency points in [`agent.ts`](../src/services/ai/agent.ts:1), [`ChatbotScreen.tsx`](../src/screens/ChatbotScreen.tsx:45), and [`useAIStore.ts`](../src/store/useAIStore.ts:6).
2. Define local gateway contract.
3. Select runtime: [`llama.cpp`](local/architecture.md:1) + SQLite/`sqlite-vec`.

### Phase 1: Build local gateway MVP
1. Implement health endpoint.
2. Implement `/v1/chat` direct chat path using Qwen3.5-2B.
3. Add model lifecycle management and warm loading.
4. Package local config and model path resolution.

### Phase 2: App compatibility layer
1. Replace [`askFinancialAgent()`](../src/services/ai/agent.ts:65) with a local HTTP client adapter.
2. Keep the existing call signature temporarily.
3. Remove hard requirement for API key and remote model selection in [`ChatbotScreen`](../src/screens/ChatbotScreen.tsx:90).
4. Add runtime readiness UI.

### Phase 3: Structured finance migration
1. Port existing finance tools from Gemini function declarations into local deterministic handlers.
2. Replace arbitrary SQL generation with parameterized query templates.
3. Add regression tests against local SQLite fixtures.

### Phase 4: Retrieval and indexing
1. Add document parser and chunker.
2. Add local embeddings.
3. Build SQLite vector + FTS index.
4. Add hybrid retrieval and heuristic rerank.
5. Add citations in responses.

### Phase 5: Memory and grounding hardening
1. Add rolling summaries.
2. Persist sessions locally.
3. Add prompt injection defenses for user and retrieved content.
4. Add insufficient-evidence behavior.

### Phase 6: Decommission legacy remote dependency
1. Remove `@google/generative-ai` package.
2. Remove Gemini API key settings and verification UI.
3. Delete remote model listing logic.
4. Delete or replace remote multimodal receipt analysis path.
5. Validate zero outbound AI traffic through test harness.

### Phase 7: Performance tuning
1. Benchmark Q4 vs Q5.
2. Tune context and retrieval counts.
3. Add optional reranker.
4. Optimize cold start and caching.

### Phase 8: Production hardening
1. Add health monitoring and local metrics.
2. Add migration scripts for AI state and index schema.
3. Add backup/rebuild workflows.
4. Freeze config defaults and release packaging.

## 28. Deployment Considerations

### Packaging
- Bundle app and sidecar separately or as a coordinated install.
- Store model files outside the app bundle if size is large.
- Provide first-run model verification and integrity check.
- Support model/profile updates via offline package import.

### Windows desktop or local host
- Run gateway as a background service or tray application.
- Bind to `127.0.0.1`.
- Keep model artifacts under an application data directory.

### Mobile constraints
If the React Native app must run on-device without a companion desktop/local server, expect stricter tradeoffs:
- lower context window
- smaller quantization
- weaker reranking
- possible removal of cross-encoder reranker
- careful battery and thermal management

For this project, a **local companion service** is the most production-ready interpretation of offline-first.

## 29. Concrete Minimal-Change Implementation Sequence for This Codebase

1. Introduce [`src/services/ai/localClient.ts`](../src/services/ai/localClient.ts) for local gateway requests.
2. Refactor [`src/services/ai/agent.ts`](../src/services/ai/agent.ts:65) into an adapter that calls the local gateway.
3. Replace API-key-centric state in [`src/store/useAIStore.ts`](../src/store/useAIStore.ts:6) with runtime-health-centric state.
4. Remove setup gating and model verification UI from [`src/screens/ChatbotScreen.tsx`](../src/screens/ChatbotScreen.tsx:45).
5. Update [`src/screens/SettingsScreen.tsx`](../src/screens/SettingsScreen.tsx:117) to remove Gemini key management and replace it with local engine diagnostics.
6. Keep the current chat UI and mode toggle initially, but rename `dump` to `structured` or remove it.
7. Preserve local OCR in [`src/services/ocr/index.ts`](../src/services/ocr/index.ts:10) and pipe extracted text into the local ingestion/indexing path.
8. Add a local gateway project, for example [`local-ai-gateway/`](../local-ai-gateway/) with endpoints, model runner, retrieval, and indexing workers.

## 30. Final Recommendation

The cleanest production-ready path is:

- **Qwen3.5-2B-Instruct** in **GGUF Q4_K_M** via **[`llama.cpp`](local/architecture.md:1)**
- **Custom local gateway** exposing stable app endpoints
- **SQLite + sqlite-vec + FTS5** for hybrid retrieval
- **Deterministic structured finance query layer** instead of model-generated SQL
- **Small local embedding model** separate from Qwen
- **Optional reranker** only after baseline latency is acceptable
- **Local session memory with summarization**
- **Full removal of Gemini API key flow and remote model selection**

This architecture preserves the existing app’s conversational experience while eliminating the current hosted dependency surface in [`src/services/ai/agent.ts`](../src/services/ai/agent.ts:1) and [`src/screens/ChatbotScreen.tsx`](../src/screens/ChatbotScreen.tsx:45), enabling private, offline-first RAG and chat with minimal application disruption.
