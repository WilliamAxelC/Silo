import { Image } from 'react-native';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { expoDb, type AITransactionRow } from '../../db/index';
import { isActiveModelInstalled } from './modelLifecycle';
import { getOcrEngine } from '../ocr/index';
import { inferReceiptCategory, reconstructMultiColumnOcrText } from '../ocr/MlKitEngine';
import { isGrounded, pickTotalFromRows } from '../ocr/receiptText';
import { assessReceiptConfidence, type ReceiptConfidence } from '../ocr/receiptConfidence';
import { parseSignedAmount } from '../../features/transactions/amount';
import { useAIStore, type Message } from '../../store/useAIStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import {
  QWEN_MODEL_HISTORY_TURN_LIMIT,
  QWEN_MODEL_MAX_PROMPT_CHARS,
  QWEN_MODEL_MAX_RAG_CONTEXT_CHARS,
  QWEN_MODEL_RETRIEVAL_ITEM_LIMIT,
} from './config';
import type { LocalRuntimeInfo } from './localInferenceTypes';

export type LocalAiMode = 'rag' | 'chat';

export interface RetrievedContextItem {
  id: string;
  kind: 'transaction' | 'balance' | 'category-spending' | 'note';
  label: string;
  content: string;
  score: number;
}

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

function getCategorySpending(category: string, days: number): { total: number; count: number } {
  const now = Date.now();
  const from = now - days * 24 * 60 * 60 * 1000;
  const rows = expoDb.getAllSync<{ total: number | null; count?: number | null }>(
    "SELECT SUM(ABS(total_amount)) as total, COUNT(*) as count FROM ai_transactions_view WHERE total_amount < 0 AND type != 'transfer' AND category LIKE ? AND date >= ?",
    [`%${category}%`, from],
  );

  return {
    total: rows[0]?.total ?? 0,
    count: typeof rows[0]?.count === 'number' && Number.isFinite(rows[0].count) ? rows[0].count : 0,
  };
}

