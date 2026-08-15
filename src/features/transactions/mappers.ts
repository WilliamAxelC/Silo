import type { Transaction, TransactionInput, TransactionType } from './types';
import { createTransactionInput } from './factories';
import { UNCATEGORIZED_EXPENSE_LABEL, UNCATEGORIZED_INCOME_LABEL } from './constants';
import { roundCurrency } from './amount';

export type TransactionListRow = {
  id: number;
  merchantName: string;
  totalAmount: number;
  type: string;
  date: number;
  imageUri: string | null;
  note: string | null;
  lineItemsText: string | null;
  category: string | null;
};

export function mapTransactionRowToModel(row: Partial<TransactionListRow> & { id: number }): Transaction {
  const rawType = row.type as TransactionType;
  const type: TransactionType = rawType === 'income' || rawType === 'expense' || rawType === 'transfer'
    ? rawType
    : (typeof row.totalAmount === 'number' && row.totalAmount > 0 ? 'income' : 'expense');

  const defaultCategory = type === 'income' ? UNCATEGORIZED_INCOME_LABEL : UNCATEGORIZED_EXPENSE_LABEL;
  const category = row.category?.trim() || defaultCategory;
  const merchantName = (row.merchantName ?? '').trim() || 'Unknown Merchant';
  const totalAmount = typeof row.totalAmount === 'number' && Number.isFinite(row.totalAmount)
    ? roundCurrency(row.totalAmount)
    : 0;
  const date = typeof row.date === 'number' && Number.isFinite(row.date) && row.date > 0
    ? row.date
    : Date.now();

  return {
    id: row.id,
    merchantName,
    totalAmount,
    type,
    date,
    imageUri: row.imageUri ?? null,
    note: row.note?.trim() ?? '',
    lineItemsText: row.lineItemsText?.trim() ?? '',
    category,
  };
}

export function buildEditableTransactionInput(transaction: Partial<Transaction>): TransactionInput {
  return createTransactionInput({
    merchantName: transaction.merchantName ?? '',
    totalAmount: transaction.totalAmount ?? 0,
    type: transaction.type ?? 'expense',
    category: transaction.category ?? '',
    date: transaction.date ?? Date.now(),
    note: transaction.note ?? '',
    lineItemsText: transaction.lineItemsText ?? '',
    imageUri: transaction.imageUri ?? null,
  });
}

