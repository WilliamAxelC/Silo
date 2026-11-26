/**
 * Receipt line items from OCR rows, whether or not an item's name and price share a row.
 *
 * Receipts print items in many layouts: "NAME  25,000" on one row; the name on one row and "13,000 X 1  13,000"
 * or "4x @35.000  140.000" on the next; option lines ("+Master Milk", "NORMAL ICE / 1x @0") between; long names
 * wrapped over two rows with the price on the second; discounts as a label plus a negative amount. Skewed photos
 * also move a price onto the row before its name. So the rows are read in order as a stream of names and price
 * groups, and each price is given to the item it belongs to:
 * - the items run from the first priced item to the first total/subtotal/"N items" row;
 * - header rows (dates, "Cashier :", order numbers, addresses, payments) never become items;
 * - a price row with no name of its own goes to the latest item still waiting for a price; with none waiting it
 *   is held for the next name ("1,450,000" printed above "2 Signature Selection");
 * - a row starting with a quantity and listing options ("1 Tiramisu Mocha Latte, Ice, Lar") opens an item whose
 *   next unquantified row is its continuation ("ge, Kenangan Blend, Milk, Less  32,000");
 * - zero-priced and "+" rows are options of the item above; negative amounts are discounts folded into it.
 * Prices must look like prices: with thousands separators, or bare digits only on receipts whose total is
 * printed bare, so IDs, dates, branch codes and postcodes in the header are never read as prices.
 */
import { isNonItemLine, levenshtein } from './receiptText';
import { serializeReceiptLineItems } from '../../features/transactions/lineItems';

