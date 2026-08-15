import type { TransactionInput, TransactionType } from './types';
import { roundCurrency } from './amount';

const VALID_TRANSACTION_TYPES = new Set<TransactionType>(['expense', 'income', 'transfer']);

export function createTransactionInput(input?: Partial<TransactionInput>): TransactionInput {
  const rawType = input?.type;
  const type: TransactionType = rawType && VALID_TRANSACTION_TYPES.has(rawType) ? rawType : 'expense';

  const rawAmount = typeof input?.totalAmount === 'number' && Number.isFinite(input.totalAmount)
    ? input.totalAmount
    : 0;

  const rawDate = typeof input?.date === 'number' && Number.isFinite(input.date) && input.date > 0
    ? input.date
    : Date.now();

  return {
    merchantName: input?.merchantName ?? '',
    totalAmount: roundCurrency(rawAmount),
    type,
    category: input?.category ?? '',
    date: rawDate,
    note: input?.note ?? '',
    lineItemsText: input?.lineItemsText ?? '',
    imageUri: input?.imageUri ?? null,
  };
}

export function deriveEditableTransactionType(totalAmount: number, fallbackType: TransactionType): TransactionType {
  if (typeof totalAmount === 'number' && Number.isFinite(totalAmount)) {
    if (totalAmount > 0) {
      return 'income';
    }
    if (totalAmount < 0) {
      return 'expense';
    }
  }

  return VALID_TRANSACTION_TYPES.has(fallbackType) ? fallbackType : 'expense';
}

export function normalizeTransactionInput(input: Partial<TransactionInput>): TransactionInput {
  const base = createTransactionInput(input);
  const merchantName = (input.merchantName ?? '').trim();
  const category = (input.category ?? '').trim();
  const note = input.note?.trim() ?? '';
  const lineItemsText = input.lineItemsText?.trim() ?? '';
  const absAmount = Math.abs(base.totalAmount);

  let signedAmount = absAmount;
  if (base.type === 'expense' || base.type === 'transfer') {
    signedAmount = -absAmount;
  }

  return {
    ...base,
    merchantName,
    category,
    note,
    lineItemsText,
    totalAmount: roundCurrency(signedAmount),
  };
}

