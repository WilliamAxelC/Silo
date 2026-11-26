import Constants from 'expo-constants';
import type { TextRecognitionResult } from '@react-native-ml-kit/text-recognition';
import { IOcrEngine, OcrResult } from './types';
import {
  buildReceiptRows,
  detectUprightRotation,
  extractAmounts,
  joinSplitThousands,
  extractReceiptDate,
  isNonItemLine,
  OcrLine,
  pickMerchantFromRows,
  pickTotalFromRows,
} from './receiptText';
import { serializeReceiptLineItems } from '../../features/transactions/lineItems';

// Auto-detects: true in Custom Dev Clients, false in Expo Go
export const IS_NATIVE_OCR_SUPPORTED = Constants.appOwnership !== 'expo';

// Manual override: switch to 'false' when you build your native client
export const FORCE_DISABLE_OCR = false;

async function recognizeNativeResult(imageUri: string): Promise<TextRecognitionResult> {
  if (FORCE_DISABLE_OCR || !IS_NATIVE_OCR_SUPPORTED) {
    throw new Error('Native OCR is currently disabled to maintain Expo Go compatibility.');
  }

  const TextRecognition = require('@react-native-ml-kit/text-recognition').default;
  return TextRecognition.recognize(imageUri);
}

export const scanReceiptNative = async (imageUri: string): Promise<string | null> => {
  const result = await recognizeNativeResult(imageUri);
  return result?.text ?? null;
};


/**
 * Auto-reconstructs multi-column OCR blocks where ML Kit separated text columns from numeric columns.
 */
export function reconstructMultiColumnOcrText(rawText: string): string {
  const rawBlocks = rawText.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (rawBlocks.length < 2) return rawText;

  const reconstructedBlocks: string[] = [];
  let i = 0;
  while (i < rawBlocks.length) {
    if (i + 1 < rawBlocks.length) {
      const block1Lines = rawBlocks[i].split('\n').map((l) => l.trim()).filter(Boolean);
      const block2Lines = rawBlocks[i + 1].split('\n').map((l) => l.trim()).filter(Boolean);

      const block1IsText = block1Lines.filter((l) => /[a-zA-Z]{3,}/.test(l)).length >= block1Lines.length * 0.5;
      const block2IsNumbers = block2Lines.filter((l) => /^[\d.,\sRp+-]+$/.test(l)).length >= block2Lines.length * 0.6;

      if (block1IsText && block2IsNumbers && Math.abs(block1Lines.length - block2Lines.length) <= 3) {
        const merged: string[] = [];
        const count = Math.max(block1Lines.length, block2Lines.length);
        for (let j = 0; j < count; j++) {
          const text = block1Lines[j] || '';
          const num = block2Lines[j] || '';
          merged.push(`${text} ${num}`.trim());
        }
        reconstructedBlocks.push(merged.join('\n'));
        i += 2;
        continue;
      }
    }
    reconstructedBlocks.push(rawBlocks[i]);
    i++;
  }

  return reconstructedBlocks.join('\n\n');
}


/**
 * Parses raw OCR text with specialized heuristics for Indonesian & international receipts.
 * Handles keywords like TOTAL, GRAND TOTAL, TOTAL BAYAR, AMOUNT DUE, TAGIHAN,
 * ignoring subtotal, tax/PPN/PB1, discount, and cash tendered/change.
 */
