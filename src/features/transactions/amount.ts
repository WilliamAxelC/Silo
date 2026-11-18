/**
 * Formats a raw text input by stripping non-numeric characters and inserting thousand separators.
 * Uses '.' thousand separators (id-ID style) to match formatDisplayCurrency.
 */
export function formatAmountInput(text: string): string {
  if (!text) return '';
  const numericValue = text.replace(/[^0-9]/g, '');
  if (!numericValue) return '';
  const strippedLeadingZeros = numericValue.replace(/^0+(?=\d)/, '');
  return strippedLeadingZeros.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * Rounds an amount to the specified number of decimal places, preventing floating point imprecision.
 */
export function roundCurrency(amount: number, decimals: number = 2): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return 0;
  }
  const factor = Math.pow(10, decimals);
  return Math.round((amount + Number.EPSILON) * factor) / factor;
}

/**
 * Parses any string, number, or nullish input into a signed currency amount based on transaction type.
 * Supports IDR conventions (dot thousands separators, comma decimals, Rp prefix, trailing ,- sen notation).
 * If type is omitted, preserves sign of input.
 * Returns negative amounts for expense/transfer, and positive amounts for income.
 */
export function parseSignedAmount(
  value: string | number | null | undefined,
  type?: 'income' | 'expense' | 'transfer' | string
): number {
  if (value === null || value === undefined || value === '') return 0;

  let parsed: number;
  let isNegative = false;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || isNaN(value)) return 0;
    parsed = Math.abs(value);
    isNegative = value < 0;
  } else {
    let str = String(value).trim();
    if (!str) return 0;

    // Strip trailing Indonesian sen dash e.g. "Rp 45.000,-" -> "Rp 45.000"
    str = str.replace(/,-\s*$/, '');

    // Detect negative sign before digits or currency symbol
    if (/-\s*\d/.test(str) || /-\s*[A-Za-z$]/.test(str) || /^\s*-/.test(str)) {
      isNegative = true;
    }

    // Keep only digits, commas, dots
    const cleaned = str.replace(/[^\d.,]/g, '').trim();
    if (!cleaned) return 0;

    const hasComma = cleaned.includes(',');
    const hasDot = cleaned.includes('.');

    let normalized: string;

    if (hasComma && hasDot) {
      const lastCommaIndex = cleaned.lastIndexOf(',');
      const lastDotIndex = cleaned.lastIndexOf('.');

      if (lastDotIndex > lastCommaIndex) {
        // e.g. 1,500.50 (English style: comma is thousand, dot is decimal)
        normalized = cleaned.replace(/,/g, '');
      } else {
        // e.g. 1.500,50 (Indonesian / European style: dot is thousand, comma is decimal)
        normalized = cleaned.replace(/\./g, '').replace(',', '.');
      }
    } else if (hasDot) {
      const dotCount = (cleaned.match(/\./g) || []).length;
      if (dotCount > 1) {
        // Multiple dots: e.g. 1.500.000 -> all dots are thousands separators
        normalized = cleaned.replace(/\./g, '');
      } else {
        // Single dot: e.g. 45.000 vs 12.5 or 12.50
        // Rule: single dot + 1-2 digits -> decimal separator
        // single dot + 3 digits -> thousands separator
        if (/\.\d{1,2}$/.test(cleaned)) {
          normalized = cleaned;
        } else {
          normalized = cleaned.replace(/\./g, '');
        }
      }
    } else if (hasComma) {
      const commaCount = (cleaned.match(/,/g) || []).length;
      if (commaCount > 1) {
        // e.g. 1,500,000 -> thousands separators
        normalized = cleaned.replace(/,/g, '');
      } else {
        // Single comma: e.g. 45,000 vs 12,5
        if (/,\d{1,2}$/.test(cleaned)) {
          normalized = cleaned.replace(',', '.');
        } else {
          normalized = cleaned.replace(/,/g, '');
        }
      }
    } else {
      normalized = cleaned;
    }

    parsed = parseFloat(normalized);
  }

  if (isNaN(parsed) || !Number.isFinite(parsed)) return 0;

  const rounded = roundCurrency(Math.abs(parsed));
  if (rounded === 0) return 0;

  if (type === 'income') {
    return rounded;
  }
  if (type === 'expense' || type === 'transfer') {
    return -rounded;
  }
  return isNegative ? -rounded : rounded;
}

/**
 * Safely sums an arbitrary number of amounts while avoiding floating point precision errors.
 */
export function addAmounts(...amounts: (number | null | undefined)[]): number {
  const sum = amounts.reduce<number>((acc, curr) => {
    const val = typeof curr === 'number' && Number.isFinite(curr) ? curr : 0;
    return acc + val;
  }, 0);
  return roundCurrency(sum);
}

/**
 * Calculates total from a list of objects containing an amount property.
 */
export function calculateTotal(items: Array<{ amount?: number | null }>): number {
  return addAmounts(...items.map((item) => item?.amount));
}

/**
 * Splits a total amount evenly across N parts, distributing remainder cents so sum(parts) === total.
 */
export function splitAmount(total: number, parts: number, decimals: number = 2): number[] {
  if (parts <= 0 || !Number.isFinite(total)) return [];
  if (parts === 1) return [roundCurrency(total, decimals)];

  const factor = Math.pow(10, decimals);
  const totalCents = Math.round(total * factor);
  const baseCents = Math.trunc(totalCents / parts);
  const remainderCents = totalCents - baseCents * parts;

  const result: number[] = [];
  const absRemainder = Math.abs(remainderCents);
  const sign = remainderCents >= 0 ? 1 : -1;

  for (let i = 0; i < parts; i++) {
    const extra = i < absRemainder ? sign : 0;
    result.push((baseCents + extra) / factor);
  }

  return result;
}

/**
 * Calculates percentage of part over total safely (0-100), avoiding division by zero.
 */
export function calculatePercentage(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total === 0) {
    return 0;
  }
  const ratio = (part / total) * 100;
  return roundCurrency(ratio);
}

/**
 * Formats display currency according to locale and currency rules.
 */
export function formatDisplayCurrency(
  amount: number | null | undefined,
  currencyCode = 'IDR',
  useThousands = true
): string {
  const safeAmount = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
  const normalizedAmount = Object.is(safeAmount, -0) ? 0 : safeAmount;

  if (!useThousands) {
    return `${currencyCode === 'IDR' ? 'Rp' : currencyCode} ${normalizedAmount}`;
  }

  try {
    return new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: currencyCode || 'IDR',
      maximumFractionDigits: currencyCode === 'IDR' ? 0 : 2,
    }).format(normalizedAmount);
  } catch {
    return `${currencyCode} ${normalizedAmount.toLocaleString('en-US')}`;
  }
}
