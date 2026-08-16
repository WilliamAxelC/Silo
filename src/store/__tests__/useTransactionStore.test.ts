import { useTransactionStore } from '../useTransactionStore';
import { db, searchTransactions as searchTransactionsDb } from '../../db/index';
import type { CategoryRecord, Transaction } from '../../features/transactions/types';

// Mock DB
jest.mock('../../db/index', () => {
  const createSelectChain = (data: any[] = []) => ({
    from: jest.fn(() => {
      const queryObj: any = Promise.resolve(data);
      queryObj.orderBy = jest.fn(() => Promise.resolve(data));
      queryObj.where = jest.fn(() => Promise.resolve(data));
      queryObj.leftJoin = jest.fn(() => ({
        orderBy: jest.fn(() => Promise.resolve(data)),
        where: jest.fn(() => Promise.resolve(data)),
      }));
      return queryObj;
    }),
  });

  const mockSelect = jest.fn(() => createSelectChain([]));
  const mockInsert = jest.fn(() => ({
    values: jest.fn(() => Promise.resolve()),
  }));
  const mockUpdate = jest.fn(() => ({
    set: jest.fn(() => ({
      where: jest.fn(() => Promise.resolve()),
    })),
  }));
  const mockDelete = jest.fn(() => ({
    where: jest.fn(() => Promise.resolve()),
  }));
  const mockTxDb = {
    insert: jest.fn(() => ({
      values: jest.fn(() => ({
        returning: jest.fn(() => Promise.resolve([{ id: 99 }])),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(() => Promise.resolve()),
      })),
    })),
    delete: jest.fn(() => ({
      where: jest.fn(() => Promise.resolve()),
    })),
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => Promise.resolve([])),
      })),
    })),
  };

  return {
    db: {
      select: mockSelect,
      insert: mockInsert,
      update: mockUpdate,
      delete: mockDelete,
      transaction: jest.fn((cb) => cb(mockTxDb)),
    },
    searchTransactions: jest.fn(),
    expoDb: {
      getAllSync: jest.fn(() => []),
      getFirstSync: jest.fn(() => null),
      runSync: jest.fn(() => ({ lastInsertRowId: 1, changes: 1 })),
      execSync: jest.fn(),
      withTransactionSync: jest.fn((cb) => cb()),
    },
  };
});
const initialStoreState = useTransactionStore.getState();
const pristineMethods = {
  initDB: initialStoreState.initDB,
  fetchTransactions: initialStoreState.fetchTransactions,
  fetchCategories: initialStoreState.fetchCategories,
  fetchBudgets: initialStoreState.fetchBudgets,
  searchTransactions: initialStoreState.searchTransactions,
  addTransaction: initialStoreState.addTransaction,
  updateTransaction: initialStoreState.updateTransaction,
  deleteTransaction: initialStoreState.deleteTransaction,
  addCategory: initialStoreState.addCategory,
  renameCategory: initialStoreState.renameCategory,
  deleteCategory: initialStoreState.deleteCategory,
  getCategoriesByType: initialStoreState.getCategoriesByType,
  normalizeCategoryForType: initialStoreState.normalizeCategoryForType,
  getCategoryUsageCount: initialStoreState.getCategoryUsageCount,
  setBudget: initialStoreState.setBudget,
  clearAllData: initialStoreState.clearAllData,
  injectDummyData: initialStoreState.injectDummyData,
  clearError: initialStoreState.clearError,
};