export function parseReceiptTextHeuristic(rawText: string): {
  extractedTotal: number | null;
  extractedMerchant: string | null;
  extractedDate: string | null;
  extractedCategory: string | null;
  extractedLineItems: string | null;
} {
  const reconstructedText = reconstructMultiColumnOcrText(rawText);
  const lines = reconstructedText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return { extractedTotal: null, extractedMerchant: null, extractedDate: null, extractedCategory: null, extractedLineItems: null };
  }

  // 1. Extract Merchant Name candidate from top header lines (skipping prices, items, totals, promos & disclaimers)
  const extractedMerchant = pickMerchantFromRows(lines);

  // 2. Extract Total Amount
  let extractedTotal: number | null = pickTotalFromRows(lines);

  // Pass 1: explicit TOTAL / GRAND TOTAL / TOTAL BAYAR / AMOUNT DUE / TAGIHAN / TOTAL BELANJA / TOTAL AKHIR / TOTAL HARGA
  if (!extractedTotal) {
    for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (
      /\b(grand\s*total|total\s*bayar|total\s*belanja|total\s*sales|total\s*amount|total\s*akhir|total\s*harga|total\s*tagihan|amount\s*due|tagihan|total|due|tl)\b/i.test(
        line
      ) || /\b(total\.)\b/i.test(line)
    ) {
      if (
        !/\b(sub\s*total|subtotal|subttl|disc|discount|diskon|item|items|qty|ppn|tax|pajak|pb-?1|charge|service|kembali|change|kembalian)\b/i.test(
          line
        )
      ) {
        let nums = line.match(/\b\d[\d.,]*\d\b|\b\d+\b/g);
        // If keyword line has no numbers, check immediately adjacent next line
        if (!nums && i + 1 < lines.length) {
          nums = lines[i + 1].match(/\b\d[\d.,]*\d\b|\b\d+\b/g);
        }
        if (nums && nums.length > 0) {
          const clean = parseInt(nums[nums.length - 1].replace(/[^\d]/g, ''), 10);
          if (!isNaN(clean) && clean >= 100) {
            extractedTotal = clean;
            break;
          }
        }
      }
    }
    }
  }

  // Pass 2: Fallback to Subtotal if no tax/discount or payment methods
  if (!extractedTotal) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (/\b(sub\s*total|subtotal|subttl)\b/i.test(line)) {
        if (!/\b(kembali|change|kembalian|disc|discount|diskon|ppn|tax|pajak|pb-?1)\b/i.test(line)) {
          let nums = line.match(/\b\d[\d.,]*\d\b|\b\d+\b/g);
          if (!nums && i + 1 < lines.length) {
            nums = lines[i + 1].match(/\b\d[\d.,]*\d\b|\b\d+\b/g);
          }
          if (nums && nums.length > 0) {
            const clean = parseInt(nums[nums.length - 1].replace(/[^\d]/g, ''), 10);
            if (!isNaN(clean) && clean >= 100) {
              extractedTotal = clean;
              break;
            }
          }
        }
      }
    }
  }

  // Pass 3: Fallback to payment method settlement (QRIS, Card, Debit, Cash) excluding change
  if (!extractedTotal) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (
        /\b(debit|qris|gopay|ovo|shopeepay|dana|bca|mandiri|cimb|bni|bri|edc|visa|master|credit|non\s*tunai|tunai|cash|tendered)\b/i.test(
          line
        )
      ) {
        if (!/\b(kembali|change|kembalian|disc|discount|diskon|ppn|tax|pajak|pb-?1)\b/i.test(line)) {
          let nums = line.match(/\b\d[\d.,]*\d\b|\b\d+\b/g);
          if (!nums && i + 1 < lines.length) {
            nums = lines[i + 1].match(/\b\d[\d.,]*\d\b|\b\d+\b/g);
          }
          if (nums && nums.length > 0) {
            const clean = parseInt(nums[nums.length - 1].replace(/[^\d]/g, ''), 10);
            if (!isNaN(clean) && clean >= 100) {
              extractedTotal = clean;
              break;
            }
          }
        }
      }
    }
  }

  // 3. Extract Date (ISO or D-M-Y; skips tax-registration/expiry rows and implausible dates)
  const extractedDate = extractReceiptDate(rawText);

  // 4. Infer Category
  const extractedCategory = inferReceiptCategory(extractedMerchant, reconstructedText);

  // 5. Extract Line Items (excluding the merchant header row so branch codes like "ALFAMART 1024" never become items)
  const extractedLineItems = extractQtyLineItems(lines) ?? extractLineItemsHeuristic(reconstructedText, extractedMerchant);

  return {
    extractedTotal,
    extractedMerchant,
    extractedDate,
    extractedCategory,
    extractedLineItems,
  };
}

