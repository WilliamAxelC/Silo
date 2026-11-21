import { create } from 'zustand';
import { and, desc, eq, sql } from 'drizzle-orm';

import {
  db,
  expoDb,
  searchTransactions as searchTransactionsDb,
  summarizeSearchTransactions as summarizeSearchTransactionsDb,
  type SearchTransactionsOptions,
} from '../db/index';
import { aiTransactionsView, budgets, categories, transactionItems, transactions } from '../db/schema';
import { roundCurrency, type TransactionFilterSummary } from '../features/transactions/amount';
import { DEFAULT_WALLET_ID, TRANSFER_CATEGORY_LABEL } from '../features/transactions/constants';
import { buildDummyTransactions } from '../features/transactions/dummyData';
import {
  getCategoriesForType,
  getCategoryTypeForTransaction,
  getUncategorizedLabel,
  inferCategoryType,
  isDuplicateCategory,
  normalizeCategoryName,
} from '../features/transactions/categories';
import { normalizeTransactionInput } from '../features/transactions/factories';
import { mapTransactionRowToModel } from '../features/transactions/mappers';
import type { CategoryRecord, CategoryType, Transaction, TransactionInput, TransactionUpdate, TransactionType, Wallet, WalletType } from '../features/transactions/types';

export type { Transaction, TransactionInput, TransactionUpdate } from '../features/transactions/types';

export interface WalletInput {
  name: string;
  type: WalletType;
  initialBalance: number;
}

interface TransactionState {
  transactionsList: Transaction[];
  /** Accounts (cash, bank, e-wallet, card) with live balances, active first. */
  wallets: Wallet[];
  categories: CategoryRecord[];
  budgets: Record<string, number>;
  isSaving: boolean;
  error: string | null;

  initDB: () => Promise<void>;
  fetchTransactions: () => Promise<void>;
  fetchCategories: () => Promise<void>;
  fetchBudgets: () => Promise<void>;
  fetchWallets: () => void;
  addWallet: (input: WalletInput) => number;
  updateWallet: (id: number, input: Partial<WalletInput> & { isActive?: boolean }) => void;
  /** Deletes an unused account; one with transactions is archived instead. Returns what happened. */
  removeWallet: (id: number) => { ok: boolean; archived?: boolean; message?: string };
  searchTransactions: (query: string, options?: SearchTransactionsOptions) => Promise<Transaction[]>;
  summarizeSearchTransactions: (query: string, options?: SearchTransactionsOptions) => Promise<TransactionFilterSummary>;
  addTransaction: (tx: TransactionInput, options?: { skipRefresh?: boolean }) => Promise<void>;
  updateTransaction: (id: number, tx: TransactionUpdate) => Promise<void>;
  deleteTransaction: (id: number) => Promise<void>;
  addCategory: (name: string, type: CategoryType) => Promise<string>;
  renameCategory: (id: number, nextName: string) => Promise<{ ok: boolean; message?: string }>;
  deleteCategory: (id: number) => Promise<{ ok: boolean; message?: string }>;
  getCategoriesByType: (type: CategoryType) => CategoryRecord[];
  normalizeCategoryForType: (category: string, transactionType: TransactionType) => string;
  getCategoryUsageCount: (name: string, type: CategoryType) => Promise<number>;
  setBudget: (category: string, limitAmount: number) => Promise<void>;

  clearAllData: () => Promise<void>;
  injectDummyData: () => Promise<void>;
  clearError: () => void;
}

function normalizeBudgetMap(rows: Array<{ category: string; limitAmount: number }>) {
  const budgetMap: Record<string, number> = {};
  rows.forEach((row) => {
    budgetMap[row.category] = row.limitAmount;
  });
  return budgetMap;
}

const WALLET_TYPES = new Set<WalletType>(['cash', 'bank', 'ewallet', 'card', 'savings']);

