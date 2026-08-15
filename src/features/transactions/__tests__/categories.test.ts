import {
  inferCategoryType,
  normalizeCategoryName,
  isDuplicateCategory,
  getCategoriesForType,
  getCategoryTypeForTransaction,
  getUncategorizedLabel,
} from '../categories';
import type { CategoryRecord } from '../types';

describe('categories utilities', () => {
  it('normalizes category names properly', () => {
    expect(normalizeCategoryName('  Food   & Dining  ')).toBe('Food & Dining');
    expect(normalizeCategoryName('Groceries')).toBe('Groceries');
  });

  it('infers category type correctly based on standard names', () => {
    expect(inferCategoryType('Salary')).toBe('income');
    expect(inferCategoryType('Freelance')).toBe('income');
    expect(inferCategoryType('Food & Dining')).toBe('expense');
    expect(inferCategoryType('Transport')).toBe('expense');
    expect(inferCategoryType('Groceries')).toBe('expense');
    expect(inferCategoryType('Custom Unknown', 'income')).toBe('income');
    expect(inferCategoryType('Custom Unknown', 'expense')).toBe('expense');
  });

  it('detects duplicate categories case-insensitively', () => {
    const existing: CategoryRecord[] = [
      { id: 1, name: 'Food & Dining', type: 'expense', isSystem: true, createdAt: 1000 },
      { id: 2, name: 'Salary', type: 'income', isSystem: true, createdAt: 1000 },
    ];

    expect(isDuplicateCategory(existing, 'food & dining', 'expense')).toBe(true);
    expect(isDuplicateCategory(existing, 'FOOD & DINING', 'expense')).toBe(true);
    expect(isDuplicateCategory(existing, 'Food & Dining', 'income')).toBe(false);
    expect(isDuplicateCategory(existing, 'Groceries', 'expense')).toBe(false);
    expect(isDuplicateCategory(existing, 'Food & Dining', 'expense', 1)).toBe(false); // excludes own id
  });

  it('filters and sorts categories by type', () => {
    const categories: CategoryRecord[] = [
      { id: 1, name: 'Transport', type: 'expense', isSystem: true, createdAt: 1000 },
      { id: 2, name: 'Salary', type: 'income', isSystem: true, createdAt: 1000 },
      { id: 3, name: 'Bills', type: 'expense', isSystem: true, createdAt: 1000 },
    ];

    const expenses = getCategoriesForType(categories, 'expense');
    expect(expenses.length).toBe(2);
    expect(expenses[0].name).toBe('Bills');
    expect(expenses[1].name).toBe('Transport');

    const incomes = getCategoriesForType(categories, 'income');
    expect(incomes.length).toBe(1);
    expect(incomes[0].name).toBe('Salary');
  });

  it('returns correct category type for transaction types', () => {
    expect(getCategoryTypeForTransaction('income')).toBe('income');
    expect(getCategoryTypeForTransaction('expense')).toBe('expense');
    expect(getUncategorizedLabel('income')).toContain('Income');
    expect(getUncategorizedLabel('expense')).toContain('Expense');
  });
});
