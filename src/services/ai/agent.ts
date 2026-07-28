import { Platform } from 'react-native';
import { expoDb, type AITransactionRow } from '../../db/index';
import { getModelLifecycleManager } from './modelLifecycle';
import { getGenerationService } from './generationService';
import { getOcrEngine } from '../ocr/index';
import { getLlamaRnAdapter } from './llamaRnAdapter';
import { useAIStore, type Message, getAIRuntimeAvailability } from '../../store/useAIStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import {
  QWEN_MODEL_DEFAULT_TEMPERATURE,
  QWEN_MODEL_DEFAULT_TOP_P,
  QWEN_MODEL_GROUNDED_TEMPERATURE,
  QWEN_MODEL_GROUNDED_TOP_P,
  QWEN_MODEL_HISTORY_TURN_LIMIT,
  QWEN_MODEL_MAX_GROUNDED_OUTPUT_TOKENS,
  QWEN_MODEL_MAX_OUTPUT_TOKENS,
  QWEN_MODEL_MAX_PROMPT_CHARS,
  QWEN_MODEL_MAX_RAG_CONTEXT_CHARS,
  QWEN_MODEL_RETRIEVAL_ITEM_LIMIT,
  QWEN_MODEL_STOP_TOKENS,
} from './config';
import {
  getErrorMessage,
  type LocalGenerationMetrics,
  type LocalGenerationRequest,
  type LocalGenerationResult,
  type LocalRuntimeInfo,
} from './localInferenceTypes';

export type LocalAiMode = 'rag' | 'chat';

export interface RetrievedContextItem {
  id: string;
  kind: 'transaction' | 'balance' | 'category-spending' | 'note';
  label: string;
  content: string;
  score: number;
}

const injectionPatterns = [/ignore all previous/i, /forget your instructions/i, /you are now a/i, /system prompt/i];
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'about',
  'balance',
  'based',
  'did',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'last',
  'me',
  'my',
  'of',
  'on',
  'or',
  'show',
  'spend',
  'spent',
  'tell',
  'the',
  'to',
  'transactions',
  'what',
  'with',
]);

function formatCurrency(amount: number | null | undefined): string {
  const safeAmount = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(safeAmount);
}

function findCategorySpending(userPrompt: string): { category: string | null; days: number } {
  const categoryMatch = userPrompt.match(/(?:spent on|spend on|for)\s+([a-zA-Z &-]+?)(?:\s+in|\s+over|\s+during|\?|$)/i);
  const daysMatch = userPrompt.match(/last\s+(\d+)\s+days?/i);

  return {
    category: categoryMatch?.[1]?.trim() ?? null,
    days: daysMatch ? Number(daysMatch[1]) : 30,
  };
}

function getRecentTransactions(limit = 5) {
  return expoDb.getAllSync<Pick<AITransactionRow, 'merchant_name' | 'total_amount' | 'category' | 'date' | 'note'>>(
    `SELECT merchant_name, total_amount, category, date, note
     FROM ai_transactions_view
     ORDER BY date DESC
     LIMIT ?`,
    [limit],
  );
}

function getCategorySpending(category: string, days: number) {
  const now = Date.now();
  const from = now - days * 24 * 60 * 60 * 1000;
  const rows = expoDb.getAllSync<{ total: number | null }>(
    'SELECT SUM(ABS(total_amount)) as total FROM ai_transactions_view WHERE total_amount < 0 AND category LIKE ? AND date >= ?',
    [`%${category}%`, from],
  );

  return rows[0]?.total ?? 0;
}

function getTotalBalance() {
  const rows = expoDb.getAllSync<{ total: number | null }>('SELECT SUM(total_amount) as total FROM ai_transactions_view');
  return rows[0]?.total ?? 0;
}

function buildOfflineProvisioningMessage() {
  const { provisioning, runtime } = useAIStore.getState();
  const runtimeReason = runtime.lastRuntimeError ? ` Runtime error: ${runtime.lastRuntimeError.message}` : '';
  const provisioningReason = provisioning.lastError ? ` Last error: ${provisioning.lastError}` : '';
  return `Silo AI local inference is unavailable. Current provisioning status: ${provisioning.status}.${provisioningReason}${runtimeReason}`;
}

function buildLocalInferenceUnavailableMessage() {
  return [
    'Local conversational generation is unavailable in this build.',
    'Please run on an Android device with local model support.',
    'Grounded local retrieval still works from data stored on this device only.',
    'Use Grounded mode for balances, category spending, and recent transaction questions.',
  ].join('\n\n');
}

