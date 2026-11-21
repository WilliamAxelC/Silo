import { parseSignedAmount } from '../../features/transactions/amount';

export interface OcrLine {
  text: string;
  frame?: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

interface FramedLine {
  text: string;
  xMin: number;
  yMin: number;
  yMax: number;
  yMid: number;
  height: number;
}

interface RowCluster {
  items: FramedLine[];
  yMin: number;
  yMax: number;
  yMid: number;
  avgHeight: number;
}

const DATE_SLASH_OR_DASH_REGEX = /\b\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b/g;
const DATE_DOT_DMY_REGEX = /\b(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])\.(?:19|20)\d{2}\b/g;
const DATE_DOT_YMD_REGEX = /\b(?:19|20)\d{2}\.(?:0?[1-9]|1[0-2])\.(?:0?[1-9]|[12]\d|3[01])\b/g;
const TIME_REGEX = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
const AMOUNT_TOKEN_REGEX = /(?<![A-Za-z0-9])(?:(?:Rp|IDR|@)\s*\.?\s*)?(\d+(?:[.,]\d+)*)(?![A-Za-z0-9])/gi;

// `TL` is the total line on Casio/Sharp cash registers (e.g. "TL  139,000"); only at row start.
const TOTAL_CANDIDATE_REGEX = /\b(grand\s*total|total\s*belanja|total\s*bayar|total|jumlah|tagihan|amount|netto)\b|^\s*tl\b/i;
const TOTAL_PREFERRED_REGEX = /\b(grand\s*total|total\s*belanja|total\s*bayar)\b/i;
const TOTAL_EXCLUDE_REGEX =
  /\b(sub\s*total|subtotal|sub-total|sub_total|subttl|total\s*items?|total\s*qty|total\s*disc\.?|diskon|discount|kembali|kembalian|change|tunai|cash|ppn|tax|dpp|service)\b/i;

// Exact / full-label summary, tax, fee, discount, payment, tender, and change patterns (anchored on stripped row label).
const NON_ITEM_SUMMARY_LABEL_REGEX =
  /^(?:sub\s*total|subttl|grand\s*total|total(?:\s+(?:belanja|bayar|sales|amount|akhir|harga|tagihan|netto|items?|qty|disc(?:ount)?|diskon|potongan|hemat|pembayaran|payment|keseluruhan|ppn|tax|pajak|service|charge|due))?|tl|ttl|harga\s*jual|jumlah(?:\s+(?:bayar|belanja|harga|item|qty|total))?|tagihan|netto|net\s*sales|net\s*total|amount\s*due|balance\s*due|items?\s*total|sub\s*total\s*items?|dpp|ppn|p\.?\s*b\.?\s*1|pb\s*1|p81|tax|pajak(?:\s+(?:restoran|ppn|pb\s*1))?|vat|gst|sc|service(?:\s*charge)?|serv\s*chg|biaya\s*(?:admin|layanan|service|pengiriman|antar|kemasan|bungkus|kantong|plastik)|admin\s*fee|delivery\s*fee|service\s*fee|platform\s*fee|ongkir|ongkos\s*kirim|rounding|pembulatan|gratuity|tips?|disc(?:ount)?|diskon(?:\s+(?:member|promo|belanja|khusus|karyawan|voucher))?|potongan(?:\s+(?:harga|diskon|voucher|promo|member|poin|kupon|tunai|langsung))?|anda\s+hemat|total\s+hemat|hemat(?:\s+(?:member|promo|belanja|anda))?|voucher(?:\s+(?:diskon|potongan|belanja|promo))?|cash\s*back|cashback|promo(?:\s+(?:diskon|potongan|member|voucher|hemat))?|kupon|coupon|member\s*disc(?:ount)?|cash|tunai|non\s*tunai|change|chnge|chng|kembali(?:an)?|uang\s*(?:tunai|kembali|bayar)|bayar|dibayar|pembayaran|payment|paid|tender(?:ed)?|saldo|balance|debit|credit|kredit|kartu|card|qris|gopay|ovo|dana|shopeepay|linkaja|flazz|e\s*money|brizzi|tapcash|edc|visa|master\s*card|bca|mandiri|bni|bri|cimb|table|meja|order|nota|struk|receipt|invoice)$/i;