function getTotalBalance() {
  // Net worth: opening balances plus all income and spending; transfers only move money between accounts.
  const rows = expoDb.getAllSync<{ total: number | null }>(
    "SELECT (SELECT COALESCE(SUM(initial_balance), 0) FROM wallets) + (SELECT COALESCE(SUM(total_amount), 0) FROM transactions WHERE type != 'transfer') AS total",
  );
  return rows[0]?.total ?? 0;
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
  const { category, days } = findCategorySpending(userPrompt);
  const asksBalance = /balance|money left|overall|net worth|have left/i.test(userPrompt);
  const wantsRecent = /recent|latest|last|history|list|transactions/i.test(userPrompt);

  if (asksBalance) {
    const totalBalance = getTotalBalance();
    return [
      {
        id: 'balance-total',
        kind: 'balance',
        label: 'Total balance',
        content: `Total balance: ${formatCurrency(totalBalance)}.`,
        score: 200,
      },
    ];
  }

  const categorySummary = category ? getCategorySpending(category, days) : null;
  if (category && categorySummary && categorySummary.total > 0) {
    const countSuffix = categorySummary.count > 0
      ? ` (${categorySummary.count} ${categorySummary.count === 1 ? 'transaction' : 'transactions'})`
      : '';
    return [
      {
        id: `category-${category.toLowerCase()}`,
        kind: 'category-spending',
        label: `${category} spending`,
        content: `Total spent on ${category} (last ${days}d): ${formatCurrency(categorySummary.total)}${countSuffix}.`,
        score: 200,
      },
    ];
  }

  const tokens = tokenizePrompt(userPrompt);
  const ftsKeywords = tokens.filter((w) => w.length > 2);
  const matchQuery = ftsKeywords.length > 0 ? ftsKeywords.map((w) => `"${w}"*`).join(' OR ') : '';

  let ftsResults: Array<Pick<AITransactionRow, 'transaction_id' | 'merchant_name' | 'total_amount' | 'category' | 'date' | 'note'>> = [];
  if (matchQuery) {
    try {
      ftsResults = expoDb.getAllSync<Pick<AITransactionRow, 'transaction_id' | 'merchant_name' | 'total_amount' | 'category' | 'date' | 'note'>>(
        `SELECT v.transaction_id, v.merchant_name, v.total_amount, v.category, v.date, v.note
         FROM transactions_fts fts
         JOIN ai_transactions_view v ON fts.rowid = v.transaction_id
         WHERE transactions_fts MATCH ?
         ORDER BY rank
         LIMIT 10`,
        [matchQuery],
      );
    } catch (e) {
      console.warn('FTS query failed, falling back to manual scoring.', e);
    }
  }

  const usedFts = ftsResults.length > 0;
  let candidateRows = ftsResults;
  if (!usedFts) {
    candidateRows = expoDb.getAllSync<Pick<AITransactionRow, 'transaction_id' | 'merchant_name' | 'total_amount' | 'category' | 'date' | 'note'>>(
      `SELECT transaction_id, merchant_name, total_amount, category, date, note
       FROM ai_transactions_view
       ORDER BY date DESC
       LIMIT 20`,
    );
  }

  const formatTxFact = (row: Pick<AITransactionRow, 'merchant_name' | 'total_amount' | 'category' | 'date' | 'note'>) => {
    const merchant = row.merchant_name || 'Unknown';
    const cat = row.category ? ` (${row.category})` : '';
    const d = new Date(row.date);
    const dateStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    return trimCollapsedText(`${merchant}${cat}: ${formatCurrency(row.total_amount)} on ${dateStr}`, 110);
  };

  let transactionItems: RetrievedContextItem[] = candidateRows
    .map((row, idx) => {
      const content = formatTxFact(row);
      const score = usedFts ? 100 - idx : scoreCandidate(userPrompt, `${row.merchant_name || ''} ${row.category || ''} ${row.note || ''}`);
      return {
        id: `tx-${row.transaction_id}`,
        kind: 'transaction' as const,
        label: row.merchant_name || 'Unknown merchant',
        content,
        score,
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, QWEN_MODEL_RETRIEVAL_ITEM_LIMIT);

  if (transactionItems.length === 0 && candidateRows.length > 0 && !category) {
    const recentLimit = wantsRecent ? QWEN_MODEL_RETRIEVAL_ITEM_LIMIT : Math.min(2, QWEN_MODEL_RETRIEVAL_ITEM_LIMIT);
    transactionItems = candidateRows.slice(0, recentLimit).map((row, idx) => ({
      id: `tx-${row.transaction_id}`,
      kind: 'transaction' as const,
      label: row.merchant_name || 'Unknown merchant',
      content: formatTxFact(row),
      score: (wantsRecent ? 40 : 5) - idx,
    }));
  }

  const contextItems: RetrievedContextItem[] = [...transactionItems];

  if (category && transactionItems.length === 0) {
    contextItems.unshift({
      id: `category-${category.toLowerCase()}`,
      kind: 'category-spending',
      label: `${category} spending`,
      content: `Total spent on ${category} (last ${days}d): ${formatCurrency(0)}.`,
      score: 200,
    });
  }

  if (!category && !wantsRecent) {
    const totalBalance = getTotalBalance();
    contextItems.push({
      id: 'balance-total',
      kind: 'balance',
      label: 'Total balance',
      content: `Total balance: ${formatCurrency(totalBalance)}.`,
      score: 10,
    });
  }

  return contextItems
    .sort((a, b) => b.score - a.score)
    .slice(0, QWEN_MODEL_RETRIEVAL_ITEM_LIMIT);
}

function trimCollapsedText(value: string, maxChars: number) {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }

  return `${collapsed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
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

function escapeChatSegment(value: string) {
  return sanitizeModelText(value).replace(/<\|im_start\|>/g, '').replace(/<\|im_end\|>/g, '').trim();
}

function supportsQwenChatTemplate(runtimeInfo: LocalRuntimeInfo | null | undefined) {
  const family = runtimeInfo?.loadedModelFamily?.toLowerCase() ?? '';
  const backend = runtimeInfo?.backend?.toLowerCase() ?? '';
  const loadedPath = runtimeInfo?.loadedModelPath?.toLowerCase() ?? '';
  return family.includes('qwen') || backend.includes('qwen') || loadedPath.includes('qwen');
}

const MAX_LOCAL_HISTORY_TURN_CHARS = 180;
const MAX_LOCAL_SUMMARY_CHARS = 220;
const MAX_LOCAL_USER_PROMPT_CHARS = 450;
const DEFAULT_LOCAL_SYSTEM_PROMPT =
  'You are Silo AI, a concise offline personal finance assistant. Reply in 2-4 short sentences or brief bullets; never invent balances or transactions.';
const DEFAULT_GROUNDED_SYSTEM_PROMPT =
  'You are Silo AI, an offline finance assistant. Answer only from the grounded local finance facts below in 1-2 short sentences. If insufficient, say you do not have enough local evidence.';

function buildCompactContextBlock(retrievedContext: RetrievedContextItem[], maxChars = QWEN_MODEL_MAX_RAG_CONTEXT_CHARS): string {
  const lines: string[] = [];
  let usedChars = 0;

  for (const item of retrievedContext.slice(0, QWEN_MODEL_RETRIEVAL_ITEM_LIMIT)) {
    const line = `- ${trimCollapsedText(item.content, 140)}`;
    const extra = lines.length > 0 ? line.length + 1 : line.length;
    if (lines.length > 0 && usedChars + extra > maxChars) {
      break;
    }
    if (lines.length === 0 && line.length > maxChars) {
      lines.push(trimCollapsedText(line, maxChars));
      break;
    }
    lines.push(line);
    usedChars += extra;
  }

  return lines.join('\n');
}

function getTrimmedHistoryForPrompt(userPrompt: string, state: ReturnType<typeof useAIStore.getState>): Message[] {
  const historyForPrompt = state.chatHistory.filter((msg) => msg.status !== 'streaming');
  if (historyForPrompt.length > 0) {
    const lastMsg = historyForPrompt[historyForPrompt.length - 1];
    if (lastMsg.role === 'user' && lastMsg.text === userPrompt) {
      historyForPrompt.pop();
    }
  }
  return historyForPrompt;
}

function fitMessagesWithinCharBudget(
  systemContent: string,
  historyMessages: ExternalChatMessage[],
  userContent: string,
  maxChars: number,
): ExternalChatMessage[] {
  const safeUser = trimCollapsedText(userContent, MAX_LOCAL_USER_PROMPT_CHARS);
  const fixedChars = systemContent.length + safeUser.length;
  const remainingBudget = Math.max(0, maxChars - fixedChars);

  const keptHistory: ExternalChatMessage[] = [];
  let usedHistoryChars = 0;
  for (let i = historyMessages.length - 1; i >= 0; i -= 1) {
    const msg = historyMessages[i];
    const trimmedContent = trimCollapsedText(msg.content, MAX_LOCAL_HISTORY_TURN_CHARS);
    if (usedHistoryChars + trimmedContent.length > remainingBudget) {
      break;
    }
    keptHistory.unshift({ role: msg.role, content: trimmedContent });
    usedHistoryChars += trimmedContent.length;
  }

  return [
    { role: 'system', content: systemContent },
    ...keptHistory,
    { role: 'user', content: safeUser },
  ];
}

function buildGroundedSystemPrompt(retrievedContext: RetrievedContextItem[], customSystemPrompt: string) {
  const contextBlock = buildCompactContextBlock(retrievedContext, QWEN_MODEL_MAX_RAG_CONTEXT_CHARS);
  if (customSystemPrompt) {
    return [
      customSystemPrompt,
      'Answer only from the grounded local finance facts below. If insufficient, say you do not have enough local evidence.',
      `Grounded local facts:\n${contextBlock}`,
    ].join('\n\n');
  }
  return `${DEFAULT_GROUNDED_SYSTEM_PROMPT}\n\nGrounded local facts:\n${contextBlock}`;
}

function buildQwenChatPromptFromMessages(messages: ExternalChatMessage[]) {
  const segments = messages.map((message) => `<|im_start|>${message.role}\n${escapeChatSegment(message.content)}<|im_end|>`);
  // Explicit empty think block disables Qwen3.5 thinking mode on raw-prompt paths too.
  segments.push('<|im_start|>assistant\n<think>\n\n</think>\n\n');
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

export function buildLocalMessagesForMode(
  userPrompt: string,
  mode: LocalAiMode,
  state: ReturnType<typeof useAIStore.getState>,
  retrievedContext?: RetrievedContextItem[],
): ExternalChatMessage[] {
  const customSystemPrompt = useSettingsStore.getState().localSystemPrompt;
  let systemPrompt = customSystemPrompt || DEFAULT_LOCAL_SYSTEM_PROMPT;

  if (mode === 'rag' && retrievedContext) {
    systemPrompt = buildGroundedSystemPrompt(retrievedContext, customSystemPrompt);
  }

  const historyForPrompt = getTrimmedHistoryForPrompt(userPrompt, state);
  const { activeTurns, summaryText } = manageContextWindow(historyForPrompt);
  const compactSummary = mode === 'chat' && summaryText ? trimCollapsedText(summaryText, MAX_LOCAL_SUMMARY_CHARS) : null;
  const effectiveSystemPrompt = compactSummary ? `${systemPrompt}\n\n${compactSummary}` : systemPrompt;

  const historyMessages: ExternalChatMessage[] = activeTurns.map((msg) => ({
    role: msg.role === 'user' ? 'user' : 'assistant',
    content: msg.text,
  }));

  return fitMessagesWithinCharBudget(
    effectiveSystemPrompt,
    historyMessages,
    userPrompt,
    QWEN_MODEL_MAX_PROMPT_CHARS,
  );
}

export function buildPromptForMode(userPrompt: string, mode: LocalAiMode, state: ReturnType<typeof useAIStore.getState>, retrievedContext?: RetrievedContextItem[]) {
  const runtimeInfo = state.runtime.runtimeInfo;
  const localMessages = buildLocalMessagesForMode(userPrompt, mode, state, retrievedContext);

  if (supportsQwenChatTemplate(runtimeInfo)) {
    return buildQwenChatPromptFromMessages(localMessages);
  }

  const historyForPrompt = getTrimmedHistoryForPrompt(userPrompt, state);
  const systemMessage = localMessages[0]?.content ?? DEFAULT_LOCAL_SYSTEM_PROMPT;
  const rawPrompt = buildFallbackChatPrompt(trimCollapsedText(userPrompt, MAX_LOCAL_USER_PROMPT_CHARS), historyForPrompt, systemMessage);
  return trimCollapsedText(rawPrompt, QWEN_MODEL_MAX_PROMPT_CHARS);
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

export interface ParsedReceiptResult {
  merchantName?: string;
  totalAmount?: number;
  category?: string;
  lineItemsText?: string;
  date?: string;
  rawText?: string;
  /** How far the total can be trusted; see receiptConfidence.ts. */
  confidence?: ReceiptConfidence;
  confidenceReasons?: string[];
}

function itemPricesFromText(lineItemsText: string | null | undefined): number[] {
  return (lineItemsText ?? '')
    .split('\n')
    .map((line) => Number(line.split('|')[1]))
    .filter((price) => Number.isFinite(price) && price > 0);
}

function withConfidence(
  result: ParsedReceiptResult,
  rows: string[],
  independentTotal: number | null,
): ParsedReceiptResult {
  const { level, reasons } = assessReceiptConfidence({
    total: result.totalAmount,
    rows,
    independentTotal,
    itemPrices: itemPricesFromText(result.lineItemsText),
  });
  return { ...result, confidence: level, confidenceReasons: reasons };
}

const RECEIPT_PROMPT_MAX_CHARS = 3000;

const RECEIPT_SCHEMA_SYSTEM_PROMPT =
  'You extract structured fields from Indonesian receipt OCR text. Output JSON matching the schema. ' +
  'Indonesian amounts like 60.000 or 60,000 mean 60000 IDR (integers, no decimals). ' +
  'Do not invent numbers not present in the OCR text. Use null for unknown merchant or date (YYYY-MM-DD).';

export const VLM_SYSTEM_PROMPT =
  'You extract structured fields from Indonesian receipt images. Output JSON matching the schema. ' +
  'Indonesian amounts like 60.000 or 60,000 mean 60000 IDR (integers, no decimals). ' +
  'Use null for unknown merchant or date (YYYY-MM-DD).';

export const VLM_RECEIPT_PROMPT =
  'Extract merchant, date (YYYY-MM-DD or null), total (integer IDR), and items (name, qty, price in integer IDR).';

async function downscaleReceiptImage(uri: string): Promise<string> {
  try {
    const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      if (typeof Image.getSize !== 'function') {
        return reject(new Error('Image.getSize unavailable'));
      }
      Image.getSize(
        uri,
        (width, height) => resolve({ width, height }),
        (err) => reject(err),
      );
    });

    const longest = Math.max(dimensions.width, dimensions.height);
    if (longest <= 768) {
      return uri;
    }

    const resize = dimensions.width >= dimensions.height ? { width: 768 } : { height: 768 };
    const manipResult = await manipulateAsync(uri, [{ resize }], {
      compress: 0.85,
      format: SaveFormat.JPEG,
    });
    return manipResult.uri;
  } catch (error) {
    console.warn('Failed to downscale receipt image with dimensions, attempting fallback resize:', error);
    try {
      const manipResult = await manipulateAsync(uri, [{ resize: { width: 768 } }], {
        compress: 0.85,
        format: SaveFormat.JPEG,
      });
      return manipResult.uri;
    } catch {
      return uri;
    }
  }
}

const RECEIPT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    merchant: { type: ['string', 'null'] },
    date: { type: ['string', 'null'] },
    total: { type: 'integer' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          qty: { type: ['integer', 'null'] },
          price: { type: 'integer' },
        },
        required: ['name', 'qty', 'price'],
        additionalProperties: false,
      },
    },
  },
  required: ['merchant', 'date', 'total', 'items'],
  additionalProperties: false,
};

interface LlmReceiptPayload {
  merchant?: string | null;
  date?: string | null;
  total?: number | string | null;
  items?: Array<{ name?: unknown; qty?: unknown; price?: unknown }>;
}

function parseReceiptJsonWithRepair(content: string): LlmReceiptPayload | null {
  const stripped = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(stripped) as LlmReceiptPayload;
  } catch {
    // Try trimming back to the last complete item object inside "items": [...]
  }

  const itemsIdx = stripped.indexOf('"items"');
  if (itemsIdx !== -1) {
    const bracketIdx = stripped.indexOf('[', itemsIdx);
    if (bracketIdx !== -1) {
      const lastBrace = stripped.lastIndexOf('}', bracketIdx);
      if (lastBrace !== -1) {
        try {
          return JSON.parse(`${stripped.slice(0, lastBrace + 1)}\n  ]\n}`) as LlmReceiptPayload;
        } catch {
          // fall through
        }
      }
      try {
        return JSON.parse(`${stripped.slice(0, bracketIdx + 1)}]\n}`) as LlmReceiptPayload;
      } catch {
        // fall through
      }
    }
  }

  const totalMatch = stripped.match(/"total"\s*:\s*(-?\d+)/);
  if (totalMatch) {
    const merchantMatch = stripped.match(/"merchant"\s*:\s*(".*?"|null)/);
    const dateMatch = stripped.match(/"date"\s*:\s*(".*?"|null)/);
    let merchant: string | null = null;
    let date: string | null = null;
    if (merchantMatch) {
      try {
        merchant = JSON.parse(merchantMatch[1]);
      } catch {
        merchant = null;
      }
    }
    if (dateMatch) {
      try {
        date = JSON.parse(dateMatch[1]);
      } catch {
        date = null;
      }
    }
    return {
      merchant,
      date,
      total: Number(totalMatch[1]),
      items: [],
    };
  }

  return null;
}

function formatReceiptItemsText(items: unknown): string | undefined {
  if (!Array.isArray(items) || items.length === 0) {
    return undefined;
  }

  const formatted: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { name?: unknown; qty?: unknown; price?: unknown };
    const rawName = typeof record.name === 'string' ? record.name.trim() : '';
    if (!rawName) continue;

    const qty =
      typeof record.qty === 'number' && Number.isFinite(record.qty) && record.qty > 1
        ? Math.round(record.qty)
        : null;
    const name = qty ? `${qty}x ${rawName}` : rawName;

    const rawPrice =
      typeof record.price === 'number' && Number.isFinite(record.price)
        ? Math.round(Math.abs(record.price))
        : typeof record.price === 'string'
          ? Math.round(Math.abs(parseSignedAmount(record.price)))
          : 0;

    if (rawPrice > 0) {
      formatted.push(`${name} | ${rawPrice}`);
    } else {
      formatted.push(name);
    }
  }

  return formatted.length > 0 ? formatted.join('\n') : undefined;
}

function isExternalConfiguredForReceipt(): boolean {
  const settings = useSettingsStore.getState();
  const url = (settings.externalApiUrl ?? '').trim();
  const model = (settings.externalApiModel ?? '').trim();
  if (!url || !model) {
    return false;
  }
  if ((settings.externalApiKey ?? '').trim().length > 0) {
    return true;
  }
  return /^https?:\/\/(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(url);
}

function isDateGrounded(isoDate: string, ocrText: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return false;
  const [, year, , day] = match;
  const hasDay = new RegExp(`(^|\\D)0?${Number(day)}(\\D|$)`).test(ocrText);
  return hasDay && (ocrText.includes(year) || new RegExp(`(^|\\D)${year.slice(2)}(\\D|$)`).test(ocrText));
}

async function canRunReceiptLlm(): Promise<boolean> {
  const settings = useSettingsStore.getState();
  if (settings.aiInferenceMode === 'external') {
    return true;
  }

  const aiState = useAIStore.getState();
  if (aiState.provisioning.status === 'ready' || (aiState.runtimeReady && aiState.runtime.modelLoaded)) {
    return true;
  }

  if (await isActiveModelInstalled()) {
    return true;
  }

  return isExternalConfiguredForReceipt();
}

export function filterReceiptOcrTextForAi(rawText: string): string {
  const reconstructed = reconstructMultiColumnOcrText(rawText);
  return reconstructed
    .split('\n')
    .map((l) => l.trim())
    .filter((line) => {
      if (line.length < 2) return false;
      const lower = line.toLowerCase();
      if (lower.startsWith('http') || lower.startsWith('www.') || lower.includes('.com')) return false;
      if (lower.includes('wifi') || lower.includes('password') || lower.includes('kritik') || lower.includes('saran')) return false;
      if (lower.includes('npwp') || lower.includes('terima kasih') || lower.includes('selamat belanja')) return false;
      if (lower.includes('layanan konsumen') || lower.includes('call center') || lower.includes('kebijakan')) return false;
      return true;
    })
    .slice(0, 35)
    .join('\n');
}

export const analyzeReceiptImage = async (
  imageUri?: string,
  _base64Image?: string,
  onStatusChange?: (status: string) => void,
): Promise<ParsedReceiptResult | null> => {
  if (!imageUri) return null;

  onStatusChange?.('Reading text…');

  const ocrEngine = getOcrEngine();
  const ocrResult = await ocrEngine.processImage(imageUri);
  if (!ocrResult.success || !ocrResult.rawText) {
    throw new Error('NO_TEXT_DETECTED');
  }

  const rows =
    ocrResult.rows && ocrResult.rows.length > 0
      ? ocrResult.rows
      : ocrResult.rawText
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
  const rawText = rows.join('\n') || ocrResult.rawText;
  const keywordTotal = pickTotalFromRows(rows);
  const heuristicTotal = keywordTotal ?? ocrResult.extractedTotal ?? undefined;

  const heuristicResult: ParsedReceiptResult = {
    merchantName: ocrResult.extractedMerchant || undefined,
    totalAmount: heuristicTotal,
    category: ocrResult.extractedCategory || inferReceiptCategory(ocrResult.extractedMerchant ?? null, rawText) || undefined,
    lineItemsText: ocrResult.extractedLineItems || undefined,
    date: ocrResult.extractedDate || undefined,
    rawText,
  };

  const { getGenerationService, isVisionAvailable } =
    require('./generationService') as typeof import('./generationService');

  if (useSettingsStore.getState().receiptReadingMode === 'vision' && (await isVisionAvailable())) {
    onStatusChange?.('Reading receipt with AI vision…');
    try {
      const processedUri = await downscaleReceiptImage(imageUri);
      const responseText = await getGenerationService().startGeneration({
        imageUri: processedUri,
        prompt: VLM_RECEIPT_PROMPT,
        mode: 'chat',
        systemPrompt: VLM_SYSTEM_PROMPT,
        jsonSchema: RECEIPT_JSON_SCHEMA,
        disableThinking: true,
        maxTokens: 512,
        temperature: 0,
      });

      const parsedData = parseReceiptJsonWithRepair(responseText);
      if (!parsedData) {
        throw new Error('FAILED_TO_PARSE_VISION_JSON');
      }

      let visionTotal: number | undefined;
      if (typeof parsedData.total === 'number' && Number.isFinite(parsedData.total)) {
        visionTotal = Math.round(parsedData.total);
      } else if (typeof parsedData.total === 'string') {
        const clean = Math.round(Math.abs(parseSignedAmount(parsedData.total)));
        if (clean > 0) visionTotal = clean;
      }

      const usedVisionTotal = typeof visionTotal === 'number' && visionTotal > 0;
      const finalTotal = usedVisionTotal ? visionTotal : heuristicTotal;

      const merchantName =
        (typeof parsedData.merchant === 'string' && parsedData.merchant.trim()) ||
        ocrResult.extractedMerchant ||
        undefined;
      const date =
        (typeof parsedData.date === 'string' && isDateGrounded(parsedData.date.trim(), rawText) && parsedData.date.trim()) ||
        ocrResult.extractedDate ||
        undefined;
      const lineItemsText = formatReceiptItemsText(parsedData.items) || ocrResult.extractedLineItems || undefined;
      const category =
        ocrResult.extractedCategory ||
        inferReceiptCategory(merchantName ?? ocrResult.extractedMerchant ?? null, rawText) ||
        undefined;

      return withConfidence(
        { merchantName, totalAmount: finalTotal, category, lineItemsText, date, rawText },
        rows,
        usedVisionTotal ? keywordTotal : null,
      );
    } catch (visionError) {
      console.warn('Vision extraction failed, falling back to text LLM / OCR heuristics:', visionError);
    } finally {
      getGenerationService().scheduleModelUnload(300_000);
    }
  }

  if (!(await canRunReceiptLlm())) {
    return withConfidence(heuristicResult, rows, null);
  }

  onStatusChange?.('Structuring receipt with AI...');

  try {
    const responseText = await getGenerationService().startGeneration({
      prompt: rawText.slice(0, RECEIPT_PROMPT_MAX_CHARS),
      mode: 'chat',
      maxTokens: 384,
      temperature: 0,
      systemPrompt: RECEIPT_SCHEMA_SYSTEM_PROMPT,
      jsonSchema: RECEIPT_JSON_SCHEMA,
      disableThinking: true,
    });

    const parsedData = parseReceiptJsonWithRepair(responseText);
    if (parsedData) {
      let llmTotal: number | undefined;
      if (typeof parsedData.total === 'number' && Number.isFinite(parsedData.total)) {
        llmTotal = Math.round(parsedData.total);
      } else if (typeof parsedData.total === 'string') {
        const clean = Math.round(Math.abs(parseSignedAmount(parsedData.total)));
        if (clean > 0) llmTotal = clean;
      }

      let finalTotal: number | undefined = heuristicTotal;
      let usedLlmTotal = false;
      if (typeof llmTotal === 'number' && llmTotal > 0) {
        if (isGrounded(llmTotal, rows)) {
          finalTotal = llmTotal;
          usedLlmTotal = true;
        } else {
          console.warn(
            `Receipt LLM total (${llmTotal}) is not grounded in OCR rows; falling back to heuristic total (${heuristicTotal ?? 'none'}).`,
          );
        }
      }

      const merchantName =
        (typeof parsedData.merchant === 'string' && parsedData.merchant.trim()) ||
        ocrResult.extractedMerchant ||
        undefined;
      // Small models invent plausible dates (bench: Qwen3.5-0.8B on 34/39 receipts); keep only dates visible in the OCR text.
      const date =
        (typeof parsedData.date === 'string' && isDateGrounded(parsedData.date.trim(), rawText) && parsedData.date.trim()) ||
        ocrResult.extractedDate ||
        undefined;
      const lineItemsText = formatReceiptItemsText(parsedData.items) || ocrResult.extractedLineItems || undefined;
      const category =
        ocrResult.extractedCategory ||
        inferReceiptCategory(merchantName ?? ocrResult.extractedMerchant ?? null, rawText) ||
        undefined;

      return withConfidence(
        { merchantName, totalAmount: finalTotal, category, lineItemsText, date, rawText },
        rows,
        usedLlmTotal ? keywordTotal : null,
      );
    }
  } catch (error) {
    console.warn('LLM Extraction skipped or failed, falling back to OCR heuristics:', error);
  } finally {
    getGenerationService().scheduleModelUnload(300_000);
  }

  return withConfidence(heuristicResult, rows, null);
};