describe('useTransactionStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useTransactionStore.setState({
      ...pristineMethods,
      transactionsList: [
        {
          id: 1,
          merchantName: 'Supermarket Hero',
          totalAmount: -150000,
          type: 'expense',
          category: 'Groceries',
          date: 1700000000000,
          note: 'Groceries shopping',
          lineItemsText: 'Milk, Eggs',
          imageUri: null,
        },
        {
          id: 2,
          merchantName: 'Monthly Salary',
          totalAmount: 10000000,
          type: 'income',
          category: 'Salary',
          date: 1700000000000,
          note: 'Primary salary',
          lineItemsText: '',
          imageUri: null,
        },
      ],
      categories: [
        { id: 1, name: 'Food & Dining', type: 'expense', isSystem: true, createdAt: 1000 },
        { id: 2, name: 'Transport', type: 'expense', isSystem: true, createdAt: 1000 },
        { id: 3, name: 'Groceries', type: 'expense', isSystem: true, createdAt: 1000 },
        { id: 4, name: 'Salary', type: 'income', isSystem: true, createdAt: 1000 },
        { id: 5, name: 'Custom Hobby', type: 'expense', isSystem: false, createdAt: 2000 },
      ],
      budgets: { 'Food & Dining': 500000, Groceries: 1500000 },
      isSaving: false,
      error: null,
    });
  });

  describe('category helpers & filtering', () => {
    it('filters categories by type properly', () => {
      const expenses = useTransactionStore.getState().getCategoriesByType('expense');
      expect(expenses.map((c) => c.name)).toEqual(['Custom Hobby', 'Food & Dining', 'Groceries', 'Transport']);

      const incomes = useTransactionStore.getState().getCategoriesByType('income');
      expect(incomes.map((c) => c.name)).toEqual(['Salary']);
    });

    it('normalizes category matching an existing category name', () => {
      const normalized = useTransactionStore.getState().normalizeCategoryForType('food & dining', 'expense');
      expect(normalized).toBe('Food & Dining');
    });

    it('falls back to Uncategorized when category does not exist', () => {
      const normalizedExpense = useTransactionStore.getState().normalizeCategoryForType('Cryptocurrency Mining', 'expense');
      expect(normalizedExpense).toBe('Uncategorized Expense');

      const normalizedIncome = useTransactionStore.getState().normalizeCategoryForType('Lottery', 'income');
      expect(normalizedIncome).toBe('Uncategorized Income');
    });
  });

  describe('fetch actions (fetchTransactions, fetchCategories, fetchBudgets)', () => {
    it('fetches and maps transactions from db view', async () => {
      (db.select as jest.Mock).mockReturnValueOnce({
        from: jest.fn(() => ({
          leftJoin: jest.fn(() => ({
            orderBy: jest.fn(() => [
              {
                id: 10,
                merchantName: 'Cinema',
                totalAmount: -75000,
                type: 'expense',
                date: 1700000000000,
                imageUri: null,
                note: 'Movie ticket',
                lineItemsText: '',
                category: 'Entertainment',
              },
            ]),
          })),
        })),
      });

      await useTransactionStore.getState().fetchTransactions();
      const list = useTransactionStore.getState().transactionsList;
      expect(list.length).toBe(1);
      expect(list[0].merchantName).toBe('Cinema');
    });

    it('fetches categories from categories table', async () => {
      (db.select as jest.Mock).mockReturnValueOnce({
        from: jest.fn(() => ({
          orderBy: jest.fn(() => [
            { id: 1, name: 'Food & Dining', type: 'expense', isSystem: true, createdAt: 1000 },
          ]),
        })),
      });

      await useTransactionStore.getState().fetchCategories();
      const categories = useTransactionStore.getState().categories;
      expect(categories.length).toBe(1);
      expect(categories[0].name).toBe('Food & Dining');
    });

    it('fetches and maps budgets for expense categories', async () => {
      (db.select as jest.Mock).mockReturnValueOnce({
        from: jest.fn(() => [
          { id: 1, category: 'Food & Dining', limitAmount: 600000 },
          { id: 2, category: 'Salary', limitAmount: 0 }, // Non-expense category ignored
        ]),
      });

      await useTransactionStore.getState().fetchBudgets();
      const budgets = useTransactionStore.getState().budgets;
      expect(budgets['Food & Dining']).toBe(600000);
      expect(budgets['Salary']).toBeUndefined();
    });

    it('initializes entire DB via initDB()', async () => {
      const fetchCategoriesSpy = jest.spyOn(useTransactionStore.getState(), 'fetchCategories').mockResolvedValueOnce();
      const fetchTransactionsSpy = jest.spyOn(useTransactionStore.getState(), 'fetchTransactions').mockResolvedValueOnce();
      const fetchBudgetsSpy = jest.spyOn(useTransactionStore.getState(), 'fetchBudgets').mockResolvedValueOnce();

      await useTransactionStore.getState().initDB();
      expect(fetchCategoriesSpy).toHaveBeenCalled();
      expect(fetchTransactionsSpy).toHaveBeenCalled();
      expect(fetchBudgetsSpy).toHaveBeenCalled();
    });
  });

  describe('transactions CRUD', () => {
    it('adds a new transaction and refreshes list', async () => {
      const fetchSpy = jest.spyOn(useTransactionStore.getState(), 'fetchTransactions').mockResolvedValueOnce();

      await useTransactionStore.getState().addTransaction({
        merchantName: 'Starbucks',
        totalAmount: 50000,
        type: 'expense',
        category: 'Food & Dining',
        date: 1700000000000,
        note: 'Coffee',
        lineItemsText: '',
      });

      expect(db.transaction).toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalled();
      expect(useTransactionStore.getState().isSaving).toBe(false);
    });

    it('updates existing transaction and refreshes state', async () => {
      (db.update as jest.Mock).mockReturnValue({
        set: jest.fn(() => ({
          where: jest.fn(),
        })),
      });

      const fetchTxSpy = jest.spyOn(useTransactionStore.getState(), 'fetchTransactions').mockResolvedValueOnce();
      const fetchBudgetsSpy = jest.spyOn(useTransactionStore.getState(), 'fetchBudgets').mockResolvedValueOnce();

      await useTransactionStore.getState().updateTransaction(1, {
        merchantName: 'Supermarket Hero Updated',
        totalAmount: -175000,
      });

      expect(db.update).toHaveBeenCalled();
      expect(fetchTxSpy).toHaveBeenCalled();
      expect(fetchBudgetsSpy).toHaveBeenCalled();
    });

    it('deletes transaction and associated items', async () => {
      const fetchTxSpy = jest.spyOn(useTransactionStore.getState(), 'fetchTransactions').mockResolvedValueOnce();
      const fetchBudgetsSpy = jest.spyOn(useTransactionStore.getState(), 'fetchBudgets').mockResolvedValueOnce();

      await useTransactionStore.getState().deleteTransaction(1);

      expect(db.transaction).toHaveBeenCalled();
      expect(fetchTxSpy).toHaveBeenCalled();
      expect(fetchBudgetsSpy).toHaveBeenCalled();
    });

    it('handles rapid consecutive transaction creations without race conditions', async () => {
      const fetchSpy = jest.spyOn(useTransactionStore.getState(), 'fetchTransactions').mockResolvedValue();

      const promises = [1, 2, 3, 4, 5].map((i) =>
        useTransactionStore.getState().addTransaction({
          merchantName: `Rapid Merchant ${i}`,
          totalAmount: i * 10000,
          type: 'expense',
          category: 'Groceries',
          date: Date.now() + i,
        })
      );

      await Promise.all(promises);

      expect(db.transaction).toHaveBeenCalledTimes(5);
      expect(useTransactionStore.getState().isSaving).toBe(false);
      expect(fetchSpy).toHaveBeenCalled();
    });

    it('handles rapid consecutive updates to the same transaction', async () => {
      (db.update as jest.Mock).mockReturnValue({
        set: jest.fn(() => ({
          where: jest.fn(),
        })),
      });

      const fetchTxSpy = jest.spyOn(useTransactionStore.getState(), 'fetchTransactions').mockResolvedValue();
      const fetchBudgetsSpy = jest.spyOn(useTransactionStore.getState(), 'fetchBudgets').mockResolvedValue();

      const update1 = useTransactionStore.getState().updateTransaction(1, { merchantName: 'Update 1' });
      const update2 = useTransactionStore.getState().updateTransaction(1, { totalAmount: -200000 });
      const update3 = useTransactionStore.getState().updateTransaction(1, { note: 'Rapid note' });

      await Promise.all([update1, update2, update3]);

      expect(db.update).toHaveBeenCalled();
      expect(useTransactionStore.getState().isSaving).toBe(false);
    });

    it('resets isSaving and sets error when addTransaction fails', async () => {
      (db.transaction as jest.Mock).mockRejectedValueOnce(new Error('Disk I/O failure'));
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        useTransactionStore.getState().addTransaction({
          merchantName: 'Failed Tx',
          totalAmount: 50000,
          type: 'expense',
          category: 'Bills',
          date: Date.now(),
        })
      ).rejects.toThrow('Disk I/O failure');

      expect(useTransactionStore.getState().isSaving).toBe(false);
      expect(useTransactionStore.getState().error).toBe('Disk I/O failure');
      errorSpy.mockRestore();
    });
  });

  describe('category management', () => {
    it('adds a valid new category', async () => {
      (db.insert as jest.Mock).mockReturnValueOnce({
        values: jest.fn(() => Promise.resolve()),
      });
      const fetchSpy = jest.spyOn(useTransactionStore.getState(), 'fetchCategories').mockResolvedValueOnce();

      const added = await useTransactionStore.getState().addCategory('Pet Care', 'expense');
      expect(added).toBe('Pet Care');
      expect(db.insert).toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalled();
    });

    it('rejects adding empty or duplicate category', async () => {
      await expect(useTransactionStore.getState().addCategory('', 'expense')).rejects.toThrow(
        'Category name is required.'
      );

      await expect(useTransactionStore.getState().addCategory('Food & Dining', 'expense')).rejects.toThrow(
        'A category with this name already exists for this type.'
      );
    });

    it('renames existing category and cascades changes', async () => {
      const fetchCatSpy = jest.spyOn(useTransactionStore.getState(), 'fetchCategories').mockResolvedValueOnce();
      const fetchTxSpy = jest.spyOn(useTransactionStore.getState(), 'fetchTransactions').mockResolvedValueOnce();
      const fetchBudgetsSpy = jest.spyOn(useTransactionStore.getState(), 'fetchBudgets').mockResolvedValueOnce();

      const result = await useTransactionStore.getState().renameCategory(5, 'Crafts & Hobby');
      expect(result.ok).toBe(true);
      expect(db.transaction).toHaveBeenCalled();
      expect(fetchCatSpy).toHaveBeenCalled();
      expect(fetchTxSpy).toHaveBeenCalled();
      expect(fetchBudgetsSpy).toHaveBeenCalled();
    });

    it('prevents renaming to empty or duplicate name', async () => {
      const emptyRes = await useTransactionStore.getState().renameCategory(5, '');
      expect(emptyRes.ok).toBe(false);
      expect(emptyRes.message).toContain('empty');

      const dupRes = await useTransactionStore.getState().renameCategory(5, 'Food & Dining');
      expect(dupRes.ok).toBe(false);
      expect(dupRes.message).toContain('already exists');
    });

    it('prevents deleting system categories', async () => {
      const result = await useTransactionStore.getState().deleteCategory(1); // Food & Dining is isSystem: true
      expect(result.ok).toBe(false);
      expect(result.message).toContain('System categories cannot be deleted');
    });

    it('prevents deleting categories in use by transactions', async () => {
      jest.spyOn(useTransactionStore.getState(), 'getCategoryUsageCount').mockResolvedValueOnce(3);

      const result = await useTransactionStore.getState().deleteCategory(5);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('already used');
    });

    it('deletes unused custom category', async () => {
      jest.spyOn(useTransactionStore.getState(), 'getCategoryUsageCount').mockResolvedValueOnce(0);
      (db.delete as jest.Mock).mockReturnValueOnce({
        where: jest.fn(() => Promise.resolve()),
      });

      const result = await useTransactionStore.getState().deleteCategory(5);
      expect(result.ok).toBe(true);
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe('budgets, search, and data clearing', () => {
    it('sets budget limit for a category', async () => {
      (db.delete as jest.Mock).mockReturnValueOnce({
        where: jest.fn(() => Promise.resolve()),
      });
      (db.insert as jest.Mock).mockReturnValueOnce({
        values: jest.fn(() => Promise.resolve()),
      });
      const fetchBudgetsSpy = jest.spyOn(useTransactionStore.getState(), 'fetchBudgets').mockResolvedValueOnce();

      await useTransactionStore.getState().setBudget('Food & Dining', 750000);
      expect(db.delete).toHaveBeenCalled();
      expect(db.insert).toHaveBeenCalled();
      expect(fetchBudgetsSpy).toHaveBeenCalled();
    });

    it('deletes budget without inserting when limitAmount is 0 or negative', async () => {
      (db.delete as jest.Mock).mockReturnValueOnce({
        where: jest.fn(() => Promise.resolve()),
      });
      const fetchBudgetsSpy = jest.spyOn(useTransactionStore.getState(), 'fetchBudgets').mockResolvedValueOnce();

      await useTransactionStore.getState().setBudget('Food & Dining', 0);
      expect(db.delete).toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(fetchBudgetsSpy).toHaveBeenCalled();
      fetchBudgetsSpy.mockRestore();
    });

    it('handles single-entry budget list correctly in fetchBudgets', async () => {
      (db.select as jest.Mock).mockReturnValueOnce({
        from: jest.fn(() => [
          { id: 1, category: 'Groceries', limitAmount: 1500000 },
        ]),
      });

      await useTransactionStore.getState().fetchBudgets();
      const budgets = useTransactionStore.getState().budgets;
      expect(Object.keys(budgets).length).toBe(1);
      expect(budgets['Groceries']).toBe(1500000);
    });

    it('searches transactions using searchTransactionsDb', async () => {
      const mockResults: Transaction[] = [
        {
          id: 1,
          merchantName: 'Supermarket Hero',
          totalAmount: -150000,
          type: 'expense',
          category: 'Groceries',
          date: 1700000000000,
        },
      ];
      (searchTransactionsDb as jest.Mock).mockReturnValueOnce(mockResults);

      const results = await useTransactionStore.getState().searchTransactions('Hero', { limit: 10 });
      expect(results).toEqual(mockResults);
      expect(searchTransactionsDb).toHaveBeenCalledWith('Hero', { limit: 10 });
    });

    it('clears all transactions and budgets in DB via clearAllData()', async () => {
      (db.delete as jest.Mock).mockReturnValue({
        where: jest.fn(() => Promise.resolve()),
      });
      const fetchTxSpy = jest.spyOn(useTransactionStore.getState(), 'fetchTransactions').mockResolvedValueOnce();
      const fetchBudgetsSpy = jest.spyOn(useTransactionStore.getState(), 'fetchBudgets').mockResolvedValueOnce();

      await useTransactionStore.getState().clearAllData();
      expect(db.delete).toHaveBeenCalled();
      expect(fetchTxSpy).toHaveBeenCalled();
      expect(fetchBudgetsSpy).toHaveBeenCalled();
    });

    it('injects dummy data with automatic category creation', async () => {
      const addCatSpy = jest.spyOn(useTransactionStore.getState(), 'addCategory').mockResolvedValue('Food & Dining');
      const addTxSpy = jest.spyOn(useTransactionStore.getState(), 'addTransaction').mockResolvedValue();
      const fetchTxSpy = jest.spyOn(useTransactionStore.getState(), 'fetchTransactions').mockResolvedValue();
      const fetchBudgetsSpy = jest.spyOn(useTransactionStore.getState(), 'fetchBudgets').mockResolvedValue();

      await useTransactionStore.getState().injectDummyData();

      expect(addTxSpy).toHaveBeenCalled();
      expect(fetchTxSpy).toHaveBeenCalled();
      expect(fetchBudgetsSpy).toHaveBeenCalled();
      expect(useTransactionStore.getState().isSaving).toBe(false);
    });

    it('handles search errors gracefully and sets error state', async () => {
      (searchTransactionsDb as jest.Mock).mockImplementationOnce(() => {
        throw new Error('FTS query syntax error');
      });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const results = await useTransactionStore.getState().searchTransactions('***');
      expect(results).toEqual([]);
      expect(useTransactionStore.getState().error).toBe('FTS query syntax error');
      errorSpy.mockRestore();
    });

    it('handles setBudget errors gracefully', async () => {
      (db.delete as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Constraint violation');
      });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await useTransactionStore.getState().setBudget('Food & Dining', 500000);
      expect(useTransactionStore.getState().error).toBe('Constraint violation');
      errorSpy.mockRestore();
    });

    it('clears error on clearError()', () => {
      useTransactionStore.setState({ error: 'DB Connection Timed Out' });
      expect(useTransactionStore.getState().error).toBe('DB Connection Timed Out');

      useTransactionStore.getState().clearError();
      expect(useTransactionStore.getState().error).toBeNull();
    });
  });
});
