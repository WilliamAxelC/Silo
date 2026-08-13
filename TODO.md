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
- [x] Add support for additional authentication schemes and custom headers (e.g., Anthropic Claude API, Google Gemini API).
- [x] Implement automatic failover from local on-device inference to External API when device RAM or battery is critically low.
- [x] Allow customizable system prompts per inference mode in user settings.

### Advanced RAG & Grounding Capabilities
- [x] Implement full-text SQLite indexing (FTS5) or vector embeddings for semantic search across transaction histories and receipt OCR text.
- [x] Enable multi-turn conversational follow-ups on grounded RAG financial queries.
- [x] Support interactive data visualizations and chart rendering directly within chat response bubbles.

### Model Provisioning & Storage Management
- [x] Add an interactive model management UI in Settings allowing users to delete downloaded weights or switch between different GGUF quantization tiers (e.g., `Q4_K_M`, `Q2_K`, `INT4`) on demand.
- [x] Support Wi-Fi-only download restrictions for OTA model provisioning.
- [x] Add automatic quantization fallback (`Q4_K_M` → `Q2_K`) on repeated out-of-memory failures during model initialization.
- [ ] Fix: Cancel download button doesn't work reliably when provisioning AI models.

- [x] Add some test cases for LLM inference.
- [x] Implement Local Bill OCR Capabilities, be it by MLKit or PaddleOCR. The results of the OCR will then have the data extracted by an LLM to automatically create transactions.

---

## Codebase Improvements (Discovered 2026-08-13)

