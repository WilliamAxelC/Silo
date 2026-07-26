import type { TransactionInput, TransactionType } from './types';

export function createTransactionInput(input?: Partial<TransactionInput>): TransactionInput {
  return {
    merchantName: input?.merchantName ?? '',
    totalAmount: input?.totalAmount ?? 0,
    type: input?.type ?? 'expense',
    category: input?.category ?? '',
    date: input?.date ?? Date.now(),
    note: input?.note ?? '',
    lineItemsText: input?.lineItemsText ?? '',
    imageUri: input?.imageUri ?? null,
  };
}

export function deriveEditableTransactionType(totalAmount: number, fallbackType: TransactionType): TransactionType {
  if (totalAmount > 0) {
    return 'income';
  }

  if (totalAmount < 0) {
    return 'expense';
  }

  return fallbackType;
}

export function normalizeTransactionInput(input: TransactionInput): TransactionInput {
  return {
    ...createTransactionInput(input),
    merchantName: input.merchantName.trim(),
    category: input.category.trim(),
    note: input.note?.trim() ?? '',
    lineItemsText: input.lineItemsText?.trim() ?? '',
  };
}