// Multi-word payment/settlement labels where both tokens are known payment/bank/method terms (e.g. "DEBIT BCA", "CASH TENDERED", "BAYAR TUNAI").
const PAYMENT_TERM =
  '(?:cash|tunai|non\\s*tunai|change|kembali(?:an)?|bayar|dibayar|pembayaran|payment|paid|tender(?:ed)?|debit|credit|kredit|kartu|card|qris|cpm|gopay|ovo|dana|shopeepay|linkaja|flazz|e\\s*money|brizzi|tapcash|edc|visa|master(?:card)?|bca|mandiri|bni|bri|cimb|transfer|va|virtual\\s*account|idr|rp|uang|saldo|balance|point|points|member)';
const PAYMENT_PHRASE_LABEL_REGEX = new RegExp(`^${PAYMENT_TERM}(?:\\s+${PAYMENT_TERM})+$`, 'i');

// Unambiguous payment/settlement prefixes where any trailing merchant/terminal tag is still a payment row (e.g. "QRIS CPM LAWSON 13,000").
const PAYMENT_PREFIX_REGEX =
  /^(?:qris|gopay|ovo|shopeepay|linkaja|flazz|e-?money|brizzi|tapcash|edc|non\s*tunai|pembayaran|kembalian|tendered)\b/i;

