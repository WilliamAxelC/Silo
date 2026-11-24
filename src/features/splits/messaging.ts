import { Linking, Share } from 'react-native';

import { formatDisplayCurrency } from '../transactions/amount';
import { formatCachedLocaleDate } from '../transactions/periods';
import type { SplitBreakdown, SplitEntry, SplitMode } from './types';

export const CURRENCY_TO_CALLING_CODE: Record<string, string> = {
  IDR: '62',
  USD: '1',
  CAD: '1',
  SGD: '65',
  MYR: '60',
  THB: '66',
  PHP: '63',
  VND: '84',
  JPY: '81',
  KRW: '82',
  CNY: '86',
  HKD: '852',
  TWD: '886',
  AUD: '61',
  NZD: '64',
  GBP: '44',
  INR: '91',
  CHF: '41',
  SAR: '966',
  AED: '971',
};

const DATE_LABEL_OPTIONS: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
};

export function inferCountryCodeFromCurrency(currencyCode: string): string {
  const normalized = (currencyCode || 'IDR').trim().toUpperCase();
  return CURRENCY_TO_CALLING_CODE[normalized] ?? '62';
}

/**
 * Normalizes a phone number into digits suitable for `https://wa.me/<digits>`.
 * Handles `+` international prefixes, `00` international prefixes, and local `0...` numbers
 * using `defaultCountryCode` (e.g. `0812-345-6789` with `62` -> `628123456789`).
 */
export function normalizePhoneForWhatsApp(
  rawPhone: string | null | undefined,
  defaultCountryCode = '62'
): string | null {
  if (!rawPhone) return null;
  const trimmed = rawPhone.trim();
  if (!trimmed) return null;

  const cleanCountry = (defaultCountryCode || '').replace(/\D/g, '');
  const hasPlusPrefix = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');

  if (!digits) return null;

  if (!hasPlusPrefix) {
    if (digits.startsWith('00')) {
      digits = digits.slice(2);
    } else if (digits.startsWith('0') && cleanCountry) {
      digits = `${cleanCountry}${digits.slice(1)}`;
    }
  }

  if (digits.length < 7 || digits.length > 15) {
    return null;
  }

  return digits;
}

export function buildWhatsAppUrl(
  message: string,
  rawPhone?: string | null,
  defaultCountryCode = '62'
): string {
  const digits = normalizePhoneForWhatsApp(rawPhone, defaultCountryCode);
  const encoded = encodeURIComponent(message);
  return digits ? `https://wa.me/${digits}?text=${encoded}` : `https://wa.me/?text=${encoded}`;
}

export interface FormatPersonBillMessageParams {
  personName: string;
  merchantName: string;
  date: number;
  billTotal: number;
  amountOwed: number;
  currency: string;
  splitMode: SplitMode;
  breakdown: SplitBreakdown | null;
  paymentDetails?: string;
  locale?: string;
  useThousandsSeparator?: boolean;
}

export function formatPersonBillMessage(params: FormatPersonBillMessageParams): string {
  const {
    personName,
    merchantName,
    date,
    billTotal,
    amountOwed,
    currency,
    splitMode,
    breakdown,
    paymentDetails,
    locale = 'en-GB',
    useThousandsSeparator = true,
  } = params;

  const money = (value: number) => formatDisplayCurrency(value, currency, useThousandsSeparator);
  const dateLabel = formatCachedLocaleDate(date, locale, DATE_LABEL_OPTIONS);
  const lines: string[] = [
    `Hi ${personName.trim() || 'there'}, here's the split for ${merchantName} (${dateLabel}):`,
  ];

  if (splitMode === 'items' && breakdown?.items && breakdown.items.length > 0) {
    lines.push('');
    for (const item of breakdown.items) {
      const shareNote =
        item.sharedWithCount > 1 ? ` (split ${item.sharedWithCount} ways)` : '';
      lines.push(`• ${item.name}${shareNote}: ${money(item.shareAmount)}`);
    }
    if (typeof breakdown.adjustmentAmount === 'number' && breakdown.adjustmentAmount !== 0) {
      const label =
        breakdown.adjustmentLabel ?? (breakdown.adjustmentAmount > 0 ? 'Tax & fees' : 'Discount');
      const sign = breakdown.adjustmentAmount > 0 ? '' : '-';
      lines.push(`• ${label}: ${sign}${money(Math.abs(breakdown.adjustmentAmount))}`);
    }
  } else if (splitMode === 'equal' && breakdown?.totalParticipants && breakdown.totalParticipants > 1) {
    lines.push(`Bill total: ${money(billTotal)} (split equally among ${breakdown.totalParticipants})`);
  } else {
    lines.push(`Bill total: ${money(billTotal)}`);
  }

  lines.push('');
  lines.push(`Your share: ${money(amountOwed)}`);

  const trimmedPayment = paymentDetails?.trim();
  if (trimmedPayment) {
    lines.push('');
    lines.push('Payment details:');
    lines.push(trimmedPayment);
  }

  return lines.join('\n');
}

