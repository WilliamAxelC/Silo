import { mapTransactionRowToModel, buildEditableTransactionInput } from '../mappers';
import { UNCATEGORIZED_EXPENSE_LABEL, UNCATEGORIZED_INCOME_LABEL } from '../constants';
import type { Transaction } from '../types';

describe('transaction mappers', () => {
  describe('mapTransactionRowToModel', () => {
    it('maps complete row to domain Transaction model correctly', () => {
      const row = {
        id: 42,
        merchantName: 'Superindo',
        totalAmount: -850000,
        type: 'expense',
        date: 1710000000000,
        imageUri: 'file:///images/receipt.jpg',
        note: 'Grocery restock',
        lineItemsText: 'Milk | 35000\nEggs | 32000',
        category: 'Groceries',
      };

      const model = mapTransactionRowToModel(row);
      expect(model).toEqual({
        id: 42,
        merchantName: 'Superindo',
        totalAmount: -850000,
        type: 'expense',
        date: 1710000000000,
        imageUri: 'file:///images/receipt.jpg',
        note: 'Grocery restock',
        lineItemsText: 'Milk | 35000\nEggs | 32000',
        category: 'Groceries',
      });
    });

    it('falls back to Uncategorized Expense when category is null for expense', () => {
      const row = {
        id: 1,
        merchantName: 'Warung',
        totalAmount: -25000,
        type: 'expense',
        date: 1710000000000,
        imageUri: null,
        note: null,
        lineItemsText: null,
        category: null,
      };

      const model = mapTransactionRowToModel(row);
      expect(model.category).toBe(UNCATEGORIZED_EXPENSE_LABEL);
      expect(model.note).toBe('');
      expect(model.lineItemsText).toBe('');
      expect(model.imageUri).toBeNull();
    });

    it('falls back to Uncategorized Income when category is null for income', () => {
      const row = {
        id: 2,
        merchantName: 'Freelance Client',
        totalAmount: 5000000,
        type: 'income',
        date: 1710000000000,
        imageUri: null,
        note: null,
        lineItemsText: null,
        category: null,
      };

      const model = mapTransactionRowToModel(row);
      expect(model.category).toBe(UNCATEGORIZED_INCOME_LABEL);
      expect(model.type).toBe('income');
    });

    it('handles missing merchant name with fallback', () => {
      const model = mapTransactionRowToModel({
        id: 3,
        totalAmount: -10000,
      });
      expect(model.merchantName).toBe('Unknown Merchant');
    });
  });

  describe('buildEditableTransactionInput', () => {
    it('creates editable TransactionInput from Transaction domain model', () => {
      const tx: Transaction = {
        id: 10,
        merchantName: 'Kopi Kenangan',
        totalAmount: -45000,
        type: 'expense',
        category: 'Food & Dining',
        date: 1712000000000,
        imageUri: 'file:///path.jpg',
        note: 'Iced coffee',
        lineItemsText: 'Coffee | 45000',
      };

      const input = buildEditableTransactionInput(tx);
      expect(input).toEqual({
        merchantName: 'Kopi Kenangan',
        totalAmount: -45000,
        type: 'expense',
        category: 'Food & Dining',
        date: 1712000000000,
        imageUri: 'file:///path.jpg',
        note: 'Iced coffee',
        lineItemsText: 'Coffee | 45000',
      });
      expect((input as any).id).toBeUndefined();
    });
  });
});