// Anchored receipt metadata rows (addresses, phone numbers, cashier/table/order IDs, status lines).
const METADATA_LINE_PREFIX_REGEX =
  /^(?:jl\.|jalan\s|telp\.?|tlp\.?|phone|fax|kasir|cashier|npwp|struk|receipt|nota|order\s*#|invoice|bill\s*#|no\.?\s*(?:trx|resep|nota|order|struk)|trx\s*id|ref\s*#|approval\s*code|status\s*:|qty\s*:|tanggal|tgl\.?|date\s*:|pos\s*\d|table\s*(?:#|\d)|meja\s*(?:#|\d))\b/i;

// Unambiguous multi-word receipt footers and tax/legal disclaimers (safe for item filtering).
const RECEIPT_DISCLAIMER_REGEX =
  /\b(?:terima\s*kasih|thank\s*you|selamat\s*(?:datang|menikmati|belanja)|barang\s*yang\s*sudah|tidak\s*dapat\s*ditukar|kritik\s*(?:&|dan)?\s*saran|layanan\s*konsumen|call\s*center|customer\s*service|follow\s*us|powered\s*by|printed\s*by|semoga\s*lekas\s*sembuh|sudah\s*termasuk|belum\s*termasuk|termasuk\s*(?:pajak|ppn|asuransi|tax)|include\s*tax|tax\s*included|harga\s*sudah|sponsored\s+by)\b/i;

// Broader promo/disclaimer regex used only when validating merchant header titles (not line items).
const MERCHANT_PROMO_OR_DISCLAIMER_REGEX =
  /\b(promo|diskon|discount|voucher|cashback|gratis|free\s+item|hemat|potongan|sponsored|sponsor|hari\s*ke-?\d*|save\s*\d+%?|sudah\s*termasuk|belum\s*termasuk|termasuk\s*(?:pajak|ppn|asuransi|tax)|include\s*tax|tax\s*included|harga\s*sudah|asuransi|terima\s*kasih|thank\s*you|selamat\s*(?:datang|menikmati|belanja)|barang\s*yang\s*sudah|tidak\s*dapat\s*ditukar|kritik|saran|layanan\s*konsumen|call\s*center|customer\s*service|follow\s*us|instagram|wifi|password|powered\s*by|printed\s*by|reprint|semoga\s*lekas\s*sembuh)\b/i;

const HEADER_METADATA_REGEX =
  /\b(jl\.?|jalan|telp\.?|phone|fax|npwp|receipt|struk|nota|order|table|meja|kasir|cashier|pos\s*\d*|date|tanggal|tgl|invoice|bill\s*#|no\.?\s*(?:trx|resep|nota)|trx\s*id|ref\s*#|pulau\/pompa|approval\s*code|www\.|https?:)\b/i;

// Price-like pattern on a receipt line: Rp/IDR amount, formatted thousands (13,000 / 28.182 / 1.565.938,00 / 60,000.00),
// decimal currency price (12.50 / 45,00), or trailing 5+ digit unformatted IDR price (17500).
// Allows 3-4 digit store/branch IDs (e.g. "ALFAMART 1024", "APOTEK KIMIA FARMA 124") and station codes ("SPBU PERTAMINA 31.129.02").
const EMBEDDED_PRICE_REGEX =
  /(?:^|\s)(?:Rp|IDR)\s*\.?\s*\d|(?:\s|^)\d{1,3}(?:\.\d{3})+(?:,\d{2})?(?:,-)?(?:\s|$)|(?:\s|^)\d{1,3}(?:,\d{3})+(?:\.\d{2})?(?:,-)?(?:\s|$)|\s\d{1,4}[.,]\d{2}\s*$|\s\d{5,}(?:[.,]\d{2})?\s*$/i;

const LEADING_QTY_REGEX = /^\s*(?:\d+\s*[x×]\s+[A-Za-z]|1\s+[A-Za-z])/i;

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function normalizeOcrLeet(token: string, eightAs: 'o' | 'h' | 'b' = 'o'): string {
  return token
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/6/g, 'g')
    .replace(/8/g, eightAs);
}

/**
 * Strips prices, percentages, and punctuation to isolate the descriptive label of an OCR row.
 */
function extractRowLabel(text: string): string {
  return text
    .replace(DATE_SLASH_OR_DASH_REGEX, ' ')
    .replace(DATE_DOT_DMY_REGEX, ' ')
    .replace(DATE_DOT_YMD_REGEX, ' ')
    .replace(TIME_REGEX, ' ')
    .replace(/\(\s*\d+(?:[.,]\d+)?\s*%?\s*\)/g, ' ')
    .replace(/(?:^|\s)(?:Rp|IDR)\s*\.?\s*[\d.,]+(?:,-)?/gi, ' ')
    .replace(/(?:^|\s)[+-]?\d+(?:[.,]\d+)*(?:%|,-)?(?=\s|$)/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Exact post-leet collapsed summary/payment/tax labels (matched against the WHOLE stripped row label).
const EXACT_LEET_NON_ITEM_LABELS = new Set([
  'subtotal',
  'subttl',
  'grandtotal',
  'total',
  'totalbayar',
  'totalbelanja',
  'totalsales',
  'totalamount',
  'totalakhir',
  'totalharga',
  'totaltagihan',
  'totalnetto',
  'totalitem',
  'totalitems',
  'totalqty',
  'totaldisc',
  'totaldiskon',
  'hargajual',
  'jumlah',
  'tagihan',
  'netto',
  'netsales',
  'amountdue',
  'balancedue',
  'cash',
  'tunai',
  'nontunai',
  'change',
  'chnge',
  'chng',
  'kembali',
  'kembalian',
  'bayar',
  'dibayar',
  'pembayaran',
  'payment',
  'paid',
  'tendered',
  'tax',
  'pajak',
  'ppn',
  'pbi',
  'dpp',
  'vat',
  'gst',
  'discount',
  'diskon',
  'service',
  'servicecharge',
  'rounding',
  'pembulatan',
  'qris',
  'debit',
  'kredit',
  'credit',
]);

// Whole-label fuzzy OCR-typo targets (applied ONLY to the entire collapsed label, never individual words of a dish name).
// Short 5-letter words ("total", "tunai", "pajak", "diskon") are intentionally excluded from unconstrained 1-edit fuzzy
// matching so legitimate words like "tunas" or "bajak" are never mistaken for receipt summary keywords.
const FUZZY_WHOLE_LABEL_TARGETS: ReadonlyArray<{ target: string; maxDist: number; minLen: number }> = [
  { target: 'subtotal', maxDist: 2, minLen: 6 },
  { target: 'grandtotal', maxDist: 2, minLen: 8 },
  { target: 'totalbayar', maxDist: 2, minLen: 8 },
  { target: 'totalbelanja', maxDist: 2, minLen: 10 },
  { target: 'kembalian', maxDist: 2, minLen: 7 },
  { target: 'pembulatan', maxDist: 2, minLen: 8 },
  { target: 'discount', maxDist: 1, minLen: 7 },
  { target: 'rounding', maxDist: 1, minLen: 7 },
  { target: 'servicecharge', maxDist: 2, minLen: 11 },
];

/**
 * Returns true ONLY if a receipt line is clearly a summary, tax, payment, tender, change, discount,
 * disclaimer, or metadata row — including OCR-garbled summary lines like "SUS T8TAL", "S8BTOTAL",
 * "CAS8", "CHNGE", "T0TAL", "KEMB4LIAN", "TUN4I", "P81".
 * Never drops legitimate multi-word item names that merely contain words like "cash", "promo",
 * "hemat", "potongan", "total", "tip", "table", "master", "tunas", or "bajak".
 */
export function isNonItemLine(text: string): boolean {
  if (!text || !text.trim()) return true;
  const trimmed = text.trim();

  if (
    METADATA_LINE_PREFIX_REGEX.test(trimmed) ||
    PAYMENT_PREFIX_REGEX.test(trimmed) ||
    RECEIPT_DISCLAIMER_REGEX.test(trimmed)
  ) {
    return true;
  }

  const label = extractRowLabel(trimmed);
  if (!label) return true;

  if (
    NON_ITEM_SUMMARY_LABEL_REGEX.test(label) ||
    PAYMENT_PHRASE_LABEL_REGEX.test(label) ||
    PAYMENT_PREFIX_REGEX.test(label) ||
    RECEIPT_DISCLAIMER_REGEX.test(label)
  ) {
    return true;
  }

  const tokens = label.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;

  // Match OCR-leet and fuzzy typos only against the WHOLE collapsed label (1-3 tokens),
  // never against a single token inside a multi-word dish/product name.
  if (tokens.length <= 3) {
    const rawCollapsed = tokens.join('');
    const collapsedO = normalizeOcrLeet(rawCollapsed, 'o');
    const collapsedB = normalizeOcrLeet(rawCollapsed, 'b');
    const collapsedH = normalizeOcrLeet(rawCollapsed, 'h');

    if (
      EXACT_LEET_NON_ITEM_LABELS.has(collapsedO) ||
      EXACT_LEET_NON_ITEM_LABELS.has(collapsedB) ||
      EXACT_LEET_NON_ITEM_LABELS.has(collapsedH) ||
      /^ch?ng[e3]?$/i.test(collapsedO)
    ) {
      return true;
    }

    for (const { target, maxDist, minLen } of FUZZY_WHOLE_LABEL_TARGETS) {
      if (collapsedO.length < minLen) continue;
      if (Math.abs(collapsedO.length - target.length) > maxDist) continue;
      if (
        levenshtein(collapsedO, target) <= maxDist ||
        levenshtein(collapsedB, target) <= maxDist ||
        levenshtein(collapsedH, target) <= maxDist
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Returns true when a candidate merchant title looks like a line item, total/payment row,
 * promo/disclaimer text, address/metadata, or garbled OCR rather than a merchant name.
 */
export function isSuspiciousMerchantName(name: string | null | undefined): boolean {
  if (!name) return true;
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 48) return true;

  // Strip trailing dates/times when checking text substance (e.g. "Test Merchant  12/03/2026")
  const withoutDates = trimmed
    .replace(DATE_SLASH_OR_DASH_REGEX, ' ')
    .replace(DATE_DOT_DMY_REGEX, ' ')
    .replace(DATE_DOT_YMD_REGEX, ' ')
    .replace(TIME_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (withoutDates.length < 2) return true;

  const letterCount = (withoutDates.match(/[A-Za-z]/g) ?? []).length;
  const nonSpaceCount = withoutDates.replace(/\s+/g, '').length;
  if (letterCount < 2 || (nonSpaceCount > 0 && letterCount / nonSpaceCount < 0.35)) {
    return true;
  }

  if (EMBEDDED_PRICE_REGEX.test(withoutDates)) {
    return true;
  }

  if (LEADING_QTY_REGEX.test(withoutDates)) {
    return true;
  }

  if (MERCHANT_PROMO_OR_DISCLAIMER_REGEX.test(withoutDates) || HEADER_METADATA_REGEX.test(withoutDates)) {
    return true;
  }

  if (isNonItemLine(withoutDates)) {
    return true;
  }

  return false;
}

/**
 * Picks a clean merchant name from the top header rows of OCR text, skipping prices,
 * item rows, totals, promos, disclaimers, addresses, and metadata.
 */
export function pickMerchantFromRows(rows: string[]): string | null {
  for (const rawRow of rows.slice(0, 6)) {
    const line = (rawRow ?? '').trim();
    if (!line || line.length < 3 || line.length > 48) continue;
    if (/^\d+$/.test(line) || /^[\d\W]+$/.test(line)) continue;

    // Strip trailing date/time if the header row combined merchant + date on one visual line
    const cleaned = line
      .replace(DATE_SLASH_OR_DASH_REGEX, ' ')
      .replace(DATE_DOT_DMY_REGEX, ' ')
      .replace(DATE_DOT_YMD_REGEX, ' ')
      .replace(TIME_REGEX, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (cleaned.length < 3 || cleaned.length > 40) continue;
    if (!isSuspiciousMerchantName(cleaned)) {
      return cleaned;
    }
  }
  return null;
}

function hasValidFrame(frame: OcrLine['frame']): frame is NonNullable<OcrLine['frame']> {
  return (
    Boolean(frame) &&
    Number.isFinite(frame!.left) &&
    Number.isFinite(frame!.top) &&
    Number.isFinite(frame!.width) &&
    Number.isFinite(frame!.height) &&
    frame!.height > 0
  );
}

/**
 * Groups OCR lines into visual rows using vertical overlap (>= 50% of the smaller height),
 * ordered top-to-bottom, with items inside each row ordered left-to-right and joined by two spaces.
 * Lines without valid frames keep their input order.
 */
export function buildReceiptRows(lines: OcrLine[]): string[] {
  const framed: FramedLine[] = [];
  const unframed: string[] = [];

  for (const line of lines) {
    const text = (line?.text ?? '').trim();
    if (!text) continue;

    if (hasValidFrame(line.frame)) {
      const { left, top, height } = line.frame;
      framed.push({
        text,
        xMin: left,
        yMin: top,
        yMax: top + height,
        yMid: top + height / 2,
        height,
      });
    } else {
      unframed.push(text);
    }
  }

  if (framed.length === 0) {
    return unframed;
  }

  framed.sort((a, b) => a.yMid - b.yMid || a.xMin - b.xMin);

  const clusters: RowCluster[] = [];
  for (const item of framed) {
    let bestCluster: RowCluster | null = null;
    let bestScore = -1;

    for (const cluster of clusters) {
      const overlap = Math.min(item.yMax, cluster.yMax) - Math.max(item.yMin, cluster.yMin);
      const smallerHeight = Math.min(item.height, cluster.avgHeight);
      const overlapRatio = smallerHeight > 0 ? overlap / smallerHeight : 0;

      if (overlapRatio >= 0.5) {
        const score = overlapRatio - 0.001 * Math.abs(item.yMid - cluster.yMid);
        if (score > bestScore) {
          bestScore = score;
          bestCluster = cluster;
        }
      }
    }

    if (!bestCluster) {
      clusters.push({
        items: [item],
        yMin: item.yMin,
        yMax: item.yMax,
        yMid: item.yMid,
        avgHeight: item.height,
      });
    } else {
      bestCluster.items.push(item);
      const count = bestCluster.items.length;
      bestCluster.yMin = bestCluster.items.reduce((sum, x) => sum + x.yMin, 0) / count;
      bestCluster.yMax = bestCluster.items.reduce((sum, x) => sum + x.yMax, 0) / count;
      bestCluster.yMid = bestCluster.items.reduce((sum, x) => sum + x.yMid, 0) / count;
      bestCluster.avgHeight = bestCluster.items.reduce((sum, x) => sum + x.height, 0) / count;
    }
  }

  clusters.sort((a, b) => a.yMid - b.yMid);

  const rowStrings = clusters.map((cluster) => {
    cluster.items.sort((a, b) => a.xMin - b.xMin);
    return cluster.items.map((item) => item.text).join('  ');
  });

  return unframed.length > 0 ? [...rowStrings, ...unframed] : rowStrings;
}

/**
 * Extracts all money-like numbers from text as integer Rupiah amounts.
 */
export function extractAmounts(text: string): number[] {
  if (!text) return [];

  const sanitized = text
    .replace(DATE_SLASH_OR_DASH_REGEX, ' ')
    .replace(DATE_DOT_DMY_REGEX, ' ')
    .replace(DATE_DOT_YMD_REGEX, ' ')
    .replace(TIME_REGEX, ' ');

  const amounts: number[] = [];
  AMOUNT_TOKEN_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = AMOUNT_TOKEN_REGEX.exec(sanitized)) !== null) {
    const token = match[1];
    if (!token || /^0\d/.test(token)) {
      continue;
    }
    const parsed = Math.round(Math.abs(parseSignedAmount(token)));
    if (Number.isFinite(parsed) && parsed >= 100) {
      amounts.push(parsed);
    }
  }

  return amounts;
}

/**
 * Picks the most likely receipt total from visual rows using Indonesian/English keyword rules.
 */
export function pickTotalFromRows(rows: string[]): number | null {
  let preferredTotal: number | null = null;
  let fallbackTotal: number | null = null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !TOTAL_CANDIDATE_REGEX.test(row) || TOTAL_EXCLUDE_REGEX.test(row)) {
      continue;
    }

    const rowAmounts = extractAmounts(row);
    let candidate: number | null = rowAmounts.length > 0 ? rowAmounts[rowAmounts.length - 1] : null;

    if (candidate === null && i + 1 < rows.length) {
      const nextAmounts = extractAmounts(rows[i + 1]);
      if (nextAmounts.length > 0) {
        candidate = nextAmounts[0];
      }
    }

    if (candidate === null) {
      continue;
    }

    if (TOTAL_PREFERRED_REGEX.test(row)) {
      preferredTotal = candidate;
    } else {
      fallbackTotal = candidate;
    }
  }

  if (preferredTotal !== null || fallbackTotal !== null) {
    return preferredTotal ?? fallbackTotal;
  }

  // Tickets/slips often have no TOTAL row, just one "Rp 10.000" price.
  const rupiahAmounts = new Set(rows.filter((row) => /\b(rp|idr)\b/i.test(row)).flatMap(extractAmounts));
  return rupiahAmounts.size === 1 ? [...rupiahAmounts][0] : null;
}

/**
 * Checks whether a candidate total exists among the amounts extracted from the OCR rows.
 */
export function isGrounded(total: number, rows: string[]): boolean {
  if (!Number.isFinite(total) || total <= 0) {
    return false;
  }
  return extractAmounts(rows.join('\n')).includes(Math.round(total));
}
