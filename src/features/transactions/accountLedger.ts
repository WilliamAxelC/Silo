import type { Transaction, Wallet } from './types';

export interface LedgerEntry {
  transaction: Transaction;
  /** Signed change to this account, in the account's currency. */
  delta: number;
  /** Account balance right after this transaction (in the account's currency). */
  balanceAfter: number;
  direction: 'in' | 'out';
}

/**
 * How a transaction changes one account, mirroring the balance query in useTransactionStore.readWallets:
 * the source account moves by its own-currency amount (original_amount for a foreign account, else
 * total_amount); a transfer's receiving account gains to_amount (or the sent home amount).
 */
export function accountDelta(transaction: Transaction, wallet: Pick<Wallet, 'id' | 'currency'>): number {
  if (transaction.walletId === wallet.id) {
    const ownCurrency =
      wallet.currency != null && transaction.originalCurrency === wallet.currency && transaction.originalAmount != null;
    return ownCurrency ? (transaction.originalAmount as number) : transaction.totalAmount;
  }
  if (transaction.type === 'transfer' && transaction.toWalletId === wallet.id) {
    return transaction.toAmount ?? -transaction.totalAmount;
  }
  return 0;
}

/** Transactions touching `wallet`, newest first, each with its effect and the running balance after it. */
export function buildAccountLedger(transactions: Transaction[], wallet: Wallet): LedgerEntry[] {
  const related = transactions
    .filter((t) => t.walletId === wallet.id || (t.type === 'transfer' && t.toWalletId === wallet.id))
    .sort((a, b) => (b.date !== a.date ? b.date - a.date : b.id - a.id));
  let balance = wallet.balance;
  return related.map((transaction) => {
    const delta = accountDelta(transaction, wallet);
    const entry: LedgerEntry = {
      transaction,
      delta,
      balanceAfter: Math.round(balance * 100) / 100,
      direction: delta >= 0 ? 'in' : 'out',
    };
    balance -= delta;
    return entry;
  });
}