function readWallets(): Wallet[] {
  const rows = expoDb.getAllSync<{
    id: number;
    name: string;
    type: string;
    isActive: number | null;
    initialBalance: number | null;
    balance: number | null;
  }>(`
    SELECT w.id, w.name, w.type, w.is_active AS isActive, w.initial_balance AS initialBalance,
      COALESCE(w.initial_balance, 0)
        + COALESCE((SELECT SUM(t.total_amount) FROM transactions t WHERE t.wallet_id = w.id), 0)
        - COALESCE((SELECT SUM(t.total_amount) FROM transactions t WHERE t.to_wallet_id = w.id AND t.type = 'transfer'), 0)
        AS balance
    FROM wallets w
    ORDER BY w.is_active DESC, w.id ASC;
  `);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: WALLET_TYPES.has(row.type as WalletType) ? (row.type as WalletType) : 'cash',
    isActive: row.isActive !== 0,
    initialBalance: row.initialBalance ?? 0,
    balance: roundCurrency(row.balance ?? 0),
  }));
}

function resolveAccounts(tx: Pick<TransactionInput, 'type' | 'walletId' | 'toWalletId'>) {
  const walletId = tx.walletId ?? DEFAULT_WALLET_ID;
  if (tx.type !== 'transfer') return { walletId, toWalletId: null };
  if (!tx.toWalletId || tx.toWalletId === walletId) {
    throw new Error('Choose two different accounts for a transfer.');
  }
  return { walletId, toWalletId: tx.toWalletId };
}

