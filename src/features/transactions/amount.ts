const ZERO_DECIMAL_CURRENCIES = new Set(['IDR', 'JPY', 'KRW', 'VND']);

const CURRENCY_SYMBOLS: Record<string, string> = {
  IDR: 'Rp',
  USD: '$',
  EUR: '€',
  GBP: '£',
  SGD: 'S$',
  JPY: '¥',
  MYR: 'RM',
  THB: '฿',
  KRW: '₩',
  CNY: 'CN¥',
  HKD: 'HK$',
  TWD: 'NT$',
  AUD: 'A$',
  NZD: 'NZ$',
  PHP: '₱',
  VND: '₫',
  INR: '₹',
  CHF: 'CHF',
  SAR: 'SAR',
  AED: 'AED',
};

/**
 * Returns the short user-facing currency prefix/symbol for inputs and labels (e.g. IDR -> "Rp", USD -> "$").
 */
export function getCurrencySymbol(currencyCode: string = 'IDR'): string {
  const normalized = (currencyCode || 'IDR').trim().toUpperCase();
  return CURRENCY_SYMBOLS[normalized] ?? normalized;
}

/**
 * Returns the number of minor-unit decimal places for a currency code.
 * Zero-decimal currencies (IDR, JPY, etc.) return 0; standard currencies return 2.
 */
export function getCurrencyDecimals(currencyCode: string = 'IDR'): number {
  const normalized = (currencyCode || 'IDR').trim().toUpperCase();
  return ZERO_DECIMAL_CURRENCIES.has(normalized) ? 0 : 2;
}

/**
 * Returns true if the currency uses fractional minor units (e.g. USD, EUR, GBP, SGD).
 */
export function currencyHasDecimals(currencyCode: string = 'IDR'): boolean {
  return getCurrencyDecimals(currencyCode) > 0;
}

/**
 * Formats a raw text input for amount entry according to currency rules.
 * - Zero-decimal currencies (IDR, JPY): strips non-digits and inserts '.' thousand separators.
 * - Decimal currencies (USD, EUR, GBP, SGD): keeps up to 2 fractional digits after '.' and
 *   inserts ',' thousand separators on the integer part, preserving in-progress typing like "12." or "12.50".
 */
