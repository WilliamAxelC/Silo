import { buildAccountLedger } from '../accountLedger';
import type { Transaction, Wallet } from '../types';

const tx = (over: Partial<Transaction>): Transaction => ({
  id: 1, merchantName: 'x', totalAmount: 0, type: 'expense', category: 'Food & Dining', date: 1, walletId: 1, ...over,
});

describe('buildAccountLedger', () => {
  it('lists money in and out of a rupiah account with a running balance', () => {
    const bca: Wallet = { id: 1, name: 'BCA', type: 'bank', isActive: true, initialBalance: 1_000_000, balance: 4_740_000, currency: null, averageRate: null };
    const ledger = buildAccountLedger(
      [
        tx({ id: 1, type: 'income', totalAmount: 5_000_000, date: 1 }),
        tx({ id: 2, type: 'transfer', totalAmount: -1_000_000, toWalletId: 2, toAmount: 9_560, date: 2 }),
        tx({ id: 3, type: 'transfer', walletId: 2, toWalletId: 1, totalAmount: -21_000, originalAmount: -200, originalCurrency: 'JPY', toAmount: 21_000, date: 3 }),
        tx({ id: 4, totalAmount: -281_000, date: 4 }),
        tx({ id: 5, walletId: 3, totalAmount: -50_000, date: 5 }),
      ],
      bca,
    );
    expect(ledger.map((e) => [e.transaction.id, e.delta, e.balanceAfter])).toEqual([
      [4, -281_000, 4_740_000],
      [3, 21_000, 5_021_000],
      [2, -1_000_000, 5_000_000],
      [1, 5_000_000, 6_000_000],
    ]);
  });

  it('uses yen amounts for a yen account', () => {
    const yen: Wallet = { id: 2, name: 'Japan Cash', type: 'cash', isActive: true, initialBalance: 0, balance: 6_160, currency: 'JPY', averageRate: 104.6 };
    const ledger = buildAccountLedger(
      [
        tx({ id: 2, walletId: 1, type: 'transfer', totalAmount: -1_000_000, toWalletId: 2, toAmount: 9_560, date: 2 }),
        tx({ id: 6, walletId: 2, totalAmount: -334_720, originalAmount: -3_200, originalCurrency: 'JPY', fxRate: 104.6, date: 6 }),
        tx({ id: 3, type: 'transfer', walletId: 2, toWalletId: 1, totalAmount: -21_000, originalAmount: -200, originalCurrency: 'JPY', toAmount: 21_000, date: 3 }),
      ],
      yen,
    );
    expect(ledger.map((e) => [e.transaction.id, e.delta, e.balanceAfter, e.direction])).toEqual([
      [6, -3_200, 6_160, 'out'],
      [3, -200, 9_360, 'out'],
      [2, 9_560, 9_560, 'in'],
    ]);
  });
});