const SEPARATED_PRICE = /^\d{1,3}(?:[.,]\d{3})+$/;
const BARE_PRICE = /^\d{3,7}$/;
// "x1", "4x", and OCR slips of "x1" ("xl", "TX").
const QTY_TOKEN = /^(?:[xX×]\s?\d{1,3}|[xX][lI|]|\d{1,3}\s?[xX×]|TX)$/;
const LEADING_QTY = /^(\d{1,2})\s*[xX×]?\s+(?=\S)/;
// "6 Pcs  Cheese Tart": a quantity with its unit before the name.
const LEADING_QTY_UNIT = /^\d{1,3}\s*(?:pcs|pc|buah|bh|porsi|prs|cup|btl|pack|pak|box)\b\.?\s*/i;
// "1023-Chocochip & Walnut", "7015-5apporo": an item code (with at least one digit) glued to the name.
const PRODUCT_CODE = /^(?=[A-Za-z]*\d)[A-Za-z0-9]{2,8}-(?=[\w(])/;

const ITEMS_END_REGEX =
  /^(?:\d+\s*)?(?:sub\s*-?\s*t[o0]?ta[l1!i]|subttl|[gs]?r?and\s*t[a-z0]tal|t[a-z0]t[a4][l1!i]|toal|jotal|tl|ttl|jumlah|amount\s*due|item\s*count|total\s*(?:items?|qty))\b|^\d+(?:[.,]\d+)?\s*x?\s*(?:items?|itens|pcs)\b|^items?\s+\d/i;

// "** BEVERAGE  64,000", "FOOD  1,213,000": a category subtotal (only when it equals the items above it).
const CATEGORY_SUBTOTAL_REGEX =
  /^(?:[*=#]+\s*\S|(?:total\s+)?(?:food|foods|beverages?|drinks?|makanan|minuman|others?|lain-?lain|snacks?|desserts?|dessert)\b)/i;

const MONTHS = 'jan|feb|mar|apr|may|mei|jun|jul|aug|agu|agt|sep|okt|oct|nov|nop|dec|des';
const DATE_REGEX = new RegExp(
  `\\b\\d{1,2}\\s?[/.-]\\s?\\d{1,2}\\s?[/.-]\\s?\\d{2,4}\\b|\\b\\d{1,2}\\s?[/ -]?(?:${MONTHS})[a-z]*[/ -]?\\s?\\d{2,4}\\b|\\b(?:${MONTHS})[a-z]*\\s+\\d{1,2}\\b`,
  'i',
);
const TIME_REGEX = /\b\d{1,2}:\d{2}\b/;
const HEADER_KEY_REGEX =
  /^(?:date|tanggal|tgl|time|jam|waktu|order|no\b|nomor|receipt|struk|nota|bill|invoice|sales|table|tbl|meja|purpose|cashier|kasir|server|waiter|customer|cust|pelanggan|member|loyalty|info|channel|pax|guest|pos\b|op\b|operator|machine|mesin|store|toko|outlet|branch|cabang|type|tipe|queue|antrian|kode|code|ref|trx|telp|tel\b|phone|hp\b|wa\b|whatsapp|npwp|alamat|address|wi-?fi|password|ssid|point|poin|card|kartu|app\b|terminal|tid\b|mid\b|batch|trace|approval|collected|printed|closed)[^:]{0,16}:/i;
const URL_REGEX = /@\S*\.|www\.|https?:|\.com\b|\.co\.id\b|\.id\/?$/i;

type Tail = {
  total?: number;
  unit?: number;
  qty?: number;
  grams?: number;
  negative: boolean;
  zero: boolean;
};
type Segment = { text: string; tail: Tail | null };

type Item = {
  name: string;
  leadingQty: boolean;
  total?: number;
  unit?: number;
  qty?: number;
  grams?: number;
  provisional?: boolean;
  options: string[];
  discounts: Array<{ value: number; label: string }>;
};

const LOOKALIKE_DIGITS: Record<string, string> = {
  O: '0',
  o: '0',
  D: '0',
  Q: '0',
  I: '1',
  i: '1',
  l: '1',
  '|': '1',
  S: '5',
  B: '8',
};

/** OCR letters inside an amount ("55.D00", "i2.000", "53.O00"), fixed only when the result is a well-formed price. */
function fixAmountLetters(token: string): string {
  // "1,450,,000": a doubled separator.
  if (/^[-+(@]*\d{1,3}(?:[.,]+\d{3})+\)?$/.test(token) && /[.,]{2}/.test(token))
    token = token.replace(/([.,])[.,]+/g, '$1');
  // "63,636g": a stray letter glued to a well-formed amount.
  const glued = token.match(/^([-+(@]*\d{1,3}(?:[.,]\d{3})+)[A-Za-z]$/);
  if (glued) return glued[1];
  const match = token.match(/^([-+(@]*)([\dODQIil|SB.,]+)(\)?)$/);
  if (!match || !/\d/.test(match[2]) || /^[\d.,]+$/.test(match[2])) return dropZeroCents(token);
  const digits = match[2].replace(/[ODQIil|SB]/g, (c) => LOOKALIKE_DIGITS[c]);
  const fixed = dropZeroCents(`${match[1]}${digits}${match[3]}`);
  return SEPARATED_PRICE.test(fixed.replace(/^[-+(@]+|\)$/g, '')) ? fixed : token;
}

/** "45,000.00", "165000,00": rupiah printed with zero cents. Non-zero cents (another currency) stay as they are. */
function dropZeroCents(token: string): string {
  return token.replace(
    /^([-+(@]*\d[\d.,]*?\d)[.,]00(\)?)$/,
    (whole, amount: string, paren: string) =>
      SEPARATED_PRICE.test(amount) || /^\d{3,7}$/.test(amount) ? `${amount}${paren}` : whole,
  );
}

function formatThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

const toInt = (digits: string) => Number(digits.replace(/\D/g, ''));
const letterCount = (text: string) => (text.match(/\p{L}/gu) ?? []).length;

/** Splits a row segment into its text and the numbers after the last word: prices, "@unit", "X 1", "1x". */
function parseSegment(raw: string, allowBare: boolean): Segment {
  const cleaned = raw
    .replace(/(^|\s)[•·]\s*/g, '$1')
    .replace(/(^|\s)(-?)\s*(?:Rp|IDR)\.?\s*(?=[\d(]|[ODQIil|]\d)/gi, '$1$2')
    .replace(/(\d),-$/, '$1')
    .replace(/\b(\d{1,3}[.,])\s(\d{3})\b/g, '$1$2')
    .trim()
    // "20 000" at the end of a price group: a thousands separator read as a space.
    .replace(/(\d,\d{3}|\d\.\d{3})\s(\d{1,3})\s(\d{3})$/, '$1 $2,$3');
  const tokens = cleaned.split(/\s+/).filter(Boolean).map(fixAmountLetters);
  // "BLACK SAKURA  45 455": a thousands separator read as a space, when neither half is a price by itself.
  const count = tokens.length;
  if (
    count >= 2 &&
    !allowBare &&
    /^\d{1,3}$/.test(tokens[count - 2]) &&
    /^\d{3}$/.test(tokens[count - 1]) &&
    /^\p{L}{2,}\W?$/u.test(tokens[count - 3] ?? 'ab')
  ) {
    tokens.splice(count - 2, 2, `${tokens[count - 2]},${tokens[count - 1]}`);
  }
  let lastWord = -1;
  tokens.forEach((token, i) => {
    if (
      letterCount(token) > 0 &&
      !QTY_TOKEN.test(token) &&
      !/^[xX×]$/.test(token) &&
      !/^[@G][\d.,]+$/.test(token)
    ) {
      lastWord = i;
    }
  });
  const text = tokens.slice(0, lastWord + 1).join(' ');
  const prices: Array<{ value: number; at: boolean; negative: boolean; index: number }> = [];
  let qty: number | undefined;
  let explicitQty = false;
  let lastQtyIndex = -1;
  let weight: number | undefined;
  tokens.slice(lastWord + 1).forEach((token, index) => {
    if (QTY_TOKEN.test(token)) {
      const n = Number(token.replace(/\D/g, ''));
      if (n > 0) qty = n;
      else if (/^[xX][lI|]$|^TX$/.test(token)) qty = 1;
      explicitQty = true;
      lastQtyIndex = index;
      return;
    }
    if (/^[xX×]$/.test(token)) {
      lastQtyIndex = index;
      return;
    }
    const negative = /^-|^\(.*\)$/.test(token);
    const at = /^[@G]/.test(token);
    const digits = token.replace(/^[-+(@G]+|[)]+$/g, '');
    if (/^0+$/.test(digits) || /^\+0$/.test(token)) {
      prices.push({ value: 0, at, negative: false, index });
      return;
    }
    if (SEPARATED_PRICE.test(digits) || ((allowBare || negative) && BARE_PRICE.test(digits))) {
      prices.push({ value: toInt(digits), at, negative, index });
    } else if (
      /^\d{1,2}$/.test(digits) &&
      qty === undefined &&
      (prices.length > 0 || index === 0)
    ) {
      // "34,000  1  34,000", "2  27,000  54,000", "INDOMIE 3 3,500 10,500": a lone small number is the quantity.
      qty = Number(digits);
      lastQtyIndex = index;
    } else if (/^\d{2,4}$/.test(digits) && prices.length === 0) {
      weight = Number(digits);
    }
  });
  if (prices.length === 0) return { text, tail: null };

  const last = prices[prices.length - 1];
  const tail: Tail = { negative: last.negative, zero: last.value === 0 };
  const unitMarked =
    last.at ||
    (lastQtyIndex > last.index && qty !== undefined) ||
    (prices.length === 1 && explicitQty && qty !== undefined && !text);
  if (unitMarked && qty !== undefined) {
    tail.unit = last.value;
    tail.qty = qty;
    tail.total = last.value * qty;
  } else {
    tail.total = last.value;
    const unit = prices.length > 1 ? prices[prices.length - 2] : undefined;
    if (unit && !unit.negative) tail.unit = unit.value;
    else if (last.at) tail.unit = last.value;
    const tolerance = Math.max(5, last.value * 0.002);
    // "2x 83.000  6.000": an OCR-garbled unit price that does not multiply out is dropped.
    if (
      qty !== undefined &&
      tail.unit !== undefined &&
      Math.abs(qty * tail.unit - last.value) > tolerance
    ) {
      if (explicitQty && qty > 1) tail.unit = undefined;
    }
    // A bare quantity only counts when quantity × unit price is the line total ("PIZZA 12 85,000" is 12 inch).
    if (
      qty !== undefined &&
      (explicitQty ||
        (tail.unit !== undefined && Math.abs(qty * tail.unit - last.value) <= tolerance))
    ) {
      tail.qty = qty;
    }
    // Weighed produce: "TELUR AYAM OMEGA 806 29,400 23,695" is 806 g at 29,400/kg.
    if (
      tail.qty === undefined &&
      weight !== undefined &&
      tail.unit !== undefined &&
      weight >= 10 &&
      Math.abs((weight / 1000) * tail.unit - last.value) <= tolerance
    ) {
      tail.grams = weight;
    }
  }
  return { text, tail };
}

/** Rejoins one row's pieces that ML Kit read as separate lines: a name with its price columns, split prices. */
function mergeNumberSegments(parts: string[], allowBare: boolean): string[] {
  const out: string[] = [];
  const numbersOnly = (part: string) =>
    /\d/.test(part) && parseSegment(part, allowBare).text === '';
  for (const part of parts) {
    const prev = out[out.length - 1];
    if (prev !== undefined && /^\d{1,2}\s*[xX×]?$/.test(prev.trim()) && !numbersOnly(part)) {
      // "1  Creamy Aren Latte": a lone quantity column before the name.
      out[out.length - 1] = `${prev.trim()} ${part}`;
    } else if (prev !== undefined && numbersOnly(part) && !/^\d{1,2}\s*[xX×]?$/.test(prev.trim())) {
      // "2x 83.000" + "6.000", and "** BEVERAGE" + "64,000": one row's name and its price columns.
      out[out.length - 1] = `${prev} ${part}`;
    } else {
      out.push(part);
    }
  }
  return out;
}

function isItemsEnd(text: string): boolean {
  const clean = text.replace(/^[^\p{L}\d]+/u, '').trim();
  if (ITEMS_END_REGEX.test(clean)) return true;
  // OCR-garbled labels: "Tatal", "Iatal", "IEMS:1", "SUBTOTAI".
  const word = clean.split(/[\s:.,]+/)[0].toLowerCase();
  if (word.length < 4) return false;
  if (levenshtein(word, 'subtotal') <= 2) return true;
  if (
    /^[a-z]{4,5}$/.test(word) &&
    (levenshtein(word, 'total') <= 1 || levenshtein(word, 'items') <= 1)
  )
    return true;
  return /^[it][a-z]tal$/.test(word) || (/^i\w{2,4}$/.test(word) && /:\s*\d/.test(clean));
}

function isHeaderText(text: string): boolean {
  return (
    DATE_REGEX.test(text) ||
    TIME_REGEX.test(text) ||
    HEADER_KEY_REGEX.test(text) ||
    /^[A-Za-z]{2,12}\s*:\s*[A-Za-z0-9]{1,12}$/.test(text) ||
    URL_REGEX.test(text) ||
    /\d{7,}/.test(text.replace(/[\s.-]/g, '')) ||
    isNonItemLine(text)
  );
}

function cleanName(text: string, keepMarks = false): { name: string; leadingQty: boolean } {
  let name = text.trim();
  let leadingQty = false;
  for (let i = 0; i < 2; i += 1) {
    const qty = name.match(LEADING_QTY) ?? name.match(LEADING_QTY_UNIT);
    if (!qty) break;
    leadingQty = true;
    name = name.slice(qty[0].length);
  }
  if (keepMarks) return { name, leadingQty };
  name = name
    .replace(PRODUCT_CODE, '')
    .replace(/\s*@\S*$/, '')
    .replace(/[\s:|•·*-]+$/, '')
    .trim();
  return { name, leadingQty };
}

/** Whether bare numbers ("17500") are prices on this receipt: only when its total is printed that way. */
function receiptUsesBarePrices(rows: string[]): boolean {
  let separated = false;
  for (const row of rows) {
    const numbers = (row.match(/\d[\d.,]*\d/g) ?? []).map(dropZeroCents);
    if (numbers.some((n) => SEPARATED_PRICE.test(n))) separated = true;
    if (isItemsEnd(row) && numbers.some((n) => BARE_PRICE.test(n) && n.length >= 4)) return true;
  }
  return !separated;
}

export function extractReceiptItems(rows: string[]): string | null {
  const allowBare = receiptUsesBarePrices(rows);
  const items: Item[] = [];
  let open: Item | null = null;
  let orphan: Tail | null = null;
  let skippedLabel: string | null = null;
  // Index of the first item after the last category subtotal ("** FOOD  214,000").
  let groupStart = 0;
  const priced = () => items.filter((item) => item.total !== undefined && !item.provisional);
  const lastPriced = () => {
    for (let i = items.length - 1; i >= 0; i -= 1)
      if (items[i].total !== undefined) return items[i];
    return null;
  };
  const removeOpenIfUnpriced = () => {
    if (open && open.total === undefined) {
      items.splice(items.indexOf(open), 1);
      const name = open.name;
      open = null;
      return name;
    }
    return null;
  };
  const setPrice = (item: Item, tail: Tail) => {
    item.total = tail.total;
    item.unit = tail.unit ?? item.unit;
    item.qty = tail.qty ?? item.qty;
    item.grams = tail.grams ?? item.grams;
    item.provisional = false;
  };

  outer: for (const row of rows) {
    for (const part of mergeNumberSegments(row.split(/\s{2,}/), allowBare)) {
      const { text, tail } = parseSegment(part, allowBare);
      if (!text && !tail) continue;

      if (text && isItemsEnd(text)) {
        if (priced().length > 0 || /^\W*(?:grand\s*)?t[o0]tal\b(?!\s*(?:items?|qty))/i.test(text))
          break outer;
        continue;
      }

      // Discounts: "-2,000", "(700)", "VOUCHER: (700)", "Discount item30%  -Rp9.900".
      if (tail?.negative) {
        const label = cleanName(text).name || skippedLabel || removeOpenIfUnpriced() || 'Discount';
        skippedLabel = null;
        const target = lastPriced();
        const cleanLabel =
          label.replace(/\s*\([^)]*\)\s*$/, '').replace(/[\s:]+$/, '') || 'Discount';
        if (target && tail.total) target.discounts.push({ value: tail.total, label: cleanLabel });
        continue;
      }

      if (text && (isHeaderText(text) || DATE_REGEX.test(part) || TIME_REGEX.test(part))) {
        skippedLabel = text;
        // A name followed by a header row ("STAFF", then "Cashier : ...") was not an item.
        if (open && open.total === undefined && HEADER_KEY_REGEX.test(text)) removeOpenIfUnpriced();
        continue;
      }
      skippedLabel = null;

      // Options: "+Master Milk", "1 Gula - Normal Sugar  +0", "NORMAL ICE" followed by "1x @0".
      if (tail?.zero) {
        const owner = lastPriced();
        const optionName = text ? cleanName(text).name : removeOpenIfUnpriced();
        if (owner && optionName) owner.options.push(optionName);
        continue;
      }
      const optionText = text ? cleanName(text, true).name : '';
      if (text && /^[+\-=*~]/.test(optionText) && open && !tail?.total) {
        const option = optionText.replace(/^[+\-=*~\s]+|[=*~\s]+$/g, '');
        if (option) open.options.push(option);
        continue;
      }
      if (text && /^\+/.test(text) && open) {
        open.options.push(text.replace(/\s+\d{1,2}$/, ''));
        if (tail && open.total === undefined) setPrice(open, tail);
        continue;
      }

      if (text && tail?.total && groupStart < items.length) {
        const group = items.slice(groupStart).filter((item) => item.total !== undefined);
        const groupSum = group.reduce((sum, item) => sum + item.total!, 0);
        if (groupSum === tail.total) {
          // "Suiiuisi:  17,727": a garbled "Subtotal:" still adds up the items above it.
          if (groupStart === 0 && /:\s*$/.test(text)) break outer;
          if (group.length >= 1 && CATEGORY_SUBTOTAL_REGEX.test(text)) {
            groupStart = items.length;
            continue;
          }
        }
      }

      if (text) {
        const { name, leadingQty } = cleanName(text);
        if (letterCount(name) < 3) {
          if (tail && open && open.total === undefined) setPrice(open, tail);
          continue;
        }
        // The second row of a wrapped name: "1 Creamy Aren Latte, Ice, Large," then "Kenangan Blend, Less Sugar  31,000".
        if (
          open &&
          open.total === undefined &&
          open.leadingQty &&
          !leadingQty &&
          open.name.includes(',')
        ) {
          open.options.push(name);
          if (tail) setPrice(open, tail);
          continue;
        }
        if (open && open.total === undefined) items.splice(items.indexOf(open), 1);
        const item: Item = { name, leadingQty, options: [], discounts: [] };
        if (tail) {
          setPrice(item, tail);
        } else if (orphan) {
          setPrice(item, orphan);
          item.provisional = true;
        }
        orphan = null;
        items.push(item);
        open = item;
        continue;
      }

      // A price group with no name of its own ("13,000 X 1  13,000", "@38.000  38.000", "1,450,000").
      if (tail) {
        if (open && (open.total === undefined || open.provisional)) {
          setPrice(open, tail);
        } else if (
          open &&
          (tail.total === open.total ||
            (tail.unit !== undefined && tail.unit === open.total) ||
            tail.total === open.unit)
        ) {
          open.qty = open.qty ?? tail.qty;
          open.unit = open.unit ?? tail.unit;
        } else {
          orphan = tail;
        }
      }
    }
  }

  const out = items
    .filter((item) => item.total !== undefined && item.total > 0)
    .map((item) => {
      const gross = item.total!;
      const discount = item.discounts.reduce((s, d) => s + d.value, 0);
      const applied = discount > 0 && discount < gross ? item.discounts : [];
      let { name } = item;
      const options = [...item.options];
      // "Tiramisu Mocha Latte, Ice, Large": the options printed after the product name.
      const comma = name.indexOf(',');
      if (comma > 2 && (name.match(/,/g) ?? []).length >= 2) {
        options.unshift(
          name
            .slice(comma + 1)
            .replace(/,\s*$/, '')
            .trim(),
        );
        name = name.slice(0, comma).trim();
      }
      const qty =
        item.qty && item.qty > 1 && item.unit
          ? `${item.qty} × ${formatThousands(item.unit)}`
          : item.grams && item.unit
            ? `${item.grams} g × ${formatThousands(item.unit)}/kg`
            : '';
      const base = qty || (applied.length ? formatThousands(gross) : '');
      const money = `${base}${applied.map((d) => ` - ${formatThousands(d.value)} ${d.label}`).join('')}`;
      const note = [money, ...options.filter(Boolean)].filter(Boolean).join(', ');
      return { name, price: String(applied.length ? gross - discount : gross), note };
    });
  return out.length > 0 ? serializeReceiptLineItems(out) : null;
}