export function inferReceiptCategory(merchantName: string | null, rawText: string): string {
  const combined = `${merchantName || ''} ${rawText}`.toLowerCase();

  if (
    /\b(kopi|coffee|cafe|caffe|resto|restaurant|rumah\s*makan|warung|mie|gacoan|bakso|ayam|nasi|padang|kitchen|bistro|tea|teh|bread|roti|bakery|cake|starbucks|hokben|solaria|mcdonald|kfc|burger|pizza|ramen|sushi|dapur|dimsum|makan|kuliner)\b/i.test(
      combined
    )
  ) {
    return 'Food & Dining';
  }

  if (
    /\b(indomaret|alfamart|superindo|hypermart|transmart|hero|lotte|grand\s*lucky|papaya|pasar|kelontong|minimarket|supermarket|mart|buah|sayur|sembako|telur|beras)\b/i.test(
      combined
    )
  ) {
    return 'Groceries';
  }

  if (
    /\b(spbu|pertamina|shell|bp|bensin|bbm|pertamax|pertalite|solar|parkir|parking|toll|tol|gojek|gocar|goride|grab|bluebird|taxi|kereta|kai|mrt|lrt|flight|pesawat|tiket\.com)\b/i.test(
      combined
    )
  ) {
    return 'Transport';
  }

  if (
    /\b(pln|listrik|pdam|air|bpjs|wifi|indihome|telkom|biznet|first\s*media|asuransi|apotek|kimia\s*farma|guardian|watsons|rs|rumah\s*sakit|klinik|dokter|obat|medika|resep)\b/i.test(
      combined
    )
  ) {
    return 'Bills';
  }

  if (
    /\b(cinema|xxi|cgv|cinepolis|bioskop|timezone|karaoke|game|steam|playstation|netflix|spotify|disney|ticket|tiket)\b/i.test(
      combined
    )
  ) {
    return 'Entertainment';
  }

  if (
    /\b(mall|zara|uniqlo|h&m|matahari|shopee|tokopedia|lazada|fashion|baju|sepatu|pakaian|butik|distro|toko)\b/i.test(
      combined
    )
  ) {
    return 'Shopping';
  }

  return 'Food & Dining';
}

function formatIdrThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// Trailing "<qty> <unit price>" columns on a tabular receipt row, e.g. "TELUR AYAM OMEGA 806 29,400" or "INDOMIE 3 3.500".
// OCR sometimes splits "29,400" into "29, 400", hence the optional space after the separator.
const TRAILING_QTY_PRICE_REGEX = /^(.*\p{L}.*?)\s+(\d{1,4}(?:[.,]\d{1,3})?)\s*[x×]?\s+@?\s*(\d{1,3}(?:[.,]\s?\d{3})+|\d{3,})$/u;

/**
 * Moves qty / unit-price columns out of an item name into its note, but only when they reconcile with the
 * line total (qty × unit, or grams × price-per-kg for weighed produce). Otherwise the name is left untouched,
 * so product names that merely end in numbers ("AQUA 600", "TEH BOTOL 350") are not mangled.
 */
export function splitQtyPriceColumns(name: string, lineTotal: number): { name: string; note: string } {
  const match = name.match(TRAILING_QTY_PRICE_REGEX);
  if (!match) return { name, note: '' };

  const baseName = match[1].replace(/[\s\-:|]+$/, '').trim();
  const qty = Number(match[2].replace(',', '.'));
  const unitPrice = Number(match[3].replace(/\D/g, ''));
  if (!baseName || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitPrice) || unitPrice <= 0) {
    return { name, note: '' };
  }

  const tolerance = Math.max(5, lineTotal * 0.002);
  if (Math.abs(qty * unitPrice - lineTotal) <= tolerance) {
    return { name: baseName, note: qty === 1 ? '' : `${match[2]} × ${formatIdrThousands(unitPrice)}` };
  }
  if (Number.isInteger(qty) && qty >= 10 && Math.abs((qty / 1000) * unitPrice - lineTotal) <= tolerance) {
    return { name: baseName, note: `${qty} g × ${formatIdrThousands(unitPrice)}/kg` };
  }
  return { name, note: '' };
}

// "13,000 X 1" (unit price X qty), optionally followed by the line total on the same OCR line.
const UNIT_X_QTY_REGEX = /^@?\s*(\d{1,3}(?:[.,]\d{3})+|\d{3,})\s*[xX×]\s*(\d{1,3})(?:\s+(-?\d{1,3}(?:[.,]\d{3})+))?$/;
const SIGNED_AMOUNT_REGEX = /^(-)?\s*(?:Rp\.?\s*)?(\d{1,3}(?:[.,]\d{3})+|\d{4,})$/i;
const NAME_WITH_AMOUNT_REGEX = /^(.*\p{L}.*?)\s+(-?\s*(?:Rp\.?\s*)?\d{1,3}(?:[.,]\d{3})+)$/u;
const ITEMS_END_REGEX = /^(?:sub\s*total|subttl|grand\s*total|total|tl|ttl)\b/i;

const toInt = (digits: string) => Number(digits.replace(/\D/g, ''));

type QtySegment =
  | { kind: 'qty'; unit: number; qty: number }
  | { kind: 'amount'; value: number }
  | { kind: 'text'; text: string };