### 14. Database Performance — Missing Indexes
- [ ] Add indexes to heavily queried columns in [`src/db/index.ts`](file:///home/william/workspace/Silo/src/db/index.ts) (`createBaseSchema`, Lines 22-33).
  - **Why**: `transactions` table is filtered/sorted by `date` on every screen (CashflowScreen, ReportsScreen, RAG queries). `transaction_items` is joined on `transaction_id` constantly. `budgets` is filtered by `category`. Without indexes these are all full table scans.
  - **Steps**:
    1. Create a new migration function `migrateToVersion8()` in `src/db/index.ts`.
    2. Add these `CREATE INDEX IF NOT EXISTS` statements:
       ```sql
       CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
       CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
       CREATE INDEX IF NOT EXISTS idx_transaction_items_txn_id ON transaction_items(transaction_id);
       CREATE INDEX IF NOT EXISTS idx_budgets_category ON budgets(category);
       CREATE INDEX IF NOT EXISTS idx_categories_type ON categories(type);
       ```
    3. Add the `if (currentVersion < 8)` guard in `runMigrations()` (after Line 252).
    4. Bump `DB_SCHEMA_VERSION` from `7` to `8` (Line 20).

### 15. Database Integrity — Batch Operations Without Transactions
- [ ] Wrap multi-table mutations in database transactions in [`src/db/index.ts`](file:///home/william/workspace/Silo/src/db/index.ts) and [`src/store/useTransactionStore.ts`](file:///home/william/workspace/Silo/src/store/useTransactionStore.ts).
  - **Why**: `deleteTransaction` (Lines 315-323) deletes `transactionItems` then `transactions` as separate queries — if the app crashes between them, the DB is left inconsistent with orphaned items or missing parents. Same risk in `seedDefaultCategories` (Lines 74-88) and `migrateLegacyCategories` (Lines 90-127) which loop individual `INSERT`s.
  - **Steps**:
    1. In `useTransactionStore.ts` `deleteTransaction` (Line 315), wrap the two deletes:
       ```ts
       await db.transaction(async (tx) => {
         await tx.delete(transactionItems).where(eq(transactionItems.transactionId, id));
         await tx.delete(transactions).where(eq(transactions.id, id));
       });
       ```
    2. In `useTransactionStore.ts` `addTransaction` (Line 223), wrap the `insert(transactions)` + `insert(transactionItems)` in a single transaction.
    3. In `src/db/index.ts`, wrap `seedDefaultCategories` (Line 74) and `migrateLegacyCategories` (Line 90) loops in `expoDb.withTransactionSync(() => { ... })`.
    4. In `useTransactionStore.ts` `renameCategory` (Line 170), wrap the category rename + transactionItems update + budgets update in a transaction.

### 16. Error Resilience — Top-Level Error Boundary
- [ ] Add a React Error Boundary to prevent white-screen crashes.
  - **Why**: [`App.tsx`](file:///home/william/workspace/Silo/App.tsx) (Lines 10-19) has no error boundary. An unhandled JS exception in any child screen crashes the entire app to a blank white screen with no recovery path.
  - **Steps**:
    1. Create `src/components/ErrorBoundary.tsx` — a class component implementing `componentDidCatch` and `getDerivedStateFromError`.
    2. Render a fallback UI with: an error icon, "Something went wrong" message, the error message (in `__DEV__` mode), and a "Restart" button that calls `this.setState({ hasError: false })`.
    3. In `App.tsx`, wrap `<AppNavigator />` (Line 15) with `<ErrorBoundary>`.

### 17. Error Resilience — User-Facing Error State in Transaction Store
- [ ] Surface store errors to the UI instead of silently `console.error`-ing.
  - **Why**: In [`src/store/useTransactionStore.ts`](file:///home/william/workspace/Silo/src/store/useTransactionStore.ts), `fetchTransactions` (Line 86), `fetchCategories` (Line 103), `fetchBudgets` (Line 114), `deleteTransaction` (Line 322), `clearAllData` (Line 345) all catch errors and only `console.error` — the user sees nothing.
  - **Steps**:
    1. Add `error: string | null` and `clearError: () => void` to `TransactionState` interface (Line 22).
    2. Initialize `error: null` in the store (Line 59).
    3. In each catch block, add `set({ error: getErrorMessage(error) })` alongside the `console.error`.
    4. Add `clearError: () => set({ error: null })` action.
    5. In `CashflowScreen.tsx`, consume `error` from the store and show a dismissible banner/toast when non-null.

### 18. Performance — Zustand Selector Granularity
- [ ] Split broad Zustand destructuring into atomic selectors in screen components.
  - **Why**: In [`src/screens/ChatbotScreen.tsx`](file:///home/william/workspace/Silo/src/screens/ChatbotScreen.tsx) and [`src/screens/SettingsScreen.tsx`](file:///home/william/workspace/Silo/src/screens/SettingsScreen.tsx), multiple fields are pulled from `useAIStore()` in a single destructure. A change to *any* field (e.g., `downloadProgress` ticking) causes a full re-render of the entire screen.
  - **Steps**:
    1. Replace patterns like `const { streamingText, chatHistory, provisioning } = useAIStore()` with individual selectors:
       ```ts
       const streamingText = useAIStore(s => s.runtime.streamingResponseText);
       const chatHistory = useAIStore(s => s.chatHistory);
       const provisioningStatus = useAIStore(s => s.provisioning.status);
       ```
    2. Apply the same pattern in `SettingsScreen.tsx` for `useSettingsStore` calls.

### 19. Performance — `useMonthlySummary` Triple Array Iteration
- [ ] Combine the three array passes in [`src/hooks/useMonthlySummary.ts`](file:///home/william/workspace/Silo/src/hooks/useMonthlySummary.ts) (Lines 10-23) into a single `.reduce()`.
  - **Why**: The current code filters the list once (Line 10), then filters+reduces for income (Lines 15-17), then filters+reduces again for expenses (Lines 19-22) — traversing the array 3 times on every recalculation.
  - **Steps**:
    1. Replace Lines 10-24 with a single `transactionsList.reduce()` that checks `isSameMonth` and accumulates `totalIncome`, `totalExpense`, `currentMonthData`, and `currentMonthExpenses` in one pass.

### 20. Code Quality — Suppress Logs Only in Dev
- [ ] Guard `LogBox.ignoreAllLogs(true)` behind `__DEV__` in [`App.tsx`](file:///home/william/workspace/Silo/App.tsx) (Line 8).
  - **Why**: This unconditionally suppresses all React Native LogBox warnings, including in production builds, hiding real issues.
  - **Steps**:
    1. Change Line 8 from `LogBox.ignoreAllLogs(true);` to `if (__DEV__) LogBox.ignoreAllLogs(true);`.

### 21. Code Quality — ChatChart Missing Memoization and Inline Styles
- [ ] Memoize and extract styles from [`src/components/ChatChart.tsx`](file:///home/william/workspace/Silo/src/components/ChatChart.tsx).
  - **Why**: The component is not wrapped in `React.memo` (Line 11) so it re-renders whenever the parent re-renders. All styles are inline objects (Lines 29, 47-48) which allocate new objects every render.
  - **Steps**:
    1. Change `export function ChatChart` to `export const ChatChart = React.memo(function ChatChart`.
    2. Extract inline style objects on Lines 29 and 47-48 into a `StyleSheet.create()` block at the bottom of the file.

### 22. Code Quality — AddTransactionScreen Decomposition
- [ ] Extract sub-components from the 738-line [`src/screens/AddTransactionScreen.tsx`](file:///home/william/workspace/Silo/src/screens/AddTransactionScreen.tsx).
  - **Why**: This file is a single monolithic component handling form state, receipt OCR, image picking, date picking, category selection modals, and receipt line item editing — all in one render function. It's very difficult to reason about, test, or maintain.
  - **Steps**:
    1. Extract the receipt line items editor section into `src/components/ReceiptItemsEditor.tsx`.
    2. Extract the category selection modal into `src/components/CategorySelectorModal.tsx`.
    3. Extract the source selection modal (Manual / Camera / Gallery) into `src/components/SourceSelectorModal.tsx`.
    4. The main screen should compose these components and pass state down via props.

### 23. UX — Missing Pull-to-Refresh on CashflowScreen
- [ ] Add pull-to-refresh to the `SectionList` in [`src/screens/CashflowScreen.tsx`](file:///home/william/workspace/Silo/src/screens/CashflowScreen.tsx) (Line 71).
  - **Why**: The CashflowScreen fetches transactions on focus (Line 21-25), but users have no manual way to trigger a data refresh if they suspect stale data.
  - **Steps**:
    1. Import `RefreshControl` from `react-native`.
    2. Add `const [refreshing, setRefreshing] = useState(false)` state.
    3. Create an `onRefresh` callback that sets `refreshing`, calls `fetchTransactions()`, then clears `refreshing`.
    4. Add `refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} />}` to the `SectionList` on Line 71.

### 24. UX — Missing Keyboard Handling in ChatbotScreen
- [ ] Add keyboard dismissal and avoidance to [`src/screens/ChatbotScreen.tsx`](file:///home/william/workspace/Silo/src/screens/ChatbotScreen.tsx).
  - **Why**: Tapping outside the chat input field does not dismiss the keyboard, and the keyboard can overlap content on devices without gesture navigation.
  - **Steps**:
    1. Import `KeyboardAvoidingView`, `Keyboard`, `TouchableWithoutFeedback`, `Platform` from `react-native`.
    2. Wrap the screen content in `<KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>`.
    3. Wrap the scrollable chat area in `<TouchableWithoutFeedback onPress={Keyboard.dismiss}>`.

### 25. Project Hygiene — Crash/Debug Logs in Git
- [ ] Remove large debug files from version control and update [`.gitignore`](file:///home/william/workspace/Silo/.gitignore).
  - **Why**: `crash-full.txt` (2.9 MB), `crash.log` (143 KB), `crash2.log` (170 KB), `crash3.log` (84 KB), `crash-native.txt` (26 KB), and `build-debug-full.log` (96 KB) are tracked in git. These bloat the repo and serve no purpose in source control.
  - **Steps**:
    1. Add these lines to `.gitignore`:
       ```
       crash*.txt
       crash*.log
       build-*.log
       ```
    2. Remove from tracking: `git rm --cached crash-full.txt crash.log crash2.log crash3.log crash-native.txt build-debug-full.log`.
    3. Commit the `.gitignore` change and the removals.

### 26. Project Hygiene — Missing Developer Tooling Scripts
- [ ] Add lint, format, and typecheck scripts to [`package.json`](file:///home/william/workspace/Silo/package.json).
  - **Why**: No ESLint, Prettier, or TypeScript checking scripts exist. Only `@types/jest` is in devDependencies, but `jest` and `jest-expo` aren't installed, so `@types/jest` is unused.
  - **Steps**:
    1. Install devDependencies: `npm install -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin prettier jest jest-expo`.
    2. Add scripts to `package.json`:
       ```json
       "lint": "expo lint",
       "format": "prettier --write 'src/**/*.{ts,tsx}'",
       "typecheck": "tsc --noEmit",
       "test": "jest"
       ```
    3. Create `.prettierrc` with project defaults.
    4. Create `jest.config.js` with `preset: 'jest-expo'`.

### 27. Project Hygiene — `.vscode/settings.json` Contains Irrelevant C++ Config
- [x] Clean up [`.vscode/settings.json`](file:///home/william/workspace/Silo/.vscode/settings.json).
  - **Why**: The file is populated entirely with `C_Cpp_Runner` configurations (compiler paths, C/C++ flags) that were auto-generated locally. It lacks any shared settings for the actual TypeScript/React Native project.
  - **Steps**:
    1. Remove all `C_Cpp_Runner.*` entries.
    2. Add useful shared settings:
       ```json
       {
         "typescript.tsdk": "node_modules/typescript/lib",
         "editor.formatOnSave": true,
         "editor.defaultFormatter": "esbenp.prettier-vscode"
       }
       ```

### 28. Accessibility — Missing Labels on Interactive Elements
- [ ] Add `accessibilityLabel` and `accessibilityRole` props to all interactive elements.
  - **Why**: `TouchableOpacity` buttons in [`CashflowScreen.tsx`](file:///home/william/workspace/Silo/src/screens/CashflowScreen.tsx) (Lines 62, 66, 73-78, 79), [`ChatChart.tsx`](file:///home/william/workspace/Silo/src/components/ChatChart.tsx), and [`AppNavigator.tsx`](file:///home/william/workspace/Silo/src/navigation/AppNavigator.tsx) (Line 73-78, the FAB button) all lack accessibility annotations. The app is unusable with TalkBack.
  - **Steps**:
    1. In `CashflowScreen.tsx`, add `accessibilityRole="button"` and descriptive `accessibilityLabel` (e.g., `"Previous month"`, `"Next month"`) to the month navigation TouchableOpacity elements (Lines 62, 66).
    2. In `CashflowScreen.tsx`, add `accessibilityLabel` to transaction rows (Line 79) like `accessibilityLabel={\`${item.merchantName}, ${item.totalAmount}\`}`.
    3. In `AppNavigator.tsx`, add `accessibilityLabel="Add transaction"` and `accessibilityRole="button"` to the FAB (Line 73).

### 29. Theme — Missing Spacing & Typography Scale
- [ ] Extend the theme system in [`src/theme/colors.ts`](file:///home/william/workspace/Silo/src/theme/colors.ts) with spacing and typography tokens.
  - **Why**: The current theme only defines 8 color tokens (Lines 1-21). Font sizes, spacing, and border radii are hardcoded per-component across every screen, leading to inconsistency and making global design changes painful.
  - **Steps**:
    1. Create `src/theme/spacing.ts` defining a spacing scale: `export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };`.
    2. Create `src/theme/typography.ts` defining font sizes and weights: `export const typography = { h1: { fontSize: 24, fontWeight: '700' }, body: { fontSize: 14, fontWeight: '400' }, caption: { fontSize: 12, fontWeight: '400' } }`.
    3. Re-export from `src/theme/useAppTheme.ts` so screens can use `theme.spacing.md` and `theme.typography.body`.

### 30. Navigation — Missing Deep Linking
- [ ] Add deep linking configuration to [`src/navigation/AppNavigator.tsx`](file:///home/william/workspace/Silo/src/navigation/AppNavigator.tsx) (Line 121).
  - **Why**: The `NavigationContainer` has no `linking` prop. The app cannot respond to external intents, URLs, or push notification deep links.
  - **Steps**:
    1. Define a `linking` config object:
       ```ts
       const linking = {
         prefixes: ['silo://', 'https://silo.app'],
         config: {
           screens: {
             MainTabs: { screens: { Cashflow: 'cashflow', Reports: 'reports', Budget: 'budget', More: 'more' } },
             Chatbot: 'chat',
             AddTransactionStack: 'add/:transactionId?',
             Settings: 'settings',
           },
         },
       };
       ```
    2. Pass `linking={linking}` to `<NavigationContainer>` on Line 121.
    3. Register the `silo://` URL scheme in `app.json` under `expo.scheme`.