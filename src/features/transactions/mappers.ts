import type { Transaction, TransactionInput } from './types';
import { createTransactionInput } from './factories';
import { UNCATEGORIZED_LABEL } from './constants';

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

export function mapTransactionRowToModel(row: TransactionListRow): Transaction {
  return {
    id: row.id,
    merchantName: row.merchantName,
    totalAmount: row.totalAmount,
    type: row.type as Transaction['type'],
    date: row.date,
    imageUri: row.imageUri,
    note: row.note ?? '',
    lineItemsText: row.lineItemsText ?? '',
    category: row.category ?? UNCATEGORIZED_LABEL,
  };
}

export function buildEditableTransactionInput(transaction: Transaction): TransactionInput {
  return createTransactionInput({
    merchantName: transaction.merchantName,
    totalAmount: transaction.totalAmount,
    type: transaction.type,
    category: transaction.category,
    date: transaction.date,
    note: transaction.note,
    lineItemsText: transaction.lineItemsText,
    imageUri: transaction.imageUri ?? null,
  });
}
