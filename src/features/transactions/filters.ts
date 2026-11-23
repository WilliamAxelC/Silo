import { endOfDay, startOfDay, subDays } from 'date-fns';
import { getPeriodBounds, shiftPeriod } from './periods';
import type { Transaction, TransactionType } from './types';

export type DateRangePreset = 'today' | 'last7' | 'thisMonth' | 'lastMonth' | 'last30' | 'custom';

export const DATE_PRESETS: Array<{ key: Exclude<DateRangePreset, 'custom'>; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'thisMonth', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
  { key: 'last30', label: 'Last 30 days' },
];

export const TYPE_OPTIONS: Array<{ key: TransactionType; label: string }> = [
  { key: 'expense', label: 'Expense' },
  { key: 'income', label: 'Income' },
  { key: 'transfer', label: 'Transfer' },
];

export function computeDatePresetBounds(
  preset: Exclude<DateRangePreset, 'custom'>,
  now = new Date(),
  monthStartDay = 1
): { from: number; to: number } {
  switch (preset) {
    case 'today':
      return { from: startOfDay(now).getTime(), to: endOfDay(now).getTime() };
    case 'last7':
      return { from: startOfDay(subDays(now, 6)).getTime(), to: endOfDay(now).getTime() };
    case 'thisMonth': {
      const bounds = getPeriodBounds(now, monthStartDay);
      return { from: bounds.startMs, to: bounds.endMs };
    }
    case 'lastMonth': {
      const bounds = getPeriodBounds(shiftPeriod(now, -1, monthStartDay), monthStartDay);
      return { from: bounds.startMs, to: bounds.endMs };
    }
    case 'last30':
      return { from: startOfDay(subDays(now, 29)).getTime(), to: endOfDay(now).getTime() };
  }
}

/** Filters chosen in the filter sheet. null means "any". */
export interface TransactionFilters {
  type: TransactionType | null;
  walletId: number | null;
  category: string | null;
  tag: string | null;
  datePreset: DateRangePreset | null;
  dateFrom: number | null;
  dateTo: number | null;
}

export const EMPTY_FILTERS: TransactionFilters = {
  type: null,
  walletId: null,
  category: null,
  tag: null,
  datePreset: null,
  dateFrom: null,
  dateTo: null,
};

/** How many filters are on (a date range counts once). Drives the Filters button badge. */
export function countActiveFilters(filters: TransactionFilters): number {
  let count = 0;
  if (filters.type) count += 1;
  if (filters.walletId != null) count += 1;
  if (filters.category) count += 1;
  if (filters.tag) count += 1;
  if (filters.dateFrom != null || filters.dateTo != null) count += 1;
  return count;
}

/** Splits search text: "#date" searches by tag, anything else is free text. */
export function parseSearchQuery(query: string): { text: string; tag: string } {
  const trimmed = query.trim();
  if (trimmed.startsWith('#')) return { text: '', tag: trimmed.replace(/^#+/, '').trim() };
  return { text: trimmed, tag: '' };
}

const sameName = (a: string | undefined | null, b: string) => (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();

/**
 * In-memory version of the database search filters (db/index.ts buildSearchFilterParts), for screens
 * that already hold the period's transactions, like Reports. An account matches either side of a transfer.
 */
export function matchesTransactionFilters(tx: Transaction, filters: TransactionFilters, query = ''): boolean {
  if (filters.type && tx.type !== filters.type) return false;
  if (filters.walletId != null && tx.walletId !== filters.walletId && tx.toWalletId !== filters.walletId) return false;
  if (filters.category && !sameName(tx.category, filters.category)) return false;
  if (filters.tag && !(tx.tags ?? []).some((t) => sameName(t, filters.tag!))) return false;
  if (filters.dateFrom != null && tx.date < filters.dateFrom) return false;
  if (filters.dateTo != null && tx.date > filters.dateTo) return false;

  const { text, tag } = parseSearchQuery(query);
  if (tag && !(tx.tags ?? []).some((t) => sameName(t, tag))) return false;
  if (text) {
    const needle = text.toLowerCase();
    const haystack = [tx.merchantName, tx.note, tx.lineItemsText, tx.category]
      .map((v) => (v ?? '').toLowerCase());
    if (!haystack.some((v) => v.includes(needle))) return false;
  }
  return true;
}