export interface FormatGroupSummaryMessageParams {
  merchantName: string;
  date: number;
  billTotal: number;
  currency: string;
  entries: ReadonlyArray<Pick<SplitEntry, 'personName' | 'amountOwed' | 'isSettled'>>;
  paymentDetails?: string;
  locale?: string;
  useThousandsSeparator?: boolean;
}

export function formatGroupSummaryMessage(params: FormatGroupSummaryMessageParams): string {
  const {
    merchantName,
    date,
    billTotal,
    currency,
    entries,
    paymentDetails,
    locale = 'en-GB',
    useThousandsSeparator = true,
  } = params;

  const money = (value: number) => formatDisplayCurrency(value, currency, useThousandsSeparator);
  const dateLabel = formatCachedLocaleDate(date, locale, DATE_LABEL_OPTIONS);
  const lines: string[] = [
    `Split bill: ${merchantName} (${dateLabel})`,
    `Total bill: ${money(billTotal)}`,
    '',
    'Breakdown:',
  ];

  let othersSum = 0;
  for (const entry of entries) {
    othersSum += entry.amountOwed;
    const status = entry.isSettled ? ' [Paid]' : '';
    lines.push(`• ${entry.personName}: ${money(entry.amountOwed)}${status}`);
  }

  const remainingForPayer = Math.max(0, billTotal - othersSum);
  if (remainingForPayer > 0.0001) {
    lines.push(`• Paid by me (my share): ${money(remainingForPayer)}`);
  }

  const trimmedPayment = paymentDetails?.trim();
  if (trimmedPayment) {
    lines.push('');
    lines.push('Payment details:');
    lines.push(trimmedPayment);
  }

  return lines.join('\n');
}

export interface FormatPersonCombinedMessageParams {
  personName: string;
  entries: ReadonlyArray<Pick<SplitEntry, 'merchantName' | 'transactionDate' | 'amountOwed' | 'currency'>>;
  paymentDetails?: string;
  locale?: string;
  useThousandsSeparator?: boolean;
}

export function formatPersonCombinedMessage(params: FormatPersonCombinedMessageParams): string {
  const {
    personName,
    entries,
    paymentDetails,
    locale = 'en-GB',
    useThousandsSeparator = true,
  } = params;

  const lines: string[] = [`Hi ${personName.trim() || 'there'}, here's a quick summary of shared bills:`];
  lines.push('');

  const totalsByCurrency = new Map<string, number>();
  for (const entry of entries) {
    const dateLabel = formatCachedLocaleDate(entry.transactionDate, locale, DATE_LABEL_OPTIONS);
    lines.push(
      `• ${entry.merchantName} (${dateLabel}): ${formatDisplayCurrency(entry.amountOwed, entry.currency, useThousandsSeparator)}`
    );
    totalsByCurrency.set(entry.currency, (totalsByCurrency.get(entry.currency) ?? 0) + entry.amountOwed);
  }

  lines.push('');
  const totalStrings = Array.from(totalsByCurrency.entries()).map(([currency, total]) =>
    formatDisplayCurrency(total, currency, useThousandsSeparator)
  );
  lines.push(`Total owed: ${totalStrings.join(' + ')}`);

  const trimmedPayment = paymentDetails?.trim();
  if (trimmedPayment) {
    lines.push('');
    lines.push('Payment details:');
    lines.push(trimmedPayment);
  }

  return lines.join('\n');
}

export async function openWhatsAppMessage(
  message: string,
  rawPhone?: string | null,
  defaultCountryCode = '62'
): Promise<{ ok: boolean; error?: string }> {
  const url = buildWhatsAppUrl(message, rawPhone, defaultCountryCode);
  try {
    await Linking.openURL(url);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not open WhatsApp.',
    };
  }
}

export async function shareMessageWithIntent(message: string, title?: string): Promise<void> {
  await Share.share(title ? { message, title } : { message });
}
