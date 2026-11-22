import { getCurrencyDecimals, roundCurrency } from '../transactions/amount';
import { normalizeCurrencyCode } from './currencies';

/**
 * Multi-currency storage rule: `totalAmount` is always in the home currency (reports, budgets and chat use it).
 * When an account or entry involves another currency, the transaction also keeps `originalAmount` in the
 * source account's currency (`originalCurrency`) and the `fxRate` used (home units per 1 foreign unit).
 * Transfers also keep `toAmount`: what arrived in the destination account, in its currency.
 */
export interface CurrencyFields {
  totalAmount: number;
  originalAmount: number | null;
  originalCurrency: string | null;
  fxRate: number | null;
  toAmount: number | null;
}

const isPositive = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

export function roundTo(amount: number, currency: string): number {
  return roundCurrency(amount, getCurrencyDecimals(currency));
}

/** Rounds an exchange rate to 6 significant digits so stored rates stay readable. */
export function roundRate(rate: number): number {
  if (!isPositive(rate)) return rate;
  const magnitude = Math.floor(Math.log10(rate));
  const factor = 10 ** (5 - magnitude);
  return Math.round(rate * factor) / factor;
}

export class CurrencyConversionError extends Error {}

/**
 * Income/expense in an account. `amount` is the positive amount the user typed, in `enteredCurrency`
 * (either the account's currency or the home currency). `sign` is -1 for expenses, +1 for income.
 * `rate` is home units per 1 unit of the account's currency, required for foreign accounts.
 */
export function resolveEntryAmounts(params: {
  homeCurrency: string;
  walletCurrency: string;
  enteredCurrency: string;
  amount: number;
  sign: 1 | -1;
  rate?: number | null;
}): CurrencyFields {
  const home = normalizeCurrencyCode(params.homeCurrency) ?? 'IDR';
  const wallet = normalizeCurrencyCode(params.walletCurrency) ?? home;
  const entered = normalizeCurrencyCode(params.enteredCurrency) ?? wallet;
  const amount = Math.abs(params.amount);

  if (wallet === home) {
    return { totalAmount: params.sign * roundTo(amount, home), originalAmount: null, originalCurrency: null, fxRate: null, toAmount: null };
  }
  if (!isPositive(params.rate)) {
    throw new CurrencyConversionError(`Enter the exchange rate for ${wallet}.`);
  }
  const rate = roundRate(params.rate);
  if (entered === wallet) {
    const native = roundTo(amount, wallet);
    return {
      totalAmount: params.sign * roundTo(native * rate, home),
      originalAmount: params.sign * native,
      originalCurrency: wallet,
      fxRate: rate,
      toAmount: null,
    };
  }
  if (entered !== home) {
    throw new CurrencyConversionError(`Enter the amount in ${wallet} or ${home}.`);
  }
  const homeAmount = roundTo(amount, home);
  return {
    totalAmount: params.sign * homeAmount,
    originalAmount: params.sign * roundTo(homeAmount / rate, wallet),
    originalCurrency: wallet,
    fxRate: rate,
    toAmount: null,
  };
}

/**
 * Transfer between accounts. `sent` is in the source account's currency; `received` is in the destination's
 * and is required when the currencies differ (that pair defines the exchange). `sourceRate` (home per source
 * unit) is only needed when neither side is in the home currency.
 */
export function resolveTransferAmounts(params: {
  homeCurrency: string;
  fromCurrency: string;
  toCurrency: string;
  sent: number;
  received?: number | null;
  sourceRate?: number | null;
}): CurrencyFields {
  const home = normalizeCurrencyCode(params.homeCurrency) ?? 'IDR';
  const from = normalizeCurrencyCode(params.fromCurrency) ?? home;
  const to = normalizeCurrencyCode(params.toCurrency) ?? home;
  const sent = roundTo(Math.abs(params.sent), from);

  if (from === home && to === home) {
    return { totalAmount: -sent, originalAmount: null, originalCurrency: null, fxRate: null, toAmount: null };
  }

  let received: number;
  if (from === to) {
    received = sent;
  } else {
    if (!isPositive(params.received)) {
      throw new CurrencyConversionError(`Enter how much ${to} arrived.`);
    }
    received = roundTo(params.received, to);
  }

  if (from === home) {
    // Buying foreign currency: the rate is what this exchange cost.
    return { totalAmount: -sent, originalAmount: null, originalCurrency: null, fxRate: roundRate(sent / received), toAmount: received };
  }
  if (to === home) {
    // Selling foreign currency back: its home value is what arrived.
    return { totalAmount: -received, originalAmount: -sent, originalCurrency: from, fxRate: roundRate(received / sent), toAmount: received };
  }
  if (!isPositive(params.sourceRate)) {
    throw new CurrencyConversionError(`Enter the exchange rate for ${from}.`);
  }
  const rate = roundRate(params.sourceRate);
  return { totalAmount: -roundTo(sent * rate, home), originalAmount: -sent, originalCurrency: from, fxRate: rate, toAmount: received };
}

/** Formats an exchange rate the way the app writes numbers: "16.260,2", "115,345". */
export function formatRate(rate: number): string {
  if (!isPositive(rate)) return '';
  return roundRate(rate).toLocaleString('id-ID', { maximumFractionDigits: 6, useGrouping: true });
}

/**
 * Parses a typed rate with '.' thousands and ',' decimals ("16.250" = 16250, "115,345" = 115.345).
 * A single '.' followed by other than exactly three digits is read as a decimal point ("0.0095", "104.6").
 */
export function parseRateText(text: string): number | null {
  const cleaned = text.replace(/\s/g, '');
  if (!cleaned) return null;
  let normalized: string;
  if (cleaned.includes(',')) normalized = cleaned.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) normalized = cleaned.replace(/\./g, '');
  else normalized = cleaned;
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? value : null;
}
