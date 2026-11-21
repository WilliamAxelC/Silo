import { Image } from 'react-native';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { expoDb } from '../../db/index';
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
}

export interface BuildRetrievedContextOptions {
  db?: GroundedSqliteDb;
  now?: Date | number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_SHORT_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const NAMED_MONTH_PATTERNS: Array<{ monthIndex: number; aliases: string[]; guarded?: boolean }> = [
  { monthIndex: 0, aliases: ['january', 'januari', 'jan'] },
  { monthIndex: 1, aliases: ['february', 'februari', 'feb'] },
  { monthIndex: 2, aliases: ['march', 'maret', 'mar'] },
  { monthIndex: 3, aliases: ['april', 'apr'] },
  { monthIndex: 4, aliases: ['mei'] },
  { monthIndex: 4, aliases: ['may'], guarded: true },
  { monthIndex: 5, aliases: ['june', 'juni', 'jun'] },
  { monthIndex: 6, aliases: ['july', 'juli', 'jul'] },
  { monthIndex: 7, aliases: ['august', 'agustus', 'aug', 'agu', 'ags'] },
  { monthIndex: 8, aliases: ['september', 'sept', 'sep'] },
  { monthIndex: 9, aliases: ['october', 'oktober', 'oct', 'okt'] },
  { monthIndex: 10, aliases: ['november', 'nov', 'nop'] },
  { monthIndex: 11, aliases: ['december', 'desember', 'dec', 'des'] },
];

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

function formatCurrency(amount: number | null | undefined): string {
  const safeAmount = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
  const normalized = Object.is(safeAmount, -0) ? 0 : safeAmount;
  let currencyCode = 'IDR';
  try {
    currencyCode = useSettingsStore.getState()?.currencyCode || 'IDR';
  } catch {
    currencyCode = 'IDR';
  }
  try {
    return new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: currencyCode,
      maximumFractionDigits: currencyCode === 'IDR' ? 0 : 2,
    })
      .format(normalized)
      .replace(/\u00a0/g, ' ');
  } catch {
    return `${currencyCode === 'IDR' ? 'Rp' : currencyCode} ${normalized}`;
  }
}