function qtyRowSegments(row: string): QtySegment[] {
  const out: QtySegment[] = [];
  for (const raw of row.split(/\s{2,}/)) {
    const part = raw.trim();
    if (!part) continue;
    const qty = part.match(UNIT_X_QTY_REGEX);
    if (qty) {
      out.push({ kind: 'qty', unit: toInt(qty[1]), qty: Number(qty[2]) });
      if (qty[3]) out.push({ kind: 'amount', value: (qty[3].startsWith('-') ? -1 : 1) * toInt(qty[3]) });
      continue;
    }
    const amount = part.match(SIGNED_AMOUNT_REGEX);
    if (amount) {
      out.push({ kind: 'amount', value: (amount[1] ? -1 : 1) * toInt(amount[2]) });
      continue;
    }
    if (!/\p{L}{2}/u.test(part)) continue;
    const named = part.match(NAME_WITH_AMOUNT_REGEX);
    if (named) {
      out.push({ kind: 'text', text: named[1].replace(/[\s:|-]+$/, '').trim() });
      out.push({ kind: 'amount', value: (/^-/.test(named[2]) ? -1 : 1) * toInt(named[2]) });
    } else {
      out.push({ kind: 'text', text: part });
    }
  }
  return out;
}

/**
 * Items on receipts that print the name on one line and "unit X qty   line total" on the next (FamilyMart,
 * Lawson and similar minimarkets), with discounts as a name line plus a negative amount. Skewed photos put
 * the line total on the name row or a qty row before the next name, so segments are paired in reading order:
 * a qty or total belongs to the latest name that still lacks one and agrees with it (unit × qty = total).
 * Discounts are folded into the item above them so the items add up to the receipt total.
 * Returns null when the receipt has no "unit X qty" rows, leaving it to the one-line parser.
 */
export function extractQtyLineItems(rows: string[]): string | null {
  type Candidate = {
    name: string;
    unit?: number;
    qty?: number;
    amount?: number;
    discounts: Array<{ value: number; label: string }>;
  };
  const candidates: Candidate[] = [];
  let pendingQty: { unit: number; qty: number } | null = null;
  let sawQty = false;
  // A summary-looking text right before a negative amount ("Onigiri Disc 2rb") still names that discount.
  let skippedLabel: string | null = null;
  const confirmed = () => candidates.filter((c) => c.qty !== undefined);
  const last = () => candidates[candidates.length - 1];

  outer: for (const row of rows) {
    for (const seg of qtyRowSegments(row)) {
      if (seg.kind === 'text') {
        if (ITEMS_END_REGEX.test(seg.text) && confirmed().length > 0) break outer;
        if (isNonItemLine(seg.text)) {
          skippedLabel = seg.text;
          continue;
        }
        skippedLabel = null;
        const candidate: Candidate = { name: seg.text, discounts: [] };
        if (pendingQty) {
          Object.assign(candidate, pendingQty);
          pendingQty = null;
        }
        candidates.push(candidate);
      } else if (seg.kind === 'qty') {
        sawQty = true;
        skippedLabel = null;
        const c = last();
        if (c && c.qty === undefined && (c.amount === undefined || c.amount === seg.unit * seg.qty)) {
          c.unit = seg.unit;
          c.qty = seg.qty;
        } else {
          pendingQty = { unit: seg.unit, qty: seg.qty };
        }
      } else if (seg.value < 0) {
        const c = last();
        // A name with no qty right before a negative amount is the discount's label, not an item.
        const label =
          skippedLabel ?? (c && c.qty === undefined && c.amount === undefined ? candidates.pop()!.name : 'disc');
        skippedLabel = null;
        const target = confirmed().pop();
        // Drop a trailing promo time window like "(20.00 - 00.00)".
        if (target) target.discounts.push({ value: -seg.value, label: label.replace(/\s*\([^)]*\)\s*$/, '') || 'disc' });
      } else {
        skippedLabel = null;
        const c = last();
        if (c && c.amount === undefined && (c.qty === undefined || c.unit! * c.qty === seg.value)) {
          c.amount = seg.value;
        }
      }
    }
  }

  if (!sawQty) return null;
  const items = confirmed()
    .map((c) => {
      const gross = c.amount ?? c.unit! * c.qty!;
      const discount = c.discounts.reduce((s, d) => s + d.value, 0);
      const base = c.qty! > 1 ? `${c.qty} × ${formatIdrThousands(c.unit!)}` : formatIdrThousands(gross);
      const note = c.discounts.length
        ? `${base}${c.discounts.map((d) => ` - ${formatIdrThousands(d.value)} ${d.label}`).join('')}`
        : c.qty! > 1
          ? base
          : '';
      return { name: c.name, price: String(gross - discount), note };
    })
    .filter((item) => Number(item.price) > 0);
  return items.length > 0 ? serializeReceiptLineItems(items) : null;
}

