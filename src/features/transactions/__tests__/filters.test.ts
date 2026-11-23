import {
  EMPTY_FILTERS,
  computeDatePresetBounds,
  countActiveFilters,
  matchesTransactionFilters,
  parseSearchQuery,
} from '../filters';
import type { Transaction } from '../types';

const tx = (over: Partial<Transaction>): Transaction =>
  ({
    id: 1,
    merchantName: 'Lawson',
    totalAmount: -13000,
    type: 'expense',
    category: 'Food & Dining',
    date: new Date(2026, 10, 20, 12).getTime(),
    walletId: 1,
    note: 'late snack',
    lineItemsText: 'LH S CARB TRFLE',
    tags: ['Date'],
    ...over,
  }) as Transaction;

describe('transaction filters', () => {
  it('counts each filter once, with a date range counting as one', () => {
    expect(countActiveFilters(EMPTY_FILTERS)).toBe(0);
    expect(
      countActiveFilters({ ...EMPTY_FILTERS, walletId: 2, tag: 'date', dateFrom: 1, dateTo: 2, datePreset: 'custom' })
    ).toBe(3);
  });

  it('reads "#tag" as a tag search and anything else as text', () => {
    expect(parseSearchQuery('  #date ')).toEqual({ text: '', tag: 'date' });
    expect(parseSearchQuery(' lawson ')).toEqual({ text: 'lawson', tag: '' });
  });

  it('matches an account on either side of a transfer', () => {
    const transfer = tx({ type: 'transfer', walletId: 1, toWalletId: 3 });
    expect(matchesTransactionFilters(transfer, { ...EMPTY_FILTERS, walletId: 3 })).toBe(true);
    expect(matchesTransactionFilters(transfer, { ...EMPTY_FILTERS, walletId: 2 })).toBe(false);
  });

  it('matches category and tag ignoring case, and dates inclusively', () => {
    const t = tx({});
    expect(matchesTransactionFilters(t, { ...EMPTY_FILTERS, category: 'food & dining' })).toBe(true);
    expect(matchesTransactionFilters(t, { ...EMPTY_FILTERS, tag: 'date' })).toBe(true);
    expect(matchesTransactionFilters(t, { ...EMPTY_FILTERS, tag: 'trip' })).toBe(false);
    expect(matchesTransactionFilters(t, { ...EMPTY_FILTERS, dateFrom: t.date, dateTo: t.date })).toBe(true);
    expect(matchesTransactionFilters(t, { ...EMPTY_FILTERS, dateFrom: t.date + 1 })).toBe(false);
    expect(matchesTransactionFilters(t, { ...EMPTY_FILTERS, type: 'income' })).toBe(false);
  });

  it('searches merchant, note, items and category text, and #tag', () => {
    const t = tx({});
    expect(matchesTransactionFilters(t, EMPTY_FILTERS, 'laws')).toBe(true);
    expect(matchesTransactionFilters(t, EMPTY_FILTERS, 'snack')).toBe(true);
    expect(matchesTransactionFilters(t, EMPTY_FILTERS, 'trfle')).toBe(true);
    expect(matchesTransactionFilters(t, EMPTY_FILTERS, 'dining')).toBe(true);
    expect(matchesTransactionFilters(t, EMPTY_FILTERS, 'indomaret')).toBe(false);
    expect(matchesTransactionFilters(t, EMPTY_FILTERS, '#DATE')).toBe(true);
    expect(matchesTransactionFilters(tx({ tags: [] }), EMPTY_FILTERS, '#date')).toBe(false);
  });

  it('builds preset bounds from the start of the first day to the end of today', () => {
    const now = new Date(2026, 10, 23, 15);
    const last7 = computeDatePresetBounds('last7', now);
    expect(new Date(last7.from)).toEqual(new Date(2026, 10, 17, 0, 0, 0, 0));
    expect(new Date(last7.to).getDate()).toBe(23);
  });
});
