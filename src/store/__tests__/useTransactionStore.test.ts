import { useTransactionStore } from '../useTransactionStore';

describe('useTransactionStore', () => {
  beforeEach(() => {
    useTransactionStore.setState({
      transactionsList: [],
      categories: [
        { id: 1, name: 'Food & Dining', type: 'expense', isSystem: true, createdAt: 1000 },
        { id: 2, name: 'Transport', type: 'expense', isSystem: true, createdAt: 1000 },
        { id: 3, name: 'Salary', type: 'income', isSystem: true, createdAt: 1000 },
      ],
      budgets: { 'Food & Dining': 500000 },
      isSaving: false,
      error: null,
    });
  });

  it('filters categories by type properly', () => {
    const expenses = useTransactionStore.getState().getCategoriesByType('expense');
    expect(expenses.map((c) => c.name)).toEqual(['Food & Dining', 'Transport']);

    const incomes = useTransactionStore.getState().getCategoriesByType('income');
    expect(incomes.map((c) => c.name)).toEqual(['Salary']);
  });

  it('normalizes category name matching existing category', () => {
    const normalized = useTransactionStore.getState().normalizeCategoryForType('food & dining', 'expense');
    expect(normalized).toBe('Food & Dining');
  });

  it('falls back to Uncategorized Expense when category does not exist', () => {
    const normalized = useTransactionStore.getState().normalizeCategoryForType('Cryptocurrency Mining', 'expense');
    expect(normalized).toContain('Uncategorized');
  });

  it('clears errors on clearError call', () => {
    useTransactionStore.setState({ error: 'Some DB error' });
    expect(useTransactionStore.getState().error).toBe('Some DB error');

    useTransactionStore.getState().clearError();
    expect(useTransactionStore.getState().error).toBeNull();
  });
});