function tokenizePrompt(userPrompt: string) {
  return userPrompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function scoreCandidate(userPrompt: string, haystack: string) {
  const tokens = tokenizePrompt(userPrompt);
  if (tokens.length === 0) {
    return 0;
  }

  const loweredHaystack = haystack.toLowerCase();
  let score = 0;
  tokens.forEach((token) => {
    if (loweredHaystack.includes(token)) {
      score += token.length > 4 ? 2 : 1;
    }
  });
  return score;
}

export function buildRetrievedContext(userPrompt: string): RetrievedContextItem[] {
  // Use FTS5 to find matches if possible.
  const keywords = userPrompt.replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(w => w.length > 2);
  const matchQuery = keywords.length > 0 ? keywords.map(w => `"${w}"*`).join(' OR ') : '';

  let ftsResults: any[] = [];
  if (matchQuery) {
    try {
      ftsResults = expoDb.getAllSync<Pick<AITransactionRow, 'transaction_id' | 'merchant_name' | 'total_amount' | 'category' | 'date' | 'note'>>(
        `SELECT v.transaction_id, v.merchant_name, v.total_amount, v.category, v.date, v.note
         FROM transactions_fts fts
         JOIN ai_transactions_view v ON fts.rowid = v.transaction_id
         WHERE transactions_fts MATCH ?
         ORDER BY rank
         LIMIT 20`,
        [matchQuery]
      );
    } catch (e) {
      console.warn('FTS query failed, falling back to manual scoring.', e);
    }
  }

  if (ftsResults.length === 0) {
    ftsResults = expoDb.getAllSync<Pick<AITransactionRow, 'transaction_id' | 'merchant_name' | 'total_amount' | 'category' | 'date' | 'note'>>(
      `SELECT transaction_id, merchant_name, total_amount, category, date, note
       FROM ai_transactions_view
       ORDER BY date DESC
       LIMIT 40`,
    );
  }

  const contextItems: RetrievedContextItem[] = ftsResults
    .map((row) => {
      const content = `${row.merchant_name || 'Unknown merchant'} ${row.category || 'Uncategorized'} ${formatCurrency(row.total_amount)} ${new Date(row.date).toLocaleDateString('en-GB')} ${row.note ?? ''}`;
      return {
        id: `tx-${row.transaction_id}`,
        kind: 'transaction' as const,
        label: row.merchant_name || 'Unknown merchant',
        content,
        score: matchQuery ? 100 : scoreCandidate(userPrompt, content), // FTS matches get static high score
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, QWEN_MODEL_RETRIEVAL_ITEM_LIMIT);

  const { category, days } = findCategorySpending(userPrompt);
  if (category) {
    const total = getCategorySpending(category, days);
    contextItems.unshift({
      id: `category-${category.toLowerCase()}`,
      kind: 'category-spending',
      label: `${category} spending`,
      content: `You spent ${formatCurrency(total)} on ${category} in the last ${days} days.`,
      score: 10,
    });
  }

  const totalBalance = getTotalBalance();
  contextItems.push({
    id: 'balance-total',
    kind: 'balance',
    label: 'Total balance',
    content: `Current total balance across local records: ${formatCurrency(totalBalance)}.`,
    score: /balance|money left|overall/i.test(userPrompt) ? 8 : 1,
  });

  return contextItems
    .sort((a, b) => b.score - a.score)
    .slice(0, QWEN_MODEL_RETRIEVAL_ITEM_LIMIT + 1);
}

function formatGroundedResponse(userPrompt: string, retrievedContext: RetrievedContextItem[]) {
  const topContext = retrievedContext.slice(0, 3);
  const bulletLines = topContext.map((item) => `- ${item.content}`).join('\n');

  if (/recent transactions|latest transactions/i.test(userPrompt)) {
    return `Here are the most relevant recent local records for your question:\n${bulletLines}`;
  }

  if (/balance|money left overall/i.test(userPrompt)) {
    const balanceItem = retrievedContext.find((item) => item.kind === 'balance');
    return balanceItem?.content ?? `I found grounded local context, but not a matching balance summary.\n${bulletLines}`;
  }

  const categoryItem = retrievedContext.find((item) => item.kind === 'category-spending');
  if (categoryItem) {
    return `${categoryItem.content}\n\nSupporting local context:\n${bulletLines}`;
  }

  return `Grounded local context for your question:\n${bulletLines}`;
}

function trimCollapsedText(value: string, maxChars: number) {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }

  return `${collapsed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function trimPreservedText(value: string, maxChars: number) {
  const normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function sanitizeModelText(value: string) {
  return value
    .replace(/<\|im_start\|>/g, '')
    .replace(/<\|im_end\|>/g, '')
    .replace(/<\|endoftext\|>/g, '')
    .replace(/\u0000/g, '')
    .trim();
}

export function estimateTokenCount(text: string | null | undefined): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  const wordCount = trimmed.split(/\s+/).length;
  const charBasedEstimate = Math.ceil(trimmed.length / 3.8);
  return Math.max(wordCount, charBasedEstimate);
}

export function manageContextWindow(chatHistory: Message[], maxContextTokens = 1024): {
  activeTurns: Message[];
  summaryText: string | null;
  totalTokens: number;
  summarizationActive: boolean;
} {
  if (chatHistory.length === 0) {
    return { activeTurns: [], summaryText: null, totalTokens: 0, summarizationActive: false };
  }

  const activeTurns = chatHistory.slice(-QWEN_MODEL_HISTORY_TURN_LIMIT);
  const olderTurns = chatHistory.slice(0, -QWEN_MODEL_HISTORY_TURN_LIMIT);
  
  let summaryText: string | null = null;
  let summarizationActive = false;
  
  if (olderTurns.length > 0) {
    summarizationActive = true;
    const summaryPoints = olderTurns.map((msg) => {
      const role = msg.role === 'user' ? 'User' : 'AI';
      const snippet = trimCollapsedText(msg.text, 80);
      return `${role}: ${snippet}`;
    });
    summaryText = `Previous conversation summary (${olderTurns.length} earlier messages):\n${summaryPoints.join(' | ')}`;
  }

  const turnsTokenCount = activeTurns.reduce((acc, msg) => acc + estimateTokenCount(msg.text), 0);
  const summaryTokenCount = estimateTokenCount(summaryText);
  let totalTokens = turnsTokenCount + summaryTokenCount;

  if (totalTokens > maxContextTokens && summaryText) {
    const allowedSummaryChars = Math.max(100, (maxContextTokens - turnsTokenCount) * 3);
    summaryText = trimCollapsedText(summaryText, allowedSummaryChars);
    totalTokens = turnsTokenCount + estimateTokenCount(summaryText);
  }

  try {
    useAIStore.getState().updateContextWindow({
      currentTokens: totalTokens,
      maxTokens: maxContextTokens,
      summarizationActive,
      windowTurnCount: activeTurns.length,
      summaryText,
    });
  } catch {
    // Ignore store update errors during initialization
  }

  return { activeTurns, summaryText, totalTokens, summarizationActive };
}

function buildChatHistorySummary(chatHistory: Message[]) {
  const { activeTurns, summaryText } = manageContextWindow(chatHistory);
  const turnLines = activeTurns.map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${trimCollapsedText(message.text, 220)}`);
  return [summaryText, ...turnLines].filter(Boolean).join('\n');
}

function hasUsableLocalInferenceBackend() {
  const settings = useSettingsStore.getState();
  if (settings.aiInferenceMode === 'external') {
    return true;
  }
  return Platform.OS === 'android';
}

function canUseNativeLocalInference() {
  if (!hasUsableLocalInferenceBackend()) {
    return false;
  }

  const state = useAIStore.getState();
  const runtimeAvailability = getAIRuntimeAvailability({
    provisioning: state.provisioning,
    runtimeReady: state.runtimeReady,
    warmupPending: state.warmupPending,
    runtime: state.runtime,
  });
  return runtimeAvailability.canRunNativeChat;
}

export async function ensureLocalRuntimeReady(onStatusChange?: (status: string) => void) {
  const settings = useSettingsStore.getState();
  if (settings.aiInferenceMode === 'external') {
    onStatusChange?.('External API mode ready.');
    return;
  }

  if (!hasUsableLocalInferenceBackend()) {
    onStatusChange?.('Local inference backend unavailable.');
    throw new Error(buildLocalInferenceUnavailableMessage());
  }

  const manager = getModelLifecycleManager();
  await manager.initialize();

  if (!canUseNativeLocalInference()) {
    onStatusChange?.('Preparing local model...');
    await manager.startProvisioningIfNeeded();
  }

  if (!canUseNativeLocalInference()) {
    throw new Error(buildOfflineProvisioningMessage());
  }
}

function answerStructuredPrompt(userPrompt: string): string | null {
  const normalizedPrompt = userPrompt.toLowerCase();

  if (normalizedPrompt.includes('total balance') || normalizedPrompt.includes('money left overall')) {
    const total = getTotalBalance();
    return `Your total balance is ${formatCurrency(total)} based on your local records.`;
  }

  if (normalizedPrompt.includes('recent transactions') || normalizedPrompt.includes('latest transactions')) {
    const rows = getRecentTransactions();
    if (rows.length === 0) {
      return 'You do not have any transactions recorded yet.';
    }

    const lines = rows
      .map((row) => `- ${row.merchant_name || 'Unknown merchant'} · ${formatCurrency(row.total_amount)} · ${row.category || 'Uncategorized'}`)
      .join('\n');

    return `Here are your most recent transactions:\n${lines}`;
  }

  if (normalizedPrompt.includes('spent on') || normalizedPrompt.includes('spend on')) {
    const { category, days } = findCategorySpending(userPrompt);
    if (!category) {
      return 'Tell me which category you want to check, for example: How much did I spend on food in the last 30 days?';
    }

    const total = getCategorySpending(category, days);
    return `You spent ${formatCurrency(total)} on ${category} in the last ${days} days based on your offline records.`;
  }

  return null;
}

function escapeChatSegment(value: string) {
  return sanitizeModelText(value).replace(/<\|im_start\|>/g, '').replace(/<\|im_end\|>/g, '').trim();
}

function supportsQwenChatTemplate(runtimeInfo: LocalRuntimeInfo | null | undefined) {
  const family = runtimeInfo?.loadedModelFamily?.toLowerCase() ?? '';
  const backend = runtimeInfo?.backend?.toLowerCase() ?? '';
  const loadedPath = runtimeInfo?.loadedModelPath?.toLowerCase() ?? '';
  return family.includes('qwen') || backend.includes('qwen') || loadedPath.includes('qwen');
}

function buildQwenChatPrompt(userPrompt: string, chatHistory: Message[], systemPrompt: string) {
  const { activeTurns, summaryText } = manageContextWindow(chatHistory);
  const effectiveSystemPrompt = summaryText ? `${systemPrompt}\n\n${summaryText}` : systemPrompt;
  const segments = [`<|im_start|>system\n${escapeChatSegment(effectiveSystemPrompt)}<|im_end|>`];

  activeTurns.forEach((message) => {
    const role = message.role === 'user' ? 'user' : 'assistant';
    segments.push(`<|im_start|>${role}\n${escapeChatSegment(message.text)}<|im_end|>`);
  });

  segments.push(`<|im_start|>user\n${escapeChatSegment(userPrompt)}<|im_end|>`);
  segments.push('<|im_start|>assistant\n');
  return segments.join('\n');
}

function buildFallbackChatPrompt(userPrompt: string, chatHistory: Message[], systemPrompt: string) {
  const historySummary = buildChatHistorySummary(chatHistory);
  return [
    systemPrompt,
    historySummary ? `Conversation so far:\n${historySummary}` : null,
    `User: ${userPrompt}`,
    'Assistant:',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildGroundedSystemPrompt(retrievedContext: RetrievedContextItem[], baseSystemPrompt: string) {
  const contextBlock = trimCollapsedText(
    retrievedContext
      .slice(0, QWEN_MODEL_RETRIEVAL_ITEM_LIMIT)
      .map((item) => `- ${trimCollapsedText(item.content, 320)}`)
      .join('\n'),
    QWEN_MODEL_MAX_RAG_CONTEXT_CHARS,
  );
  return [
    baseSystemPrompt,
    'Answer only from the grounded local finance facts below.',
    'If the facts are insufficient, say that you do not have enough local evidence.',
    `Grounded local facts:\n${contextBlock}`,
    'Respond in 3 short paragraphs or fewer.',
  ].join('\n\n');
}

export function buildPromptForMode(userPrompt: string, mode: LocalAiMode, state: ReturnType<typeof useAIStore.getState>, retrievedContext?: RetrievedContextItem[]) {
  const runtimeInfo = state.runtime.runtimeInfo;
  const customSystemPrompt = useSettingsStore.getState().localSystemPrompt;
  const defaultSystemPrompt = [
    'You are Silo AI, an offline finance assistant running locally on this Android device.',
    'Be concise, practical, and honest about uncertainty.',
    'Do not invent balances, transactions, or categories that are not present in the local app data.',
    'For exact numeric finance queries, the app handles deterministic answers before you are called.',
  ].join(' ');
  
  let systemPrompt = customSystemPrompt || defaultSystemPrompt;
  
  if (mode === 'rag' && retrievedContext) {
    systemPrompt = buildGroundedSystemPrompt(retrievedContext, systemPrompt);
  }

  const historyForPrompt = state.chatHistory.filter(msg => msg.status !== 'streaming');
  if (historyForPrompt.length > 0) {
    const lastMsg = historyForPrompt[historyForPrompt.length - 1];
    if (lastMsg.role === 'user' && lastMsg.text === userPrompt) {
      historyForPrompt.pop();
    }
  }

  const rawPrompt = supportsQwenChatTemplate(runtimeInfo)
    ? buildQwenChatPrompt(trimCollapsedText(userPrompt, 500), historyForPrompt, systemPrompt)
    : buildFallbackChatPrompt(trimCollapsedText(userPrompt, 500), historyForPrompt, systemPrompt);

  return supportsQwenChatTemplate(runtimeInfo)
    ? trimPreservedText(rawPrompt, QWEN_MODEL_MAX_PROMPT_CHARS)
    : trimCollapsedText(rawPrompt, QWEN_MODEL_MAX_PROMPT_CHARS);
}

export interface ExternalChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function buildExternalMessagesForMode(
  userPrompt: string,
  mode: LocalAiMode,
  state: ReturnType<typeof useAIStore.getState>,
  retrievedContext?: RetrievedContextItem[],
): ExternalChatMessage[] {
  const customSystemPrompt = useSettingsStore.getState().externalSystemPrompt;
  const defaultSystemPrompt = [
    'You are Silo AI, a helpful and intelligent personal finance assistant.',
    'Be concise, practical, and honest about uncertainty.',
    'Do not invent balances, transactions, or categories that are not present in the provided app data.',
  ].join(' ');
  let systemPrompt = customSystemPrompt || defaultSystemPrompt;

  if (mode === 'rag' && retrievedContext) {
    const contextBlock = trimCollapsedText(
      retrievedContext
        .slice(0, QWEN_MODEL_RETRIEVAL_ITEM_LIMIT)
        .map((item) => `- ${trimCollapsedText(item.content, 320)}`)
        .join('\n'),
      QWEN_MODEL_MAX_RAG_CONTEXT_CHARS,
    );
    systemPrompt = `${systemPrompt}\n\nAnswer only from the grounded local finance facts below. If the facts are insufficient, say that you do not have enough evidence.\n\nGrounded finance facts:\n${contextBlock}`;
  }

  const messages: ExternalChatMessage[] = [];
  
  const historyForPrompt = state.chatHistory.filter(msg => msg.status !== 'streaming');
  if (historyForPrompt.length > 0) {
    const lastMsg = historyForPrompt[historyForPrompt.length - 1];
    if (lastMsg.role === 'user' && lastMsg.text === userPrompt) {
      historyForPrompt.pop();
    }
  }

  const { activeTurns, summaryText } = manageContextWindow(historyForPrompt);
  const effectiveSystemPrompt = summaryText ? `${systemPrompt}\n\n${summaryText}` : systemPrompt;
  
  messages.push({ role: 'system', content: effectiveSystemPrompt });
  activeTurns.forEach((msg) => {
    messages.push({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.text,
    });
  });
  messages.push({ role: 'user', content: userPrompt });

  return messages;
}

function publishGenerationText(text: string, requestId: string, onStatusChange?: (status: string) => void) {
  const state = useAIStore.getState();
  if (state.runtime.activeGenerationRequestId !== requestId) {
    throw Object.assign(new Error('Local generation was cancelled.'), { code: 'generation-cancelled' });
  }

  state.setStreamingResponseText(text);
  onStatusChange?.('Assistant response ready.');
  return text;
}

export async function cancelActiveLocalGeneration(reason = 'Generation cancelled by user.') {
  const state = useAIStore.getState();
  const requestId = state.runtime.activeGenerationRequestId;
  if (!requestId) {
    return false;
  }

  state.appendLog({
    level: 'warn',
    event: 'generation-cancel-requested',
    message: reason,
    details: { requestId },
  });

  try {
    await getLlamaRnAdapter().stopCompletion();
  } catch (error) {
    state.appendLog({
      level: 'warn',
      event: 'generation-cancel-bridge-error',
      message: getErrorMessage(error, 'Native cancelGeneration() failed.'),
      details: { requestId },
    });
  } finally {
    const latestState = useAIStore.getState();
    latestState.setActiveGenerationRequestId(null);
    latestState.setStreamingResponseText('');
    latestState.setActiveStatusLabel('Cancelled', null);
    latestState.setRuntimeError({
      code: 'generation-cancelled',
      message: reason,
      recoverable: true,
    });
  }

  return true;
}

function buildGenerationStatusLabel(result: LocalGenerationResult) {
  if (typeof result.tokensPerSecond === 'number' && result.tokensPerSecond > 0) {
    return `Generating response locally... ${result.tokensPerSecond} tok/s`;
  }

  return 'Generating response locally...';
}

function appendGenerationLog(metrics: LocalGenerationMetrics) {
  useAIStore.getState().appendLog({
    level: metrics.status === 'error' ? 'error' : metrics.status === 'cancelled' ? 'warn' : 'info',
    event: `generation-${metrics.status}`,
    message: `Local assistant generation ${metrics.status}.`,
    details: metrics as unknown as Record<string, unknown>,
  });
}

function appendInferenceTraceLog(
  level: 'info' | 'warn' | 'error',
  event: string,
  message: string,
  details?: Record<string, unknown>,
) {
  useAIStore.getState().appendLog({
    level,
    event,
    message,
    details,
  });
}

function appendRuntimeDiagnosticsLog(
  requestId: string,
  runtimeInfo: LocalRuntimeInfo | null | undefined,
  mode: LocalAiMode,
  generationResult?: LocalGenerationResult,
) {
  if (!runtimeInfo) {
    return;
  }

  useAIStore.getState().appendLog({
    level: 'info',
    event: 'runtime-generation-diagnostics',
    message: 'Native runtime diagnostics captured for local generation.',
    details: {
      requestId,
      mode,
      backend: runtimeInfo.backend,
      version: runtimeInfo.version ?? null,
      loadedModelPath: runtimeInfo.loadedModelPath ?? null,
      loadedModelFamily: runtimeInfo.loadedModelFamily ?? null,
      loadedModelQuantization: runtimeInfo.loadedModelQuantization ?? null,
      abi: runtimeInfo.abi ?? null,
      supportsStreaming: runtimeInfo.supportsStreaming,
      maxContextTokens: runtimeInfo.maxContextTokens ?? null,
      isModelLoaded: runtimeInfo.isModelLoaded ?? null,
      configuredContextTokens: runtimeInfo.configuredContextTokens ?? null,
      configuredCpuThreads: runtimeInfo.configuredCpuThreads ?? null,
      configuredGpuLayers: runtimeInfo.configuredGpuLayers ?? null,
      configuredBatchTokens: runtimeInfo.configuredBatchTokens ?? null,
      configuredUseFlashAttention: runtimeInfo.configuredUseFlashAttention ?? null,
      configuredUseMlock: runtimeInfo.configuredUseMlock ?? null,
      resolvedContextTokens: runtimeInfo.resolvedContextTokens ?? null,
      resolvedBatchTokens: runtimeInfo.resolvedBatchTokens ?? null,
      resolvedMicroBatchTokens: runtimeInfo.resolvedMicroBatchTokens ?? null,
      resolvedThreads: runtimeInfo.resolvedThreads ?? null,
      resolvedThreadsBatch: runtimeInfo.resolvedThreadsBatch ?? null,
      resolvedOffloadKqv: runtimeInfo.resolvedOffloadKqv ?? null,
      estimatedGpuOffloadRequested: runtimeInfo.estimatedGpuOffloadRequested ?? null,
      gpuOffloadSupportedByBuild: runtimeInfo.gpuOffloadSupportedByBuild ?? null,
      detectedBackendDeviceCount: runtimeInfo.detectedBackendDeviceCount ?? null,
      detectedVulkanDeviceCount: runtimeInfo.detectedVulkanDeviceCount ?? null,
      detectedBackendSummary: runtimeInfo.detectedBackendSummary ?? null,
      detectedVulkanDevices: runtimeInfo.detectedVulkanDevices ?? null,
      likelyCpuOnlyRuntime: runtimeInfo.likelyCpuOnlyRuntime ?? null,
      lastPromptTokens: runtimeInfo.lastPromptTokens ?? null,
      lastCompletionTokens: runtimeInfo.lastCompletionTokens ?? null,
      lastPromptEvalDurationMs: runtimeInfo.lastPromptEvalDurationMs ?? null,
      lastGenerationEvalDurationMs: runtimeInfo.lastGenerationEvalDurationMs ?? null,
      lastTotalDurationMs: runtimeInfo.lastTotalDurationMs ?? null,
      lastStopReason: runtimeInfo.lastStopReason ?? null,
      generationResultPromptTokens: generationResult?.promptTokens ?? null,
      generationResultCompletionTokens: generationResult?.completionTokens ?? null,
      generationResultPromptEvalDurationMs: generationResult?.promptEvalDurationMs ?? null,
      generationResultGenerationEvalDurationMs: generationResult?.generationEvalDurationMs ?? null,
      generationResultTotalDurationMs: generationResult?.totalDurationMs ?? null,
      generationResultStopReason: generationResult?.stopReason ?? null,
      runtimeMatchesGeneration:
        generationResult == null
          ? null
          : {
              promptTokens:
                runtimeInfo.lastPromptTokens === undefined || generationResult.promptTokens === undefined
                  ? null
                  : runtimeInfo.lastPromptTokens === generationResult.promptTokens,
              completionTokens:
                runtimeInfo.lastCompletionTokens === undefined || generationResult.completionTokens === undefined
                  ? null
                  : runtimeInfo.lastCompletionTokens === generationResult.completionTokens,
              promptEvalDurationMs:
                runtimeInfo.lastPromptEvalDurationMs === undefined || generationResult.promptEvalDurationMs === undefined
                  ? null
                  : runtimeInfo.lastPromptEvalDurationMs === generationResult.promptEvalDurationMs,
              generationEvalDurationMs:
                runtimeInfo.lastGenerationEvalDurationMs === undefined || generationResult.generationEvalDurationMs === undefined
                  ? null
                  : runtimeInfo.lastGenerationEvalDurationMs === generationResult.generationEvalDurationMs,
              totalDurationMs:
                runtimeInfo.lastTotalDurationMs === undefined || generationResult.totalDurationMs === undefined
                  ? null
                  : runtimeInfo.lastTotalDurationMs === generationResult.totalDurationMs,
              stopReason:
                runtimeInfo.lastStopReason == null || generationResult.stopReason == null
                  ? null
                  : runtimeInfo.lastStopReason === generationResult.stopReason,
            },
    },
  });
}

async function runLocalGeneration(request: LocalGenerationRequest, mode: LocalAiMode, onStatusChange?: (status: string) => void) {
  const state = useAIStore.getState();
  const bridge = {
    generate: async (_req: unknown): Promise<LocalGenerationResult> => ({
      text: '',
      queueDurationMs: 0,
      promptEvalDurationMs: 0,
      generationEvalDurationMs: 0,
      totalDurationMs: 0,
      tokensPerSecond: 0,
      stopReason: 'stop' as const,
      promptTokens: 0,
      completionTokens: 0,
    }),
    getRuntimeInfo: async (): Promise<LocalRuntimeInfo> => getLlamaRnAdapter().getRuntimeInfo(),
  };
  const requestId = request.requestId ?? `req-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const metrics: LocalGenerationMetrics = {
    requestId,
    startedAt,
    promptChars: request.prompt.length,
    mode,
    status: 'running',
  };

  appendInferenceTraceLog('info', 'generation-request-received', 'Local generation request received by JS orchestrator.', {
    requestId,
    mode,
    promptChars: request.prompt.length,
    maxTokens: request.maxTokens ?? null,
    temperature: request.temperature ?? null,
    topP: request.topP ?? null,
    stopTokens: request.stop ?? [],
    stream: request.stream ?? false,
    runtimeState: state.runtime.runtimeState,
    runtimeReady: state.runtimeReady,
    modelLoaded: state.runtime.modelLoaded,
    generationHealthy: state.runtime.generationHealthy,
    activeGenerationRequestId: state.runtime.activeGenerationRequestId,
  });

  state.setActiveGenerationRequestId(requestId);
  state.setStreamingResponseText('');
  state.setActiveStatusLabel('Generating response locally...');
  state.setRuntimeError(null);
  appendGenerationLog({ ...metrics, status: 'queued' });
  appendInferenceTraceLog('info', 'generation-enqueued', 'Generation request enqueued in JS state and dispatched to native bridge.', {
    requestId,
    queuedAt: startedAt,
  });
  onStatusChange?.('Generating response locally...');

  try {
    appendInferenceTraceLog('info', 'generation-dispatch-native', 'Dispatching generation request to native bridge.', {
      requestId,
      dispatchDelayMs: Date.now() - startedAtMs,
    });
    const result = await bridge.generate({
      ...request,
      requestId,
    });

    appendInferenceTraceLog('info', 'generation-native-resolved', 'Native bridge generation call resolved.', {
      requestId,
      nativeRoundTripMs: Date.now() - startedAtMs,
      queueDurationMs: result.queueDurationMs ?? null,
      promptEvalDurationMs: result.promptEvalDurationMs ?? null,
      generationEvalDurationMs: result.generationEvalDurationMs ?? null,
      totalDurationMs: result.totalDurationMs ?? null,
      tokensPerSecond: result.tokensPerSecond ?? null,
      stopReason: result.stopReason ?? null,
      promptTokens: result.promptTokens ?? null,
      completionTokens: result.completionTokens ?? null,
      textChars: result.text.length,
    });

    const runtimeInfo = await bridge.getRuntimeInfo();
    state.setRuntimeInfo(runtimeInfo);
    appendRuntimeDiagnosticsLog(requestId, runtimeInfo, mode, result);
    appendInferenceTraceLog('info', 'generation-runtime-snapshot', 'Captured runtime snapshot after native generation.', {
      requestId,
      backend: runtimeInfo.backend,
      loadedModelPath: runtimeInfo.loadedModelPath ?? null,
      configuredGpuLayers: runtimeInfo.configuredGpuLayers ?? null,
      estimatedGpuOffloadRequested: runtimeInfo.estimatedGpuOffloadRequested ?? null,
      gpuOffloadSupportedByBuild: runtimeInfo.gpuOffloadSupportedByBuild ?? null,
      detectedBackendDeviceCount: runtimeInfo.detectedBackendDeviceCount ?? null,
      detectedVulkanDeviceCount: runtimeInfo.detectedVulkanDeviceCount ?? null,
      detectedBackendSummary: runtimeInfo.detectedBackendSummary ?? null,
      detectedVulkanDevices: runtimeInfo.detectedVulkanDevices ?? null,
      likelyCpuOnlyRuntime: runtimeInfo.likelyCpuOnlyRuntime ?? null,
      fallbackReason:
        runtimeInfo.estimatedGpuOffloadRequested && runtimeInfo.likelyCpuOnlyRuntime
          ? runtimeInfo.gpuOffloadSupportedByBuild
            ? 'gpu-requested-but-no-vulkan-devices-detected'
            : 'gpu-requested-but-build-has-no-gpu-offload-support'
          : null,
    });

    const cleanedText = sanitizeModelText(result.text);
    onStatusChange?.(buildGenerationStatusLabel(result));
    const streamedText = publishGenerationText(cleanedText, requestId, onStatusChange);
    state.setStreamingResponseText(streamedText);
    state.setActiveStatusLabel('Response ready', null);

    appendGenerationLog({
      ...metrics,
      finishedAt: new Date().toISOString(),
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalDurationMs: result.totalDurationMs,
      queueDurationMs: result.queueDurationMs,
      promptEvalDurationMs: result.promptEvalDurationMs,
      generationEvalDurationMs: result.generationEvalDurationMs,
      tokensPerSecond: result.tokensPerSecond,
      status: result.stopReason === 'cancelled' ? 'cancelled' : 'complete',
      stopReason: result.stopReason ?? null,
    });
    appendInferenceTraceLog('info', 'generation-complete', 'JS orchestration completed local generation successfully.', {
      requestId,
      totalElapsedMs: Date.now() - startedAtMs,
      finalTextChars: streamedText.length,
      stopReason: result.stopReason ?? null,
    });

    return streamedText.trim();
  } catch (error) {
    const latestState = useAIStore.getState();
    const message = getErrorMessage(error, 'Local assistant generation failed.');
    const isCancelled = typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'generation-cancelled';

    appendGenerationLog({
      ...metrics,
      finishedAt: new Date().toISOString(),
      status: isCancelled ? 'cancelled' : 'error',
      errorMessage: message,
    });
    appendInferenceTraceLog(isCancelled ? 'warn' : 'error', isCancelled ? 'generation-cancelled' : 'generation-failed', 'Local generation failed inside JS orchestration.', {
      requestId,
      totalElapsedMs: Date.now() - startedAtMs,
      errorMessage: message,
      errorCode: typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: string }).code ?? null : null,
    });

    if (!isCancelled) {
      latestState.setRuntimeError({
        code: 'generation-failed',
        message,
        recoverable: true,
      });
    }

    throw error;
  } finally {
    const latestState = useAIStore.getState();
    if (latestState.runtime.activeGenerationRequestId === requestId) {
      latestState.setActiveGenerationRequestId(null);
    }
    latestState.setActiveStatusLabel(null, null);
    appendInferenceTraceLog('info', 'generation-finalized', 'JS generation finalizer completed.', {
      requestId,
      totalElapsedMs: Date.now() - startedAtMs,
      runtimeState: latestState.runtime.runtimeState,
      activeGenerationRequestId: latestState.runtime.activeGenerationRequestId,
    });
  }
}

export const askFinancialAgent = async (
  userPrompt: string,
  _apiKey: string | null,
  _modelName: string | null,
  mode: LocalAiMode,
  onStatusChange?: (status: string) => void,
): Promise<string> => {
  for (const pattern of injectionPatterns) {
    if (pattern.test(userPrompt)) {
      return '🛡️ **GUARDRAIL TRIGGERED:** Potential prompt injection detected. Request blocked.';
    }
  }

  const shouldRequireNativeRuntime = mode === 'chat';

  if (shouldRequireNativeRuntime) {
    await ensureLocalRuntimeReady(onStatusChange);
    onStatusChange?.('Running local inference...');
  } else {
    onStatusChange?.('Retrieving grounded local context...');
  }

  const structuredAnswer = answerStructuredPrompt(userPrompt);
  if (structuredAnswer) {
    return structuredAnswer;
  }

  if (mode === 'rag') {
    const retrievedContext = buildRetrievedContext(userPrompt);
    if (retrievedContext.length === 0) {
      return 'No grounded local context matched your question yet. Try asking about a merchant, category, balance, or recent transactions already stored on this device.';
    }

    if (!canUseNativeLocalInference()) {
      return formatGroundedResponse(userPrompt, retrievedContext);
    }

    const prompt = buildPromptForMode(userPrompt, mode, useAIStore.getState(), retrievedContext);
    return runLocalGeneration(
      {
        prompt,
        maxTokens: QWEN_MODEL_MAX_GROUNDED_OUTPUT_TOKENS,
        temperature: QWEN_MODEL_GROUNDED_TEMPERATURE,
        topP: QWEN_MODEL_GROUNDED_TOP_P,
        stop: [...QWEN_MODEL_STOP_TOKENS],
      },
      mode,
      onStatusChange,
    );
  }

  const prompt = buildPromptForMode(userPrompt, mode, useAIStore.getState());

  return runLocalGeneration(
    {
      prompt,
      maxTokens: QWEN_MODEL_MAX_OUTPUT_TOKENS,
      temperature: QWEN_MODEL_DEFAULT_TEMPERATURE,
      topP: QWEN_MODEL_DEFAULT_TOP_P,
      stop: [...QWEN_MODEL_STOP_TOKENS],
    },
    mode,
    onStatusChange,
  );
};

export interface ParsedReceiptResult {
  merchantName?: string;
  totalAmount?: number;
  category?: string;
  lineItemsText?: string;
  date?: string;
}

export const analyzeReceiptImage = async (imageUri?: string, base64Image?: string): Promise<ParsedReceiptResult | null> => {
  if (!imageUri) return null;
  
  // 1. Run local OCR
  const engineId = useSettingsStore.getState().ocrEngineId;
  const ocrEngine = getOcrEngine(engineId);
  const ocrResult = await ocrEngine.processImage(imageUri);
  if (!ocrResult.success || !ocrResult.rawText) {
    throw new Error('NO_TEXT_DETECTED');
  }
  
  await ensureLocalRuntimeReady();

  // 2. Extract entities via LLM
  const prompt = `You are a financial receipt parser.
Extract the following information from the OCR text below:
- merchantName: Name of the store or merchant.
- totalAmount: The total cost as a number.
- category: A short category (e.g. "Food", "Transport", "Groceries").
- date: Date of the receipt in YYYY-MM-DD format.
- lineItemsText: A brief comma-separated list of items bought.

Return ONLY a valid JSON object matching these keys. If a value is missing, omit the key or use null.

OCR TEXT:
${ocrResult.rawText}

JSON RESPONSE:`;

  try {
    const responseText = await getGenerationService().startGeneration({ 
      prompt, 
      mode: 'chat' // chat mode gives it general reasoning capability
    });
    
    // Attempt to extract JSON from the response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsedData = JSON.parse(jsonMatch[0]);
      return {
        merchantName: parsedData.merchantName || ocrResult.extractedMerchant || undefined,
        totalAmount: typeof parsedData.totalAmount === 'number' ? parsedData.totalAmount : ocrResult.extractedTotal || undefined,
        category: parsedData.category,
        lineItemsText: parsedData.lineItemsText,
        date: parsedData.date,
      };
    }
  } catch (error) {
    console.error("LLM Extraction Error:", error);
    // Fallback to basic OCR data if LLM fails
    return {
      totalAmount: ocrResult.extractedTotal || undefined,
    };
  } finally {
    getGenerationService().scheduleModelUnload(10000); // Unload after 10 seconds of idle
  }
  
  return null;
};
