import { Image } from 'react-native';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { expoDb } from '../../db/index';
import { getModelLifecycleManager, isActiveModelInstalled } from './modelLifecycle';
import { getOcrEngine } from '../ocr/index';
import { inferReceiptCategory, reconstructMultiColumnOcrText } from '../ocr/MlKitEngine';
import { isGrounded, isNonItemLine, isSuspiciousMerchantName, pickMerchantFromRows, pickTotalFromRows } from '../ocr/receiptText';
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
}

export interface BuildRetrievedContextOptions {
  db?: GroundedSqliteDb;
  now?: Date | number;
  /** Billing month start day (1-28); defaults to the user's setting. */
  monthStartDay?: number;
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
]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
        if (merchantPrefixGuard.test(prefix)) {
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

  const budgetCatRows = safeQuery<{ category?: string }>(
    db,
    `SELECT DISTINCT category FROM budgets WHERE category IS NOT NULL AND TRIM(category) != ''`,
  );
  budgetCatRows.forEach((row) => add(row.category, 'expense'));

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
  const cleanedPrompt = period.matchedText ? userPrompt.replace(period.matchedText, ' ') : userPrompt;

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
  const asksTopCategories =
    /\b(top\s+categor|categor(?:y|ies)\s+breakdown|spending\s+breakdown|where\s+(?:did|does)\s+(?:my\s+)?money\s+go|most\s+spent\s+categor|kategori\s+(?:terbesar|terbanyak|tertinggi)|rincian\s+kategori|pengeluaran\s+per\s+kategori)\b/i.test(
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
  const asksBalance = explicitBalancePhrase || genericLeftWithoutBudget || accountBalanceImplied;

  const consumedTokens = new Set<string>([...categoryTokens, ...accountTokens]);
  const keywords = extractSearchKeywords(cleanedPrompt, consumedTokens);

  return {
    period,
    categories,
    account,
    keywords,
    asksBalance,
    asksBudget,
    wantsRecent,
    asksBiggest,
    asksIncomeVsSpending,
    asksTopCategories,
  };
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

  // 1. Primary path: FTS5 requiring ALL terms (AND) with uncapped SQL COUNT/SUM.
  const matchQuery = terms.map((w) => `"${w}"*`).join(' AND ');
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
    likeClause = terms
      .map(
        () =>
          "(t.merchant_name LIKE ? ESCAPE '\\' OR t.note LIKE ? ESCAPE '\\' OR t.line_items_text LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM transaction_items i WHERE i.transaction_id = t.id AND i.category LIKE ? ESCAPE '\\'))",
      )
      .join(' AND ');
    terms.forEach((term) => {
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

    const normalizedTerms = terms.map((t) => normalizeForMatch(t));
    const currencyCode = currentCurrencyCode();

    for (const row of candidateRows) {
      const merchantNorm = normalizeForMatch(row.merchant_name || '');
      const remainingTerms = normalizedTerms.filter((t) => !merchantNorm.includes(t));
      if (remainingTerms.length === 0) {
        // Merchant itself matched every search term; keep the full receipt total.
        continue;
      }

      const parsedItems = parseReceiptLineItemsText(row.line_items_text || '');
      let matchedItemSum = 0;
      let matchedItemCount = 0;
      for (const item of parsedItems) {
        const itemHay = normalizeForMatch(`${item.name} ${item.note}`);
        if (!remainingTerms.every((t) => itemHay.includes(t))) {
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

export function buildRetrievedContext(
  userPrompt: string,
  options?: BuildRetrievedContextOptions,
): RetrievedContextItem[] {
  const db = options?.db ?? expoDb;
  const now = options?.now instanceof Date ? options.now : new Date(options?.now ?? Date.now());
  const basicWallets = loadWalletsBasic(db);
  const userCategories = loadUserCategories(db);
  const monthStartDay = options?.monthStartDay ?? currentMonthStartDay();
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
    parsed.asksTopCategories;

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

  const includeSummary =
    !hasSpecificIntent ||
    parsed.asksIncomeVsSpending ||
    asksExplicitOverview ||
    asksUnscopedSpending;
  const includeTopCategories =
    parsed.asksTopCategories ||
    parsed.asksIncomeVsSpending ||
    asksExplicitOverview ||
    (!hasSpecificIntent && !asksUnscopedSpending);
  const includeBiggest = parsed.asksBiggest;
  const includeBudgets = parsed.asksBudget;
  const includeBalance = parsed.asksBalance;
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
    const budgetParams: any[] = account !== null ? [budgetFromMs, budgetToMs, account.id] : [budgetFromMs, budgetToMs];

    const budgetRows = safeQuery<{
      category?: string;
      limit_amount?: number | null;
      spent?: number | null;
    }>(
      db,
      `SELECT
         b.category,
         b.limit_amount,
         COALESCE((
           SELECT SUM(CASE WHEN i.id IS NOT NULL AND i.amount > 0 THEN i.amount ELSE ABS(t.total_amount) END)
           FROM transactions t
           JOIN transaction_items i ON t.id = i.transaction_id
           WHERE t.type != 'transfer'
             AND t.total_amount < 0
             AND LOWER(i.category) = LOWER(b.category)
             AND t.date >= ? AND t.date < ?${walletFilterJoinSql}
         ), 0) AS spent
       FROM budgets b
       WHERE b.limit_amount > 0
       ORDER BY b.category ASC`,
      budgetParams,
    );

    if (budgetRows.length > 0) {
      const namedCatSet = new Set(parsed.categories.map((c) => c.name.toLowerCase()));
      const matchingCategoryBudgets =
        namedCatSet.size > 0
          ? budgetRows.filter((row) => row.category && namedCatSet.has(row.category.toLowerCase()))
          : [];
      matchedAllNamedCategoryBudgets =
        namedCatSet.size > 0 && matchingCategoryBudgets.length === namedCatSet.size;

      // Scope to named category budgets when matching budgets exist; otherwise show all configured budgets.
      const rowsToEmit = matchingCategoryBudgets.length > 0 ? matchingCategoryBudgets : budgetRows;

      const formatBudgetRow = (row: { category?: string; limit_amount?: number | null; spent?: number | null }) => {
        const limit = Number(row.limit_amount ?? 0) || 0;
        const spent = Number(row.spent ?? 0) || 0;
        const remaining = limit - spent;
        const remText =
          remaining >= 0
            ? `remaining ${formatCurrency(remaining)}`
            : `over by ${formatCurrency(Math.abs(remaining))}`;
        return `${row.category}: limit ${formatCurrency(limit)}, spent ${formatCurrency(spent)}, ${remText}`;
      };

      const accountPart = account ? `, Account: ${account.name}` : '';
      if (rowsToEmit.length === 1) {
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
          sumRem >= 0 ? `remaining ${formatCurrency(sumRem)}` : `over by ${formatCurrency(Math.abs(sumRem))}`;

        budgetItems.push({
          id: 'budgets-summary',
          kind: 'budget',
          label: 'Budgets',
          content: `Budgets (${budgetPeriodLabel}${accountPart}): Total limit ${formatCurrency(sumLimit)}, spent ${formatCurrency(sumSpent)}, ${sumRemText}`,
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
        content: `Budgets: 0 budgets configured for ${budgetPeriodLabel} (you have not set any monthly budget limits yet).`,
        score: 955,
      });
    }
  }

  const includeCategories = hasCategoryIntent && !(isPureCategoryBudgetQuestion && matchedAllNamedCategoryBudgets);

  // 2. Named category breakdown (only when categories were asked)
  const categoryItems: RetrievedContextItem[] = [];
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
      categoryItems.push({
        id: `category-${catMatch.name.toLowerCase()}`,
        kind: 'category-spending',
        label: `${catMatch.name} ${actionWord}`,
        content: `Category ${catMatch.name}: ${formatCurrency(catTotal)} ${actionWord} (${catCount} ${txnWord}${merchantsSuffix})`,
        score: 950,
      });
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
            content: `Summary: Spent ${formatCurrency(totalSpent)}, Income ${formatCurrency(totalIncome)}, Net ${formatSignedCurrency(net)} (${txCount} ${txCount === 1 ? 'txn' : 'txns'})`,
            score: parsed.asksIncomeVsSpending ? 945 : 900,
          },
    );
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
       LIMIT 3`,
      periodParams,
    );
    if (topCategoryRows.length > 0) {
      const topStr = topCategoryRows
        .map((row) => `${row.category} ${formatCurrency(row.total ?? 0)}`)
        .join(', ');
      items.push({
        id: 'top-categories',
        kind: 'top-categories',
        label: 'Top categories',
        content: `Top categories: ${topStr}`,
        score: parsed.asksTopCategories ? 945 : 840,
      });
    }
  }

  // 6. Biggest single expense (only when asked)
  if (includeBiggest) {
    const biggestRows = safeQuery<{
      merchant_name?: string;
      amount?: number | null;
      date?: number | null;
    }>(
      db,
      `SELECT
         t.merchant_name,
         ABS(t.total_amount) AS amount,
         t.date
       FROM transactions t
       WHERE t.type != 'transfer' AND t.total_amount < 0 AND t.date >= ? AND t.date < ?${walletFilterJoinSql}
       ORDER BY t.total_amount ASC, t.date DESC
       LIMIT 1`,
      periodParams,
    );
    const biggest = biggestRows[0];
    if (biggest && biggest.merchant_name && typeof biggest.amount === 'number' && biggest.amount > 0) {
      const datePart = typeof biggest.date === 'number' ? formatShortDate(biggest.date, refYear) : '';
      items.push({
        id: 'biggest-expense',
        kind: 'biggest-expense',
        label: 'Biggest expense',
        content: `Biggest expense: ${biggest.merchant_name} ${formatCurrency(biggest.amount)} (${datePart})`,
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
const DEFAULT_LOCAL_SYSTEM_PROMPT =
  'You are Silo AI, a concise offline personal finance assistant. Reply in 2-4 short sentences or brief bullets; never invent balances or transactions.';
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
    const contextBlock = buildCompactContextBlock(retrievedContext, 2000);
    systemPrompt = `${systemPrompt}\n\nThe grounded finance facts below are the user's real Silo records. Answer only from these facts in 1-3 short sentences, quoting amounts exactly as written. If the facts do not cover the question, say so clearly.\n\nGrounded finance facts:\n${contextBlock}`;
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

      const rawVisionMerchant = typeof parsedData.merchant === 'string' ? parsedData.merchant.trim() : undefined;
      const merchantName = sanitizeMerchantName(rawVisionMerchant, cleanOcrMerchant);
      const date =
        (typeof parsedData.date === 'string' && isDateGrounded(parsedData.date.trim(), rawText) && parsedData.date.trim()) ||
        ocrResult.extractedDate ||
        undefined;
      const lineItemsText = formatReceiptItemsText(parsedData.items) || cleanOcrItems || undefined;
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
      console.warn('Vision extraction failed, falling back to text LLM / OCR heuristics:', visionError);
    } finally {
      getGenerationService().scheduleModelUnload(300_000);
    }
  }

  if (!(await canRunReceiptLlm())) {
    return withConfidence(heuristicResult, rows, null, ocrResult.extractedMerchant);
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

      const rawLlmMerchant = typeof parsedData.merchant === 'string' ? parsedData.merchant.trim() : undefined;
      const merchantName = sanitizeMerchantName(rawLlmMerchant, cleanOcrMerchant);
      // Small models invent plausible dates (bench: Qwen3.5-0.8B on 34/39 receipts); keep only dates visible in the OCR text.
      const date =
        (typeof parsedData.date === 'string' && isDateGrounded(parsedData.date.trim(), rawText) && parsedData.date.trim()) ||
        ocrResult.extractedDate ||
        undefined;
      const lineItemsText = formatReceiptItemsText(parsedData.items) || cleanOcrItems || undefined;
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
    console.warn('LLM Extraction skipped or failed, falling back to OCR heuristics:', error);
  } finally {
    getGenerationService().scheduleModelUnload(300_000);
  }

  return withConfidence(heuristicResult, rows, null, ocrResult.extractedMerchant);
};
