import { Image } from 'react-native';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { expoDb } from '../../db/index';
import { getModelLifecycleManager, isActiveModelInstalled } from './modelLifecycle';
import { getOcrEngine } from '../ocr/index';
import { computeBudgetStatus, type BudgetDb, type BudgetPlan } from '../../features/budgets/engine';
import { readBudgetPlans } from '../../features/budgets/plans';
import { getCachedRate } from '../fx/rates';
import { normalizeReceiptImage } from '../ocr/normalizeImage';
import type { OcrResult } from '../ocr/types';
import { inferReceiptCategory, reconstructMultiColumnOcrText } from '../ocr/MlKitEngine';
import {
  extractAmounts,
  isGrounded,
  isNonItemLine,
  isPlausibleReceiptDate,
  isSuspiciousMerchantName,
  pickMerchantFromRows,
  pickTotalFromRows,
} from '../ocr/receiptText';
import { assessReceiptConfidence, type ReceiptConfidence } from '../ocr/receiptConfidence';
import { formatDisplayCurrency, parseSignedAmount } from '../../features/transactions/amount';
import { parseReceiptLineItemsText, serializeReceiptLineItems } from '../../features/transactions/lineItems';
import { clampMonthStartDay, getPeriodBounds, shiftPeriod } from '../../features/transactions/periods';
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

export type RetrievedContextKind =
  | 'period'
  | 'summary'
  | 'top-categories'
  | 'biggest-expense'
  | 'category-spending'
  | 'budget'
  | 'balance'
  | 'keyword-match'
  | 'transaction'
  | 'note';

export interface RetrievedContextItem {
  id: string;
  kind: RetrievedContextKind;
  label: string;
  content: string;
  score: number;
}

export interface GroundedSqliteDb {
  getAllSync<T = any>(sql: string): T[];
  getAllSync<T = any>(sql: string, params: any[]): T[];
}

export interface GroundedTimePeriod {
  kind:
    | 'today'
    | 'yesterday'
    | 'this-week'
    | 'last-week'
    | 'this-month'
    | 'last-month'
    | 'last-n-days'
    | 'named-month'
    | 'this-year'
    | 'last-year';
  label: string;
  fromMs: number;
  toMs: number;
  isExplicit: boolean;
  matchedText?: string;
}

export interface GroundedCategoryMatch {
  name: string;
  type: 'expense' | 'income';
  matchedViaSynonym: boolean;
  triggerTerm: string;
}

export interface GroundedParsedQuery {
  period: GroundedTimePeriod;
  categories: GroundedCategoryMatch[];
  account: { id: number; name: string } | null;
  keywords: string[];
  asksBalance: boolean;
  asksBudget: boolean;
  wantsRecent: boolean;
  asksBiggest: boolean;
  asksIncomeVsSpending: boolean;
  asksTopCategories: boolean;
  /** "Which store did I spend the most at?" */
  asksTopMerchants: boolean;
  /** "average daily spending", "rata-rata per hari" */
  asksAverage: boolean;
  /** Judgement questions ("am I doing okay?", "can I afford ...?") that need the overview and balance. */
  asksFinancialHealth: boolean;
  /** The earlier period of a comparison ("this month vs last month"); `period` is then the later one. */
  comparePeriod: GroundedTimePeriod | null;
}

export interface BuildRetrievedContextOptions {
  db?: GroundedSqliteDb;
  now?: Date | number;
  /** Billing month start day (1-28); defaults to the user's setting. */
  monthStartDay?: number;
  /** Earlier user questions in this chat, oldest first, so a follow-up like "And last month?" keeps its topic. */
  previousUserPrompts?: string[];
}

const MONTH_SHORT_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const NAMED_MONTH_PATTERNS: Array<{ monthIndex: number; aliases: string[]; guarded?: boolean }> = [
  { monthIndex: 0, aliases: ['january', 'januari'] },
  { monthIndex: 0, aliases: ['jan'], guarded: true },
  { monthIndex: 1, aliases: ['february', 'februari'] },
  { monthIndex: 1, aliases: ['feb'], guarded: true },
  { monthIndex: 2, aliases: ['march', 'maret'] },
  { monthIndex: 2, aliases: ['mar'], guarded: true },
  { monthIndex: 3, aliases: ['april'] },
  { monthIndex: 3, aliases: ['apr'], guarded: true },
  { monthIndex: 4, aliases: ['may', 'mei'], guarded: true },
  { monthIndex: 5, aliases: ['june', 'juni'] },
  { monthIndex: 5, aliases: ['jun'], guarded: true },
  { monthIndex: 6, aliases: ['july', 'juli'] },
  { monthIndex: 6, aliases: ['jul'], guarded: true },
  { monthIndex: 7, aliases: ['august', 'agustus'] },
  { monthIndex: 7, aliases: ['aug', 'agu', 'ags'], guarded: true },
  { monthIndex: 8, aliases: ['september'] },
  { monthIndex: 8, aliases: ['sept', 'sep'], guarded: true },
  { monthIndex: 9, aliases: ['october', 'oktober'] },
  { monthIndex: 9, aliases: ['oct', 'okt'], guarded: true },
  { monthIndex: 10, aliases: ['november'] },
  { monthIndex: 10, aliases: ['nov', 'nop'], guarded: true },
  { monthIndex: 11, aliases: ['december', 'desember'] },
  { monthIndex: 11, aliases: ['dec', 'des'], guarded: true },
];

// Venue-prefix synonyms that belong to a proper merchant name when followed by a specific
// non-stopword token (e.g. "Warung Mei", "Supermarket Hero", "Hotel Mulia").
const VENUE_PREFIX_SYNONYMS = new Set([
  'warung',
  'restaurant',
  'resto',
  'supermarket',
  'minimarket',
  'pasar',
  'hotel',
  'apotek',
  'klinik',
  'bioskop',
  'sekolah',
]);

// Broad synonyms that represent an entire category rather than a narrow sub-item;
// skip opportunistic FTS lookups for these when the category itself already has hits.
const BROAD_CATEGORY_SYNONYMS = new Set([
  'food',
  'dining',
  'eat',
  'eating',
  'meal',
  'meals',
  'makan',
  'makanan',
  'minum',
  'minuman',
  'kuliner',
  'jajan',
  'transport',
  'transportation',
  'transportasi',
  'commute',
  'kendaraan',
  'grocery',
  'groceries',
  'sembako',
  'shopping',
  'belanja',
  'bill',
  'bills',
  'utility',
  'utilities',
  'tagihan',
  'entertainment',
  'hiburan',
  'health',
  'healthcare',
  'medical',
  'kesehatan',
  'education',
  'pendidikan',
  'travel',
  'vacation',
  'holiday',
  'liburan',
  'wisata',
  'home',
  'house',
  'household',
  'rumah',
  'salary',
  'gaji',
  'freelance',
]);

const CATEGORY_SYNONYM_GROUPS: Array<{
  targetPatterns: RegExp[];
  synonyms: string[];
}> = [
  {
    targetPatterns: [/food|dining|makan|kuliner/i],
    synonyms: [
      'food',
      'dining',
      'eat',
      'eating',
      'meal',
      'meals',
      'restaurant',
      'resto',
      'makan',
      'makanan',
      'minum',
      'minuman',
      'kuliner',
      'jajan',
      'warung',
    ],
  },
  {
    targetPatterns: [/transport|commute|kendaraan/i],
    synonyms: [
      'transport',
      'transportation',
      'transportasi',
      'bensin',
      'bbm',
      'fuel',
      'gas',
      'commute',
      'ojol',
      'ojek',
      'parkir',
      'tol',
      'toll',
      'taxi',
      'taksi',
      'ongkos',
      'kendaraan',
    ],
  },
  {
    targetPatterns: [/grocer|sembako/i, /shopping|belanja/i],
    synonyms: ['grocery', 'groceries', 'sembako', 'supermarket', 'minimarket', 'pasar', 'bahan makanan'],
  },
  {
    targetPatterns: [/shopping|belanja/i, /grocer/i],
    synonyms: ['shopping', 'belanja', 'fashion', 'baju', 'pakaian'],
  },
  {
    targetPatterns: [/bill|utilit|tagihan/i],
    synonyms: [
      'bill',
      'bills',
      'utility',
      'utilities',
      'tagihan',
      'listrik',
      'internet',
      'wifi',
      'pulsa',
      'kuota',
      'sewa',
      'rent',
      'kos',
      'kost',
      'cicilan',
    ],
  },
  {
    targetPatterns: [/entertain|hiburan/i],
    synonyms: [
      'entertainment',
      'hiburan',
      'bioskop',
      'nonton',
      'movie',
      'movies',
      'game',
      'games',
      'streaming',
      'konser',
    ],
  },
  {
    targetPatterns: [/health|kesehatan|medical/i],
    synonyms: ['health', 'healthcare', 'medical', 'kesehatan', 'dokter', 'obat', 'apotek', 'klinik', 'rumah sakit'],
  },
  {
    targetPatterns: [/educat|pendidikan/i],
    synonyms: ['education', 'pendidikan', 'sekolah', 'kuliah', 'kursus', 'buku'],
  },
  {
    targetPatterns: [/travel|liburan|wisata/i],
    synonyms: ['travel', 'vacation', 'holiday', 'liburan', 'wisata', 'hotel', 'tiket'],
  },
  {
    targetPatterns: [/home|rumah|house/i],
    synonyms: ['home', 'house', 'household', 'rumah', 'rumah tangga', 'perabot'],
  },
  {
    targetPatterns: [/salary|gaji/i],
    synonyms: ['salary', 'gaji', 'upah', 'paycheck'],
  },
  {
    targetPatterns: [/freelance|sampingan|proyek/i],
    synonyms: ['freelance', 'sampingan', 'proyek'],
  },
];

const GENERIC_CATEGORY_TOKENS = new Set([
  'and',
  'the',
  'for',
  'other',
  'misc',
  'general',
  'uncategorized',
  'expense',
  'expenses',
  'income',
  'transfer',
  'lain',
  'lainnya',
]);

const GENERIC_WALLET_TOKENS = new Set([
  'wallet',
  'account',
  'accounts',
  'bank',
  'card',
  'cash',
  'main',
  'my',
  'default',
  'dompet',
  'akun',
  'rekening',
  'utama',
]);

const STOP_WORDS = new Set([
  // English grammar & question words
  'a',
  'about',
  'actually',
  'active',
  'all',
  'also',
  'am',
  'an',
  'and',
  'any',
  'are',
  'aren',
  'at',
  'available',
  'average',
  'avg',
  'based',
  'be',
  'been',
  'between',
  'both',
  'breakdown',
  'by',
  'can',
  'check',
  'compare',
  'compared',
  'comparison',
  'configured',
  'couldn',
  'current',
  'currently',
  'detail',
  'details',
  'did',
  'didn',
  'do',
  'does',
  'doesn',
  'don',
  'during',
  'each',
  'every',
  'find',
  'for',
  'from',
  'get',
  'give',
  'go',
  'got',
  'had',
  'has',
  'hasn',
  'have',
  'haven',
  'how',
  'i',
  'in',
  'info',
  'is',
  'isn',
  'it',
  'its',
  'just',
  'leftover',
  'list',
  'made',
  'make',
  'many',
  'me',
  'more',
  'most',
  'mostly',
  'much',
  'my',
  'now',
  'of',
  'on',
  'only',
  'or',
  'our',
  'out',
  'over',
  'per',
  'please',
  'plus',
  'really',
  'search',
  'see',
  'set',
  'shouldn',
  'show',
  'single',
  'so',
  'some',
  'status',
  'still',
  'tell',
  'than',
  'that',
  'the',
  'their',
  'them',
  'there',
  'these',
  'this',
  'those',
  'to',
  'top',
  'up',
  'us',
  'versus',
  'vs',
  'was',
  'wasn',
  'we',
  'went',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'will',
  'with',
  'won',
  'would',
  'wouldn',
  'you',
  'your',
  // English temporal & finance intent terms
  'account',
  'accounts',
  'amount',
  'balance',
  'balances',
  'biggest',
  'budget',
  'budgeted',
  'budgeting',
  'budgets',
  'buy',
  'bought',
  'cap',
  'caps',
  'cash',
  'cashflow',
  'categories',
  'category',
  'cost',
  'day',
  'days',
  'earn',
  'earned',
  'earning',
  'earnings',
  'expense',
  'expenses',
  'expensive',
  'finance',
  'finances',
  'financial',
  'fund',
  'funds',
  'highest',
  'history',
  'income',
  'largest',
  'last',
  'latest',
  'left',
  'limit',
  'limits',
  'money',
  'month',
  'monthly',
  'months',
  'net',
  'overall',
  'overview',
  'paid',
  'past',
  'pay',
  'period',
  'previous',
  'purchase',
  'purchases',
  'recent',
  'remain',
  'remaining',
  'report',
  'save',
  'saved',
  'saving',
  'savings',
  'spend',
  'spending',
  'spent',
  'summary',
  'today',
  'total',
  'transaction',
  'transactions',
  'wallet',
  'wallets',
  'week',
  'weekly',
  'weeks',
  'worth',
  'year',
  'yearly',
  'yesterday',
  // Indonesian grammar, temporal & finance intent terms
  'ada',
  'aja',
  'aku',
  'akun',
  'anggaran',
  'apa',
  'apakah',
  'arus',
  'atau',
  'bagaimana',
  'banding',
  'bandingkan',
  'batas',
  'bayar',
  'belakangan',
  'beli',
  'berapa',
  'berapaan',
  'bersih',
  'besar',
  'bisa',
  'bujet',
  'bulan',
  'bulanan',
  'catat',
  'catatan',
  'cek',
  'cuma',
  'daftar',
  'dalam',
  'dan',
  'dana',
  'dapat',
  'dari',
  'deh',
  'dengan',
  'di',
  'dibanding',
  'dibayar',
  'dibeli',
  'didapat',
  'dihabiskan',
  'dikeluarkan',
  'dipakai',
  'diterima',
  'dompet',
  'dong',
  'duit',
  'duitku',
  'gue',
  'gw',
  'habis',
  'habiskan',
  'hanya',
  'hari',
  'ini',
  'itu',
  'jatah',
  'jumlah',
  'kalau',
  'kamu',
  'kan',
  'kas',
  'kasih',
  'kategori',
  'ke',
  'kekayaan',
  'keluar',
  'keluarkan',
  'kemarin',
  'keuangan',
  'kita',
  'kok',
  'ku',
  'lagi',
  'lalu',
  'liat',
  'lihat',
  'loe',
  'lu',
  'mahal',
  'mana',
  'masih',
  'masuk',
  'memakai',
  'membayar',
  'membeli',
  'mendapat',
  'menerima',
  'mengeluarkan',
  'menghabiskan',
  'minggu',
  'mu',
  'nih',
  'nya',
  'pada',
  'pakai',
  'paling',
  'pekan',
  'pemasukan',
  'pendapatan',
  'pengeluaran',
  'penghasilan',
  'perbandingan',
  'punya',
  'rata',
  'rekening',
  'rincian',
  'ringkasan',
  'riwayat',
  'rupiah',
  'saja',
  'saldo',
  'saldoku',
  'sama',
  'saya',
  'sebelumnya',
  'sebulan',
  'sekarang',
  'selama',
  'seminggu',
  'semua',
  'sepanjang',
  'sih',
  'sisa',
  'sudah',
  'tahu',
  'tahun',
  'tampilkan',
  'tentang',
  'terakhir',
  'terbaru',
  'terbesar',
  'tercatat',
  'terima',
  'terpakai',
  'tersisa',
  'tertinggi',
  'tinggal',
  'transaksi',
  'tunjukin',
  'tunjukkan',
  'uang',
  'uangku',
  'untuk',
  'ya',
  'yang',
  // Fillers that otherwise leak into AND keyword search (review F-M1)
  'may',
  'ever',
  'anything',
  'something',
  'into',
  'receive',
  'received',
  'banyak',
  'tolong',
  'coba',
  'pernah',
  'seluruh',
  've',
  'll',
  're',
  // Conversational filler: never a merchant or item to search for (reported 2026-11-23).
  'hi',
  'hello',
  'hey',
  'doing',
  'going',
  'analyse',
  'analyze',
  'analysis',
  'help',
  'thanks',
  'thank',
  'ok',
  'okay',
  'advice',
  'tips',
  'health',
  'look',
  'looking',
  'well',
  'good',
  'bad',
  'situation',
  // Question words and filler from the 2026-11-25 chat benchmark (src/services/ai/chatBench).
  'whats',
  'hows',
  'wheres',
  'im',
  'ive',
  'dont',
  'financially',
  'time',
  'times',
  'order',
  'ordered',
  'orders',
  'store',
  'stores',
  'shop',
  'shops',
  'merchant',
  'merchants',
  'daily',
  'costs',
  'paying',
  'should',
  'could',
  'cut',
  'back',
  'take',
  'without',
  'idea',
  'new',
  'afford',
  'next',
  'buying',
  'blow',
  'blowing',
  'million',
  'thousand',
  'juta',
  'ribu',
  'terbanyak',
  'thing',
  'things',
  'stuff',
  // Advice and planning filler (chat benchmark advice tier).
  'if',
  'half',
  'quarter',
  'third',
  'tips',
  'tip',
  'any',
  'keep',
  'overspending',
  'overspend',
  'plan',
  'cover',
  'emergency',
  'fund',
  'long',
  'reach',
  'would',
  'gimana',
  'caranya',
  'biar',
  'lebih',
  'hemat',
  'nabung',
  'menabung',
  'saran',
  'percent',
  'persen',
  // Over-budget words ("Ada anggaran yang kelewatan?") are a budget question, not a merchant name.
  'kelewatan',
  'kelebihan',
  'lewat',
  'melebihi',
  'melewati',
  'jebol',
  'overbudget',
  'exceeded',
  'exceed',
]);