export function formatAmountInput(text: string, currencyCode: string = 'IDR'): string {
  if (!text) return '';
  const decimals = getCurrencyDecimals(currencyCode);

  if (decimals === 0) {
    const numericValue = text.replace(/[^0-9]/g, '');
    if (!numericValue) return '';
    const strippedLeadingZeros = numericValue.replace(/^0+(?=\d)/, '');
    return strippedLeadingZeros.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  const cleaned = text.replace(/[^0-9.]/g, '');
  if (!cleaned) return '';

  const firstDot = cleaned.indexOf('.');
  if (firstDot === -1) {
    const strippedLeadingZeros = cleaned.replace(/^0+(?=\d)/, '');
    return strippedLeadingZeros.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  const rawInteger = cleaned.slice(0, firstDot);
  const rawFraction = cleaned.slice(firstDot + 1).replace(/\./g, '').slice(0, decimals);
  const integerPart = rawInteger ? rawInteger.replace(/^0+(?=\d)/, '') : '0';
  const formattedInt = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${formattedInt}.${rawFraction}`;
}

/**
 * Formats a stored numeric amount for editing in an amount input field, preserving minor units when supported.
 */
export function formatAmountForInput(amount: number, currencyCode: string = 'IDR'): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '';
  const decimals = getCurrencyDecimals(currencyCode);
  const rounded = roundCurrency(Math.abs(amount), decimals);
  if (decimals === 0) {
    return formatAmountInput(Math.round(rounded).toString(), currencyCode);
  }
  return formatAmountInput(rounded.toString(), currencyCode);
}

/**
 * Parses a stored or scanned price string numerically for the given currency and formats it
 * for display in an input field, avoiding raw digit stripping that turns decimal points into
 * extra digits on zero-decimal currencies (e.g. "12.50" in IDR -> "13", not "1.250").
 */
export function formatStoredAmountForInput(
  value: string | number | null | undefined,
  currencyCode: string = 'IDR'
): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    return formatAmountForInput(value, currencyCode);
  }
  const trimmed = value.trim();
  if (!trimmed || !/\d/.test(trimmed)) return '';
  const parsed = Math.abs(parseSignedAmount(trimmed, undefined, currencyCode));
  return formatAmountForInput(parsed, currencyCode);
}

/**
 * Maximum transaction/calculator amount kept well below Number.MAX_SAFE_INTEGER / 100 (~9e13)
 * so both integer currencies (IDR/JPY) and 2-decimal currencies (USD/EUR/GBP/SGD) remain
 * cent-exact through IEEE-754 arithmetic, rounding, and serialization.
 */
export const MAX_TRANSACTION_AMOUNT = 1e13;

/**
 * Returns true when an amount is finite and within [-MAX_TRANSACTION_AMOUNT, MAX_TRANSACTION_AMOUNT].
 */
export function isAmountWithinRange(amount: number): boolean {
  return typeof amount === 'number' && Number.isFinite(amount) && Math.abs(amount) <= MAX_TRANSACTION_AMOUNT;
}

/**
 * Rounds an amount to the specified number of decimal places, preventing floating point imprecision.
 * Returns exact integers and values near Number.MAX_SAFE_INTEGER unchanged so scaling by 10^decimals
 * never corrupts precision.
 */
export function roundCurrency(amount: number, decimals: number = 2): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return 0;
  }
  if (Object.is(amount, -0) || amount === 0) {
    return 0;
  }
  if (Number.isInteger(amount)) {
    return amount;
  }
  const factor = Math.pow(10, decimals);
  if (!Number.isFinite(factor) || Math.abs(amount) * factor >= Number.MAX_SAFE_INTEGER) {
    return amount;
  }
  const rounded = Math.round((amount + Math.sign(amount) * Number.EPSILON) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Parses any string, number, or nullish input into a signed currency amount based on transaction type.
 * Supports IDR conventions (dot thousands separators, comma decimals, Rp prefix, trailing ,- sen notation)
 * as well as decimal-currency inputs (comma thousands, dot decimals) when currencyCode is provided.
 * If type is omitted, preserves sign of input.
 * Returns negative amounts for expense/transfer, and positive amounts for income.
 */
export function parseSignedAmount(
  value: string | number | null | undefined,
  type?: 'income' | 'expense' | 'transfer' | string,
  currencyCode?: string
): number {
  if (value === null || value === undefined || value === '') return 0;

  const hasCurrencyContext = typeof currencyCode === 'string' && currencyCode.trim().length > 0;
  const targetDecimals = hasCurrencyContext ? getCurrencyDecimals(currencyCode) : 2;
  const allowCurrencyDecimals = hasCurrencyContext && targetDecimals > 0;

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
      } else if (allowCurrencyDecimals) {
        // In decimal currencies (USD/EUR/GBP/SGD), a single dot is always the decimal separator
        normalized = cleaned;
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
      } else if (allowCurrencyDecimals) {
        // In decimal-currency input formatting, commas are thousand separators unless clearly 1-2 digit decimal
        if (/,\d{1,2}$/.test(cleaned)) {
          normalized = cleaned.replace(',', '.');
        } else {
          normalized = cleaned.replace(/,/g, '');
        }
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

  const rounded = roundCurrency(Math.abs(parsed), targetDecimals);
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
 * Always places the minus sign before the currency symbol/code for negative amounts.
 */
export function formatDisplayCurrency(
  amount: number | null | undefined,
  currencyCode = 'IDR',
  useThousands = true
): string {
  const safeAmount = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
  const normalizedAmount = Object.is(safeAmount, -0) ? 0 : safeAmount;
  const isNegative = normalizedAmount < 0;
  const absAmount = Math.abs(normalizedAmount);
  const sign = isNegative ? '-' : '';
  const decimals = getCurrencyDecimals(currencyCode);

  if (!useThousands) {
    return `${sign}${currencyCode === 'IDR' ? 'Rp' : currencyCode} ${absAmount}`;
  }

  try {
    const code = (currencyCode || 'IDR').toUpperCase();
    if (code !== 'IDR' && CURRENCY_SYMBOLS[code]) {
      // Intl's id-ID locale writes "JP¥"/"US$"; use the app's short symbols for foreign currencies.
      const number = new Intl.NumberFormat('id-ID', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(absAmount);
      return `${sign}${CURRENCY_SYMBOLS[code]}\u00a0${number}`;
    }
    const formattedAbs = new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: code,
      maximumFractionDigits: decimals,
    }).format(absAmount);
    return `${sign}${formattedAbs}`;
  } catch {
    return `${sign}${currencyCode} ${absAmount.toLocaleString('en-US')}`;
  }
}

/**
 * Formats an amount into a compact, cell-safe string for dense spaces like the monthly calendar grid.
 * - IDR: uses Indonesian suffixes and comma decimal separator (e.g. 45rb, 1,2jt, 1,5M).
 * - Other currencies: uses dot decimal separator and k/M/B/T suffixes (e.g. 1.2k, 45k, 1.2M).
 * Always formats the absolute magnitude; callers convey direction via color or prefix.
 */
export function formatCompactAmount(amount: number | null | undefined, currencyCode: string = 'IDR'): string {
  const safe = typeof amount === 'number' && Number.isFinite(amount) ? Math.abs(amount) : 0;
  if (safe === 0) return '0';

  const normalizedCode = (currencyCode || 'IDR').trim().toUpperCase();
  const isIdr = normalizedCode === 'IDR';
  const decimalSep = isIdr ? ',' : '.';

  const tiers: ReadonlyArray<{ threshold: number; suffix: string }> = isIdr
    ? [
        { threshold: 1e12, suffix: 'T' },
        { threshold: 1e9, suffix: 'M' },
        { threshold: 1e6, suffix: 'jt' },
        { threshold: 1e3, suffix: 'rb' },
      ]
    : [
        { threshold: 1e12, suffix: 'T' },
        { threshold: 1e9, suffix: 'B' },
        { threshold: 1e6, suffix: 'M' },
        { threshold: 1e3, suffix: 'k' },
      ];

  const formatScaled = (value: number, suffix: string): string => {
    if (value < 10) {
      const rounded = Math.round(value * 10) / 10;
      const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace('.', decimalSep);
      return `${text}${suffix}`;
    }
    return `${Math.round(value)}${suffix}`;
  };

  for (let i = 0; i < tiers.length; i += 1) {
    const tier = tiers[i];
    if (safe >= tier.threshold) {
      const scaled = safe / tier.threshold;
      const rounded = scaled < 10 ? Math.round(scaled * 10) / 10 : Math.round(scaled);
      // Promote values like 999.6k -> 1M or 999.6rb -> 1jt so we never output "1000k" / "1000rb".
      if (rounded >= 1000 && i > 0) {
        return formatScaled(safe / tiers[i - 1].threshold, tiers[i - 1].suffix);
      }
      return formatScaled(scaled, tier.suffix);
    }
  }

  // Values below 1,000
  const decimals = getCurrencyDecimals(normalizedCode);
  if (decimals === 0 || safe >= 100) {
    const rounded = Math.round(safe);
    if (rounded >= 1000) {
      return `1${tiers[tiers.length - 1].suffix}`;
    }
    return String(rounded);
  }

  const roundedOneDecimal = Math.round(safe * 10) / 10;
  if (Number.isInteger(roundedOneDecimal)) {
    return String(roundedOneDecimal);
  }
  return roundedOneDecimal.toFixed(1).replace('.', decimalSep);
}

export type ExpressionEvalError = 'empty' | 'incomplete' | 'division_by_zero' | 'invalid' | 'overflow';

export type ExpressionEvalResult =
  | { ok: true; value: number; isExpression: boolean }
  | { ok: false; error: ExpressionEvalError };

type CalcToken =
  | { kind: 'number'; value: number }
  | { kind: 'op'; op: '+' | '-' | '*' | '/' };

const MAX_CALCULATOR_VALUE = MAX_TRANSACTION_AMOUNT;

/**
 * Safe recursive-descent evaluator for calculator amount expressions (+, -, ×/*, ÷/).
 * Never uses eval or Function. Rejects incomplete expressions, division by zero, and
 * values exceeding MAX_TRANSACTION_AMOUNT so callers never commit an inaccurate amount.
 */
export function evaluateAmountExpression(expression: string, decimals: number = 2): ExpressionEvalResult {
  if (typeof expression !== 'string') {
    return { ok: false, error: 'invalid' };
  }

  const normalized = expression
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/−/g, '-')
    .replace(/\s+/g, '');

  if (!normalized) {
    return { ok: false, error: 'empty' };
  }

  const tokens: CalcToken[] = [];
  let i = 0;

  while (i < normalized.length) {
    const ch = normalized[i];

    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ kind: 'op', op: ch });
      i += 1;
      continue;
    }

    if ((ch >= '0' && ch <= '9') || ch === '.') {
      const start = i;
      let dotCount = 0;
      while (i < normalized.length && ((normalized[i] >= '0' && normalized[i] <= '9') || normalized[i] === '.')) {
        if (normalized[i] === '.') dotCount += 1;
        i += 1;
      }
      const rawNum = normalized.slice(start, i);
      if (dotCount > 1) {
        return { ok: false, error: 'invalid' };
      }
      if (rawNum === '.' || rawNum.endsWith('.')) {
        return { ok: false, error: 'incomplete' };
      }
      const parsed = Number(rawNum);
      if (!Number.isFinite(parsed) || Math.abs(parsed) > MAX_CALCULATOR_VALUE) {
        return { ok: false, error: 'overflow' };
      }
      tokens.push({ kind: 'number', value: parsed });
      continue;
    }

    return { ok: false, error: 'invalid' };
  }

  const lastToken = tokens[tokens.length - 1];
  if (lastToken?.kind === 'op') {
    return { ok: false, error: 'incomplete' };
  }

  let cursor = 0;
  let binaryOpCount = 0;
  let failError: ExpressionEvalError | null = null;

  const parseUnary = (): number => {
    const token = tokens[cursor];
    if (!token) {
      failError = failError ?? 'incomplete';
      return 0;
    }
    if (token.kind === 'op' && token.op === '-') {
      cursor += 1;
      return -parseUnary();
    }
    if (token.kind === 'number') {
      cursor += 1;
      return token.value;
    }
    failError = failError ?? 'invalid';
    return 0;
  };

  const parseTerm = (): number => {
    let left = parseUnary();
    if (failError) return 0;

    while (cursor < tokens.length) {
      const token = tokens[cursor];
      if (token.kind === 'op' && (token.op === '*' || token.op === '/')) {
        cursor += 1;
        binaryOpCount += 1;
        const right = parseUnary();
        if (failError) return 0;
        if (token.op === '/') {
          if (right === 0) {
            failError = 'division_by_zero';
            return 0;
          }
          left = left / right;
        } else {
          left = left * right;
        }
        if (!Number.isFinite(left) || Math.abs(left) > MAX_CALCULATOR_VALUE) {
          failError = 'overflow';
          return 0;
        }
      } else {
        break;
      }
    }

    return left;
  };

  const parseExpr = (): number => {
    let left = parseTerm();
    if (failError) return 0;

    while (cursor < tokens.length) {
      const token = tokens[cursor];
      if (token.kind === 'op' && (token.op === '+' || token.op === '-')) {
        cursor += 1;
        binaryOpCount += 1;
        const right = parseTerm();
        if (failError) return 0;
        left = token.op === '+' ? left + right : left - right;
        if (!Number.isFinite(left) || Math.abs(left) > MAX_CALCULATOR_VALUE) {
          failError = 'overflow';
          return 0;
        }
      } else {
        break;
      }
    }

    return left;
  };

  const rawResult = parseExpr();
  if (failError) {
    return { ok: false, error: failError };
  }
  if (cursor < tokens.length) {
    return { ok: false, error: 'invalid' };
  }
  if (!Number.isFinite(rawResult) || Math.abs(rawResult) > MAX_CALCULATOR_VALUE) {
    return { ok: false, error: 'overflow' };
  }

  const roundedResult = roundCurrency(rawResult, decimals);
  if (!isAmountWithinRange(roundedResult)) {
    return { ok: false, error: 'overflow' };
  }

  return {
    ok: true,
    value: roundedResult,
    isExpression: binaryOpCount > 0,
  };
}

/**
 * Formats a raw calculator expression (e.g. "45000+18500" or "1250.5*2") for readable display
 * using the active currency's thousands/decimal conventions.
 */
export function formatCalculatorExpression(expression: string, currencyCode: string = 'IDR'): string {
  if (!expression) return '';
  const cleaned = expression
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/−/g, '-')
    .replace(/\s+/g, '');

  const parts: string[] = [];
  let i = 0;

  while (i < cleaned.length) {
    const ch = cleaned[i];
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      const displayOp = ch === '*' ? '×' : ch === '/' ? '÷' : ch;
      if (parts.length === 0 && ch === '-') {
        parts.push('-');
      } else {
        parts.push(` ${displayOp} `);
      }
      i += 1;
    } else if ((ch >= '0' && ch <= '9') || ch === '.') {
      const start = i;
      while (i < cleaned.length && ((cleaned[i] >= '0' && cleaned[i] <= '9') || cleaned[i] === '.')) {
        i += 1;
      }
      const numStr = cleaned.slice(start, i);
      parts.push(formatAmountInput(numStr, currencyCode));
    } else {
      i += 1;
    }
  }

  return parts.join('').trimStart();
}

export interface TransactionFilterSummary {
  count: number;
  totalIn: number;
  totalOut: number;
  net: number;
}

/**
 * Computes count, total inflows, total outflows, and net flow for a list of transactions.
 * Transfers are included in `count` but excluded from both `totalIn` and `totalOut`.
 */
export function summarizeTransactions(
  items: ReadonlyArray<{ type?: string; totalAmount?: number | null }>
): TransactionFilterSummary {
  let totalIn = 0;
  let totalOut = 0;

  for (const tx of items) {
    if (tx.type === 'transfer') continue;
    const raw = typeof tx.totalAmount === 'number' && Number.isFinite(tx.totalAmount) ? tx.totalAmount : 0;
    if (tx.type === 'income') {
      totalIn = addAmounts(totalIn, Math.abs(raw));
    } else if (tx.type === 'expense') {
      totalOut = addAmounts(totalOut, Math.abs(raw));
    } else if (raw > 0) {
      totalIn = addAmounts(totalIn, raw);
    } else if (raw < 0) {
      totalOut = addAmounts(totalOut, Math.abs(raw));
    }
  }

  return {
    count: items.length,
    totalIn,
    totalOut,
    net: addAmounts(totalIn, -totalOut),
  };
}
