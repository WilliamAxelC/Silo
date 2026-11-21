import { buildTransactionsCsv, CSV_HEADERS } from '../csvExport';
import type { Transaction, Wallet } from '../../features/transactions/types';

describe('buildTransactionsCsv', () => {
  const wallets: Pick<Wallet, 'id' | 'name'>[] = [
    { id: 1, name: 'Main Wallet' },
    { id: 2, name: 'BCA, Checking' },
    { id: 3, name: 'GoPay "Personal"' },
  ];

  const sampleDate = new Date(2026, 10, 15, 10, 30).getTime(); // 15 Nov 2026

  it('includes Account and To Account headers and outputs header-only CSV for empty input', () => {
    const csv = buildTransactionsCsv([], { wallets });
    expect(csv).toBe(`${CSV_HEADERS.join(',')}\n`);
    expect(CSV_HEADERS).toContain('Account');
    expect(CSV_HEADERS).toContain('To Account');
  });

  it('labels transfers as Transfer with both Account and To Account populated', () => {
    const txs: Transaction[] = [
      {
        id: 1,
        merchantName: 'Top up GoPay',
        totalAmount: -500000,
        type: 'transfer',
        category: 'Transfer',
        date: sampleDate,
        note: 'Monthly wallet refill',
        lineItemsText: '',
        walletId: 2,
        toWalletId: 3,
      },
      {
        id: 2,
        merchantName: 'Coffee Shop',
        totalAmount: -12.5,
        type: 'expense',
        category: 'Food & Dining',
        date: sampleDate,
        note: 'Latte, "iced"',
        lineItemsText: 'Latte | 12.5',
        walletId: 1,
        toWalletId: null,
      },
      {
        id: 3,
        merchantName: 'Acme Corp',
        totalAmount: 3500.75,
        type: 'income',
        category: 'Salary',
        date: sampleDate,
        note: '',
        lineItemsText: '',
        walletId: 2,
        toWalletId: null,
      },
    ];

    const csv = buildTransactionsCsv(txs, { wallets, dateFormat: 'en-GB' });
    const lines = csv.trimEnd().split('\n');
    expect(lines).toHaveLength(4);

    // Header
    expect(lines[0]).toBe('Date,Merchant Name,Category,Amount,Type,Account,To Account,Description,Receipt Items');

    // Transfer row
    expect(lines[1]).toBe(
      '15/11/2026,"Top up GoPay","Transfer",-500000,Transfer,"BCA, Checking","GoPay ""Personal""","Monthly wallet refill",""'
    );

    // Expense row (preserves decimal amount, escapes quotes/commas, empty To Account)
    expect(lines[2]).toBe(
      '15/11/2026,"Coffee Shop","Food & Dining",-12.5,Expense,"Main Wallet","","Latte, ""iced""","Latte | 12.5"'
    );

    // Income row
    expect(lines[3]).toBe(
      '15/11/2026,"Acme Corp","Salary",3500.75,Income,"BCA, Checking","","",""'
    );
  });

  it('respects en-US dateFormat and handles unknown or missing wallet ids gracefully', () => {
    const csv = buildTransactionsCsv(
      [
        {
          id: 9,
          merchantName: 'Street Food',
          totalAmount: -25000,
          type: 'expense',
          category: 'Food & Dining',
          date: sampleDate,
          note: '',
          lineItemsText: '',
          walletId: 999,
          toWalletId: null,
        },
      ],
      { wallets, dateFormat: 'en-US' }
    );

    const lines = csv.trimEnd().split('\n');
    expect(lines[1]).toBe('11/15/2026,"Street Food","Food & Dining",-25000,Expense,"","","",""');
  });

  it('preserves embedded newlines in notes inside RFC-4180 double quotes', () => {
    const csv = buildTransactionsCsv(
      [
        {
          id: 10,
          merchantName: 'Bakery',
          totalAmount: -40000,
          type: 'expense',
          category: 'Food & Dining',
          date: sampleDate,
          note: 'Line 1\nLine 2 "fresh"',
          lineItemsText: 'Bread | 40000',
          walletId: 1,
          toWalletId: null,
        },
      ],
      { wallets, dateFormat: 'en-GB' }
    );

    expect(csv).toContain('"Line 1\nLine 2 ""fresh"""');
  });
});