/**
 * Everyday words that stand for a group of merchants. "coffee" should find Kopi Kenangan and Starbucks, not only
 * a merchant with "coffee" in its name (chat benchmark 2026-11-25).
 */
const KEYWORD_CONCEPTS: Array<{ triggers: string[]; terms: string[] }> = [
  {
    triggers: ['coffee', 'kopi', 'cafe', 'kafe', 'ngopi'],
    terms: ['coffee', 'kopi', 'starbucks', 'cafe', 'kafe', 'kenangan', 'janji jiwa', 'tomoro', 'fore'],
  },
  {
    triggers: ['subscription', 'langganan', 'streaming'],
    terms: ['subscription', 'langganan', 'netflix', 'spotify', 'youtube', 'disney', 'vidio', 'icloud', 'google one', 'chatgpt'],
  },
  { triggers: ['rent', 'sewa', 'kontrakan'], terms: ['rent', 'sewa', 'kos', 'kost', 'kontrakan'] },
  { triggers: ['ojek', 'ojol', 'ride'], terms: ['gojek', 'grab', 'maxim', 'ojek', 'ride'] },
  { triggers: ['fuel', 'petrol', 'bensin'], terms: ['pertamina', 'shell', 'bensin', 'pertalite', 'pertamax', 'fuel'] },
  { triggers: ['delivery'], terms: ['gofood', 'grabfood', 'shopeefood', 'delivery'] },
  { triggers: ['trip', 'vacation', 'holiday'], terms: ['trip', 'travel', 'flight', 'hotel', 'traveloka', 'tiket', 'vacation', 'holiday'] },
];

/** "subscriptions" -> "subscription" so prefix search also finds the singular. */
function stemKeyword(term: string): string {
  return term.length > 4 && term.endsWith('s') && !term.endsWith('ss') ? term.slice(0, -1) : term;
}

function expandKeyword(term: string): string[] {
  const stem = stemKeyword(term);
  const concept = KEYWORD_CONCEPTS.find((c) => c.triggers.includes(term) || c.triggers.includes(stem));
  return concept ? concept.terms : [stem];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readGroundedBudgetPlans(db: GroundedSqliteDb): BudgetPlan[] {
  try {
    return readBudgetPlans({
      getAllSync: <T,>(sql: string, params: (string | number | null)[]) => safeQuery<T>(db, sql, params),
      runSync: () => ({ lastInsertRowId: 0, changes: 0 }),
    }).filter((plan) => !plan.archived);
  } catch {
    return [];
  }
}

function safeQuery<T>(db: GroundedSqliteDb, sql: string, params?: any[]): T[] {
  try {
    const rows = params && params.length > 0 ? db.getAllSync<T>(sql, params) : db.getAllSync<T>(sql);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function currentCurrencyCode(): string {
  try {
    return useSettingsStore.getState?.()?.currencyCode || 'IDR';
  } catch {
    return 'IDR';
  }
}

function formatCurrency(amount: number | null | undefined): string {
  let currencyCode = 'IDR';
  let useThousandsSeparator = true;
  try {
    const settings = useSettingsStore.getState?.();
    currencyCode = settings?.currencyCode || 'IDR';
    if (typeof settings?.useThousandsSeparator === 'boolean') {
      useThousandsSeparator = settings.useThousandsSeparator;
    }
  } catch {
    currencyCode = 'IDR';
    useThousandsSeparator = true;
  }
  return formatDisplayCurrency(amount, currencyCode, useThousandsSeparator).replace(/\u00a0/g, ' ');
}

function formatSignedCurrency(amount: number): string {
  if (!Number.isFinite(amount) || amount === 0) {
    return formatCurrency(0);
  }
  return amount > 0 ? `+${formatCurrency(amount)}` : formatCurrency(-Math.abs(amount));
}

/** "Rp 1.200.000 more in Nov 2026 than in Oct 2026 (Rp 13.279.500 vs Rp 12.079.500)" */
function describeChange(current: number, previous: number, currentLabel: string, previousLabel: string): string {
  const diff = current - previous;
  const pair = `(${formatCurrency(current)} vs ${formatCurrency(previous)})`;
  if (diff === 0) return `the same in ${currentLabel} as in ${previousLabel} ${pair}`;
  return `${formatCurrency(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} in ${currentLabel} than in ${previousLabel} ${pair}`;
}

function formatShortDate(ms: number, referenceYear?: number): string {
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  if (referenceYear !== undefined && yyyy === referenceYear) {
    return `${dd}/${mm}`;
  }
  return `${dd}/${mm}/${yyyy}`;
}

function startOfLocalDay(year: number, month: number, day: number): number {
  return new Date(year, month, day, 0, 0, 0, 0).getTime();
}

function currentMonthStartDay(): number {
  return clampMonthStartDay(useSettingsStore.getState?.()?.monthStartDay ?? 1);
}

/** The billing month containing `anchor`, honouring the user's month start day; `toMs` is exclusive. */
function billingMonthPeriod(
  kind: 'this-month' | 'last-month',
  anchor: Date,
  monthStartDay: number,
): { kind: 'this-month' | 'last-month'; label: string; fromMs: number; toMs: number } {
  const bounds = getPeriodBounds(anchor, monthStartDay);
  const prefix = kind === 'this-month' ? 'This month' : 'Last month';
  const range =
    bounds.monthStartDay === 1
      ? `${MONTH_SHORT_NAMES[bounds.start.getMonth()]} ${bounds.start.getFullYear()}`
      : `${formatShortDate(bounds.startMs)}–${formatShortDate(bounds.endMs)}`;
  return { kind, label: `${prefix} (${range})`, fromMs: bounds.startMs, toMs: bounds.endMs + 1 };
}

export function parseTimePeriod(
  userPrompt: string,
  nowInput?: Date | number,
  monthStartDay: number = 1,
): GroundedTimePeriod {
  const now = nowInput instanceof Date ? new Date(nowInput.getTime()) : new Date(nowInput ?? Date.now());
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const todayStart = startOfLocalDay(y, m, d);
  const tomorrowStart = startOfLocalDay(y, m, d + 1);
  const dayFromMon = (now.getDay() + 6) % 7;

  // Anchor rolling lookbacks to local start-of-day so SQL boundaries match the printed calendar date.
  const buildLastNDaysPeriod = (days: number, matchedText: string): GroundedTimePeriod => {
    const clampedDays = Math.max(1, Math.min(3650, days));
    const fromMs = startOfLocalDay(y, m, d - clampedDays);
    const toMs = Math.max(now.getTime() + 1, tomorrowStart);
    return {
      kind: 'last-n-days',
      label: `Last ${clampedDays} days (${formatShortDate(fromMs)}–${formatShortDate(now.getTime())})`,
      fromMs,
      toMs,
      isExplicit: true,
      matchedText,
    };
  };

  // 1. Last N days / weeks (English & Indonesian)
  const enDaysMatch = userPrompt.match(
    /\b(?:(?:over|in|during)\s+(?:the\s+)?)?(?:last|past)\s+(\d{1,4})\s+days?\b/i,
  );
  if (enDaysMatch) {
    return buildLastNDaysPeriod(Number(enDaysMatch[1]) || 30, enDaysMatch[0]);
  }

  const enWeeksMatch = userPrompt.match(
    /\b(?:(?:over|in|during)\s+(?:the\s+)?)?(?:last|past)\s+(\d{1,3})\s+weeks?\b/i,
  );
  if (enWeeksMatch) {
    return buildLastNDaysPeriod((Number(enWeeksMatch[1]) || 2) * 7, enWeeksMatch[0]);
  }

  const idDaysMatch = userPrompt.match(/\b(?:dalam\s+)?(\d{1,4})\s+hari\s+(?:terakhir|belakangan|ke\s*belakang)\b/i);
  if (idDaysMatch) {
    return buildLastNDaysPeriod(Number(idDaysMatch[1]) || 30, idDaysMatch[0]);
  }

  const idWeeksMatch = userPrompt.match(
    /\b(?:dalam\s+)?(\d{1,3})\s+(?:minggu|pekan)\s+(?:terakhir|belakangan|ke\s*belakang)\b/i,
  );
  if (idWeeksMatch) {
    return buildLastNDaysPeriod((Number(idWeeksMatch[1]) || 2) * 7, idWeeksMatch[0]);
  }

  const idRollingMonthMatch = userPrompt.match(/\bsebulan\s+terakhir\b/i);
  if (idRollingMonthMatch) {
    return buildLastNDaysPeriod(30, idRollingMonthMatch[0]);
  }

  const idRollingWeekMatch = userPrompt.match(/\bseminggu\s+terakhir\b/i);
  if (idRollingWeekMatch) {
    return buildLastNDaysPeriod(7, idRollingWeekMatch[0]);
  }

  // 2. Last month (check before single-word "kemarin")
  const lastMonthMatch = userPrompt.match(/\b(?:(?:last|previous)\s+month|bulan\s+(?:lalu|kemarin|sebelumnya))\b/i);
  if (lastMonthMatch) {
    return {
      ...billingMonthPeriod('last-month', shiftPeriod(now, -1, monthStartDay), monthStartDay),
      isExplicit: true,
      matchedText: lastMonthMatch[0],
    };
  }

  // 3. This month
  const thisMonthMatch = userPrompt.match(/\b(?:(?:this|current)\s+month|bulan\s+ini)\b/i);
  if (thisMonthMatch) {
    return {
      ...billingMonthPeriod('this-month', now, monthStartDay),
      isExplicit: true,
      matchedText: thisMonthMatch[0],
    };
  }

  // 4. Last week (calendar Mon–Sun)
  const lastWeekMatch = userPrompt.match(/\b(?:(?:last|previous)\s+week|(?:minggu|pekan)\s+(?:lalu|kemarin|sebelumnya))\b/i);
  if (lastWeekMatch) {
    const thisWeekStart = startOfLocalDay(y, m, d - dayFromMon);
    const lastWeekStart = startOfLocalDay(y, m, d - dayFromMon - 7);
    return {
      kind: 'last-week',
      label: `Last week (${formatShortDate(lastWeekStart)}–${formatShortDate(thisWeekStart - 1)})`,
      fromMs: lastWeekStart,
      toMs: thisWeekStart,
      isExplicit: true,
      matchedText: lastWeekMatch[0],
    };
  }

  // 5. This week (calendar Mon–Sun)
  const thisWeekMatch = userPrompt.match(/\b(?:(?:this|current)\s+week|(?:minggu|pekan)\s+ini)\b/i);
  if (thisWeekMatch) {
    const thisWeekStart = startOfLocalDay(y, m, d - dayFromMon);
    const nextWeekStart = startOfLocalDay(y, m, d - dayFromMon + 7);
    return {
      kind: 'this-week',
      label: `This week (${formatShortDate(thisWeekStart)}–${formatShortDate(nextWeekStart - 1)})`,
      fromMs: thisWeekStart,
      toMs: nextWeekStart,
      isExplicit: true,
      matchedText: thisWeekMatch[0],
    };
  }

  // 6. Yesterday
  const yesterdayMatch = userPrompt.match(/\b(?:yesterday|kemarin)\b/i);
  if (yesterdayMatch) {
    const yesterdayStart = startOfLocalDay(y, m, d - 1);
    return {
      kind: 'yesterday',
      label: `Yesterday (${formatShortDate(yesterdayStart)})`,
      fromMs: yesterdayStart,
      toMs: todayStart,
      isExplicit: true,
      matchedText: yesterdayMatch[0],
    };
  }

  // 7. Today
  const todayMatch = userPrompt.match(/\b(?:today|hari\s+ini)\b/i);
  if (todayMatch) {
    return {
      kind: 'today',
      label: `Today (${formatShortDate(todayStart)})`,
      fromMs: todayStart,
      toMs: tomorrowStart,
      isExplicit: true,
      matchedText: todayMatch[0],
    };
  }

  // 8. Named month (English & Indonesian, optional year).
  // Short aliases ("jan", "feb", ..., "des") and ambiguous names ("may", "mei") require a period cue
  // or 4-digit year so merchant names like "Warung Mei" or "Jan Bakery" stay merchant lookups.
  const merchantPrefixGuard = /\b(?:at|warung|toko|kedai|kafe|cafe|resto|restoran|bakery|kopi|rm)\s+$/i;
  for (const entry of NAMED_MONTH_PATTERNS) {
    const aliasGroup = entry.aliases.join('|');
    const regex = entry.guarded
      ? new RegExp(
          `(?:\\b(?:in|for|during|of|from|(?:di\\s+)?bulan|bln)\\s+(?:${aliasGroup})\\b(?:\\s+(\\d{4}))?|\\b(?:${aliasGroup})\\s+(\\d{4})\\b)`,
          'i',
        )
      : new RegExp(`(\\b(?:in|for|during|of|from|(?:di\\s+)?bulan|bln)\\s+)?\\b(?:${aliasGroup})\\b(?:\\s+(\\d{4}))?`, 'i');
    const match = userPrompt.match(regex);
    if (match) {
      const explicitYearRaw = entry.guarded ? (match[1] ?? match[2]) : match[2];
      const hasPeriodCue = entry.guarded ? true : Boolean(match[1]);
      if (!entry.guarded && !hasPeriodCue && !explicitYearRaw && typeof match.index === 'number') {
        const prefix = userPrompt.slice(0, match.index);
        const suffix = userPrompt.slice(match.index + match[0].length);
        // "di April Cafe" / "April Bakery": a capitalised name or venue word after the month means a merchant.
        const venueSuffix = /^\s+(?:cafe|café|kafe|bakery|resto|restaurant|coffee|kopi|store|shop|mart|bar)\b/i.test(suffix);
        const diBeforeName = /\bdi\s+$/i.test(prefix) && /^\s+\p{Lu}/u.test(suffix);
        if (merchantPrefixGuard.test(prefix) || venueSuffix || diBeforeName) {
          continue;
        }
      }
      const explicitYear = explicitYearRaw ? Number(explicitYearRaw) : null;
      const targetYear =
        explicitYear && explicitYear >= 1970 && explicitYear <= 2100
          ? explicitYear
          : entry.monthIndex <= m
            ? y
            : y - 1;
      const fromDate = new Date(targetYear, entry.monthIndex, 1, 0, 0, 0, 0);
      const toDate = new Date(targetYear, entry.monthIndex + 1, 1, 0, 0, 0, 0);
      return {
        kind: 'named-month',
        label: `${MONTH_SHORT_NAMES[entry.monthIndex]} ${targetYear}`,
        fromMs: fromDate.getTime(),
        toMs: toDate.getTime(),
        isExplicit: true,
        matchedText: match[0],
      };
    }
  }

  // 9. Last year / This year
  const lastYearMatch = userPrompt.match(/\b(?:(?:last|previous)\s+year|tahun\s+(?:lalu|kemarin|sebelumnya))\b/i);
  if (lastYearMatch) {
    return {
      kind: 'last-year',
      label: `Last year (${y - 1})`,
      fromMs: new Date(y - 1, 0, 1, 0, 0, 0, 0).getTime(),
      toMs: new Date(y, 0, 1, 0, 0, 0, 0).getTime(),
      isExplicit: true,
      matchedText: lastYearMatch[0],
    };
  }

  const thisYearMatch = userPrompt.match(/\b(?:(?:this|current)\s+year|tahun\s+ini)\b/i);
  if (thisYearMatch) {
    return {
      kind: 'this-year',
      label: `This year (${y})`,
      fromMs: new Date(y, 0, 1, 0, 0, 0, 0).getTime(),
      toMs: new Date(y + 1, 0, 1, 0, 0, 0, 0).getTime(),
      isExplicit: true,
      matchedText: thisYearMatch[0],
    };
  }

  // 10. Default: the current billing month (custom month start day aware)
  return {
    ...billingMonthPeriod('this-month', now, monthStartDay),
    isExplicit: false,
  };
}

interface StoredCategory {
  name: string;
  type: 'expense' | 'income';
}

interface BasicWallet {
  id: number;
  name: string;
  type: string;
  isActive: boolean;
}

interface StoredWallet extends BasicWallet {
  balance: number;
}

function loadUserCategories(db: GroundedSqliteDb): StoredCategory[] {
  const seen = new Map<string, StoredCategory>();
  const add = (name: string | null | undefined, type: string | null | undefined) => {
    const trimmed = name?.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, {
        name: trimmed,
        type: type === 'income' ? 'income' : 'expense',
      });
    }
  };

  const catRows = safeQuery<{ name?: string; type?: string }>(db, 'SELECT name, type FROM categories ORDER BY id ASC');
  catRows.forEach((row) => add(row.name, row.type));

  // Avoid scanning transaction_items on normal DBs where categories is already seeded/migrated.
  if (catRows.length === 0) {
    const txCatRows = safeQuery<{ category?: string; type?: string }>(
      db,
      `SELECT DISTINCT i.category AS category, t.type AS type
       FROM transaction_items i
       LEFT JOIN transactions t ON t.id = i.transaction_id
       WHERE i.category IS NOT NULL AND TRIM(i.category) != '' AND COALESCE(t.type, 'expense') != 'transfer'`,
    );
    txCatRows.forEach((row) => add(row.category, row.type));
  }

  readGroundedBudgetPlans(db).forEach((plan) => plan.categories.forEach((category) => add(category, 'expense')));

  return Array.from(seen.values());
}

function loadWalletsBasic(db: GroundedSqliteDb): BasicWallet[] {
  const rows = safeQuery<{
    id?: number;
    name?: string;
    type?: string;
    is_active?: number | null;
  }>(db, 'SELECT id, name, type, is_active FROM wallets ORDER BY is_active DESC, id ASC');

  return rows
    .filter((row): row is { id: number; name: string; type?: string; is_active?: number | null } =>
      typeof row.id === 'number' && typeof row.name === 'string' && row.name.trim().length > 0,
    )
    .map((row) => ({
      id: row.id,
      name: row.name.trim(),
      type: row.type ?? 'cash',
      isActive: row.is_active !== 0,
    }));
}

function loadWalletsWithBalances(db: GroundedSqliteDb): StoredWallet[] {
  const rows = safeQuery<{
    id?: number;
    name?: string;
    type?: string;
    is_active?: number | null;
    balance?: number | null;
  }>(
    db,
    `SELECT
       w.id,
       w.name,
       w.type,
       w.is_active,
       COALESCE(w.initial_balance, 0)
         + COALESCE((SELECT SUM(t.total_amount) FROM transactions t WHERE t.wallet_id = w.id), 0)
         - COALESCE((SELECT SUM(t.total_amount) FROM transactions t WHERE t.to_wallet_id = w.id AND t.type = 'transfer'), 0)
         AS balance
     FROM wallets w
     ORDER BY w.is_active DESC, w.id ASC`,
  );

  return rows
    .filter((row): row is { id: number; name: string; type?: string; is_active?: number | null; balance?: number | null } =>
      typeof row.id === 'number' && typeof row.name === 'string' && row.name.trim().length > 0,
    )
    .map((row) => ({
      id: row.id,
      name: row.name.trim(),
      type: row.type ?? 'cash',
      isActive: row.is_active !== 0,
      balance: typeof row.balance === 'number' && Number.isFinite(row.balance) ? row.balance : 0,
    }));
}

function matchWordOrPhrase(text: string, phrase: string): boolean {
  const escaped = escapeRegex(phrase.trim().toLowerCase()).replace(/\s+/g, '\\s+');
  if (!escaped) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu').test(text);
}

function isPartOfNamedMerchant(text: string, term: string): boolean {
  if (!VENUE_PREFIX_SYNONYMS.has(term.toLowerCase())) {
    return false;
  }
  const escaped = escapeRegex(term.trim().toLowerCase()).replace(/\s+/g, '\\s+');
  const match = text.match(new RegExp(`(?:^|[^\\p{L}\\p{N}])(${escaped})\\s+([\\p{L}\\p{N}]+)`, 'iu'));
  if (!match) {
    return false;
  }
  const nextToken = match[2].toLowerCase();
  return nextToken.length >= 2 && !/^\d+$/.test(nextToken) && !STOP_WORDS.has(nextToken);
}

function matchCategoriesInPrompt(
  cleanedPrompt: string,
  userCategories: StoredCategory[],
): { matches: GroundedCategoryMatch[]; consumedTokens: Set<string> } {
  const lowered = cleanedPrompt.toLowerCase();
  const matches: GroundedCategoryMatch[] = [];
  const matchedKeys = new Set<string>();
  const consumedTokens = new Set<string>();

  const recordMatch = (cat: StoredCategory, matchedViaSynonym: boolean, triggerTerm: string) => {
    const key = cat.name.toLowerCase();
    if (matchedKeys.has(key)) return;
    matchedKeys.add(key);
    matches.push({ name: cat.name, type: cat.type, matchedViaSynonym, triggerTerm });
    triggerTerm
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 0)
      .forEach((t) => consumedTokens.add(t));
  };

  // Pass 1: Full category name match (longest first)
  const sortedCategories = [...userCategories].sort((a, b) => b.name.length - a.name.length);
  for (const cat of sortedCategories) {
    if (matchWordOrPhrase(lowered, cat.name)) {
      recordMatch(cat, false, cat.name);
    }
  }

  // Pass 2: Individual distinctive tokens of real category names (e.g. "food" -> "Food & Dining")
  for (const cat of sortedCategories) {
    if (matchedKeys.has(cat.name.toLowerCase())) continue;
    const catTokens = cat.name
      .toLowerCase()
      .split(/[\s&/,-]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && !GENERIC_CATEGORY_TOKENS.has(t));

    for (const token of catTokens) {
      const variants = [token];
      if (token.endsWith('ies') && token.length > 4) {
        variants.push(`${token.slice(0, -3)}y`);
      } else if (token.endsWith('s') && token.length > 3) {
        variants.push(token.slice(0, -1));
      } else {
        variants.push(`${token}s`);
      }
      const hit = variants.find((variant) => matchWordOrPhrase(lowered, variant));
      if (hit) {
        recordMatch(cat, false, hit);
        break;
      }
    }
  }

  // Pass 3: English & Indonesian synonyms resolved against real user categories
  for (const group of CATEGORY_SYNONYM_GROUPS) {
    const hitSynonyms = group.synonyms.filter(
      (syn) => matchWordOrPhrase(lowered, syn) && !isPartOfNamedMerchant(lowered, syn),
    );
    if (hitSynonyms.length === 0) continue;

    let resolvedCategory: StoredCategory | undefined;
    for (const pattern of group.targetPatterns) {
      resolvedCategory = sortedCategories.find((cat) => pattern.test(cat.name));
      if (resolvedCategory) break;
    }

    if (resolvedCategory) {
      if (!matchedKeys.has(resolvedCategory.name.toLowerCase())) {
        const primaryHit = hitSynonyms[0];
        const isDirectTokenOfCategory = resolvedCategory.name
          .toLowerCase()
          .split(/[\s&/,-]+/)
          .includes(primaryHit.toLowerCase());
        recordMatch(resolvedCategory, !isDirectTokenOfCategory, primaryHit);
      }
      // Consume all synonyms in this group that appeared in the query so phrases like
      // "makan dan minum" or "food and restaurants" do not leak into keyword search.
      for (const syn of hitSynonyms) {
        syn
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter((t) => t.length > 0)
          .forEach((t) => consumedTokens.add(t));
      }
    }
  }

  return { matches, consumedTokens };
}