export const useTransactionStore = create<TransactionState>((set, get) => ({
  transactionsList: [],
  wallets: [],
  categories: [],
  budgets: {},
  isSaving: false,
  error: null,

  initDB: async () => {
    get().fetchWallets();
    await get().fetchCategories();
    await get().fetchTransactions();
    await get().fetchBudgets();
  },

  fetchTransactions: async () => {
    try {
      const rows = await db
        .select({
          id: aiTransactionsView.transactionId,
          merchantName: aiTransactionsView.merchantName,
          totalAmount: aiTransactionsView.totalAmount,
          type: aiTransactionsView.type,
          date: aiTransactionsView.date,
          imageUri: transactions.imageUri,
          note: aiTransactionsView.note,
          lineItemsText: aiTransactionsView.lineItemsText,
          category: aiTransactionsView.category,
          walletId: transactions.walletId,
          toWalletId: transactions.toWalletId,
        })
        .from(aiTransactionsView)
        .leftJoin(transactions, eq(aiTransactionsView.transactionId, transactions.id))
        .orderBy(desc(aiTransactionsView.date));

      set({ transactionsList: rows.map(mapTransactionRowToModel) });
      get().fetchWallets();
    } catch (error) {
      console.error('Failed to fetch transactions:', error);
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  fetchWallets: () => {
    try {
      set({ wallets: readWallets() });
    } catch (error) {
      console.warn('Failed to read accounts:', error);
    }
  },

  addWallet: ({ name, type, initialBalance }) => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Give the account a name.');
    const result = expoDb.runSync('INSERT INTO wallets (name, type, is_active, initial_balance) VALUES (?, ?, 1, ?);', [
      trimmed,
      type,
      Number.isFinite(initialBalance) ? initialBalance : 0,
    ]);
    get().fetchWallets();
    return Number(result.lastInsertRowId);
  },

  updateWallet: (id, input) => {
    const current = get().wallets.find((wallet) => wallet.id === id);
    if (!current) return;
    if (input.isActive === false && get().wallets.filter((w) => w.isActive).length <= 1 && current.isActive) {
      throw new Error('Keep at least one active account.');
    }
    expoDb.runSync('UPDATE wallets SET name = ?, type = ?, initial_balance = ?, is_active = ? WHERE id = ?;', [
      (input.name ?? current.name).trim() || current.name,
      input.type ?? current.type,
      input.initialBalance ?? current.initialBalance,
      (input.isActive ?? current.isActive) ? 1 : 0,
      id,
    ]);
    get().fetchWallets();
  },

  removeWallet: (id) => {
    const wallet = get().wallets.find((item) => item.id === id);
    if (!wallet) return { ok: false, message: 'Account not found.' };
    if (wallet.isActive && get().wallets.filter((w) => w.isActive).length <= 1) {
      return { ok: false, message: 'Keep at least one active account.' };
    }
    const used = expoDb.getFirstSync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM transactions WHERE wallet_id = ? OR to_wallet_id = ?;',
      [id, id],
    );
    // The default account is the fallback for saves without an account (and budgets point at it): archive only.
    if ((used?.n ?? 0) > 0 || id === DEFAULT_WALLET_ID) {
      expoDb.runSync('UPDATE wallets SET is_active = 0 WHERE id = ?;', [id]);
      get().fetchWallets();
      return { ok: true, archived: true };
    }
    expoDb.runSync('DELETE FROM wallets WHERE id = ?;', [id]);
    get().fetchWallets();
    return { ok: true };
  },

  fetchCategories: async () => {
    try {
      const rows = await db.select().from(categories).orderBy(categories.type, categories.name);
      set({
        categories: rows.map((row) => ({
          id: row.id,
          name: row.name,
          type: row.type as CategoryType,
          isSystem: row.isSystem,
          createdAt: row.createdAt,
        })),
      });
    } catch (error) {
      console.error('Failed to fetch categories:', error);
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  fetchBudgets: async () => {
    try {
      const expenseCategoryNames = new Set(get().categories.filter((category) => category.type === 'expense').map((category) => category.name));
      const allRows = await db.select().from(budgets);
      const filteredRows = allRows.filter((row) => expenseCategoryNames.has(row.category));
      set({ budgets: normalizeBudgetMap(filteredRows) });
    } catch (error) {
      console.error('Failed to fetch budgets:', error);
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  searchTransactions: async (query, options) => {
    try {
      return searchTransactionsDb(query, options);
    } catch (error) {
      console.error('Failed to search transactions:', error);
      set({ error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  },

  summarizeSearchTransactions: async (query, options) => {
    try {
      return summarizeSearchTransactionsDb(query, options);
    } catch (error) {
      console.error('Failed to summarize search transactions:', error);
      set({ error: error instanceof Error ? error.message : String(error) });
      return { count: 0, totalIn: 0, totalOut: 0, net: 0 };
    }
  },

  getCategoriesByType: (type) => getCategoriesForType(get().categories, type),

  normalizeCategoryForType: (category, transactionType) => {
    const type = getCategoryTypeForTransaction(transactionType);
    const normalized = normalizeCategoryName(category);
    const available = getCategoriesForType(get().categories, type);
    const exists = available.some((item) => item.name.toLowerCase() === normalized.toLowerCase());

    if (exists) {
      return available.find((item) => item.name.toLowerCase() === normalized.toLowerCase())?.name ?? normalized;
    }

    return getUncategorizedLabel(type);
  },

  getCategoryUsageCount: async (name, type) => {
    const normalizedName = normalizeCategoryName(name);
    const transactionUsage = await db
      .select({ count: sql<number>`count(*)` })
      .from(transactionItems)
      .leftJoin(transactions, eq(transactions.id, transactionItems.transactionId))
      .where(and(eq(transactionItems.category, normalizedName), eq(transactions.type, type)));

    const budgetUsage = type === 'expense'
      ? await db.select({ count: sql<number>`count(*)` }).from(budgets).where(eq(budgets.category, normalizedName))
      : [{ count: 0 }];

    return Number(transactionUsage[0]?.count ?? 0) + Number(budgetUsage[0]?.count ?? 0);
  },

  addCategory: async (name, type) => {
    const normalizedName = normalizeCategoryName(name);
    if (!normalizedName) {
      throw new Error('Category name is required.');
    }

    if (isDuplicateCategory(get().categories, normalizedName, type)) {
      throw new Error('A category with this name already exists for this type.');
    }

    await db.insert(categories).values({
      name: normalizedName,
      type,
      isSystem: false,
      createdAt: Date.now(),
    });

    await get().fetchCategories();
    return normalizedName;
  },

  renameCategory: async (id, nextName) => {
    const current = get().categories.find((item) => item.id === id);
    const normalizedName = normalizeCategoryName(nextName);

    if (!current) {
      return { ok: false, message: 'Category not found.' };
    }

    if (!normalizedName) {
      return { ok: false, message: 'Category name cannot be empty.' };
    }

    if (isDuplicateCategory(get().categories, normalizedName, current.type, id)) {
      return { ok: false, message: 'A category with this name already exists for this type.' };
    }

    await db.transaction(async (tx) => {
      await tx.update(categories).set({ name: normalizedName }).where(eq(categories.id, id));
      await tx
        .update(transactionItems)
        .set({ category: normalizedName })
        .where(
          and(
            eq(transactionItems.category, current.name),
            sql`${transactionItems.transactionId} IN (SELECT ${transactions.id} FROM ${transactions} WHERE ${transactions.type} = ${current.type})`
          )
        );

      if (current.type === 'expense') {
        const matchingBudgetRows = await tx.select().from(budgets).where(eq(budgets.category, current.name));
        if (matchingBudgetRows.length > 0) {
          await tx.update(budgets).set({ category: normalizedName }).where(eq(budgets.category, current.name));
        }
      }
    });

    await get().fetchCategories();
    await get().fetchTransactions();
    await get().fetchBudgets();
    return { ok: true };
  },

  deleteCategory: async (id) => {
    const current = get().categories.find((item) => item.id === id);
    if (!current) {
      return { ok: false, message: 'Category not found.' };
    }

    if (current.isSystem) {
      return { ok: false, message: 'System categories cannot be deleted.' };
    }

    const usageCount = await get().getCategoryUsageCount(current.name, current.type);
    if (usageCount > 0) {
      return { ok: false, message: 'This category is already used in transactions or budgets.' };
    }

    await db.delete(categories).where(eq(categories.id, id));
    await get().fetchCategories();
    await get().fetchBudgets();
    return { ok: true };
  },

  addTransaction: async (tx, options) => {
    set({ isSaving: true });
    try {
      const normalizedTx = normalizeTransactionInput(tx);
      const categoryType = getCategoryTypeForTransaction(normalizedTx.type);
      const normalizedCategory =
        normalizedTx.type === 'transfer'
          ? TRANSFER_CATEGORY_LABEL
          : get().normalizeCategoryForType(normalizedTx.category, normalizedTx.type);
      const accounts = resolveAccounts(normalizedTx);
      await db.transaction(async (txDb) => {
        const [newTx] = await txDb
          .insert(transactions)
          .values({
            walletId: accounts.walletId,
            toWalletId: accounts.toWalletId,
            merchantName: normalizedTx.merchantName,
            totalAmount: normalizedTx.totalAmount,
            type: normalizedTx.type,
            date: normalizedTx.date,
            imageUri: normalizedTx.imageUri,
            note: normalizedTx.note,
            lineItemsText: normalizedTx.lineItemsText,
          })
          .returning({ id: transactions.id });

        if (newTx?.id) {
          await txDb.insert(transactionItems).values({
            transactionId: newTx.id,
            category: normalizedCategory || getUncategorizedLabel(categoryType),
            amount: Math.abs(normalizedTx.totalAmount),
          });
        }
      });

      if (!options?.skipRefresh) {
        await get().fetchTransactions();
      }
    } catch (error) {
      console.error('Failed to add transaction:', error);
      set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      set({ isSaving: false });
    }
  },

  updateTransaction: async (id, tx) => {
    set({ isSaving: true });
    try {
      const normalizedTx = normalizeTransactionInput(tx as TransactionInput);
      const existingTransaction = get().transactionsList.find((item) => item.id === id);
      const nextType = (tx.type ?? existingTransaction?.type ?? 'expense') as TransactionType;
      const nextCategory =
        nextType === 'transfer'
          ? TRANSFER_CATEGORY_LABEL
          : tx.category !== undefined
            ? get().normalizeCategoryForType(normalizedTx.category, nextType)
            : existingTransaction?.category;
      const accountsChanged = tx.walletId !== undefined || tx.toWalletId !== undefined || tx.type !== undefined;
      const accounts = accountsChanged
        ? resolveAccounts({
            type: nextType,
            walletId: tx.walletId ?? existingTransaction?.walletId,
            toWalletId: tx.toWalletId !== undefined ? tx.toWalletId : existingTransaction?.toWalletId,
          })
        : null;

      await db.transaction(async (txDb) => {
        if (
          tx.merchantName !== undefined ||
          tx.totalAmount !== undefined ||
          tx.date !== undefined ||
          tx.type !== undefined ||
          tx.imageUri !== undefined ||
          tx.note !== undefined ||
          tx.lineItemsText !== undefined ||
          accounts
        ) {
          await txDb
            .update(transactions)
            .set({
              merchantName: tx.merchantName !== undefined ? normalizedTx.merchantName : undefined,
              totalAmount: tx.totalAmount,
              type: tx.type,
              date: tx.date,
              imageUri: tx.imageUri,
              note: tx.note !== undefined ? normalizedTx.note : undefined,
              lineItemsText: tx.lineItemsText !== undefined ? normalizedTx.lineItemsText : undefined,
              walletId: accounts?.walletId,
              toWalletId: accounts ? accounts.toWalletId : undefined,
            })
            .where(eq(transactions.id, id));
        }

        if (tx.category !== undefined || tx.totalAmount !== undefined || tx.type !== undefined) {
          await txDb
            .update(transactionItems)
            .set({
              category: nextCategory,
              amount: tx.totalAmount !== undefined ? Math.abs(tx.totalAmount) : undefined,
            })
            .where(eq(transactionItems.transactionId, id));
        }
      });

      await get().fetchTransactions();
      await get().fetchBudgets();
    } catch (error) {
      console.error('Failed to update transaction:', error);
      set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      set({ isSaving: false });
    }
  },

  deleteTransaction: async (id) => {
    try {
      await db.transaction(async (tx) => {
        await tx.delete(transactionItems).where(eq(transactionItems.transactionId, id));
        await tx.delete(transactions).where(eq(transactions.id, id));
      });
      await get().fetchTransactions();
      await get().fetchBudgets();
    } catch (error) {
      console.error('Failed to delete transaction:', error);
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  setBudget: async (category, limitAmount) => {
    try {
      const normalizedCategory = normalizeCategoryName(category);
      await db.transaction(async (txDb) => {
        await txDb.delete(budgets).where(eq(budgets.category, normalizedCategory));
        if (limitAmount > 0) {
          await txDb.insert(budgets).values({ category: normalizedCategory, limitAmount, walletId: DEFAULT_WALLET_ID });
        }
      });
      await get().fetchBudgets();
    } catch (error) {
      console.error('Failed to set budget:', error);
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  clearAllData: async () => {
    try {
      await db.transaction(async (txDb) => {
        await txDb.delete(transactionItems);
        await txDb.delete(transactions);
        await txDb.delete(budgets);
      });
      await get().fetchTransactions();
      await get().fetchBudgets();
    } catch (error) {
      console.error('Failed to clear data:', error);
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  injectDummyData: async () => {
    set({ isSaving: true });
    try {
      const existingCategories = get().categories;
      for (const tx of buildDummyTransactions()) {
        const normalizedCategoryName = normalizeCategoryName(tx.category);
        const categoryType = inferCategoryType(normalizedCategoryName, tx.type);
        const alreadyExists = existingCategories.some(
          (category) => category.type === categoryType && category.name.toLowerCase() === normalizedCategoryName.toLowerCase()
        );

        if (!alreadyExists) {
          await get().addCategory(normalizedCategoryName, categoryType);
        }

        await get().addTransaction(tx, { skipRefresh: true });
      }
      await get().fetchTransactions();
      await get().fetchBudgets();
    } catch (error) {
      console.error('Failed to inject dummy data:', error);
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ isSaving: false });
    }
  },

  clearError: () => set({ error: null }),
}));