function formatSignedCurrency(amount: number): string {
  if (!Number.isFinite(amount) || amount === 0) {
    return formatCurrency(0);
  }
  return amount > 0 ? `+${formatCurrency(amount)}` : `-${formatCurrency(Math.abs(amount))}`;
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

export function parseTimePeriod(userPrompt: string, nowInput?: Date | number): GroundedTimePeriod {
  const now = nowInput instanceof Date ? new Date(nowInput.getTime()) : new Date(nowInput ?? Date.now());
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const todayStart = startOfLocalDay(y, m, d);
  const tomorrowStart = startOfLocalDay(y, m, d + 1);
  const dayFromMon = (now.getDay() + 6) % 7;

  // 1. Last N days (English & Indonesian)
  const enDaysMatch = userPrompt.match(
    /\b(?:(?:over|in|during)\s+(?:the\s+)?)?(?:last|past)\s+(\d{1,4})\s+days?\b/i,
  );
  if (enDaysMatch) {
    const days = Math.max(1, Math.min(3650, Number(enDaysMatch[1]) || 30));
    const fromMs = now.getTime() - days * DAY_MS;
    const toMs = Math.max(now.getTime() + 1, tomorrowStart);
    return {
      kind: 'last-n-days',
      label: `Last ${days} days (${formatShortDate(fromMs)}–${formatShortDate(now.getTime())})`,
      fromMs,
      toMs,
      isExplicit: true,
      matchedText: enDaysMatch[0],
    };
  }

  const idDaysMatch = userPrompt.match(/\b(?:dalam\s+)?(\d{1,4})\s+hari\s+(?:terakhir|belakangan|ke\s*belakang)\b/i);
  if (idDaysMatch) {
    const days = Math.max(1, Math.min(3650, Number(idDaysMatch[1]) || 30));
    const fromMs = now.getTime() - days * DAY_MS;
    const toMs = Math.max(now.getTime() + 1, tomorrowStart);
    return {
      kind: 'last-n-days',
      label: `Last ${days} days (${formatShortDate(fromMs)}–${formatShortDate(now.getTime())})`,
      fromMs,
      toMs,
      isExplicit: true,
      matchedText: idDaysMatch[0],
    };
  }

  const idRollingMonthMatch = userPrompt.match(/\bsebulan\s+terakhir\b/i);
  if (idRollingMonthMatch) {
    const fromMs = now.getTime() - 30 * DAY_MS;
    const toMs = Math.max(now.getTime() + 1, tomorrowStart);
    return {
      kind: 'last-n-days',
      label: `Last 30 days (${formatShortDate(fromMs)}–${formatShortDate(now.getTime())})`,
      fromMs,
      toMs,
      isExplicit: true,
      matchedText: idRollingMonthMatch[0],
    };
  }

  const idRollingWeekMatch = userPrompt.match(/\bseminggu\s+terakhir\b/i);
  if (idRollingWeekMatch) {
    const fromMs = now.getTime() - 7 * DAY_MS;
    const toMs = Math.max(now.getTime() + 1, tomorrowStart);
    return {
      kind: 'last-n-days',
      label: `Last 7 days (${formatShortDate(fromMs)}–${formatShortDate(now.getTime())})`,
      fromMs,
      toMs,
      isExplicit: true,
      matchedText: idRollingWeekMatch[0],
    };
  }

  // 2. Last month (check before single-word "kemarin")
  const lastMonthMatch = userPrompt.match(/\b(?:(?:last|previous)\s+month|bulan\s+(?:lalu|kemarin|sebelumnya))\b/i);
  if (lastMonthMatch) {
    const prevStart = new Date(y, m - 1, 1, 0, 0, 0, 0);
    const currStart = new Date(y, m, 1, 0, 0, 0, 0);
    return {
      kind: 'last-month',
      label: `Last month (${MONTH_SHORT_NAMES[prevStart.getMonth()]} ${prevStart.getFullYear()})`,
      fromMs: prevStart.getTime(),
      toMs: currStart.getTime(),
      isExplicit: true,
      matchedText: lastMonthMatch[0],
    };
  }

  // 3. This month
  const thisMonthMatch = userPrompt.match(/\b(?:(?:this|current)\s+month|bulan\s+ini)\b/i);
  if (thisMonthMatch) {
    return {
      kind: 'this-month',
      label: `This month (${MONTH_SHORT_NAMES[m]} ${y})`,
      fromMs: new Date(y, m, 1, 0, 0, 0, 0).getTime(),
      toMs: new Date(y, m + 1, 1, 0, 0, 0, 0).getTime(),
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

  // 8. Named month (English & Indonesian, optional year)
  for (const entry of NAMED_MONTH_PATTERNS) {
    const aliasGroup = entry.aliases.join('|');
    const regex = entry.guarded
      ? new RegExp(
          `(?:\\b(?:in|for|during|of|from|on|bulan)\\s+(?:${aliasGroup})\\b(?:\\s+(\\d{4}))?|\\b(?:${aliasGroup})\\s+(\\d{4})\\b)`,
          'i',
        )
      : new RegExp(`(?:\\b(?:in|for|during|of|from|on|bulan)\\s+)?\\b(?:${aliasGroup})\\b(?:\\s+(\\d{4}))?`, 'i');
    const match = userPrompt.match(regex);
    if (match) {
      const explicitYearRaw = match[1] ?? match[2];
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

  // 10. Default: this calendar month
  return {
    kind: 'this-month',
    label: `This month (${MONTH_SHORT_NAMES[m]} ${y})`,
    fromMs: new Date(y, m, 1, 0, 0, 0, 0).getTime(),
    toMs: new Date(y, m + 1, 1, 0, 0, 0, 0).getTime(),
    isExplicit: false,
  };
}

interface StoredCategory {
  name: string;
  type: 'expense' | 'income';
}

interface StoredWallet {
  id: number;
  name: string;
  type: string;
  isActive: boolean;
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

  const txCatRows = safeQuery<{ category?: string; type?: string }>(
    db,
    `SELECT DISTINCT i.category AS category, t.type AS type
     FROM transaction_items i
     LEFT JOIN transactions t ON t.id = i.transaction_id
     WHERE i.category IS NOT NULL AND TRIM(i.category) != '' AND COALESCE(t.type, 'expense') != 'transfer'`,
  );
  txCatRows.forEach((row) => add(row.category, row.type));

  const budgetCatRows = safeQuery<{ category?: string }>(
    db,
    `SELECT DISTINCT category FROM budgets WHERE category IS NOT NULL AND TRIM(category) != ''`,
  );
  budgetCatRows.forEach((row) => add(row.category, 'expense'));

  return Array.from(seen.values());
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
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
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
      .split(/[^a-z0-9]+/)
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
    const hitSynonyms = group.synonyms.filter((syn) => matchWordOrPhrase(lowered, syn));
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
          .split(/[^a-z0-9]+/)
          .filter((t) => t.length > 0)
          .forEach((t) => consumedTokens.add(t));
      }
    }
  }

  return { matches, consumedTokens };
}

function matchAccountInPrompt(
  cleanedPrompt: string,
  wallets: StoredWallet[],
): { account: { id: number; name: string } | null; consumedTokens: Set<string> } {
  const lowered = cleanedPrompt.toLowerCase();
  const consumedTokens = new Set<string>();
  const sorted = [...wallets].sort((a, b) => b.name.length - a.name.length);

  // Pass 1: Full wallet name
  for (const wallet of sorted) {
    if (matchWordOrPhrase(lowered, wallet.name)) {
      wallet.name
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 0)
        .forEach((t) => consumedTokens.add(t));
      return { account: { id: wallet.id, name: wallet.name }, consumedTokens };
    }
  }

  // Pass 2: Unique distinctive token from wallet name (e.g. "BCA" -> "Bank BCA")
  const tokenToWallets = new Map<string, StoredWallet[]>();
  for (const wallet of sorted) {
    const tokens = wallet.name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
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
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !/^\d+$/.test(token) && !STOP_WORDS.has(token) && !consumedTokens.has(token));

  return Array.from(new Set(rawTokens)).slice(0, 4);
}

export function parseGroundedQuery(
  userPrompt: string,
  options?: { db?: GroundedSqliteDb; now?: Date | number; categories?: StoredCategory[]; wallets?: StoredWallet[] },
): GroundedParsedQuery {
  const db = options?.db ?? expoDb;
  const period = parseTimePeriod(userPrompt, options?.now);
  const cleanedPrompt = period.matchedText ? userPrompt.replace(period.matchedText, ' ') : userPrompt;

  const userCategories = options?.categories ?? loadUserCategories(db);
  const wallets = options?.wallets ?? loadWalletsWithBalances(db);

  const { matches: categories, consumedTokens: categoryTokens } = matchCategoriesInPrompt(cleanedPrompt, userCategories);
  const { account, consumedTokens: accountTokens } = matchAccountInPrompt(cleanedPrompt, wallets);

  const asksBudget = /\b(budget|budgets|budgeted|budgeting|anggaran|bujet|limit|limits|cap|caps|batas|jatah)\b/i.test(
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
    account !== null && !/\b(spend|spent|spending|expense|expenses|pengeluaran|beli|bayar)\b/i.test(userPrompt);
  const asksBalance = explicitBalancePhrase || genericLeftWithoutBudget || accountBalanceImplied;

  const wantsRecent =
    /\b(recent|latest|history|list|show\s+(?:me\s+)?(?:my\s+)?(?:all\s+)?transactions?|all\s+transactions?|last\s+\d*\s*transactions?|transaksi\s+terbaru|transaksi\s+terakhir|transaksi\s+apa\s+saja|pengeluaran\s+terbaru|pengeluaran\s+terakhir|riwayat|daftar\s+transaksi|tampilkan\s+(?:semua\s+)?transaksi|tunjukkan\s+(?:semua\s+|daftar\s+)?transaksi|lihat\s+transaksi)\b/i.test(
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

function formatLineItemSnippet(lineItemsText: string | null | undefined, keywords: string[]): string | null {
  if (!lineItemsText || !lineItemsText.trim()) return null;
  const rawLines = lineItemsText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (rawLines.length === 0) return null;

  const loweredKeywords = keywords.map((k) => k.toLowerCase());
  const matchingLines =
    loweredKeywords.length > 0
      ? rawLines.filter((line) => loweredKeywords.some((kw) => line.toLowerCase().includes(kw)))
      : [];
  const chosen = (matchingLines.length > 0 ? matchingLines : rawLines).slice(0, 2);

  const formatted = chosen.map((line) => {
    const pipeMatch = line.match(/^(.+?)\s*\|\s*(-?\d+(?:\.\d+)?)$/);
    if (pipeMatch) {
      const itemName = pipeMatch[1].trim();
      const price = Number(pipeMatch[2]);
      if (Number.isFinite(price) && price > 0) {
        return `${itemName} ${formatCurrency(price)}`;
      }
    }
    return trimCollapsedText(line, 45);
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
    amountStr = `-${formatCurrency(Math.abs(row.total_amount))}`;
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

function queryKeywordTransactions(
  db: GroundedSqliteDb,
  keywords: string[],
  range: { fromMs: number; toMs: number } | null,
  accountId: number | null,
): MatchedTxRow[] {
  const ftsTerms = keywords
    .map((w) => w.replace(/[^a-z0-9]/gi, ''))
    .filter((w) => w.length >= 2);

  const dateClause = range ? ' AND t.date >= ? AND t.date < ?' : '';
  const walletClause = accountId !== null ? ' AND t.wallet_id = ?' : '';
  const tailParams: any[] = [];
  if (range) tailParams.push(range.fromMs, range.toMs);
  if (accountId !== null) tailParams.push(accountId);

  let rows: MatchedTxRow[] = [];

  if (ftsTerms.length > 0) {
    const matchQuery = ftsTerms.map((w) => `"${w}"*`).join(' OR ');
    rows = safeQuery<MatchedTxRow>(
      db,
      `SELECT
         t.id AS transaction_id,
         t.merchant_name,
         t.total_amount,
         t.type,
         t.date,
         t.note,
         t.line_items_text,
         i.category
       FROM transactions_fts fts
       JOIN transactions t ON fts.rowid = t.id
       LEFT JOIN transaction_items i ON t.id = i.transaction_id
       WHERE transactions_fts MATCH ?${dateClause}${walletClause}
       ORDER BY fts.rank, t.date DESC
       LIMIT 8`,
      [matchQuery, ...tailParams],
    );
  }

  if (rows.length === 0 && ftsTerms.length > 0) {
    const likeConditions = ftsTerms
      .map(() => '(t.merchant_name LIKE ? OR t.note LIKE ? OR t.line_items_text LIKE ? OR i.category LIKE ?)')
      .join(' OR ');
    const likeParams: string[] = [];
    ftsTerms.forEach((term) => {
      const pattern = `%${term}%`;
      likeParams.push(pattern, pattern, pattern, pattern);
    });

    rows = safeQuery<MatchedTxRow>(
      db,
      `SELECT
         t.id AS transaction_id,
         t.merchant_name,
         t.total_amount,
         t.type,
         t.date,
         t.note,
         t.line_items_text,
         i.category
       FROM transactions t
       LEFT JOIN transaction_items i ON t.id = i.transaction_id
       WHERE (${likeConditions})${dateClause}${walletClause}
       ORDER BY t.date DESC
       LIMIT 8`,
      [...likeParams, ...tailParams],
    );
  }

  // Deduplicate by transaction_id
  const unique: MatchedTxRow[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    if (typeof row.transaction_id === 'number' && !seen.has(row.transaction_id)) {
      seen.add(row.transaction_id);
      unique.push(row);
    }
  }
  return unique;
}

export function buildRetrievedContext(
  userPrompt: string,
  options?: BuildRetrievedContextOptions,
): RetrievedContextItem[] {
  const db = options?.db ?? expoDb;
  const now = options?.now instanceof Date ? options.now : new Date(options?.now ?? Date.now());
  const wallets = loadWalletsWithBalances(db);
  const userCategories = loadUserCategories(db);
  const parsed = parseGroundedQuery(userPrompt, { db, now, categories: userCategories, wallets });

  const { period, account } = parsed;
  const walletFilterSql = account !== null ? ' AND wallet_id = ?' : '';
  const walletFilterJoinSql = account !== null ? ' AND t.wallet_id = ?' : '';
  const periodParams: any[] = account !== null ? [period.fromMs, period.toMs, account.id] : [period.fromMs, period.toMs];

  const items: RetrievedContextItem[] = [];

  // 1. Period header (always present)
  const accountSuffix = account ? `, Account: ${account.name}` : '';
  items.push({
    id: 'period',
    kind: 'period',
    label: 'Period',
    content: `Period: ${period.label}${accountSuffix}`,
    score: 1000,
  });

  // 2. Period totals: total spent, total income, net, transaction count (transfers excluded)
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

  // 3. Top 3 spending categories (transfers excluded)
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

  // 4. Biggest single expense (transfers excluded)
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
       i.category
     FROM transactions t
     LEFT JOIN transaction_items i ON t.id = i.transaction_id
     WHERE t.type != 'transfer' AND t.total_amount < 0 AND t.date >= ? AND t.date < ?${walletFilterJoinSql}
     ORDER BY t.total_amount ASC, t.date DESC
     LIMIT 1`,
    periodParams,
  );
  const biggest = biggestRows[0];
  const refYear = now.getFullYear();

  const summaryItem: RetrievedContextItem =
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
        };

  let biggestItem: RetrievedContextItem | null = null;
  if (biggest && biggest.merchant_name && typeof biggest.amount === 'number' && biggest.amount > 0) {
    const datePart = typeof biggest.date === 'number' ? formatShortDate(biggest.date, refYear) : '';
    biggestItem = {
      id: 'biggest-expense',
      kind: 'biggest-expense',
      label: 'Biggest expense',
      content: `Biggest expense: ${biggest.merchant_name} ${formatCurrency(biggest.amount)} (${datePart})`,
      score: parsed.asksBiggest ? 950 : 850,
    };
  } else if (parsed.asksBiggest) {
    biggestItem = {
      id: 'biggest-expense',
      kind: 'biggest-expense',
      label: 'Biggest expense',
      content: 'Biggest expense: None in this period.',
      score: 950,
    };
  }

  // 5. Budgets for the period (computed before emitting overview so pure empty-budget queries stay focused)
  const usePeriodForBudgets =
    period.kind === 'this-month' || period.kind === 'last-month' || period.kind === 'named-month';
  const budgetFromMs = usePeriodForBudgets ? period.fromMs : new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();
  const budgetToMs = usePeriodForBudgets ? period.toMs : new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0).getTime();
  const budgetPeriodLabel = usePeriodForBudgets
    ? period.label
    : `${MONTH_SHORT_NAMES[now.getMonth()]} ${now.getFullYear()}`;
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

  // When the user asks purely about remaining budget and no budgets exist, omit unrelated
  // cashflow Net figures so the 0.8B model does not substitute Net for remaining budget.
  const isPureEmptyBudgetQuery =
    parsed.asksBudget &&
    budgetRows.length === 0 &&
    !parsed.asksBalance &&
    !parsed.asksBiggest &&
    !parsed.asksIncomeVsSpending &&
    !parsed.wantsRecent &&
    parsed.categories.length === 0 &&
    parsed.keywords.length === 0 &&
    !/\b(spend|spent|spending|expense|expenses|pengeluaran|beli|bayar|habis)\b/i.test(userPrompt);

  if (!isPureEmptyBudgetQuery) {
    // Place general period overview before question-focused facts so the 0.8B model
    // sees the directly requested metrics closest to the user's question.
    if (!parsed.asksIncomeVsSpending) {
      items.push(summaryItem);
    }
    if (topCategoryRows.length > 0) {
      const topStr = topCategoryRows
        .map((row) => `${row.category} ${formatCurrency(row.total ?? 0)}`)
        .join(', ');
      items.push({
        id: 'top-categories',
        kind: 'top-categories',
        label: 'Top categories',
        content: `Top categories: ${topStr}`,
        score: 840,
      });
    }
    if (biggestItem && !parsed.asksBiggest) {
      items.push(biggestItem);
    }
    if (parsed.asksIncomeVsSpending) {
      items.push(summaryItem);
    }
    if (biggestItem && parsed.asksBiggest) {
      items.push(biggestItem);
    }
  }

  // 6. Named category breakdown (spent + top merchants)
  const opportunisticKeywords: string[] = [];
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
    if (catCount > 0) {
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
    } else if (catMatch.triggerTerm.length >= 3) {
      opportunisticKeywords.push(catMatch.triggerTerm);
    }

    if (catMatch.matchedViaSynonym && catMatch.triggerTerm.length >= 3) {
      opportunisticKeywords.push(catMatch.triggerTerm);
    }

    const actionWord = catMatch.type === 'income' ? 'income' : 'spent';
    const txnWord = catCount === 1 ? 'txn' : 'txns';
    items.push({
      id: `category-${catMatch.name.toLowerCase()}`,
      kind: 'category-spending',
      label: `${catMatch.name} ${actionWord}`,
      content: `Category ${catMatch.name}: ${formatCurrency(catTotal)} ${actionWord} (${catCount} ${txnWord}${merchantsSuffix})`,
      score: 950,
    });
  }

  // Emit budgets fact item
  if (budgetRows.length > 0) {
    const namedCatSet = new Set(parsed.categories.map((c) => c.name.toLowerCase()));
    const orderedBudgets = [...budgetRows].sort((a, b) => {
      const aMatch = a.category && namedCatSet.has(a.category.toLowerCase()) ? 1 : 0;
      const bMatch = b.category && namedCatSet.has(b.category.toLowerCase()) ? 1 : 0;
      return bMatch - aMatch;
    });

    const formattedBudgets = orderedBudgets.map((row) => {
      const limit = Number(row.limit_amount ?? 0) || 0;
      const spent = Number(row.spent ?? 0) || 0;
      const remaining = limit - spent;
      const remText =
        remaining >= 0
          ? `remaining ${formatCurrency(remaining)}`
          : `over by ${formatCurrency(Math.abs(remaining))}`;
      return `${row.category}: limit ${formatCurrency(limit)}, spent ${formatCurrency(spent)}, ${remText}`;
    });

    let totalBudgetPrefix = '';
    if (orderedBudgets.length > 1) {
      const sumLimit = orderedBudgets.reduce((s, r) => s + (Number(r.limit_amount ?? 0) || 0), 0);
      const sumSpent = orderedBudgets.reduce((s, r) => s + (Number(r.spent ?? 0) || 0), 0);
      const sumRem = sumLimit - sumSpent;
      const sumRemText =
        sumRem >= 0 ? `remaining ${formatCurrency(sumRem)}` : `over by ${formatCurrency(Math.abs(sumRem))}`;
      totalBudgetPrefix = `Total limit ${formatCurrency(sumLimit)}, spent ${formatCurrency(sumSpent)}, ${sumRemText} | `;
    }

    items.push({
      id: 'budgets-summary',
      kind: 'budget',
      label: 'Budgets',
      content: `Budgets (${budgetPeriodLabel}): ${totalBudgetPrefix}${formattedBudgets.join('; ')}`,
      score: parsed.asksBudget ? 955 : 830,
    });
  } else if (parsed.asksBudget) {
    items.push({
      id: 'budgets-none',
      kind: 'budget',
      label: 'Budgets',
      content: 'Budgets: 0 budgets configured (you have not set any monthly budget limits yet).',
      score: 955,
    });
  }

  // 7. Balance & per-account balances ONLY when question is about balance / money left / specific account
  if (parsed.asksBalance) {
    const totalBalance = wallets.length > 0 ? wallets.reduce((sum, w) => sum + w.balance, 0) : getTotalBalance(db);
    let balanceLine: string;
    if (account) {
      const targetWallet = wallets.find((w) => w.id === account.id);
      const otherWallets = wallets.filter((w) => w.id !== account.id);
      const targetPart = targetWallet
        ? `${targetWallet.name}: ${formatCurrency(targetWallet.balance)}`
        : `${account.name}: ${formatCurrency(0)}`;
      const othersPart =
        otherWallets.length > 0
          ? `; Other: ${otherWallets.map((w) => `${w.name} ${formatCurrency(w.balance)}`).join(', ')}`
          : '';
      balanceLine = `Current balance: ${targetPart}; Total all accounts: ${formatCurrency(totalBalance)}${othersPart}`;
    } else if (wallets.length === 1) {
      balanceLine = `Current balance: ${formatCurrency(totalBalance)} (${wallets[0].name})`;
    } else if (wallets.length > 1) {
      const perAccount = wallets.map((w) => `${w.name} ${formatCurrency(w.balance)}`).join(', ');
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

  // 9. Keyword / Merchant matches (FTS + LIKE fallback)
  const searchTerms = parsed.keywords.length > 0 ? parsed.keywords : Array.from(new Set(opportunisticKeywords));
  const isExplicitKeywordSearch = parsed.keywords.length > 0;

  if (searchTerms.length > 0) {
    let matchedRows = queryKeywordTransactions(db, searchTerms, { fromMs: period.fromMs, toMs: period.toMs }, account?.id ?? null);
    let outsidePeriod = false;

    if (matchedRows.length === 0 && !period.isExplicit) {
      matchedRows = queryKeywordTransactions(db, searchTerms, null, account?.id ?? null);
      outsidePeriod = matchedRows.length > 0;
    }

    const kwLabel = searchTerms.join(' ');
    if (matchedRows.length > 0) {
      const loweredTerms = searchTerms.map((t) => t.toLowerCase());
      const allLineItemOnlyMatches = matchedRows.every((row) => {
        const merchantLower = (row.merchant_name || '').toLowerCase();
        const itemsLower = (row.line_items_text || '').toLowerCase();
        const hitsMerchant = loweredTerms.some((term) => merchantLower.includes(term));
        const hitsLineItem = loweredTerms.some((term) => itemsLower.includes(term));
        return !hitsMerchant && hitsLineItem;
      });

      let sumPart = '';
      if (allLineItemOnlyMatches) {
        let matchedItemSum = 0;
        let matchedItemCount = 0;
        for (const row of matchedRows) {
          for (const rawLine of (row.line_items_text || '').split('\n')) {
            const trimmed = rawLine.trim();
            if (!trimmed) continue;
            if (!loweredTerms.some((term) => trimmed.toLowerCase().includes(term))) continue;
            const pipeMatch = trimmed.match(/^.+?\s*\|\s*(-?\d+(?:\.\d+)?)$/);
            if (pipeMatch) {
              const price = Number(pipeMatch[1]);
              if (Number.isFinite(price) && price > 0) {
                matchedItemSum += price;
                matchedItemCount += 1;
              }
            }
          }
        }
        if (matchedItemCount > 0) {
          sumPart = `, matched item total ${formatCurrency(matchedItemSum)}`;
        }
      } else {
        const expenseMatches = matchedRows.filter((r) => r.type !== 'transfer' && r.total_amount < 0);
        const incomeMatches = matchedRows.filter((r) => r.type !== 'transfer' && r.total_amount > 0);
        const expenseSum = expenseMatches.reduce((s, r) => s + Math.abs(r.total_amount), 0);
        const incomeSum = incomeMatches.reduce((s, r) => s + r.total_amount, 0);

        if (expenseMatches.length > 0 && incomeMatches.length === 0) {
          sumPart = `, total spent ${formatCurrency(expenseSum)}`;
        } else if (incomeMatches.length > 0 && expenseMatches.length === 0) {
          sumPart = `, total income ${formatCurrency(incomeSum)}`;
        }
      }
      const scopePart = outsidePeriod ? ', outside current month' : '';
      const txnWord = matchedRows.length === 1 ? 'txn' : 'txns';

      items.push({
        id: 'kw-summary',
        kind: 'keyword-match',
        label: `Matches for ${kwLabel}`,
        content: `Matching "${kwLabel}" (${matchedRows.length} ${txnWord}${sumPart}${scopePart}):`,
        score: 940,
      });

      matchedRows.slice(0, QWEN_MODEL_RETRIEVAL_ITEM_LIMIT).forEach((row, idx) => {
        items.push({
          id: `kw-tx-${row.transaction_id}`,
          kind: 'keyword-match',
          label: row.merchant_name || 'Match',
          content: `- ${formatTransactionLine(row, searchTerms, true, refYear)}`,
          score: 935 - idx * 10,
        });
      });
    } else if (isExplicitKeywordSearch) {
      items.push({
        id: 'kw-none',
        kind: 'keyword-match',
        label: `Matches for ${kwLabel}`,
        content: `Matching "${kwLabel}": 0 transactions found in ${period.label} (${formatCurrency(0)}).`,
        score: 940,
      });
    }
  }

  // 10. Recent transactions (when asked to show/list transactions)
  if (parsed.wantsRecent) {
    const recentDateClause = period.isExplicit ? ' AND t.date >= ? AND t.date < ?' : '';
    const recentParams: any[] = [];
    if (period.isExplicit) recentParams.push(period.fromMs, period.toMs);
    if (account !== null) recentParams.push(account.id);

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
         MIN(i.category) AS category
       FROM transactions t
       LEFT JOIN transaction_items i ON t.id = i.transaction_id
       WHERE 1=1${recentDateClause}${walletFilterJoinSql}
       GROUP BY t.id
       ORDER BY t.date DESC, t.id DESC
       LIMIT ?`,
      [...recentParams, QWEN_MODEL_RETRIEVAL_ITEM_LIMIT],
    );

    if (recentRows.length > 0) {
      items.push({
        id: 'recent-header',
        kind: 'note',
        label: 'Recent transactions',
        content: `Recent transactions (${recentRows.length}):`,
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
        content: 'Recent transactions: None recorded.',
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
    line: trimCollapsedText(item.content, 260),
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