function matchAccountInPrompt(
  cleanedPrompt: string,
  wallets: Array<Pick<BasicWallet, 'id' | 'name'>>,
): { account: { id: number; name: string } | null; consumedTokens: Set<string> } {
  const lowered = cleanedPrompt.toLowerCase();
  const consumedTokens = new Set<string>();
  const sorted = [...wallets].sort((a, b) => b.name.length - a.name.length);

  // Pass 1: Full wallet name
  for (const wallet of sorted) {
    if (matchWordOrPhrase(lowered, wallet.name)) {
      wallet.name
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 0)
        .forEach((t) => consumedTokens.add(t));
      return { account: { id: wallet.id, name: wallet.name }, consumedTokens };
    }
  }

  // Pass 2: Unique distinctive token from wallet name (e.g. "BCA" -> "Bank BCA")
  const tokenToWallets = new Map<string, Array<Pick<BasicWallet, 'id' | 'name'>>>();
  for (const wallet of sorted) {
    const tokens = wallet.name
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 3 && !GENERIC_WALLET_TOKENS.has(t));
    for (const token of tokens) {
      const list = tokenToWallets.get(token) ?? [];
      list.push(wallet);
      tokenToWallets.set(token, list);
    }
  }

  for (const [token, matchingWallets] of tokenToWallets.entries()) {
    if (matchingWallets.length === 1 && matchWordOrPhrase(lowered, token)) {
      consumedTokens.add(token);
      return { account: { id: matchingWallets[0].id, name: matchingWallets[0].name }, consumedTokens };
    }
  }

  return { account: null, consumedTokens };
}

function extractSearchKeywords(cleanedPrompt: string, consumedTokens: Set<string>): string[] {
  const rawTokens = cleanedPrompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !/^\d+$/.test(token) && !STOP_WORDS.has(token) && !consumedTokens.has(token));

  return Array.from(new Set(rawTokens)).slice(0, 4);
}

export function parseGroundedQuery(
  userPrompt: string,
  options?: {
    db?: GroundedSqliteDb;
    now?: Date | number;
    categories?: StoredCategory[];
    wallets?: Array<Pick<BasicWallet, 'id' | 'name'>>;
    monthStartDay?: number;
  },
): GroundedParsedQuery {
  const db = options?.db ?? expoDb;
  const period = parseTimePeriod(userPrompt, options?.now, options?.monthStartDay ?? currentMonthStartDay());
  const comparePeriod = parseComparisonPeriod(userPrompt, period, options?.now, options?.monthStartDay ?? currentMonthStartDay());
  // Both periods' words ("October and November") are dates, not merchants to search for.
  let cleanedPrompt = period.matchedText ? userPrompt.replace(period.matchedText, ' ') : userPrompt;
  if (comparePeriod?.matchedText) cleanedPrompt = cleanedPrompt.replace(comparePeriod.matchedText, ' ');

  const userCategories = options?.categories ?? loadUserCategories(db);
  const wallets = options?.wallets ?? loadWalletsBasic(db);

  const { matches: categories, consumedTokens: categoryTokens } = matchCategoriesInPrompt(cleanedPrompt, userCategories);
  const { account, consumedTokens: accountTokens } = matchAccountInPrompt(cleanedPrompt, wallets);

  const asksBudget = /\b(budget|budgets|budgeted|budgeting|anggaran|bujet|limit|limits|cap|caps|batas|jatah)\b/i.test(
    userPrompt,
  );
  const wantsRecent =
    /\b(recent|latest|history|list|riwayat)\b/i.test(userPrompt) ||
    /\b(?:show|display|give|view|see)\s+(?:me\s+)?(?:my\s+)?(?:all\s+)?(?:the\s+)?(?:[\p{L}\p{N}&-]+\s+){0,3}(?:transactions?|expenses?|purchases?)\b/iu.test(
      userPrompt,
    ) ||
    /\b(?:all|last\s+\d+)\s+(?:[\p{L}\p{N}&-]+\s+){0,2}(?:transactions?|expenses?|purchases?)\b/iu.test(userPrompt) ||
    /\bwhat\s+(?:[\p{L}\p{N}&-]+\s+){0,2}(?:transactions?|purchases?)\b/iu.test(userPrompt) ||
    /\b(?:transactions?|purchases?)\s+(?:did\s+i\s+(?:make|have)|were\s+made)\b/i.test(userPrompt) ||
    /\b(?:transaksi|pengeluaran|pemasukan)\s+(?:[\p{L}\p{N}&-]+\s+){0,2}(?:terbaru|terakhir|apa\s+saja)\b/iu.test(
      userPrompt,
    ) ||
    /\b(?:daftar|tampilkan|tunjukkan|tunjukin|lihat|liat)\s+(?:semua\s+|daftar\s+)?(?:[\p{L}\p{N}&-]+\s+){0,2}(?:transaksi|pengeluaran|pemasukan)\b/iu.test(
      userPrompt,
    );
  const asksBiggest =
    /\b(biggest|largest|highest|most\s+expensive|top\s+expense|single\s+expense|terbesar|paling\s+besar|paling\s+mahal|tertinggi)\b/i.test(
      userPrompt,
    );
  const asksIncomeVsSpending =
    /\b(income|earn|earned|earning|earnings|vs|versus|compare|comparison|cashflow|cash\s+flow|net|pemasukan|pendapatan|penghasilan|banding|bandingkan|dibanding|perbandingan|arus\s+kas)\b/i.test(
      userPrompt,
    );
  // The old pattern ended in `categor\b`, which never matches "category": "What is my most spent category"
  // got no category facts and the model made up a list (reported 2026-11-25).
  const asksWhereMoneyGoes =
    /\bwhere\s+(?:did|does|do|is|has)\s+(?:all\s+)?(?:my\s+)?money\s+(?:go|goes|going|gone)\b|\buang(?:ku)?\s+(?:saya\s+)?(?:habis|lari)\s+ke\s+mana\b/i.test(
      userPrompt,
    );
  const asksTopCategories =
    asksWhereMoneyGoes ||
    /\b(?:top\s+(?:spending\s+)?categor\w*|categor(?:y|ies)\s+breakdown|spending\s+breakdown|by\s+categor\w*|most\s+(?:spent|spending)|spen[dt]\s+(?:the\s+)?most\s+on|(?:biggest|largest|highest|main|top)\s+(?:spending\s+|expense\s+)?categor\w*|kategori\s+(?:\p{L}+\s+)?(?:terbesar|terbanyak|tertinggi|paling\s+(?:besar|banyak))|rincian\s+kategori|pengeluaran\s+per\s+kategori|paling\s+banyak\s+(?:keluar|habis|belanja))\b/iu.test(
      userPrompt,
    );
  const asksTopMerchants =
    /\b(?:which|what)\s+(?:store|shop|merchant|place|restaurant|vendor|outlet)s?\b.*\bmost\b|\btop\s+(?:merchants?|stores?|shops?|places)\b|\b(?:toko|merchant|tempat)\s+(?:\p{L}+\s+)?(?:terbanyak|paling\s+(?:sering|banyak|besar))\b/iu.test(
      userPrompt,
    );
  const asksAverage = /\b(?:average|avg|per\s+day|a\s+day|daily\s+(?:spend|spending|average)|rata[\s-]*rata|per\s+hari|sehari)\b/i.test(userPrompt);
  const asksFinancialHealth =
    /\b(?:afford|doing\s+(?:okay|ok|well|fine|good|alright)|how\s+am\s+i\s+doing|on\s+track|financial(?:ly)?\s+(?:health|situation|shape|ok|okay|fine)|financially|can\s+i\s+(?:buy|get)|mampu\s+beli|sanggup\s+beli|cukup\s+(?:uang|duit)|keuangan(?:ku)?\s+(?:sehat|aman|oke|baik))\b/i.test(
      userPrompt,
    );

  const explicitBalancePhrase =
    /\b(balance|balances|net\s+worth|money\s+left|cash\s+left|funds\s+left|how\s+much\s+money|total\s+money|my\s+money|remaining\s+money|account\s+balance|wallet\s+balance|saldo|saldoku|sisa\s+uang|sisa\s+duit|sisa\s+dana|uang\s+(?:saya|ku|gue|gw|aku)|duit\s+(?:saya|ku|gue|gw|aku)|uangku|duitku|total\s+uang|total\s+duit|kekayaan\s+bersih)\b/i.test(
      userPrompt,
    );
  const genericLeftWithoutBudget =
    !asksBudget &&
    categories.length === 0 &&
    /\b(have\s+left|do\s+i\s+have\s+left|berapa\s+sisa)\b/i.test(userPrompt);
  const accountBalanceImplied =
    account !== null &&
    !asksBudget &&
    !wantsRecent &&
    !asksBiggest &&
    !asksIncomeVsSpending &&
    !/\b(spend|spent|spending|expense|expenses|pengeluaran|beli|bayar)\b/i.test(userPrompt);
  // "Where is my money going?" names "my money" but asks about spending, not the balance.
  const asksBalance = (explicitBalancePhrase && !asksWhereMoneyGoes) || genericLeftWithoutBudget || accountBalanceImplied;
  const orderedPeriod = comparePeriod && comparePeriod.fromMs > period.fromMs ? comparePeriod : period;
  const earlierPeriod = comparePeriod && comparePeriod.fromMs > period.fromMs ? period : comparePeriod;

  const consumedTokens = new Set<string>([...categoryTokens, ...accountTokens]);
  const keywords = extractSearchKeywords(cleanedPrompt, consumedTokens);

  return {
    period: orderedPeriod,
    categories,
    account,
    keywords,
    asksBalance,
    asksBudget,
    wantsRecent,
    asksBiggest,
    asksIncomeVsSpending,
    asksTopCategories,
    asksTopMerchants,
    asksAverage,
    asksFinancialHealth,
    comparePeriod: earlierPeriod,
  };
}

// "than last month", or a comparison word next to an earlier period ("compared to before"). "Income vs spending"
// compares two totals of one period, not two periods.
const COMPARISON_PATTERN =
  /\bthan\s+(?:last|previous|before|usual|the\s+(?:last|previous))\b|\b(?:compare[sd]?|comparison|vs|versus|banding|bandingkan|dibanding(?:kan)?|perbandingan|daripada|ketimbang)\b.*\b(?:last|previous|prior|before|sebelumnya|lalu|kemarin)\b/i;

const FOLLOW_UP_START = /^(?:and|but|what\s+about|how\s+about|same\s+for|terus|trus|lalu|kalau|kalo|gimana\s+dengan|bagaimana\s+dengan)\b/i;
const FOLLOW_UP_REFERENCE = /\b(?:that|it|this\s+one|those|them|itu|tersebut|tadi)\b/i;

/**
 * A short follow-up ("And last month?", "What category was that?") carries no topic of its own, so it is read
 * together with the previous question; a period named in the follow-up replaces the earlier one.
 */
export function resolveFollowUpPrompt(userPrompt: string, previousUserPrompts: string[] = []): string {
  const previous = previousUserPrompts[previousUserPrompts.length - 1]?.trim();
  const current = userPrompt.trim();
  if (!previous || current.split(/\s+/).length > 7) return userPrompt;
  if (!FOLLOW_UP_START.test(current) && !FOLLOW_UP_REFERENCE.test(current)) return userPrompt;
  const previousPeriod = parseTimePeriod(previous);
  const base =
    parseTimePeriod(current).isExplicit && previousPeriod.matchedText ? previous.replace(previousPeriod.matchedText, ' ') : previous;
  return `${base.replace(/\s+/g, ' ').replace(/[\s?.!]+$/, '').trim()}. ${current}`;
}

