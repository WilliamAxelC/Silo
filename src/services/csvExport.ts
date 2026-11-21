import type { Transaction, Wallet } from '../features/transactions/types';

export const CSV_HEADERS = [
  'Date',
  'Merchant Name',
  'Category',
  'Amount',
  'Type',
  'Account',
  'To Account',
  'Description',
  'Receipt Items',
] as const;

export interface BuildTransactionsCsvOptions {
  wallets?: ReadonlyArray<Pick<Wallet, 'id' | 'name'>>;
  dateFormat?: string;
}

function escapeCsvCell(value: string | null | undefined): string {
  const safe = value ?? '';
  return `"${safe.replace(/"/g, '""')}"`;
}

function formatCsvDate(timestamp: number, dateFormat?: string): string {
  const options: Intl.DateTimeFormatOptions = {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  };
  try {
    return new Date(timestamp).toLocaleDateString(dateFormat || 'en-GB', options);
  } catch {
    return new Date(timestamp).toLocaleDateString('en-GB', options);
  }
}

function resolveCsvTypeLabel(tx: Pick<Transaction, 'type' | 'totalAmount'>): 'Transfer' | 'Income' | 'Expense' {
  if (tx.type === 'transfer') return 'Transfer';
  if (tx.type === 'income') return 'Income';
  if (tx.type === 'expense') return 'Expense';
  return (tx.totalAmount || 0) > 0 ? 'Income' : 'Expense';
}

/**
 * Pure CSV builder for exporting transactions.
 * Labels transfers accurately as "Transfer" and includes "Account" and "To Account" columns.
 */
export function buildTransactionsCsv(
  transactions: ReadonlyArray<Transaction>,
  options?: BuildTransactionsCsvOptions
): string {
  const walletMap = new Map<number, string>();
  if (options?.wallets) {
    for (const wallet of options.wallets) {
      walletMap.set(wallet.id, wallet.name);
    }
  }

  const lines: string[] = [CSV_HEADERS.join(',')];

  for (const tx of transactions) {
    const dateStr = formatCsvDate(tx.date, options?.dateFormat);
    const merchant = escapeCsvCell(tx.merchantName);
    const category = escapeCsvCell(tx.category);
    const amount = Number.isFinite(tx.totalAmount) ? tx.totalAmount : 0;
    const typeLabel = resolveCsvTypeLabel(tx);
    const accountName = tx.walletId != null ? walletMap.get(tx.walletId) ?? '' : '';
    const toAccountName =
      tx.type === 'transfer' && tx.toWalletId != null ? walletMap.get(tx.toWalletId) ?? '' : '';
    const note = escapeCsvCell(tx.note);
    const lineItemsText = escapeCsvCell(tx.lineItemsText);

    lines.push(
      [
        dateStr,
        merchant,
        category,
        String(amount),
        typeLabel,
        escapeCsvCell(accountName),
        escapeCsvCell(toAccountName),
        note,
        lineItemsText,
      ].join(',')
    );
  }

  return `${lines.join('\n')}\n`;
}