export function extractLineItemsHeuristic(reconstructedText: string, merchantName?: string | null): string | null {
  const lines = reconstructedText.split('\n').map((l) => l.trim()).filter(Boolean);
  const resolvedMerchant = merchantName !== undefined ? merchantName : pickMerchantFromRows(lines);
  const normalizedMerchant = resolvedMerchant?.trim().toLowerCase() ?? null;
  const items: Array<{ name: string; price: string; note: string }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Never treat the merchant header row (e.g. "ALFAMART 1024" or "APOTEK KIMIA FARMA 124") as a line item.
    if (normalizedMerchant && i < 6 && line.toLowerCase().includes(normalizedMerchant)) {
      const cleanedHeader = line
        .replace(/\b\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b/g, ' ')
        .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (cleanedHeader === normalizedMerchant) {
        continue;
      }
    }
    if (!isNonItemLine(line)) {
      const amounts = extractAmounts(line);
      const hasText = /[a-zA-Z]{3,}/.test(line);
      if (hasText && amounts.length > 0 && line.length >= 6 && line.length <= 60) {
        const price = amounts[amounts.length - 1];
        const name = line
          .replace(/(?:(?:Rp|IDR)\s*\.?\s*)?\d+(?:[.,]\d+)*(?:,-)?\s*$/i, '')
          .replace(/[\s\-:|]+$/, '')
          .trim();
        if (name && !isNonItemLine(name)) {
          items.push({ price: String(price), ...splitQtyPriceColumns(name, price) });
        }
      }
    }
  }

  return items.length > 0 ? serializeReceiptLineItems(items) : null;
}

export function buildOcrResultFromLines(lines: OcrLine[], fallbackText: string): OcrResult {
  const rows = buildReceiptRows(lines);
  const rawText = rows.length > 0 ? rows.join('\n') : fallbackText;

  if (!rawText.trim()) {
    return {
      rawText: '',
      rows: [],
      extractedTotal: null,
      extractedMerchant: null,
      extractedDate: null,
      extractedCategory: null,
      extractedLineItems: null,
      success: false,
      error: 'Empty text returned',
    };
  }

  const parsed = parseReceiptTextHeuristic(rawText);
  const extractedTotal = (rows.length > 0 ? pickTotalFromRows(rows) : null) ?? parsed.extractedTotal;

  return {
    rawText,
    rows,
    extractedTotal,
    extractedMerchant: parsed.extractedMerchant,
    extractedDate: parsed.extractedDate,
    extractedCategory: parsed.extractedCategory,
    extractedLineItems: parsed.extractedLineItems,
    success: true,
    uprightRotation: detectUprightRotation(lines),
  };
}

function extractLinesFromMlKitResult(result: TextRecognitionResult): OcrLine[] {
  const lines: OcrLine[] = [];
  if (Array.isArray(result.blocks)) {
    for (const block of result.blocks) {
      if (!Array.isArray(block?.lines)) continue;
      for (const line of block.lines) {
        if (!line?.text) continue;
        lines.push({
          text: joinSplitThousands(line.text),
          frame: line.frame
            ? {
                left: line.frame.left,
                top: line.frame.top,
                width: line.frame.width,
                height: line.frame.height,
              }
            : undefined,
          cornerPoints: Array.isArray(line.cornerPoints) ? line.cornerPoints : undefined,
        });
      }
    }
  }

  if (lines.length === 0 && result.text) {
    for (const text of result.text.split('\n')) {
      if (text.trim()) {
        lines.push({ text });
      }
    }
  }

  return lines;
}

export class MlKitEngine implements IOcrEngine {
  async processImage(imageUri: string): Promise<OcrResult> {
    try {
      const result = await recognizeNativeResult(imageUri);

      if (!result || !result.text) {
        return {
          rawText: '',
          rows: [],
          extractedTotal: null,
          extractedMerchant: null,
          extractedDate: null,
          extractedCategory: null,
          extractedLineItems: null,
          success: false,
          error: 'Empty text returned',
        };
      }

      const lines = extractLinesFromMlKitResult(result);
      return buildOcrResultFromLines(lines, result.text);
    } catch (error: any) {
      return {
        rawText: '',
        rows: [],
        extractedTotal: null,
        extractedMerchant: null,
        extractedDate: null,
        extractedCategory: null,
        extractedLineItems: null,
        success: false,
        error: error?.message || 'Unknown OCR Error',
      };
    }
  }
}

export const defaultOcrEngine = new MlKitEngine();