/** The period before `period` of the same size, for "this month vs last month" style questions. */
function previousPeriodOf(period: GroundedTimePeriod, now: Date | number | undefined, monthStartDay: number): GroundedTimePeriod | null {
  switch (period.kind) {
    case 'this-month':
      return parseTimePeriod('last month', now, monthStartDay);
    case 'this-week':
      return parseTimePeriod('last week', now, monthStartDay);
    case 'today':
      return parseTimePeriod('yesterday', now, monthStartDay);
    case 'this-year':
      return parseTimePeriod('last year', now, monthStartDay);
    case 'named-month':
    case 'last-month': {
      const start = new Date(period.fromMs);
      const prev = new Date(start.getFullYear(), start.getMonth() - 1, 15);
      const label = `${MONTH_SHORT_NAMES[prev.getMonth()]} ${prev.getFullYear()}`;
      return {
        kind: 'named-month',
        label,
        fromMs: new Date(prev.getFullYear(), prev.getMonth(), start.getDate(), 0, 0, 0, 0).getTime(),
        toMs: period.fromMs,
        isExplicit: true,
      };
    }
    default:
      return null;
  }
}

/**
 * A second period for comparison questions: an explicitly named one ("October and November"), or the
 * period before the asked one when the question compares ("more than last month", "vs last week").
 */
function parseComparisonPeriod(
  userPrompt: string,
  period: GroundedTimePeriod,
  now: Date | number | undefined,
  monthStartDay: number,
): GroundedTimePeriod | null {
  const rest = period.matchedText ? userPrompt.replace(period.matchedText, ' ') : userPrompt;
  const second = parseTimePeriod(rest, now, monthStartDay);
  if (period.isExplicit && second.isExplicit && (second.fromMs !== period.fromMs || second.toMs !== period.toMs)) {
    return second;
  }
  if (!COMPARISON_PATTERN.test(userPrompt)) return null;
  return previousPeriodOf(period, now, monthStartDay);
}

function getTotalBalance(db: GroundedSqliteDb): number {
  // Net worth: opening balances plus all income and spending; transfers only move money between accounts.
  const rows = safeQuery<{ total?: number | null }>(
    db,
    "SELECT (SELECT COALESCE(SUM(initial_balance), 0) FROM wallets) + (SELECT COALESCE(SUM(total_amount), 0) FROM transactions WHERE type != 'transfer') AS total",
  );
  return rows[0]?.total ?? 0;
}

interface MatchedTxRow {
  transaction_id: number;
  merchant_name: string;
  total_amount: number;
  type: string;
  date: number;
  note: string | null;
  line_items_text: string | null;
  category: string | null;
}

