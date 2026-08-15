import {
  createTransactionInput,
  deriveEditableTransactionType,
  normalizeTransactionInput,
} from '../factories';
import type { TransactionInput } from '../types';

describe('transaction factories', () => {
  describe('createTransactionInput', () => {
    it('creates default transaction input when called with empty or undefined arguments', () => {
      const result = createTransactionInput();

      expect(result.merchantName).toBe('');
      expect(result.totalAmount).toBe(0);
      expect(result.type).toBe('expense');
      expect(result.category).toBe('');
      expect(typeof result.date).toBe('number');
      expect(result.date).toBeGreaterThan(0);
      expect(result.note).toBe('');
      expect(result.lineItemsText).toBe('');
      expect(result.imageUri).toBeNull();
    });

    it('retains valid provided fields', () => {
      const now = 1700000000000;
      const input: Partial<TransactionInput> = {
        merchantName: 'Starbucks Coffee',
        totalAmount: 65000.5,
        type: 'expense',
        category: 'Food & Dining',
        date: now,
        note: 'Afternoon coffee with team',
        lineItemsText: '1 Caramel Macchiato',
        imageUri: 'file:///path/to/receipt.jpg',
      };

      const result = createTransactionInput(input);
      expect(result.merchantName).toBe('Starbucks Coffee');
      expect(result.totalAmount).toBe(65000.5);
      expect(result.type).toBe('expense');
      expect(result.category).toBe('Food & Dining');
      expect(result.date).toBe(now);
      expect(result.note).toBe('Afternoon coffee with team');
      expect(result.lineItemsText).toBe('1 Caramel Macchiato');
      expect(result.imageUri).toBe('file:///path/to/receipt.jpg');
    });

    it('falls back to "expense" when type is invalid or unknown', () => {
      const result = createTransactionInput({ type: 'invalid_type' as any });
      expect(result.type).toBe('expense');
    });

    it('supports "income" and "transfer" transaction types', () => {
      expect(createTransactionInput({ type: 'income' }).type).toBe('income');
      expect(createTransactionInput({ type: 'transfer' }).type).toBe('transfer');
    });

    it('guards against NaN, Infinity, -Infinity for totalAmount', () => {
      expect(createTransactionInput({ totalAmount: NaN }).totalAmount).toBe(0);
      expect(createTransactionInput({ totalAmount: Infinity }).totalAmount).toBe(0);
      expect(createTransactionInput({ totalAmount: -Infinity }).totalAmount).toBe(0);
      expect(createTransactionInput({ totalAmount: undefined }).totalAmount).toBe(0);
    });

    it('guards against non-finite or non-positive dates by falling back to current timestamp', () => {
      const before = Date.now();
      const resultZero = createTransactionInput({ date: 0 });
      const after = Date.now();
      expect(resultZero.date).toBeGreaterThanOrEqual(before);
      expect(resultZero.date).toBeLessThanOrEqual(after);

      const resultNeg = createTransactionInput({ date: -1000 });
      expect(resultNeg.date).toBeGreaterThanOrEqual(before);

      const resultNaN = createTransactionInput({ date: NaN });
      expect(resultNaN.date).toBeGreaterThanOrEqual(before);
    });
  });

  describe('deriveEditableTransactionType', () => {
    it('derives "income" when totalAmount is positive', () => {
      expect(deriveEditableTransactionType(50000, 'expense')).toBe('income');
      expect(deriveEditableTransactionType(0.01, 'transfer')).toBe('income');
    });

    it('derives "expense" when totalAmount is negative', () => {
      expect(deriveEditableTransactionType(-50000, 'income')).toBe('expense');
      expect(deriveEditableTransactionType(-0.5, 'transfer')).toBe('expense');
    });

    it('uses fallbackType when totalAmount is zero or non-finite', () => {
      expect(deriveEditableTransactionType(0, 'income')).toBe('income');
      expect(deriveEditableTransactionType(0, 'transfer')).toBe('transfer');
      expect(deriveEditableTransactionType(0, 'expense')).toBe('expense');
      expect(deriveEditableTransactionType(NaN, 'income')).toBe('income');
      expect(deriveEditableTransactionType(Infinity, 'transfer')).toBe('transfer');
    });

    it('falls back to "expense" if fallbackType is invalid and amount is zero', () => {
      expect(deriveEditableTransactionType(0, 'invalid' as any)).toBe('expense');
    });
  });

  describe('normalizeTransactionInput', () => {
    it('trims string properties (merchantName, category, note, lineItemsText)', () => {
      const input: Partial<TransactionInput> = {
        merchantName: '   Supermarket Hero   ',
        category: '  Groceries  ',
        note: '   Weekly groceries   ',
        lineItemsText: '   Apples, Milk   ',
        totalAmount: 150000,
        type: 'expense',
      };

      const normalized = normalizeTransactionInput(input);
      expect(normalized.merchantName).toBe('Supermarket Hero');
      expect(normalized.category).toBe('Groceries');
      expect(normalized.note).toBe('Weekly groceries');
      expect(normalized.lineItemsText).toBe('Apples, Milk');
    });

    it('enforces negative amount for expense and transfer types', () => {
      const expense = normalizeTransactionInput({ totalAmount: 75000, type: 'expense' });
      expect(expense.totalAmount).toBe(-75000);

      const alreadyNegExpense = normalizeTransactionInput({ totalAmount: -75000, type: 'expense' });
      expect(alreadyNegExpense.totalAmount).toBe(-75000);

      const transfer = normalizeTransactionInput({ totalAmount: 50000, type: 'transfer' });
      expect(transfer.totalAmount).toBe(-50000);
    });

    it('enforces positive amount for income type', () => {
      const income = normalizeTransactionInput({ totalAmount: 5000000, type: 'income' });
      expect(income.totalAmount).toBe(5000000);

      const negIncome = normalizeTransactionInput({ totalAmount: -5000000, type: 'income' });
      expect(negIncome.totalAmount).toBe(5000000);
    });

    it('handles zero amounts safely', () => {
      const zeroExpense = normalizeTransactionInput({ totalAmount: 0, type: 'expense' });
      expect(zeroExpense.totalAmount).toBe(0);
      expect(Object.is(zeroExpense.totalAmount, -0)).toBe(false);
    });

    it('rounds totalAmount properly to 2 decimal places', () => {
      const rounded = normalizeTransactionInput({ totalAmount: 123.4567, type: 'income' });
      expect(rounded.totalAmount).toBe(123.46);
    });
  });
});