function normalizeForMatch(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function escapeLikePattern(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function formatLineItemSnippet(lineItemsText: string | null | undefined, keywords: string[]): string | null {
  if (!lineItemsText || !lineItemsText.trim()) return null;
  const parsedItems = parseReceiptLineItemsText(lineItemsText);
  if (parsedItems.length === 0) return null;

  const normalizedKeywords = keywords.map((k) => normalizeForMatch(k)).filter((k) => k.length > 0);
  let matchingItems = parsedItems;
  if (normalizedKeywords.length > 0) {
    const allMatch = parsedItems.filter((item) => {
      const hay = normalizeForMatch(`${item.name} ${item.note}`);
      return normalizedKeywords.every((kw) => hay.includes(kw));
    });
    if (allMatch.length > 0) {
      matchingItems = allMatch;
    } else {
      const anyMatch = parsedItems.filter((item) => {
        const hay = normalizeForMatch(`${item.name} ${item.note}`);
        return normalizedKeywords.some((kw) => hay.includes(kw));
      });
      if (anyMatch.length > 0) {
        matchingItems = anyMatch;
      }
    }
  }

  const currencyCode = currentCurrencyCode();
  const formatted = matchingItems.slice(0, 2).map((item) => {
    const price = item.price.trim() ? Math.abs(parseSignedAmount(item.price.trim(), undefined, currencyCode)) : 0;
    if (Number.isFinite(price) && price > 0) {
      return `${trimCollapsedText(item.name, 35)} ${formatCurrency(price)}`;
    }
    return trimCollapsedText(item.name, 45);
  });

  return formatted.join(', ');
}

function formatTransactionLine(
  row: MatchedTxRow,
  keywords: string[] = [],
  includeDetails = false,
  referenceYear?: number,
): string {
  const merchant = row.merchant_name || 'Unknown';
  const cat = row.category ? ` (${row.category})` : '';
  const dateStr = formatShortDate(row.date, referenceYear);
  let amountStr: string;
  if (row.type === 'transfer') {
    amountStr = `${formatCurrency(Math.abs(row.total_amount))} (transfer)`;
  } else if (row.total_amount > 0) {
    amountStr = `+${formatCurrency(row.total_amount)}`;
  } else {
    amountStr = formatCurrency(-Math.abs(row.total_amount));
  }

  let details = '';
  if (includeDetails) {
    const parts: string[] = [];
    const itemSnippet = formatLineItemSnippet(row.line_items_text, keywords);
    if (itemSnippet) {
      parts.push(`items: ${itemSnippet}`);
    }
    const cleanNote = row.note?.trim();
    if (cleanNote) {
      parts.push(`note: ${trimCollapsedText(cleanNote, 55)}`);
    }
    if (parts.length > 0) {
      details = ` [${parts.join('; ')}]`;
    }
  }

  return trimCollapsedText(`${dateStr} ${merchant}${cat} ${amountStr}${details}`, 160);
}

interface KeywordMatchResult {
  totalCount: number;
  expenseCount: number;
  expenseSum: number;
  incomeCount: number;
  incomeSum: number;
  allMatchedViaLineItems: boolean;
  sampleRows: MatchedTxRow[];
}

interface KeywordAggregateSqlRow {
  total_count?: number | null;
  expense_count?: number | null;
  expense_sum?: number | null;
  income_count?: number | null;
  income_sum?: number | null;
  line_item_row_count?: number | null;
}

interface LineItemCandidateRow {
  id: number;
  merchant_name: string | null;
  total_amount: number;
  type: string;
  line_items_text: string | null;
}

function queryKeywordMatches(
  db: GroundedSqliteDb,
  keywords: string[],
  range: { fromMs: number; toMs: number } | null,
  accountId: number | null,
  options?: { sampleLimit?: number; allowLikeFallback?: boolean },
): KeywordMatchResult {
  const empty: KeywordMatchResult = {
    totalCount: 0,
    expenseCount: 0,
    expenseSum: 0,
    incomeCount: 0,
    incomeSum: 0,
    allMatchedViaLineItems: false,
    sampleRows: [],
  };

  const terms = keywords
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase())
    .filter((w) => w.length >= 2);
  if (terms.length === 0) {
    return empty;
  }

  const sampleLimit = options?.sampleLimit ?? QWEN_MODEL_RETRIEVAL_ITEM_LIMIT;
  const allowLikeFallback = options?.allowLikeFallback ?? true;
  const dateClause = range ? ' AND t.date >= ? AND t.date < ?' : '';
  const walletClause = accountId !== null ? ' AND t.wallet_id = ?' : '';
  const tailParams: any[] = [];
  if (range) tailParams.push(range.fromMs, range.toMs);
  if (accountId !== null) tailParams.push(accountId);

  const aggregateSelect = `
    COUNT(*) AS total_count,
    COALESCE(SUM(CASE WHEN t.type != 'transfer' AND t.total_amount < 0 THEN 1 ELSE 0 END), 0) AS expense_count,
    COALESCE(SUM(CASE WHEN t.type != 'transfer' AND t.total_amount < 0 THEN ABS(t.total_amount) ELSE 0 END), 0) AS expense_sum,
    COALESCE(SUM(CASE WHEN t.type != 'transfer' AND t.total_amount > 0 THEN 1 ELSE 0 END), 0) AS income_count,
    COALESCE(SUM(CASE WHEN t.type != 'transfer' AND t.total_amount > 0 THEN t.total_amount ELSE 0 END), 0) AS income_sum,
    COALESCE(SUM(CASE WHEN t.type != 'transfer' AND t.line_items_text IS NOT NULL AND TRIM(t.line_items_text) != '' THEN 1 ELSE 0 END), 0) AS line_item_row_count
  `;

  // An everyday word ("coffee") stands for its merchants (KEYWORD_CONCEPTS) when it is alone or the last word
  // ("Bali trip", "Netflix subscription"). Leading it, it is part of a name ("Coffee Place", "Kopi Kenangan")
  // and is matched as written, plural stem aside.
  const termGroups = terms.map((term, idx) => (idx === terms.length - 1 ? expandKeyword(term) : [stemKeyword(term)]));

  // 1. Primary path: FTS5 requiring ALL terms (AND) with uncapped SQL COUNT/SUM.
  const matchQuery = termGroups.map((alts) => `(${alts.map((alt) => `"${alt}"*`).join(' OR ')})`).join(' AND ');
  const ftsParams = [matchQuery, ...tailParams];
  const ftsAggRows = safeQuery<KeywordAggregateSqlRow>(
    db,
    `SELECT ${aggregateSelect}
     FROM transactions_fts fts
     CROSS JOIN transactions t ON fts.rowid = t.id
     WHERE transactions_fts MATCH ?${dateClause}${walletClause}`,
    ftsParams,
  );

  let usedLike = false;
  let aggRow = ftsAggRows[0];
  let totalCount = Number(aggRow?.total_count ?? 0) || 0;

  let likeClause = '';
  let likeParams: string[] = [];

  // 2. Fallback path: LIKE ... ESCAPE '\' requiring ALL terms (AND) across merchant/note/items/category.
  if (totalCount === 0 && allowLikeFallback) {
    const likeAlt =
      "(t.merchant_name LIKE ? ESCAPE '\\' OR t.note LIKE ? ESCAPE '\\' OR t.line_items_text LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM transaction_items i WHERE i.transaction_id = t.id AND i.category LIKE ? ESCAPE '\\'))";
    likeClause = termGroups.map((alts) => `(${alts.map(() => likeAlt).join(' OR ')})`).join(' AND ');
    termGroups.flat().forEach((term) => {
      const pattern = `%${escapeLikePattern(term)}%`;
      likeParams.push(pattern, pattern, pattern, pattern);
    });

    const likeAggRows = safeQuery<KeywordAggregateSqlRow>(
      db,
      `SELECT ${aggregateSelect}
       FROM transactions t
       WHERE (${likeClause})${dateClause}${walletClause}`,
      [...likeParams, ...tailParams],
    );
    aggRow = likeAggRows[0];
    totalCount = Number(aggRow?.total_count ?? 0) || 0;
    usedLike = totalCount > 0;
  }

  if (totalCount === 0) {
    return empty;
  }

  const expenseCount = Number(aggRow?.expense_count ?? 0) || 0;
  let expenseSum = Number(aggRow?.expense_sum ?? 0) || 0;
  const incomeCount = Number(aggRow?.income_count ?? 0) || 0;
  let incomeSum = Number(aggRow?.income_sum ?? 0) || 0;
  const lineItemRowCount = Number(aggRow?.line_item_row_count ?? 0) || 0;

  // 3. Per-row line-item adjustment: when a keyword matched a line item inside a larger receipt
  // (rather than the merchant name itself), sum only the matched line-item prices for that row.
  let lineItemMatchedRows = 0;
  const nonTransferCount = expenseCount + incomeCount;
  if (lineItemRowCount > 0) {
    const candidateRows = usedLike
      ? safeQuery<LineItemCandidateRow>(
          db,
          `SELECT t.id, t.merchant_name, t.total_amount, t.type, t.line_items_text
           FROM transactions t
           WHERE (${likeClause})${dateClause}${walletClause}
             AND t.type != 'transfer'
             AND t.line_items_text IS NOT NULL AND TRIM(t.line_items_text) != ''`,
          [...likeParams, ...tailParams],
        )
      : safeQuery<LineItemCandidateRow>(
          db,
          `SELECT t.id, t.merchant_name, t.total_amount, t.type, t.line_items_text
           FROM transactions_fts fts
           CROSS JOIN transactions t ON fts.rowid = t.id
           WHERE transactions_fts MATCH ?${dateClause}${walletClause}
             AND t.type != 'transfer'
             AND t.line_items_text IS NOT NULL AND TRIM(t.line_items_text) != ''`,
          ftsParams,
        );

    const normalizedGroups = termGroups.map((alts) => alts.map((alt) => normalizeForMatch(alt)));
    const currencyCode = currentCurrencyCode();

    for (const row of candidateRows) {
      const merchantNorm = normalizeForMatch(row.merchant_name || '');
      const remainingGroups = normalizedGroups.filter((alts) => !alts.some((alt) => merchantNorm.includes(alt)));
      if (remainingGroups.length === 0) {
        // Merchant itself matched every search term; keep the full receipt total.
        continue;
      }

      const parsedItems = parseReceiptLineItemsText(row.line_items_text || '');
      let matchedItemSum = 0;
      let matchedItemCount = 0;
      for (const item of parsedItems) {
        const itemHay = normalizeForMatch(`${item.name} ${item.note}`);
        if (!remainingGroups.every((alts) => alts.some((alt) => itemHay.includes(alt)))) {
          continue;
        }
        const price = item.price.trim() ? Math.abs(parseSignedAmount(item.price.trim(), undefined, currencyCode)) : 0;
        if (Number.isFinite(price) && price > 0) {
          matchedItemSum += price;
          matchedItemCount += 1;
        }
      }

      if (matchedItemCount > 0 && matchedItemSum > 0) {
        if (row.total_amount < 0) {
          expenseSum = expenseSum - Math.abs(row.total_amount) + matchedItemSum;
        } else if (row.total_amount > 0) {
          incomeSum = incomeSum - row.total_amount + matchedItemSum;
        }
        lineItemMatchedRows += 1;
      }
    }
  }

  // 4. Fetch a small set of display rows (deduplicated via scalar category subquery).
  const sampleRows = usedLike
    ? safeQuery<MatchedTxRow>(
        db,
        `SELECT
           t.id AS transaction_id,
           t.merchant_name,
           t.total_amount,
           t.type,
           t.date,
           t.note,
           t.line_items_text,
           (SELECT i.category FROM transaction_items i WHERE i.transaction_id = t.id ORDER BY i.id ASC LIMIT 1) AS category
         FROM transactions t
         WHERE (${likeClause})${dateClause}${walletClause}
         ORDER BY t.date DESC, t.id DESC
         LIMIT ?`,
        [...likeParams, ...tailParams, sampleLimit],
      )
    : safeQuery<MatchedTxRow>(
        db,
        `SELECT
           t.id AS transaction_id,
           t.merchant_name,
           t.total_amount,
           t.type,
           t.date,
           t.note,
           t.line_items_text,
           (SELECT i.category FROM transaction_items i WHERE i.transaction_id = t.id ORDER BY i.id ASC LIMIT 1) AS category
         FROM transactions_fts fts
         CROSS JOIN transactions t ON fts.rowid = t.id
         WHERE transactions_fts MATCH ?${dateClause}${walletClause}
         ORDER BY fts.rank, t.date DESC, t.id DESC
         LIMIT ?`,
        [...ftsParams, sampleLimit],
      );

  return {
    totalCount,
    expenseCount,
    expenseSum,
    incomeCount,
    incomeSum,
    allMatchedViaLineItems: nonTransferCount > 0 && lineItemMatchedRows === nonTransferCount,
    sampleRows,
  };
}

export interface PlanningIntent {
  /** "save 20% of my income", "cut food in half": the share asked about, 0-1. */
  share: number | null;
  shareLabel: string | null;
  /** "how long to save 10 million": the goal amount. */
  goalAmount: number | null;
  /** "how many months of expenses could my savings cover", "dana darurat" */
  coverage: boolean;
  /** "make me a budget for next month" */
  plan: boolean;
  /** "how can I save more", "any tips", "cut back" */
  tips: boolean;
}

const WORD_SHARES: Array<[RegExp, number, string]> = [
  [/\b(?:half|separuh|setengah(?:nya)?)\b/i, 0.5, 'Half'],
  [/\b(?:quarter|seperempat)\b/i, 0.25, 'A quarter'],
  [/\b(?:a\s+third|sepertiga)\b/i, 1 / 3, 'A third'],
];

/** Amount named in a question: "10 million", "10 juta", "10jt", "Rp 10.000.000", "500k". */
export function parsePromptAmount(prompt: string): number | null {
  let best: number | null = null;
  for (const m of prompt.matchAll(/(\d+(?:[.,]\d+)*)\s*(juta|jt|million|mil|m|ribu|rb|k|thousand)?\b/gi)) {
    const raw = m[1];
    const scale = (m[2] ?? '').toLowerCase();
    let value = /^\d{1,3}(?:[.,]\d{3})+$/.test(raw) ? Number(raw.replace(/[.,]/g, '')) : Number(raw.replace(',', '.'));
    if (['juta', 'jt', 'million', 'mil', 'm'].includes(scale)) value *= 1_000_000;
    else if (['ribu', 'rb', 'k', 'thousand'].includes(scale)) value *= 1_000;
    const isYear = !scale && /^(?:19|20)\d{2}$/.test(raw);
    if (!isYear && Number.isFinite(value) && value >= 1000 && (best === null || value > best)) best = value;
  }
  return best;
}

/**
 * Advice and planning questions need numbers the small model gets wrong when it works them out itself
 * ("5.05 years" to save 10 million at Rp 1.970.500 a month, chat benchmark 2026-11-25), so retrieval computes them.
 */
export function detectPlanningIntent(prompt: string): PlanningIntent {
  const pct = prompt.match(/(\d{1,3}(?:[.,]\d+)?)\s*(?:%|percent|persen)/i);
  let share: number | null = null;
  let shareLabel: string | null = null;
  if (pct) {
    const value = Number(pct[1].replace(',', '.'));
    if (value > 0 && value <= 100) {
      share = value / 100;
      shareLabel = `${pct[1]}%`;
    }
  } else {
    const word = WORD_SHARES.find(([re]) => re.test(prompt));
    if (word) {
      share = word[1];
      shareLabel = word[2];
    }
  }
  const asksDuration = /\b(?:how\s+long|how\s+many\s+(?:months|weeks|years)|when\s+(?:can|will|could)\s+i|berapa\s+lama|kapan)\b/i.test(prompt);
  const goalAmount =
    asksDuration && /\b(?:save|saving|reach|collect|afford|buy|nabung|menabung|tabung|kumpul\w*|beli)\b/i.test(prompt)
      ? parsePromptAmount(prompt)
      : null;
  const coverage =
    /\b(?:emergency(?:\s+fund)?|months?\s+of\s+(?:expenses|spending|living)|(?:savings|money|balance)\s+(?:could\s+|would\s+|will\s+)?(?:cover|last)|dana\s+darurat|bertahan\s+berapa)\b/i.test(
      prompt,
    );
  const plan =
    /\b(?:make|create|plan|build|suggest|set\s+up|draft|buat\w*|bikin\w*|susun\w*|rencana\w*)\b[^?.!]*\b(?:budget|anggaran|spending\s+plan)\b|\bbudget\s+(?:for|plan)\s+next\b|\banggaran\s+bulan\s+depan\b/i.test(
      prompt,
    );
  const tips =
    /\b(?:tips?|advice|advise|suggest\w*|recommend\w*|how\s+(?:can|do|should)\s+i\s+(?:save|spend\s+less|cut|reduce|stop)|save\s+more|spend\s+less|cut\s+back|reduce|overspend\w*|hemat|nabung|menabung|saran|caranya|gimana\s+cara)\b/i.test(
      prompt,
    );
  return { share, shareLabel, goalAmount, coverage, plan, tips };
}

export function buildRetrievedContext(
  userPrompt: string,
  options?: BuildRetrievedContextOptions,
): RetrievedContextItem[] {
  const db = options?.db ?? expoDb;
  const now = options?.now instanceof Date ? options.now : new Date(options?.now ?? Date.now());
  const basicWallets = loadWalletsBasic(db);
  const userCategories = loadUserCategories(db);
  const monthStartDay = options?.monthStartDay ?? currentMonthStartDay();
  userPrompt = resolveFollowUpPrompt(userPrompt, options?.previousUserPrompts);
  const parsed = parseGroundedQuery(userPrompt, {
    db,
    now,
    categories: userCategories,
    wallets: basicWallets,
    monthStartDay,
  });

  const { period, account } = parsed;
  const walletFilterSql = account !== null ? ' AND wallet_id = ?' : '';
  const walletFilterJoinSql = account !== null ? ' AND t.wallet_id = ?' : '';
  const periodParams: any[] = account !== null ? [period.fromMs, period.toMs, account.id] : [period.fromMs, period.toMs];
  const refYear = now.getFullYear();

  const hasCategoryIntent = parsed.categories.length > 0;
  const hasKeywordIntent = parsed.keywords.length > 0;
  const hasSpecificIntent =
    parsed.asksBalance ||
    parsed.asksBudget ||
    hasCategoryIntent ||
    parsed.asksBiggest ||
    hasKeywordIntent ||
    parsed.wantsRecent ||
    parsed.asksIncomeVsSpending ||
    parsed.asksTopCategories ||
    parsed.asksTopMerchants;

  const asksExplicitOverview =
    /\b(summary|overview|report|ringkasan|total\s+(?:spend|spent|spending|expense|expenses|pengeluaran)|overall\s+(?:spend|spent|spending|expense|expenses))\b/i.test(
      userPrompt,
    );
  const asksUnscopedSpending =
    !hasCategoryIntent &&
    !hasKeywordIntent &&
    !parsed.asksBiggest &&
    !parsed.wantsRecent &&
    /\b(spend|spent|spending|expense|expenses|pengeluaran|dihabiskan|dikeluarkan)\b/i.test(userPrompt);

  let includeSummary =
    !hasSpecificIntent ||
    parsed.asksIncomeVsSpending ||
    parsed.asksFinancialHealth ||
    parsed.asksAverage ||
    asksExplicitOverview ||
    asksUnscopedSpending;
  let includeTopCategories =
    parsed.asksTopCategories ||
    parsed.asksIncomeVsSpending ||
    parsed.asksFinancialHealth ||
    asksExplicitOverview ||
    (!hasSpecificIntent && !asksUnscopedSpending);
  const planning = detectPlanningIntent(userPrompt);
  const asksPlanning = planning.share !== null || planning.goalAmount !== null || planning.coverage || planning.plan || planning.tips;
  if (asksPlanning) {
    includeSummary = includeSummary || !hasCategoryIntent || planning.plan;
    includeTopCategories = includeTopCategories || planning.plan || (planning.tips && !hasCategoryIntent);
  }
  const includeBiggest = parsed.asksBiggest;
  // A plan or tips about a named category ("overspending on shopping") need the budgets too.
  const includeBudgets = parsed.asksBudget || planning.plan || (planning.tips && hasCategoryIntent);
  const includeBalance = parsed.asksBalance || parsed.asksFinancialHealth || planning.coverage;
  const comparePeriod = parsed.comparePeriod;
  const includeRecent = parsed.wantsRecent;

  // Filter recent rows by parsed.categories unless the prompt has a separate unmodified recent-list clause
  // (e.g. "how much did I spend on food, and show my recent transactions").
  const hasUnmodifiedRecentClause =
    /\b(?:and|,|dan)\s+(?:show|list|tampilkan|tunjukkan|lihat)\s+(?:me\s+)?(?:my\s+)?(?:all\s+|semua\s+)?(?:recent|latest|terbaru|terakhir)?\s*(?:transactions?|transaksi)\b/i.test(
      userPrompt,
    );
  const filterRecentByCategories = hasCategoryIntent && !hasUnmodifiedRecentClause;

  // If the user asked purely about a named category's remaining budget (e.g. "Berapa sisa anggaran makan?"),
  // the matching budget row already carries spent + limit + remaining; only also emit category-spending if
  // the user asked about spending/merchants or if no budget exists for that category.
  const isPureCategoryBudgetQuestion =
    hasCategoryIntent &&
    parsed.asksBudget &&
    !parsed.wantsRecent &&
    !parsed.asksBiggest &&
    !/\b(spend|spent|spending|expense|expenses|pengeluaran|merchant|top|terbanyak|terbesar)\b/i.test(userPrompt);

  const items: RetrievedContextItem[] = [];
  const budgetLimitByCategory = new Map<string, number>();
  let topCategoryTotals: Array<{ category: string; total: number }> = [];

  // 1. Budgets (queried first when asked so pure category-budget queries know if a matching budget exists)
  let matchedAllNamedCategoryBudgets = false;
  const budgetItems: RetrievedContextItem[] = [];
  if (includeBudgets) {
    const usePeriodForBudgets =
      period.kind === 'this-month' || period.kind === 'last-month' || period.kind === 'named-month';
    const currentBillingMonth = billingMonthPeriod('this-month', now, monthStartDay);
    const budgetFromMs = usePeriodForBudgets ? period.fromMs : currentBillingMonth.fromMs;
    const budgetToMs = usePeriodForBudgets ? period.toMs : currentBillingMonth.toMs;
    const budgetPeriodLabel = usePeriodForBudgets ? period.label : currentBillingMonth.label;

    // General budgets (features/budgets/engine.ts): status for the period containing the asked-about date.
    const budgetAt = usePeriodForBudgets ? budgetToMs - 1 : now.getTime();
    const homeCode = currentCurrencyCode();
    const budgetRows = readGroundedBudgetPlans(db)
      .filter((plan) => account === null || plan.walletIds.length === 0 || plan.walletIds.includes(account.id))
      .map((plan) => {
        try {
          const status = computeBudgetStatus(
            db as unknown as BudgetDb,
            plan,
            homeCode,
            budgetAt,
            (code) => getCachedRate(code, homeCode)?.rate ?? null,
          );
          if (status.ended && plan.kind === 'once' && budgetAt >= status.periodEnd) return null;
          return {
            category: plan.name,
            categories: plan.categories,
            currency: status.currency,
            limit_amount: status.available,
            spent: status.spent,
          };
        } catch {
          return null;
        }
      })
      .filter((row): row is NonNullable<typeof row> => row !== null && row.limit_amount > 0);
    budgetRows.forEach((row) => {
      if (row.categories.length === 1) budgetLimitByCategory.set(row.categories[0].toLowerCase(), row.limit_amount);
    });

    if (budgetRows.length > 0) {
      const namedCatSet = new Set(parsed.categories.map((c) => c.name.toLowerCase()));
      const matchingCategoryBudgets =
        namedCatSet.size > 0
          ? budgetRows.filter(
              (row) =>
                (row.category && namedCatSet.has(row.category.toLowerCase())) ||
                row.categories.some((c) => namedCatSet.has(c.toLowerCase())),
            )
          : [];
      matchedAllNamedCategoryBudgets =
        namedCatSet.size > 0 && matchingCategoryBudgets.length === namedCatSet.size;

      // Scope to named category budgets when matching budgets exist; otherwise show all configured budgets.
      const rowsToEmit = matchingCategoryBudgets.length > 0 ? matchingCategoryBudgets : budgetRows;

      const formatBudgetRow = (row: { category?: string; currency?: string; limit_amount?: number | null; spent?: number | null }) => {
        const limit = Number(row.limit_amount ?? 0) || 0;
        const spent = Number(row.spent ?? 0) || 0;
        const remaining = limit - spent;
        const fmt = (n: number) =>
          row.currency && row.currency !== currentCurrencyCode()
            ? formatDisplayCurrency(n, row.currency)
            : formatCurrency(n);
        // What is left comes first: the 0.8B model read "over by" as a surplus and the limit as what remains
        // (chat benchmark 2026-11-25).
        const remText =
          remaining >= 0 ? `${fmt(remaining)} left` : `nothing left, OVER budget by ${fmt(Math.abs(remaining))}`;
        return `${row.category}: ${remText} (limit ${fmt(limit)}, spent ${fmt(spent)})`;
      };

      const accountPart = account ? `, Account: ${account.name}` : '';
      if (rowsToEmit.length === 1) {
        // "Can I still take Grab rides without blowing my transport budget?" got "Yes" with Transport over budget
        // once advice answers stopped refusing (chat benchmark 2026-11-25): spell the verdict out.
        const only = rowsToEmit[0];
        const onlyOver = (Number(only.spent ?? 0) || 0) - (Number(only.limit_amount ?? 0) || 0);
        if (onlyOver > 0 && /\b(?:can|could|still|afford|enough|without|blow\w*|bisa|masih|cukup|boleh)\b/i.test(userPrompt)) {
          budgetItems.push({
            id: 'budgets-verdict',
            kind: 'budget',
            label: 'Budget left?',
            content: `Answer: No (Tidak), ${only.category} is already OVER budget by ${formatCurrency(onlyOver)}; nothing is left to spend.`,
            score: 956,
          });
        }
        budgetItems.push({
          id: 'budgets-summary',
          kind: 'budget',
          label: 'Budgets',
          content: `Budgets (${budgetPeriodLabel}${accountPart}): ${formatBudgetRow(rowsToEmit[0])}`,
          score: 955,
        });
      } else {
        const sumLimit = rowsToEmit.reduce((s, r) => s + (Number(r.limit_amount ?? 0) || 0), 0);
        const sumSpent = rowsToEmit.reduce((s, r) => s + (Number(r.spent ?? 0) || 0), 0);
        const sumRem = sumLimit - sumSpent;
        const sumRemText =
          sumRem >= 0 ? `${formatCurrency(sumRem)} left` : `OVER budget by ${formatCurrency(Math.abs(sumRem))}`;

        // Name the over-budget ones outright; the 0.8B model otherwise picked the wrong one (chat benchmark).
        const overRows = rowsToEmit.filter((r) => (Number(r.spent ?? 0) || 0) > (Number(r.limit_amount ?? 0) || 0));
        const withinRows = rowsToEmit.filter((r) => !overRows.includes(r));
        const overPart =
          overRows.length > 0
            ? ` OVER budget (melebihi anggaran): ${overRows.map((r) => r.category).join(', ')}.${withinRows.length > 0 ? ` Within budget: ${withinRows.map((r) => r.category).join(', ')}.` : ''}`
            : ' None over budget (tidak ada yang melebihi anggaran).';
        // A yes/no "am I over budget?" gets its answer spelled out: in Indonesian the 0.8B model echoed the question
        // ("Tidak ada anggaran yang kelewatan") despite the OVER line (chat benchmark 2026-11-25).
        if (/\b(?:over|exceed\w*|overbudget|kelewat\w*|melebihi|melewati|lewat|jebol|kelebihan|boros)\b/i.test(userPrompt)) {
          budgetItems.push({
            id: 'budgets-verdict',
            kind: 'budget',
            label: 'Over budget?',
            content:
              overRows.length > 0
                ? `Answer: Yes (Ya), over budget on ${overRows.map((r) => r.category).join(' and ')}.`
                : 'Answer: No (Tidak), every budget is within its limit.',
            score: 956,
          });
        }
        budgetItems.push({
          id: 'budgets-summary',
          kind: 'budget',
          label: 'Budgets',
          // Verdict first: led by "all budgets together Rp 1.129.000 left", the model answered "not over budget"
          // while Bills was over (emulator check of 1.3.6, 2026-11-25).
          content: `Budgets (${budgetPeriodLabel}${accountPart}):${overPart} All budgets together: ${sumRemText} (limit ${formatCurrency(sumLimit)}, spent ${formatCurrency(sumSpent)}).`,
          score: 955,
        });
        rowsToEmit.forEach((row, idx) => {
          budgetItems.push({
            id: `budget-${(row.category || String(idx)).toLowerCase()}`,
            kind: 'budget',
            label: row.category || 'Budget',
            content: `- ${formatBudgetRow(row)}`,
            score: 948 - idx,
          });
        });
      }
    } else {
      budgetItems.push({
        id: 'budgets-none',
        kind: 'budget',
        label: 'Budgets',
        content: `Budgets: 0 budgets configured for ${budgetPeriodLabel} (you have not set up any budgets yet).`,
        score: 955,
      });
    }
  }

  const includeCategories = hasCategoryIntent && !(isPureCategoryBudgetQuestion && matchedAllNamedCategoryBudgets);

  // 2. Named category breakdown (only when categories were asked)
  const categoryItems: RetrievedContextItem[] = [];
  const categoryTotalsByName = new Map<string, number>();
  const opportunisticKeywords: string[] = [];
  if (includeCategories) {
    for (const catMatch of parsed.categories) {
      const amountCondition = catMatch.type === 'income' ? 't.total_amount > 0' : 't.total_amount < 0';
      const catParams: any[] =
        account !== null
          ? [catMatch.name, period.fromMs, period.toMs, account.id]
          : [catMatch.name, period.fromMs, period.toMs];

      const catSumRows = safeQuery<{ total?: number | null; count?: number | null }>(
        db,
        `SELECT
           COALESCE(SUM(CASE WHEN i.id IS NOT NULL AND i.amount > 0 THEN i.amount ELSE ABS(t.total_amount) END), 0) AS total,
           COUNT(DISTINCT t.id) AS count
         FROM transactions t
         JOIN transaction_items i ON t.id = i.transaction_id
         WHERE t.type != 'transfer' AND ${amountCondition}
           AND LOWER(i.category) = LOWER(?)
           AND t.date >= ? AND t.date < ?${walletFilterJoinSql}`,
        catParams,
      );
      const catTotal = Number(catSumRows[0]?.total ?? 0) || 0;
      categoryTotalsByName.set(catMatch.name, catTotal);
      const catCount = Number(catSumRows[0]?.count ?? 0) || 0;

      let merchantsSuffix = '';
      if (catCount > 0 && !(includeRecent && filterRecentByCategories)) {
        const topMerchants = safeQuery<{ merchant_name?: string; total?: number | null }>(
          db,
          `SELECT
             t.merchant_name,
             COALESCE(SUM(CASE WHEN i.id IS NOT NULL AND i.amount > 0 THEN i.amount ELSE ABS(t.total_amount) END), 0) AS total
           FROM transactions t
           JOIN transaction_items i ON t.id = i.transaction_id
           WHERE t.type != 'transfer' AND ${amountCondition}
             AND LOWER(i.category) = LOWER(?)
             AND t.date >= ? AND t.date < ?${walletFilterJoinSql}
           GROUP BY t.merchant_name
           ORDER BY total DESC
           LIMIT 3`,
          catParams,
        );
        const merchantList = topMerchants
          .filter((row) => row.merchant_name)
          .map((row) => `${row.merchant_name} ${formatCurrency(row.total ?? 0)}`)
          .join(', ');
        if (merchantList) {
          merchantsSuffix = `; top: ${merchantList}`;
        }
      }

      if (
        catMatch.matchedViaSynonym &&
        catMatch.triggerTerm.length >= 3 &&
        !BROAD_CATEGORY_SYNONYMS.has(catMatch.triggerTerm.toLowerCase())
      ) {
        opportunisticKeywords.push(catMatch.triggerTerm);
      }

      const actionWord = catMatch.type === 'income' ? 'income' : 'spent';
      const txnWord = catCount === 1 ? 'txn' : 'txns';
      const periodPart = comparePeriod ? ` in ${period.label}` : '';
      categoryItems.push({
        id: `category-${catMatch.name.toLowerCase()}`,
        kind: 'category-spending',
        label: `${catMatch.name} ${actionWord}`,
        content: `Category ${catMatch.name}${periodPart}: ${formatCurrency(catTotal)} ${actionWord} (${catCount} ${txnWord}${merchantsSuffix})`,
        score: 950,
      });

      if (comparePeriod) {
        const prevParams: any[] =
          account !== null
            ? [catMatch.name, comparePeriod.fromMs, comparePeriod.toMs, account.id]
            : [catMatch.name, comparePeriod.fromMs, comparePeriod.toMs];
        const prevRows = safeQuery<{ total?: number | null; count?: number | null }>(
          db,
          `SELECT
             COALESCE(SUM(CASE WHEN i.id IS NOT NULL AND i.amount > 0 THEN i.amount ELSE ABS(t.total_amount) END), 0) AS total,
             COUNT(DISTINCT t.id) AS count
           FROM transactions t
           JOIN transaction_items i ON t.id = i.transaction_id
           WHERE t.type != 'transfer' AND ${amountCondition}
             AND LOWER(i.category) = LOWER(?)
             AND t.date >= ? AND t.date < ?${walletFilterJoinSql}`,
          prevParams,
        );
        const prevTotal = Number(prevRows[0]?.total ?? 0) || 0;
        const prevCount = Number(prevRows[0]?.count ?? 0) || 0;
        categoryItems.push({
          id: `category-${catMatch.name.toLowerCase()}-compare`,
          kind: 'category-spending',
          label: `${catMatch.name} ${actionWord} (${comparePeriod.label})`,
          content: `Category ${catMatch.name} in ${comparePeriod.label}: ${formatCurrency(prevTotal)} ${actionWord} (${prevCount} ${prevCount === 1 ? 'txn' : 'txns'}); ${describeChange(catTotal, prevTotal, period.label, comparePeriod.label)}`,
          score: 949,
        });
      }
    }
  }

  // 3. Keyword / Merchant matches (FTS AND + LIKE ESCAPE AND, uncapped SQL COUNT/SUM)
  const searchTerms = hasKeywordIntent ? parsed.keywords : Array.from(new Set(opportunisticKeywords));
  const keywordItems: RetrievedContextItem[] = [];
  let keywordMatchedInPeriod = false;

  if (searchTerms.length > 0) {
    const sampleLimit = parsed.wantsRecent ? QWEN_MODEL_RETRIEVAL_ITEM_LIMIT : 3;
    const kwOptions = { sampleLimit, allowLikeFallback: hasKeywordIntent };
    let matchResult = queryKeywordMatches(
      db,
      searchTerms,
      { fromMs: period.fromMs, toMs: period.toMs },
      account?.id ?? null,
      kwOptions,
    );
    let outsidePeriod = false;

    if (matchResult.totalCount === 0 && !period.isExplicit) {
      matchResult = queryKeywordMatches(db, searchTerms, null, account?.id ?? null, kwOptions);
      outsidePeriod = matchResult.totalCount > 0;
    }

    const kwLabel = searchTerms.join(' ');
    const accountPart = account ? ` in ${account.name}` : '';
    if (matchResult.totalCount > 0) {
      keywordMatchedInPeriod = !outsidePeriod;

      let sumPart = '';
      if (matchResult.allMatchedViaLineItems) {
        const itemTotal =
          matchResult.expenseCount > 0 && matchResult.incomeCount === 0
            ? matchResult.expenseSum
            : matchResult.incomeCount > 0 && matchResult.expenseCount === 0
              ? matchResult.incomeSum
              : 0;
        if (itemTotal > 0) {
          sumPart = `, matched item total ${formatCurrency(itemTotal)}`;
        }
      } else if (matchResult.expenseCount > 0 && matchResult.incomeCount === 0) {
        sumPart = `, total spent ${formatCurrency(matchResult.expenseSum)}`;
      } else if (matchResult.incomeCount > 0 && matchResult.expenseCount === 0) {
        sumPart = `, total income ${formatCurrency(matchResult.incomeSum)}`;
      } else if (matchResult.incomeCount > 0 && matchResult.expenseCount > 0) {
        // "coffee" finds Kopi Kenangan purchases and also a "Kopi Senja" client payment: give both totals.
        sumPart = `, total spent ${formatCurrency(matchResult.expenseSum)} in ${matchResult.expenseCount} ${matchResult.expenseCount === 1 ? 'expense' : 'expenses'}, income ${formatCurrency(matchResult.incomeSum)} in ${matchResult.incomeCount}`;
      }

      const scopePart = outsidePeriod ? ', outside current month' : '';
      const subsetPart =
        matchResult.totalCount > matchResult.sampleRows.length ? `; latest ${matchResult.sampleRows.length}` : '';
      const txnWord = matchResult.totalCount === 1 ? 'txn' : 'txns';

      keywordItems.push({
        id: 'kw-summary',
        kind: 'keyword-match',
        label: `Matches for ${kwLabel}`,
        content: `Matching "${kwLabel}" (${matchResult.totalCount} ${txnWord}${sumPart}${scopePart}${subsetPart}):`,
        score: 940,
      });

      matchResult.sampleRows.forEach((row, idx) => {
        keywordItems.push({
          id: `kw-tx-${row.transaction_id}`,
          kind: 'keyword-match',
          label: row.merchant_name || 'Match',
          content: `- ${formatTransactionLine(row, searchTerms, true, refYear)}`,
          score: 935 - idx * 10,
        });
      });
    } else if (hasKeywordIntent) {
      const periodPart = period.isExplicit ? ` in ${period.label}` : '';
      keywordItems.push({
        id: 'kw-none',
        kind: 'keyword-match',
        label: `Matches for ${kwLabel}`,
        content: `Matching "${kwLabel}": No matching transactions found${periodPart}${accountPart}.`,
        score: 940,
      });
    }
  }

  // A vague question ("how am I doing?") can leave only a stray word to search for. When it matches
  // nothing, also give the period overview, so the model never sees just a "no matches" line and
  // invents a reason it cannot reach the data (reported 2026-11-23: "unable to access ... network error").
  const keywordOnlyIntent =
    hasKeywordIntent &&
    !parsed.asksBalance &&
    !parsed.asksBudget &&
    !hasCategoryIntent &&
    !parsed.asksBiggest &&
    !parsed.wantsRecent &&
    !parsed.asksIncomeVsSpending &&
    !parsed.asksTopCategories;
  // A clear money question ("what did I buy at X?") keeps its compact "no matches" answer.
  const namesMoneyAction =
    /\b(spend|spent|spending|buy|bought|pay|paid|cost|costs|earn|earned|receive|received|beli|bayar|belanja|habis)\b/i.test(userPrompt);
  if (keywordOnlyIntent && !namesMoneyAction && keywordItems.every((item) => item.id === 'kw-none')) {
    includeSummary = true;
    includeTopCategories = true;
  }

  // Emit Period header only when period-scoped facts need it (skip redundant Period line for
  // all-time balance-only, self-labeled budget-only, implicit recent-only, or zero-match keyword-only).
  const needsPeriodHeader =
    includeSummary ||
    includeTopCategories ||
    includeBiggest ||
    includeCategories ||
    keywordMatchedInPeriod ||
    (includeRecent && period.isExplicit);

  if (needsPeriodHeader) {
    const accountSuffix = account ? `, Account: ${account.name}` : '';
    items.push({
      id: 'period',
      kind: 'period',
      label: 'Period',
      content: `Period: ${period.label}${accountSuffix}`,
      score: 1000,
    });
  }

  // 4. Period summary (only when asked: spending overview, income vs spending, or generic question)
  if (includeSummary) {
    const summaryRows = safeQuery<{
      total_spent?: number | null;
      total_income?: number | null;
      tx_count?: number | null;
    }>(
      db,
      `SELECT
         COALESCE(SUM(CASE WHEN total_amount < 0 THEN ABS(total_amount) ELSE 0 END), 0) AS total_spent,
         COALESCE(SUM(CASE WHEN total_amount > 0 THEN total_amount ELSE 0 END), 0) AS total_income,
         COUNT(*) AS tx_count
       FROM transactions
       WHERE type != 'transfer' AND date >= ? AND date < ?${walletFilterSql}`,
      periodParams,
    );
    const totalSpent = Number(summaryRows[0]?.total_spent ?? 0) || 0;
    const totalIncome = Number(summaryRows[0]?.total_income ?? 0) || 0;
    const txCount = Number(summaryRows[0]?.tx_count ?? 0) || 0;
    const net = totalIncome - totalSpent;
    const netWord = net > 0 ? ' saved' : net < 0 ? ' overspent' : '';
    const elapsedDays = Math.max(1, Math.ceil((Math.min(now.getTime(), period.toMs) - period.fromMs) / 86_400_000));
    const averagePart =
      parsed.asksAverage && totalSpent > 0
        ? `, average spent per day ${formatCurrency(Math.round(totalSpent / elapsedDays))} over ${elapsedDays} ${elapsedDays === 1 ? 'day' : 'days'}`
        : '';
    const summaryLabel = comparePeriod ? `Summary ${period.label}` : 'Summary';

    items.push(
      txCount === 0
        ? {
            id: 'period-summary',
            kind: 'summary',
            label: 'Period summary',
            content: `Summary: No transactions in this period (Spent ${formatCurrency(0)}, Income ${formatCurrency(0)}, Net ${formatCurrency(0)})`,
            score: parsed.asksIncomeVsSpending ? 945 : 900,
          }
        : {
            id: 'period-summary',
            kind: 'summary',
            label: 'Period summary',
            content: `${summaryLabel}: Spent ${formatCurrency(totalSpent)}, Income ${formatCurrency(totalIncome)}, Net ${formatSignedCurrency(net)}${netWord} (${txCount} ${txCount === 1 ? 'txn' : 'txns'}${averagePart})`,
            score: parsed.asksIncomeVsSpending ? 945 : 900,
          },
    );

    if (comparePeriod) {
      const prevRows = safeQuery<{ total_spent?: number | null; total_income?: number | null; tx_count?: number | null }>(
        db,
        `SELECT
           COALESCE(SUM(CASE WHEN total_amount < 0 THEN ABS(total_amount) ELSE 0 END), 0) AS total_spent,
           COALESCE(SUM(CASE WHEN total_amount > 0 THEN total_amount ELSE 0 END), 0) AS total_income,
           COUNT(*) AS tx_count
         FROM transactions
         WHERE type != 'transfer' AND date >= ? AND date < ?${walletFilterSql}`,
        account !== null ? [comparePeriod.fromMs, comparePeriod.toMs, account.id] : [comparePeriod.fromMs, comparePeriod.toMs],
      );
      const prevSpent = Number(prevRows[0]?.total_spent ?? 0) || 0;
      const prevIncome = Number(prevRows[0]?.total_income ?? 0) || 0;
      const prevCount = Number(prevRows[0]?.tx_count ?? 0) || 0;
      items.push({
        id: 'period-summary-compare',
        kind: 'summary',
        label: `Summary ${comparePeriod.label}`,
        content: `Summary ${comparePeriod.label}: Spent ${formatCurrency(prevSpent)}, Income ${formatCurrency(prevIncome)}, Net ${formatSignedCurrency(prevIncome - prevSpent)} (${prevCount} ${prevCount === 1 ? 'txn' : 'txns'})`,
        score: 944,
      });
      items.push({
        id: 'period-change',
        kind: 'summary',
        label: 'Spending change',
        content: `Spending: ${describeChange(totalSpent, prevSpent, period.label, comparePeriod.label)}`,
        score: 943,
      });
    }
  }

  // 5. Top 3 spending categories (only when income-vs-spending, top-categories, overview, or generic)
  if (includeTopCategories) {
    const topCategoryRows = safeQuery<{ category?: string; total?: number | null; count?: number | null }>(
      db,
      `SELECT
         COALESCE(NULLIF(TRIM(i.category), ''), 'Uncategorized') AS category,
         COALESCE(SUM(CASE WHEN i.id IS NOT NULL AND i.amount > 0 THEN i.amount ELSE ABS(t.total_amount) END), 0) AS total,
         COUNT(DISTINCT t.id) AS count
       FROM transactions t
       LEFT JOIN transaction_items i ON t.id = i.transaction_id
       WHERE t.type != 'transfer' AND t.total_amount < 0 AND t.date >= ? AND t.date < ?${walletFilterJoinSql}
       GROUP BY COALESCE(NULLIF(TRIM(i.category), ''), 'Uncategorized')
       ORDER BY total DESC
       LIMIT ${planning.plan ? 6 : 3}`,
      periodParams,
    );
    topCategoryTotals = topCategoryRows.map((row) => ({ category: row.category ?? 'Uncategorized', total: Number(row.total ?? 0) || 0 }));
    if (topCategoryRows.length > 0) {
      const topStr = topCategoryRows
        .map((row, idx) => `${idx + 1}. ${row.category} ${formatCurrency(row.total ?? 0)}`)
        .join(', ');
      const first = topCategoryRows[0];
      const leadPart = parsed.asksTopCategories
        ? `Most spent category: ${first.category} ${formatCurrency(first.total ?? 0)}. `
        : '';
      items.push({
        id: 'top-categories',
        kind: 'top-categories',
        label: 'Top categories',
        content: `${leadPart}Top spending categories: ${topStr}`,
        score: parsed.asksTopCategories ? 945 : 840,
      });
    }
  }

  // 5b. Top merchants (only when asked: "which store did I spend the most at?")
  if (parsed.asksTopMerchants) {
    const merchantRows = safeQuery<{ merchant_name?: string; total?: number | null; count?: number | null }>(
      db,
      `SELECT t.merchant_name, SUM(ABS(t.total_amount)) AS total, COUNT(*) AS count
       FROM transactions t
       WHERE t.type != 'transfer' AND t.total_amount < 0 AND t.date >= ? AND t.date < ?${walletFilterJoinSql}
       GROUP BY t.merchant_name
       ORDER BY total DESC
       LIMIT 3`,
      periodParams,
    );
    items.push({
      id: 'top-merchants',
      kind: 'top-categories',
      label: 'Top merchants',
      content:
        merchantRows.length > 0
          ? `Top merchants by spending: ${merchantRows
              .map((row, idx) => `${idx + 1}. ${row.merchant_name} ${formatCurrency(row.total ?? 0)} (${row.count} ${row.count === 1 ? 'txn' : 'txns'})`)
              .join(', ')}`
          : 'Top merchants by spending: none in this period.',
      score: 946,
    });
  }

  // 5c. Worked-out numbers for advice and planning questions (detectPlanningIntent).
  if (planning.share !== null || planning.goalAmount !== null || planning.coverage || planning.plan) {
    const totalsRows = safeQuery<{ spent?: number | null; income?: number | null }>(
      db,
      `SELECT
         COALESCE(SUM(CASE WHEN total_amount < 0 THEN ABS(total_amount) ELSE 0 END), 0) AS spent,
         COALESCE(SUM(CASE WHEN total_amount > 0 THEN total_amount ELSE 0 END), 0) AS income
       FROM transactions
       WHERE type != 'transfer' AND date >= ? AND date < ?${walletFilterSql}`,
      periodParams,
    );
    const spentTotal = Number(totalsRows[0]?.spent ?? 0) || 0;
    const incomeTotal = Number(totalsRows[0]?.income ?? 0) || 0;
    const netTotal = incomeTotal - spentTotal;
    const lines: string[] = [];

    if (planning.share !== null && planning.shareLabel) {
      const named = parsed.categories.find((c) => c.type === 'expense' && categoryTotalsByName.has(c.name));
      if (named) {
        const base = categoryTotalsByName.get(named.name) ?? 0;
        const part = Math.round(base * planning.share);
        lines.push(
          `${planning.shareLabel} of ${named.name} spending (${formatCurrency(base)}) is ${formatCurrency(part)}, so cutting ${planning.shareLabel.toLowerCase()} of it saves ${formatCurrency(part)} a month.`,
        );
      } else if (incomeTotal > 0) {
        const target = Math.round(incomeTotal * planning.share);
        const savedPct = ((netTotal / incomeTotal) * 100).toFixed(1);
        const gap = target - netTotal;
        lines.push(
          `${planning.shareLabel} of income (${formatCurrency(incomeTotal)}) is ${formatCurrency(target)}. Saved so far: ${formatCurrency(netTotal)} (${savedPct}% of income). ` +
            (gap > 0
              ? `To save ${planning.shareLabel}, spend ${formatCurrency(gap)} less.`
              : `That already meets ${planning.shareLabel}, with ${formatCurrency(-gap)} to spare.`),
        );
      }
    }

    if (planning.goalAmount !== null) {
      lines.push(
        netTotal > 0
          ? `Saving ${formatCurrency(planning.goalAmount)} at ${formatCurrency(netTotal)} saved per month takes about ${(planning.goalAmount / netTotal).toFixed(1)} months.`
          : `Saving ${formatCurrency(planning.goalAmount)}: nothing was saved this period (net ${formatSignedCurrency(netTotal)}), so it is not reachable at this rate.`,
      );
    }

    if (planning.coverage && spentTotal > 0) {
      const wallets = loadWalletsWithBalances(db);
      const balance = wallets.length > 0 ? wallets.reduce((sum, w) => sum + w.balance, 0) : getTotalBalance(db);
      lines.push(
        `Total balance ${formatCurrency(balance)} covers about ${(balance / spentTotal).toFixed(1)} months of spending at ${formatCurrency(spentTotal)} a month.`,
      );
    }

    if (planning.plan && topCategoryTotals.length > 0) {
      // This period's spending per category, rounded to Rp 50.000, with over-budget ones cut to their limit.
      const round = (n: number) => Math.max(50_000, Math.round(n / 50_000) * 50_000);
      const planRows = topCategoryTotals.map(({ category, total }) => {
        const limit = budgetLimitByCategory.get(category.toLowerCase());
        const capped = limit !== undefined && total > limit;
        return { category, amount: capped ? limit : round(total), capped };
      });
      const planTotal = planRows.reduce((sum, row) => sum + row.amount, 0);
      const left = incomeTotal - planTotal;
      lines.push(
        `Suggested budget for next month (this month's spending, over-budget ones cut to their limit): ` +
          planRows.map((row) => `${row.category} ${formatCurrency(row.amount)}${row.capped ? ' (cut to its budget)' : ''}`).join(', ') +
          `. Total ${formatCurrency(planTotal)}` +
          (incomeTotal > 0 ? `, leaving ${formatCurrency(left)} of ${formatCurrency(incomeTotal)} income for savings and other costs.` : '.'),
      );
    }

    if (lines.length > 0) {
      items.push({ id: 'planning', kind: 'summary', label: 'Worked out', content: `Worked out (use these numbers as the answer): ${lines.join(' ')}`, score: 958 });
    }
  }

  // 6. Biggest single expense (only when asked)
  if (includeBiggest) {
    const biggestRows = safeQuery<{
      merchant_name?: string;
      amount?: number | null;
      date?: number | null;
      category?: string | null;
    }>(
      db,
      `SELECT
         t.merchant_name,
         ABS(t.total_amount) AS amount,
         t.date,
         (SELECT i.category FROM transaction_items i WHERE i.transaction_id = t.id ORDER BY i.amount DESC, i.id ASC LIMIT 1) AS category
       FROM transactions t
       WHERE t.type != 'transfer' AND t.total_amount < 0 AND t.date >= ? AND t.date < ?${walletFilterJoinSql}
       ORDER BY t.total_amount ASC, t.date DESC
       LIMIT 1`,
      periodParams,
    );
    const biggest = biggestRows[0];
    if (biggest && biggest.merchant_name && typeof biggest.amount === 'number' && biggest.amount > 0) {
      const datePart = typeof biggest.date === 'number' ? formatShortDate(biggest.date, refYear) : '';
      const categoryPart = biggest.category?.trim() ? `, category ${biggest.category.trim()}` : '';
      items.push({
        id: 'biggest-expense',
        kind: 'biggest-expense',
        label: 'Biggest expense',
        content: `Biggest expense: ${biggest.merchant_name} ${formatCurrency(biggest.amount)} (${datePart}${categoryPart})`,
        score: 950,
      });
    } else {
      items.push({
        id: 'biggest-expense',
        kind: 'biggest-expense',
        label: 'Biggest expense',
        content: 'Biggest expense: None in this period.',
        score: 950,
      });
    }
  }

  // Emit category & budget items in order
  items.push(...categoryItems);
  items.push(...budgetItems);

  // 7. Balance & per-account balances ONLY when asked (avoids running wallet SUM subqueries otherwise)
  if (includeBalance) {
    const walletsWithBalances = loadWalletsWithBalances(db);
    const totalBalance =
      walletsWithBalances.length > 0
        ? walletsWithBalances.reduce((sum, w) => sum + w.balance, 0)
        : getTotalBalance(db);
    let balanceLine: string;
    if (account) {
      const targetWallet = walletsWithBalances.find((w) => w.id === account.id);
      const otherWallets = walletsWithBalances.filter((w) => w.id !== account.id);
      const targetPart = targetWallet
        ? `${targetWallet.name}: ${formatCurrency(targetWallet.balance)}`
        : `${account.name}: ${formatCurrency(0)}`;
      const othersPart =
        otherWallets.length > 0
          ? `; Other: ${otherWallets.map((w) => `${w.name} ${formatCurrency(w.balance)}`).join(', ')}`
          : '';
      balanceLine = `Current balance: ${targetPart}; Total all accounts: ${formatCurrency(totalBalance)}${othersPart}`;
    } else if (walletsWithBalances.length === 1) {
      balanceLine = `Current balance: ${formatCurrency(totalBalance)} (${walletsWithBalances[0].name})`;
    } else if (walletsWithBalances.length > 1) {
      const perAccount = walletsWithBalances.map((w) => `${w.name} ${formatCurrency(w.balance)}`).join(', ');
      balanceLine = `Current balance: Total ${formatCurrency(totalBalance)} | Accounts: ${perAccount}`;
    } else {
      balanceLine = `Current balance: ${formatCurrency(totalBalance)}`;
    }

    items.push({
      id: 'balance-total',
      kind: 'balance',
      label: 'Current balance',
      content: balanceLine,
      score: 960,
    });
  }

  // Emit keyword items
  items.push(...keywordItems);

  // 8. Recent transactions (uses idx_transactions_date backwards before looking up category via idx_transaction_items_txn_id)
  if (includeRecent) {
    const recentDateClause = period.isExplicit ? ' AND t.date >= ? AND t.date < ?' : '';
    const recentCatNames = filterRecentByCategories ? parsed.categories.map((c) => c.name.toLowerCase()) : [];
    const catPlaceholders = recentCatNames.map(() => '?').join(', ');
    const recentCategoryClause =
      recentCatNames.length > 0
        ? ` AND t.type != 'transfer' AND EXISTS (SELECT 1 FROM transaction_items ci WHERE ci.transaction_id = t.id AND LOWER(ci.category) IN (${catPlaceholders}))`
        : '';

    const categorySubquery =
      recentCatNames.length > 0
        ? `(SELECT i.category FROM transaction_items i WHERE i.transaction_id = t.id AND LOWER(i.category) IN (${catPlaceholders}) ORDER BY i.id ASC LIMIT 1)`
        : `(SELECT i.category FROM transaction_items i WHERE i.transaction_id = t.id ORDER BY i.id ASC LIMIT 1)`;

    const outerParams: any[] = recentCatNames.length > 0 ? [...recentCatNames] : [];
    const innerParams: any[] = [];
    if (period.isExplicit) innerParams.push(period.fromMs, period.toMs);
    if (account !== null) innerParams.push(account.id);
    if (recentCatNames.length > 0) innerParams.push(...recentCatNames);

    const recentRows = safeQuery<MatchedTxRow>(
      db,
      `SELECT
         t.id AS transaction_id,
         t.merchant_name,
         t.total_amount,
         t.type,
         t.date,
         t.note,
         t.line_items_text,
         ${categorySubquery} AS category
       FROM transactions t
       WHERE 1=1${recentDateClause}${walletFilterJoinSql}${recentCategoryClause}
       ORDER BY t.date DESC, t.id DESC
       LIMIT ?`,
      [...outerParams, ...innerParams, QWEN_MODEL_RETRIEVAL_ITEM_LIMIT],
    );

    const accountLabel = account && !needsPeriodHeader ? ` for ${account.name}` : '';
    if (recentRows.length > 0) {
      items.push({
        id: 'recent-header',
        kind: 'note',
        label: 'Recent transactions',
        content: `Recent transactions${accountLabel} (${recentRows.length}):`,
        score: 920,
      });
      recentRows.forEach((row, idx) => {
        items.push({
          id: `tx-${row.transaction_id}`,
          kind: 'transaction',
          label: row.merchant_name || 'Unknown merchant',
          content: `- ${formatTransactionLine(row, [], false, refYear)}`,
          score: 915 - idx * 10,
        });
      });
    } else {
      items.push({
        id: 'recent-none',
        kind: 'note',
        label: 'Recent transactions',
        content: `Recent transactions${accountLabel}: None recorded.`,
        score: 920,
      });
    }
  }

  return items;
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
// Tuned on the chat benchmark (src/services/ai/chatBench, bench/chat/README.md) with Qwen 3.5 0.8B.
const DEFAULT_LOCAL_SYSTEM_PROMPT =
  'You are Silo AI, a friendly personal finance assistant inside the Silo app on this phone. Amounts are in Rupiah (Rp). ' +
  "For questions about the user's money, answer the question directly in the first sentence using the facts from their Silo records below. " +
  'Copy names and amounts exactly as written; never invent, round or recalculate categories, merchants, balances or amounts. ' +
  'If a "Worked out" line is in the facts, it is the answer: use its numbers. ' +
  'For advice or planning (saving, budgets, tips, "how can I"), never refuse: give two or three concrete tips that name their biggest categories and use amounts from the facts. ' +
  "If the facts do not cover a question about a specific record, say you don't have that in their Silo records. " +
  'If the question has nothing to do with money or Silo (like the weather), say briefly that you only help with money matters. ' +
  'Reply in 1-4 short sentences, in the language of the question. Never mention internet, network or server problems.';
const CHAT_FACTS_HEADING = "Facts from the user's Silo records (use when relevant):";
const DEFAULT_GROUNDED_SYSTEM_PROMPT =
  "You are Silo AI. Below are the user's real Silo finance records. Answer ONLY from these facts in 1-3 short sentences (or a brief list if asked). " +
  "Quote amounts exactly as written; never recalculate. Reply in the user's language. If the data does not cover the question, say so clearly.";

function isTrimmableTransactionItem(item: RetrievedContextItem): boolean {
  return item.kind === 'transaction' || item.id.startsWith('kw-tx-');
}

export function buildCompactContextBlock(
  retrievedContext: RetrievedContextItem[],
  maxChars = QWEN_MODEL_MAX_RAG_CONTEXT_CHARS,
): string {
  if (retrievedContext.length === 0) {
    return '';
  }

  const entries = retrievedContext.map((item, idx) => ({
    item,
    idx,
    line: trimCollapsedText(item.content, maxChars),
  }));

  const calcLength = (list: typeof entries) =>
    list.reduce((sum, entry, index) => sum + entry.line.length + (index > 0 ? 1 : 0), 0);

  while (calcLength(entries) > maxChars && entries.length > 1) {
    // Trim the least relevant transaction list items first so core computed facts are preserved.
    let dropIndex = -1;
    let lowestTrimmableScore = Infinity;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (isTrimmableTransactionItem(entry.item)) {
        if (entry.item.score <= lowestTrimmableScore) {
          lowestTrimmableScore = entry.item.score;
          dropIndex = i;
        }
      }
    }

    if (dropIndex === -1) {
      // No transaction list rows remain; drop lowest-priority supporting item (never dropping Period if others exist).
      let lowestScore = Infinity;
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        if (entry.item.kind === 'period' && entries.length > 1) {
          continue;
        }
        if (entry.item.score <= lowestScore) {
          lowestScore = entry.item.score;
          dropIndex = i;
        }
      }
    }

    if (dropIndex === -1) {
      dropIndex = entries.length - 1;
    }
    entries.splice(dropIndex, 1);

    // Clean up orphaned "Recent transactions (N):" header if all transaction rows were trimmed
    const hasTxRow = entries.some((e) => e.item.kind === 'transaction');
    if (!hasTxRow) {
      const headerIdx = entries.findIndex((e) => e.item.id === 'recent-header');
      if (headerIdx !== -1) {
        entries.splice(headerIdx, 1);
      }
    }
  }

  if (entries.length === 1 && entries[0].line.length > maxChars) {
    entries[0].line = trimCollapsedText(entries[0].line, maxChars);
  }

  return entries.map((e) => e.line).join('\n');
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

const FALSE_CONNECTIVITY_CLAIM =
  /\b(?:network|internet|connection|connectivity|server|online)\b[^.!?\n]{0,60}\b(?:error|issue|problem|unavailable|down|failure|failed|timed?\s*out)\b|\bcheck (?:your )?(?:internet|network|connection)\b|\bunable to (?:access|retrieve|reach|connect to) (?:your |the )?(?:financial |finance )?(?:data|records|information|database|account)\b/i;

/**
 * The on-device model sometimes excuses itself with a made-up network error (reported 2026-11-23:
 * "I am unable to access your financial data due to a network error"). Silo reads records locally and
 * real failures surface as errors, so any reply blaming connectivity is false: replace it with an
 * honest pointer to what does work.
 */
export function replaceFalseConnectivityClaim(text: string, mode: LocalAiMode): string {
  if (!FALSE_CONNECTIVITY_CLAIM.test(text)) return text;
  return mode === 'chat'
    ? "I couldn't find records in Silo that answer that. Try naming a period, account, category or merchant, for example \"How much did I spend on food this month?\""
    : "I couldn't find records in Silo that answer that. Try naming a period, account, category or merchant, for example \"How much did I spend on food this month?\"";
}

const REPLY_AMOUNT_PATTERN =
  /(?<![\p{L}\p{N}])(rp\.?\s*|idr\s*|\$\s*)?[-+]?(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(\s*(?:juta|jt|million|ribu|rb|thousand|k)\b)?/giu;

interface ReplyAmount {
  value: number;
  hasCurrency: boolean;
  approximate: boolean;
}

/** Amounts in a model reply or prompt: "Rp 4.899.000", "4,899,000", "Rp 15.20", "4.9 juta". */
export function extractReplyAmounts(text: string): ReplyAmount[] {
  const amounts: ReplyAmount[] = [];
  for (const match of text.matchAll(REPLY_AMOUNT_PATTERN)) {
    const raw = match[2];
    const scale = (match[3] ?? '').trim().toLowerCase();
    const grouped = raw.match(/^(\d{1,3}(?:[.,]\d{3})+)(?:[.,]\d{1,2})?$/);
    let value = grouped ? Number(grouped[1].replace(/[.,]/g, '')) : Number(raw.replace(',', '.'));
    if (!Number.isFinite(value)) continue;
    let approximate = false;
    if (['juta', 'jt', 'million'].includes(scale)) {
      value *= 1_000_000;
      approximate = true;
    } else if (['ribu', 'rb', 'thousand', 'k'].includes(scale)) {
      value *= 1_000;
      approximate = true;
    }
    amounts.push({ value, hasCurrency: Boolean(match[1]), approximate });
  }
  return amounts;
}

/**
 * Money amounts in `reply` that appear nowhere in what the model was shown. Counts, dates and years are
 * ignored: only amounts written with a currency, a thousands separator or a scale word ("4.9 juta") count.
 */
export function findUngroundedAmounts(reply: string, context: string): number[] {
  const known = extractReplyAmounts(context).map((a) => a.value);
  return extractReplyAmounts(reply)
    .filter((a) => a.hasCurrency || a.approximate || a.value >= 10_000)
    .filter((a) =>
      !known.some((k) => (a.approximate ? Math.abs(k - a.value) <= Math.max(0.06 * k, 1) : Math.abs(k - a.value) < 1)),
    )
    .map((a) => a.value);
}

/**
 * Last step for every local chat reply. The small model sometimes writes amounts that are not in the user's
 * records (reported 2026-11-25: "Transport: Rp 15.20 (1 transaction)" next to a made-up category list). A
 * reply with any such amount is replaced by the facts it was given, so Silo never shows invented money.
 */
export interface LocalChatReplyCheck {
  /** false when the reply had invented amounts or denied an over-budget verdict; `text` is then the facts. */
  ok: boolean;
  text: string;
}

const GUARD_FALLBACK_INTRO = "I couldn't put that into words reliably, so here are the numbers from your Silo records:";

export function checkLocalChatReply(reply: string, messages: ExternalChatMessage[], mode: LocalAiMode = 'chat'): LocalChatReplyCheck {
  const text = replaceFalseConnectivityClaim(reply, mode);
  const context = messages.map((m) => m.content).join('\n');
  // A reply to "am I over budget?" must name a budget that is over, and no budget that is within its limit;
  // the 0.8B model answered "Tidak ada" with Transport and Shopping over, and called Entertainment over with
  // Rp 30.000 left (chat benchmark and emulator check, 2026-11-25).
  const overVerdict = context.match(/Answer: Yes \(Ya\), over budget on ([^\n]+)\./);
  const withinBudget = context.match(/Within budget: ([^\n]+?)\. All budgets together/)?.[1].split(', ') ?? [];
  const lowerText = text.toLowerCase();
  const noRoomVerdict = /Answer: No \(Tidak\), .+ is already OVER budget/.test(context);
  const contradictsVerdict =
    (overVerdict !== null &&
      (!overVerdict[1].split(' and ').some((name) => lowerText.includes(name.trim().toLowerCase())) ||
        withinBudget.some((name) => lowerText.includes(name.trim().toLowerCase())))) ||
    (noRoomVerdict && /^\W*(?:yes|ya|iya|bisa)\b/i.test(text));
  if (!contradictsVerdict && findUngroundedAmounts(text, context).length === 0) return { ok: true, text };

  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const factsStart = [CHAT_FACTS_HEADING, 'Grounded local facts:']
    .map((heading) => ({ heading, idx: system.indexOf(heading) }))
    .find((entry) => entry.idx >= 0);
  const facts = factsStart
    ? system
        .slice(factsStart.idx + factsStart.heading.length)
        .split(/\n\n/)[0]
        .split('\n')
        .map((line) => line.replace(/^Worked out \(use these numbers as the answer\): /, '').trim())
        .filter((line) => line.length > 0)
    : [];
  if (facts.length === 0) {
    return {
      ok: false,
      text: "I couldn't find records in Silo that answer that. Try naming a period, account, category or merchant, for example \"How much did I spend on food this month?\"",
    };
  }
  return { ok: false, text: `${GUARD_FALLBACK_INTRO}\n${facts.join('\n')}` };
}

/**
 * Last step for every local chat reply. The small model sometimes writes amounts that are not in the user's
 * records (reported 2026-11-25: "Transport: Rp 15.20 (1 transaction)" next to a made-up category list). A
 * reply with any such amount is replaced by the facts it was given, so Silo never shows invented money.
 */
export function finalizeLocalChatReply(reply: string, messages: ExternalChatMessage[], mode: LocalAiMode = 'chat'): string {
  return checkLocalChatReply(reply, messages, mode).text;
}

/** Sampling and prompt for the one retry after a rejected reply (temperature 0.1 instead of 0.3). */
export const GUARD_RETRY_TEMPERATURE = 0.1;
export function buildGuardRetryMessages(messages: ExternalChatMessage[]): ExternalChatMessage[] {
  return messages.map((m, idx) =>
    idx === 0 && m.role === 'system'
      ? {
          ...m,
          content: `${m.content}\n\nIMPORTANT: write amounts exactly as they appear in the facts above. Do not calculate, round or invent any other amount.`,
        }
      : m,
  );
}

function buildGroundedSystemPrompt(retrievedContext: RetrievedContextItem[], customSystemPrompt: string) {
  const contextBlock = buildCompactContextBlock(retrievedContext, QWEN_MODEL_MAX_RAG_CONTEXT_CHARS);
  if (customSystemPrompt) {
    return [
      customSystemPrompt,
      "The grounded local facts below are the user's real Silo finance records. Answer only from the grounded local finance facts below in 1-3 short sentences, quoting amounts exactly as written. If the facts do not cover the question, say so clearly.",
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
  } else if (mode === 'chat' && retrievedContext?.length) {
    // Chat mode also sees the user's records (reported 2026-11-24: "the local model in chat mode doesn't have
    // access to my data"), but may talk more freely than Grounded mode.
    systemPrompt = `${systemPrompt}\n\n${CHAT_FACTS_HEADING}\n${buildCompactContextBlock(retrievedContext, QWEN_MODEL_MAX_RAG_CONTEXT_CHARS)}`;
  }

  // The small local model copies earlier answers, wrong ones included (reported 2026-11-25: every reply repeated
  // the balance "1. Rp 10.143.197"). Facts are rebuilt for every question, and follow-ups are resolved before
  // retrieval (resolveFollowUpPrompt), so only the previous question goes in, as context, never past answers.
  const historyForPrompt = getTrimmedHistoryForPrompt(userPrompt, state);
  manageContextWindow(historyForPrompt);
  const previousQuestion = [...historyForPrompt].reverse().find((msg) => msg.role === 'user')?.text;
  const effectiveSystemPrompt =
    previousQuestion && resolveFollowUpPrompt(userPrompt, [previousQuestion]) !== userPrompt
      ? `${systemPrompt}\n\nThe user's previous question was: "${trimCollapsedText(previousQuestion, MAX_LOCAL_SUMMARY_CHARS)}"`
      : systemPrompt;

  return fitMessagesWithinCharBudget(effectiveSystemPrompt, [], userPrompt, QWEN_MODEL_MAX_PROMPT_CHARS);
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
    const contextBlock = buildCompactContextBlock(retrievedContext, 2000);
    systemPrompt = `${systemPrompt}\n\nThe grounded finance facts below are the user's real Silo records. Answer only from these facts in 1-3 short sentences, quoting amounts exactly as written. If the facts do not cover the question, say so clearly.\n\nGrounded finance facts:\n${contextBlock}`;
  } else if (mode === 'chat' && retrievedContext?.length) {
    const contextBlock = buildCompactContextBlock(retrievedContext, 2000);
    systemPrompt = `${systemPrompt}\n\nWhen the user asks about their own money, use these facts from their Silo records and quote amounts exactly; for general questions, give practical advice that fits them.\n\n${CHAT_FACTS_HEADING}\n${contextBlock}`;
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
  /** The receipt photo turned upright, when it was sideways or upside down; use it instead of the original. */
  imageUri?: string;
}

function itemPricesFromText(lineItemsText: string | null | undefined): number[] {
  return parseReceiptLineItemsText(lineItemsText ?? '')
    .map((item) => Math.round(Math.abs(parseSignedAmount(item.price.trim()))))
    .filter((price) => Number.isFinite(price) && price > 0);
}

function sanitizeMerchantName(...candidates: Array<string | null | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (!isSuspiciousMerchantName(trimmed)) {
      return trimmed;
    }
  }
  return undefined;
}

function filterSerializedLineItems(lineItemsText: string | null | undefined): string | undefined {
  if (!lineItemsText) return undefined;
  const kept = parseReceiptLineItemsText(lineItemsText).filter(
    (item) => item.name.trim().length > 0 && !isNonItemLine(item.name),
  );
  const serialized = serializeReceiptLineItems(kept);
  return serialized ? serialized : undefined;
}

function withConfidence(
  result: ParsedReceiptResult,
  rows: string[],
  independentTotal: number | null,
  rawMerchantCandidate?: string | null,
): ParsedReceiptResult {
  const { level, reasons } = assessReceiptConfidence({
    total: result.totalAmount,
    rows,
    independentTotal,
    itemPrices: itemPricesFromText(result.lineItemsText),
    merchantName: result.merchantName ?? rawMerchantCandidate ?? null,
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

  const drafts: Array<{ name: string; price: string; note: string }> = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { name?: unknown; qty?: unknown; price?: unknown };
    const rawName = typeof record.name === 'string' ? record.name.trim() : '';
    if (!rawName || isNonItemLine(rawName)) continue;

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

    drafts.push({ name, price: rawPrice > 0 ? String(rawPrice) : '', note: '' });
  }

  const serialized = serializeReceiptLineItems(drafts);
  return serialized ? serialized : undefined;
}

const GARBAGE_ITEM_NAME_REGEX = /@|www\.|https?:|\.(?:com|co\.id|id)\b|\b(?:jl|jalan|kel|kec|rt|rw)\.?\s/i;

/**
 * Model-read line items (vision or text model) kept only when they look like purchases on THIS receipt:
 * the name is a real product label (not a phone number, address, website, summary/payment row or the
 * merchant) and the price appears in the OCR text (directly, or as qty x unit price). Duplicates and a
 * total echoed as an item are dropped. Returns undefined when nothing trustworthy is left, so callers
 * fall back to the OCR-parsed items.
 */
export function groundModelItems(
  items: unknown,
  rows: string[],
  total?: number | null,
  merchantName?: string | null,
): string | undefined {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const ocrAmounts = new Set(extractAmounts(rows.join('\n')));
  const canGround = ocrAmounts.size > 0;
  const merchant = merchantName?.trim().toLowerCase() ?? '';
  const seen = new Set<string>();
  const kept: Array<{ name: string; qty?: number; price: number }> = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { name?: unknown; qty?: unknown; price?: unknown };
    const name = typeof record.name === 'string' ? record.name.replace(/\s+/g, ' ').trim() : '';
    const letters = (name.match(/\p{L}/gu) ?? []).length;
    const visible = name.replace(/\s/g, '').length;
    if (!name || letters < 2 || letters / Math.max(1, visible) < 0.4) continue;
    if (isNonItemLine(name) || GARBAGE_ITEM_NAME_REGEX.test(name)) continue;
    if (merchant && name.toLowerCase() === merchant) continue;

    const qty = typeof record.qty === 'number' && Number.isFinite(record.qty) && record.qty > 1 ? Math.round(record.qty) : undefined;
    const price =
      typeof record.price === 'number' && Number.isFinite(record.price)
        ? Math.round(Math.abs(record.price))
        : typeof record.price === 'string'
          ? Math.round(Math.abs(parseSignedAmount(record.price)))
          : 0;
    if (price <= 0) continue;
    const grounded =
      !canGround ||
      ocrAmounts.has(price) ||
      (qty !== undefined && (ocrAmounts.has(Math.round(price / qty)) || ocrAmounts.has(price * qty)));
    if (!grounded) continue;

    const key = `${name.toLowerCase()}|${price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ name, qty, price });
  }

  // A receipt's total read back as one of several items is not a purchase.
  const items2 = total && kept.length > 1 ? kept.filter((item) => item.price !== Math.round(total)) : kept;
  return items2.length > 0 ? formatReceiptItemsText(items2) : undefined;
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
  await useSettingsStore.getState().waitForSettingsLoaded?.();
  const settings = useSettingsStore.getState();
  if (settings.aiInferenceMode === 'external') {
    await settings.waitForSecretsHydrated?.();
    return true;
  }

  await getModelLifecycleManager?.()?.ensureInitialized?.();

  const aiState = useAIStore.getState();
  if (aiState.provisioning.status === 'ready' || (aiState.runtimeReady && aiState.runtime.modelLoaded)) {
    return true;
  }

  if (await isActiveModelInstalled()) {
    return true;
  }

  await useSettingsStore.getState().waitForSecretsHydrated?.();
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

function ocrResultScore(result: OcrResult): number {
  if (!result.success || !result.rawText) return -1;
  const rows = result.rows?.length ? result.rows : result.rawText.split('\n').filter((line) => line.trim());
  const pricedRows = rows.filter((row) => extractAmounts(row).length > 0).length;
  return (result.extractedTotal ? 1000 : 0) + pricedRows * 10 + Math.min(rows.length, 9);
}

/**
 * OCRs a document-scanner style black-and-white copy of the photo first (helps gallery photos with
 * shadows, colour casts or low contrast), and also reads the original when the scan finds no total,
 * keeping whichever read looks more like a receipt. Without the native normalizer, reads the original.
 */
/** A read with a total and at least two priced rows. */
const UPRIGHT_SCORE = 1020;

export interface RecognizedReceipt extends OcrResult {
  /** Clockwise degrees the photo had to be turned to read upright (0 when it already was). */
  rotation: 0 | 90 | 180 | 270;
  /** The image that was read, turned upright (only when rotation is not 0). */
  uprightReadUri?: string;
}

async function rotateImage(uri: string, degrees: number): Promise<string | null> {
  try {
    const result = await manipulateAsync(uri, [{ rotate: degrees }], { compress: 0.9, format: SaveFormat.JPEG });
    return result?.uri ?? null;
  } catch (error) {
    console.warn('Could not rotate receipt image:', error);
    return null;
  }
}

/**
 * Receipts photographed sideways or upside down: when the OCR's text direction says the photo is turned,
 * reads it once more turned upright (OCR on a turned photo jumbles the row order even when words are read).
 */
async function readUpright(
  engine: ReturnType<typeof getOcrEngine>,
  uri: string,
  first: OcrResult,
): Promise<RecognizedReceipt> {
  const rotation = first.uprightRotation;
  if (!first.success || !rotation) return { ...first, rotation: 0 };
  const rotatedUri = await rotateImage(uri, rotation);
  if (!rotatedUri) return { ...first, rotation: 0 };
  const upright = await engine.processImage(rotatedUri).catch(() => null);
  if (!upright?.success) return { ...first, rotation: 0 };
  return { ...upright, rotation, uprightReadUri: rotatedUri };
}

export async function recognizeReceiptText(
  imageUri: string,
  options: { alreadyScanned?: boolean } = {},
): Promise<RecognizedReceipt> {
  const engine = getOcrEngine();
  // A gallery photo already turned into a scan (cropped, black and white) is read as is.
  const normalizedUri = options.alreadyScanned ? null : await normalizeReceiptImage(imageUri);
  if (!normalizedUri) {
    return readUpright(engine, imageUri, await engine.processImage(imageUri));
  }

  const normalized = await engine.processImage(normalizedUri);
  if (normalized.success && normalized.extractedTotal && ocrResultScore(normalized) >= UPRIGHT_SCORE && !normalized.uprightRotation) {
    return { ...normalized, rotation: 0 };
  }
  const original = await engine.processImage(imageUri);
  const useOriginal = ocrResultScore(original) > ocrResultScore(normalized);
  return readUpright(engine, useOriginal ? imageUri : normalizedUri, useOriginal ? original : normalized);
}

/** Thrown by analyzeReceiptImage when its AbortSignal fires; callers should treat it as a silent cancel. */
export const RECEIPT_SCAN_CANCELLED = 'SCAN_CANCELLED';

export interface AnalyzeReceiptOptions {
  /** Aborting stops the scan between stages and stops an in-flight model generation. */
  signal?: AbortSignal;
  /** The image is already a document-style scan (gallery import), so skip normalizing it again. */
  alreadyScanned?: boolean;
}

export const analyzeReceiptImage = async (
  imageUri?: string,
  base64Image?: string,
  onStatusChange?: (status: string) => void,
  options: AnalyzeReceiptOptions = {},
): Promise<ParsedReceiptResult | null> => {
  const out: { uprightUri?: string } = {};
  const result = await analyzeReceiptImageCore(imageUri, base64Image, onStatusChange, options, out);
  return result && out.uprightUri ? { ...result, imageUri: out.uprightUri } : result;
};

const analyzeReceiptImageCore = async (
  imageUri: string | undefined,
  _base64Image: string | undefined,
  onStatusChange: ((status: string) => void) | undefined,
  options: AnalyzeReceiptOptions,
  out: { uprightUri?: string },
): Promise<ParsedReceiptResult | null> => {
  if (!imageUri) return null;
  const { signal } = options;
  const throwIfCancelled = () => {
    if (signal?.aborted) throw new Error(RECEIPT_SCAN_CANCELLED);
  };
  throwIfCancelled();

  onStatusChange?.('Reading text…');

  const ocrResult = await recognizeReceiptText(imageUri, { alreadyScanned: options.alreadyScanned });
  throwIfCancelled();
  if (ocrResult.rotation !== 0) {
    // Keep the photo upright from now on (and give the vision model the upright version too).
    const upright =
      options.alreadyScanned && ocrResult.uprightReadUri ? ocrResult.uprightReadUri : await rotateImage(imageUri, ocrResult.rotation);
    if (upright) {
      out.uprightUri = upright;
      imageUri = upright;
    }
  }
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

  const cleanOcrMerchant = sanitizeMerchantName(ocrResult.extractedMerchant, pickMerchantFromRows(rows));
  const cleanOcrItems = filterSerializedLineItems(ocrResult.extractedLineItems);

  const heuristicResult: ParsedReceiptResult = {
    merchantName: cleanOcrMerchant,
    totalAmount: heuristicTotal,
    category: ocrResult.extractedCategory || inferReceiptCategory(cleanOcrMerchant ?? null, rawText) || undefined,
    lineItemsText: cleanOcrItems,
    date: ocrResult.extractedDate || undefined,
    rawText,
  };

  const { getGenerationService, isVisionAvailable } =
    require('./generationService') as typeof import('./generationService');

  await useSettingsStore.getState().waitForSettingsLoaded?.();

  throwIfCancelled();

  // While a model is generating for this scan, an abort stops the generation instead of waiting for it.
  let generating = false;
  const stopGenerationOnAbort = () => {
    if (generating) void getGenerationService().cancelGeneration('Receipt scan cancelled.');
  };
  signal?.addEventListener?.('abort', stopGenerationOnAbort);
  const generate = async (params: Parameters<ReturnType<typeof getGenerationService>['startGeneration']>[0]) => {
    throwIfCancelled();
    generating = true;
    try {
      return await getGenerationService().startGeneration(params);
    } finally {
      generating = false;
      throwIfCancelled();
    }
  };

  try {
    if (useSettingsStore.getState().receiptReadingMode === 'vision' && (await isVisionAvailable())) {
      onStatusChange?.('Reading receipt with AI vision…');
      try {
        const processedUri = await downscaleReceiptImage(imageUri);
        const responseText = await generate({
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

        // Small vision models misread or invent totals; prefer the OCR TOTAL line when theirs isn't on the receipt.
        const visionTotalGrounded = typeof visionTotal === 'number' && visionTotal > 0 && isGrounded(visionTotal, rows);
        const usedVisionTotal =
          typeof visionTotal === 'number' && visionTotal > 0 && (visionTotalGrounded || heuristicTotal == null);
        const finalTotal = usedVisionTotal ? visionTotal : heuristicTotal;

        const rawVisionMerchant = typeof parsedData.merchant === 'string' ? parsedData.merchant.trim() : undefined;
        const merchantName = sanitizeMerchantName(rawVisionMerchant, cleanOcrMerchant);
        const date =
          (typeof parsedData.date === 'string' &&
            isDateGrounded(parsedData.date.trim(), rawText) &&
            isPlausibleReceiptDate(parsedData.date.trim()) &&
            parsedData.date.trim()) ||
          ocrResult.extractedDate ||
          undefined;
        const lineItemsText =
          groundModelItems(parsedData.items, rows, finalTotal, merchantName) || cleanOcrItems || undefined;
        const category =
          ocrResult.extractedCategory ||
          inferReceiptCategory(merchantName ?? cleanOcrMerchant ?? null, rawText) ||
          undefined;

        return withConfidence(
          { merchantName, totalAmount: finalTotal, category, lineItemsText, date, rawText },
          rows,
          usedVisionTotal ? keywordTotal : null,
          rawVisionMerchant,
        );
      } catch (visionError) {
        throwIfCancelled();
        console.warn('Vision extraction failed, falling back to text LLM / OCR heuristics:', visionError);
      } finally {
        getGenerationService().scheduleModelUnload(300_000);
      }
    }

    throwIfCancelled();
    if (!(await canRunReceiptLlm())) {
      return withConfidence(heuristicResult, rows, null, ocrResult.extractedMerchant);
    }
    throwIfCancelled();

    onStatusChange?.('Structuring receipt with AI...');

    try {
      const responseText = await generate({
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

        const rawLlmMerchant = typeof parsedData.merchant === 'string' ? parsedData.merchant.trim() : undefined;
        const merchantName = sanitizeMerchantName(rawLlmMerchant, cleanOcrMerchant);
        // Small models invent plausible dates (bench: Qwen3.5-0.8B on 34/39 receipts); keep only dates visible in the OCR text.
        const date =
          (typeof parsedData.date === 'string' &&
            isDateGrounded(parsedData.date.trim(), rawText) &&
            isPlausibleReceiptDate(parsedData.date.trim()) &&
            parsedData.date.trim()) ||
          ocrResult.extractedDate ||
          undefined;
        const lineItemsText =
          groundModelItems(parsedData.items, rows, finalTotal, merchantName) || cleanOcrItems || undefined;
        const category =
          ocrResult.extractedCategory ||
          inferReceiptCategory(merchantName ?? cleanOcrMerchant ?? null, rawText) ||
          undefined;

        return withConfidence(
          { merchantName, totalAmount: finalTotal, category, lineItemsText, date, rawText },
          rows,
          usedLlmTotal ? keywordTotal : null,
          rawLlmMerchant,
        );
      }
    } catch (error) {
      throwIfCancelled();
      console.warn('LLM Extraction skipped or failed, falling back to OCR heuristics:', error);
    } finally {
      getGenerationService().scheduleModelUnload(300_000);
    }

    return withConfidence(heuristicResult, rows, null, ocrResult.extractedMerchant);
  } finally {
    signal?.removeEventListener?.('abort', stopGenerationOnAbort);
  }
};
