import { create } from 'zustand';
import { and, eq, sql } from 'drizzle-orm';

import {
  db,
  expoDb,
  getDailyTotalsForRange as getDailyTotalsForRangeDb,
  searchTransactions as searchTransactionsDb,
  summarizeSearchTransactions as summarizeSearchTransactionsDb,
  type DailyTotal,
  type SearchTransactionsOptions,
} from '../db/index';
import { budgets, categories, transactionItems, transactions } from '../db/schema';
import { roundCurrency, type TransactionFilterSummary } from '../features/transactions/amount';
import { roundRate } from '../features/currency/conversion';
import { normalizeCurrencyCode } from '../features/currency/currencies';
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
import { mapTransactionRowToModel, type TransactionListRow } from '../features/transactions/mappers';
import type { CategoryRecord, CategoryType, Transaction, TransactionInput, TransactionUpdate, TransactionType, Wallet, WalletType } from '../features/transactions/types';

export type { Transaction, TransactionInput, TransactionUpdate } from '../features/transactions/types';

export interface WalletInput {
  name: string;
  type: WalletType;
  initialBalance: number;
  /** ISO 4217 code for a foreign-currency account; omit/null for the home currency. */
  currency?: string | null;
}

interface TransactionState {
  transactionsList: Transaction[];
  /** Accounts (cash, bank, e-wallet, card) with live balances, active first. */
  wallets: Wallet[];
  categories: CategoryRecord[];
  budgets: Record<string, number>;
  isSaving: boolean;
  error: string | null;
  /** Monotonic version incremented whenever transactions, wallets, categories, or budgets change. */
  dataVersion: number;
  hasLoadedTransactions: boolean;
  hasLoadedCategories: boolean;
  hasLoadedBudgets: boolean;
  transactionsDirty: boolean;
  categoriesDirty: boolean;
  budgetsDirty: boolean;
  /** Last user-selected Cashflow period anchor (epoch ms), preserved across edit/delete/remounts. */
  selectedCashflowDateMs: number | null;

  initDB: () => Promise<void>;
  setSelectedCashflowDateMs: (timestamp: number | null) => void;
  invalidateData: (slices?: { transactions?: boolean; categories?: boolean; budgets?: boolean }) => void;
  fetchTransactions: () => Promise<void>;
  fetchTransactionsIfNeeded: () => Promise<void>;
  fetchCategories: () => Promise<void>;
  fetchBudgets: () => Promise<void>;
  fetchWallets: () => void;
  addWallet: (input: WalletInput) => number;
  updateWallet: (id: number, input: Partial<WalletInput> & { isActive?: boolean }) => void;
  /** Deletes an unused account; one with transactions is archived instead. Returns what happened. */
  removeWallet: (id: number) => { ok: boolean; archived?: boolean; message?: string };
  searchTransactions: (query: string, options?: SearchTransactionsOptions) => Promise<Transaction[]>;
  summarizeSearchTransactions: (query: string, options?: SearchTransactionsOptions) => Promise<TransactionFilterSummary>;
  getDailyTotals: (startMs: number, endMs: number) => DailyTotal[];
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

const LIST_TRANSACTIONS_SQL = `
  SELECT
    t.id AS id,
    t.merchant_name AS merchantName,
    t.total_amount AS totalAmount,
    t.type AS type,
    t.date AS date,
    t.image_uri AS imageUri,
    t.note AS note,
    t.line_items_text AS lineItemsText,
    i.category AS category,
    t.wallet_id AS walletId,
    t.to_wallet_id AS toWalletId,
    t.original_amount AS originalAmount,
    t.original_currency AS originalCurrency,
    t.fx_rate AS fxRate,
    t.to_amount AS toAmount
  FROM transactions t
  LEFT JOIN transaction_items i ON t.id = i.transaction_id
  ORDER BY t.date DESC, t.id DESC;
`;

function compareTransactionsDesc(a: Transaction, b: Transaction): number {
  if (b.date !== a.date) return b.date - a.date;
  return b.id - a.id;
}

function insertTransactionSorted(list: Transaction[], tx: Transaction): Transaction[] {
  const withoutExisting = list.filter((item) => item.id !== tx.id);
  if (withoutExisting.length === 0 || compareTransactionsDesc(tx, withoutExisting[0]) <= 0) {
    return [tx, ...withoutExisting];
  }
  const insertIdx = withoutExisting.findIndex((item) => compareTransactionsDesc(tx, item) <= 0);
  if (insertIdx === -1) {
    return [...withoutExisting, tx];
  }
  return [...withoutExisting.slice(0, insertIdx), tx, ...withoutExisting.slice(insertIdx)];
}

function readTransactionsList(): Transaction[] {
  const rows = expoDb.getAllSync<TransactionListRow>(LIST_TRANSACTIONS_SQL);
  return rows.map(mapTransactionRowToModel);
}

/**
 * Balances are in each account's own currency: a foreign account sums the foreign-side amounts of its
 * transactions (original_amount) and what arrived through transfers (to_amount). Home accounts are unchanged.
 * averageRate = home currency paid / foreign units received across exchanges and income into the account.
 */
function readWallets(): Wallet[] {
  const rows = expoDb.getAllSync<{
    id: number;
    name: string;
    type: string;
    isActive: number | null;
    initialBalance: number | null;
    currency: string | null;
    balance: number | null;
    costHome: number | null;
    costUnits: number | null;
  }>(`
    SELECT w.id, w.name, w.type, w.is_active AS isActive, w.initial_balance AS initialBalance, w.currency AS currency,
      COALESCE(w.initial_balance, 0)
        + COALESCE((
            SELECT SUM(CASE WHEN w.currency IS NOT NULL AND t.original_currency = w.currency
                            THEN t.original_amount ELSE t.total_amount END)
            FROM transactions t WHERE t.wallet_id = w.id), 0)
        + COALESCE((
            SELECT SUM(COALESCE(t.to_amount, -t.total_amount))
            FROM transactions t WHERE t.to_wallet_id = w.id AND t.type = 'transfer'), 0)
        AS balance,
      CASE WHEN w.currency IS NULL THEN NULL ELSE
        COALESCE((SELECT SUM(-t.total_amount) FROM transactions t
                  WHERE t.to_wallet_id = w.id AND t.type = 'transfer' AND t.to_amount > 0), 0)
        + COALESCE((SELECT SUM(t.total_amount) FROM transactions t
                  WHERE t.wallet_id = w.id AND t.type = 'income' AND t.original_currency = w.currency AND t.original_amount > 0), 0)
      END AS costHome,
      CASE WHEN w.currency IS NULL THEN NULL ELSE
        COALESCE((SELECT SUM(t.to_amount) FROM transactions t
                  WHERE t.to_wallet_id = w.id AND t.type = 'transfer' AND t.to_amount > 0), 0)
        + COALESCE((SELECT SUM(t.original_amount) FROM transactions t
                  WHERE t.wallet_id = w.id AND t.type = 'income' AND t.original_currency = w.currency AND t.original_amount > 0), 0)
      END AS costUnits
    FROM wallets w
    ORDER BY w.is_active DESC, w.id ASC;
  `);
  return rows.map((row) => {
    const currency = row.currency?.trim().toUpperCase() || null;
    const averageRate =
      currency && (row.costUnits ?? 0) > 0 && (row.costHome ?? 0) > 0 ? roundRate((row.costHome ?? 0) / (row.costUnits ?? 1)) : null;
    return {
      id: row.id,
      name: row.name,
      type: WALLET_TYPES.has(row.type as WalletType) ? (row.type as WalletType) : 'cash',
      isActive: row.isActive !== 0,
      initialBalance: row.initialBalance ?? 0,
      balance: roundCurrency(row.balance ?? 0),
      currency,
      averageRate,
    };
  });
}

function readWalletsSafe(fallback: Wallet[]): Wallet[] {
  try {
    return readWallets();
  } catch (error) {
    console.warn('Failed to read accounts:', error);
    return fallback;
  }
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
  dataVersion: 0,
  hasLoadedTransactions: false,
  hasLoadedCategories: false,
  hasLoadedBudgets: false,
  transactionsDirty: false,
  categoriesDirty: false,
  budgetsDirty: false,
  selectedCashflowDateMs: null,

  setSelectedCashflowDateMs: (timestamp) => {
    set({ selectedCashflowDateMs: typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : null });
  },

  initDB: async () => {
    await get().fetchCategories();
    await get().fetchTransactions();
    await get().fetchBudgets();
  },

  invalidateData: (slices) => {
    const all = !slices;
    set((state) => ({
      transactionsDirty: all || slices?.transactions ? true : state.transactionsDirty,
      categoriesDirty: all || slices?.categories ? true : state.categoriesDirty,
      budgetsDirty: all || slices?.budgets ? true : state.budgetsDirty,
      dataVersion: state.dataVersion + 1,
    }));
  },

  fetchTransactions: async () => {
    try {
      const transactionsList = readTransactionsList();
      const nextWallets = readWalletsSafe(get().wallets);
      set((state) => ({
        transactionsList,
        wallets: nextWallets,
        hasLoadedTransactions: true,
        transactionsDirty: false,
        dataVersion: state.dataVersion + 1,
      }));
    } catch (error) {
      console.error('Failed to fetch transactions:', error);
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  fetchTransactionsIfNeeded: async () => {
    const { hasLoadedTransactions, transactionsDirty } = get();
    if (!hasLoadedTransactions || transactionsDirty) {
      await get().fetchTransactions();
    }
  },

  fetchWallets: () => {
    try {
      const nextWallets = readWallets();
      set((state) => ({
        wallets: nextWallets,
        dataVersion: state.dataVersion + 1,
      }));
    } catch (error) {
      console.warn('Failed to read accounts:', error);
    }
  },

  addWallet: ({ name, type, initialBalance, currency }) => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Give the account a name.');
    const result = expoDb.runSync(
      'INSERT INTO wallets (name, type, is_active, initial_balance, currency) VALUES (?, ?, 1, ?, ?);',
      [trimmed, type, Number.isFinite(initialBalance) ? initialBalance : 0, normalizeCurrencyCode(currency)],
    );
    get().fetchWallets();
    return Number(result.lastInsertRowId);
  },

  updateWallet: (id, input) => {
    const current = get().wallets.find((wallet) => wallet.id === id);
    if (!current) return;
    if (input.isActive === false && get().wallets.filter((w) => w.isActive).length <= 1 && current.isActive) {
      throw new Error('Keep at least one active account.');
    }
    const nextCurrency = input.currency !== undefined ? normalizeCurrencyCode(input.currency) : current.currency;
    if (nextCurrency !== current.currency) {
      // Amounts already recorded are in the old currency, so it can only change while the account is unused.
      const used = expoDb.getFirstSync<{ n: number }>(
        'SELECT COUNT(*) AS n FROM transactions WHERE wallet_id = ? OR to_wallet_id = ?;',
        [id, id],
      );
      if ((used?.n ?? 0) > 0) {
        throw new Error("This account already has transactions, so its currency can't change. Create a new account instead.");
      }
    }
    expoDb.runSync('UPDATE wallets SET name = ?, type = ?, initial_balance = ?, is_active = ?, currency = ? WHERE id = ?;', [
      (input.name ?? current.name).trim() || current.name,
      input.type ?? current.type,
      input.initialBalance ?? current.initialBalance,
      (input.isActive ?? current.isActive) ? 1 : 0,
      nextCurrency,
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
      set((state) => ({
        categories: rows.map((row) => ({
          id: row.id,
          name: row.name,
          type: row.type as CategoryType,
          isSystem: row.isSystem,
          createdAt: row.createdAt,
        })),
        hasLoadedCategories: true,
        categoriesDirty: false,
        dataVersion: state.dataVersion + 1,
      }));
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
      set((state) => ({
        budgets: normalizeBudgetMap(filteredRows),
        hasLoadedBudgets: true,
        budgetsDirty: false,
        dataVersion: state.dataVersion + 1,
      }));
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

  getDailyTotals: (startMs, endMs) => {
    try {
      return getDailyTotalsForRangeDb(startMs, endMs);
    } catch (error) {
      console.error('Failed to load daily totals:', error);
      return [];
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
    if (!options?.skipRefresh) {
      set({ isSaving: true });
    }
    try {
      const normalizedTx = normalizeTransactionInput(tx);
      const categoryType = getCategoryTypeForTransaction(normalizedTx.type);
      const normalizedCategory =
        normalizedTx.type === 'transfer'
          ? TRANSFER_CATEGORY_LABEL
          : get().normalizeCategoryForType(normalizedTx.category, normalizedTx.type);
      const finalCategory = normalizedCategory || getUncategorizedLabel(categoryType);
      const accounts = resolveAccounts(normalizedTx);
      let insertedId: number | null = null;
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
            originalAmount: normalizedTx.originalAmount ?? null,
            originalCurrency: normalizedTx.originalCurrency ?? null,
            fxRate: normalizedTx.fxRate ?? null,
            toAmount: accounts.toWalletId ? normalizedTx.toAmount ?? null : null,
          })
          .returning({ id: transactions.id });

        if (newTx?.id) {
          insertedId = newTx.id;
          await txDb.insert(transactionItems).values({
            transactionId: newTx.id,
            category: finalCategory,
            amount: Math.abs(normalizedTx.totalAmount),
          });
        }
      });

      if (options?.skipRefresh) {
        set((state) => ({
          transactionsDirty: true,
          dataVersion: state.dataVersion + 1,
        }));
      } else if (insertedId != null) {
        const createdTx = mapTransactionRowToModel({
          id: insertedId,
          merchantName: normalizedTx.merchantName,
          totalAmount: normalizedTx.totalAmount,
          type: normalizedTx.type,
          date: normalizedTx.date,
          imageUri: normalizedTx.imageUri ?? null,
          note: normalizedTx.note ?? null,
          lineItemsText: normalizedTx.lineItemsText ?? null,
          category: finalCategory,
          walletId: accounts.walletId,
          toWalletId: accounts.toWalletId,
          originalAmount: normalizedTx.originalAmount ?? null,
          originalCurrency: normalizedTx.originalCurrency ?? null,
          fxRate: normalizedTx.fxRate ?? null,
          toAmount: accounts.toWalletId ? normalizedTx.toAmount ?? null : null,
        });
        const nextWallets = readWalletsSafe(get().wallets);
        set((state) => ({
          transactionsList: insertTransactionSorted(state.transactionsList, createdTx),
          wallets: nextWallets,
          isSaving: false,
          transactionsDirty: state.transactionsDirty,
          dataVersion: state.dataVersion + 1,
        }));
      } else {
        const transactionsList = readTransactionsList();
        const nextWallets = readWalletsSafe(get().wallets);
        set((state) => ({
          transactionsList,
          wallets: nextWallets,
          isSaving: false,
          hasLoadedTransactions: true,
          transactionsDirty: false,
          dataVersion: state.dataVersion + 1,
        }));
      }
    } catch (error) {
      console.error('Failed to add transaction:', error);
      set({ error: error instanceof Error ? error.message : String(error), isSaving: false });
      throw error;
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
      // Currency fields travel together: the amount, its currency and the rate are only meaningful as a set.
      const currencyChanged =
        tx.originalAmount !== undefined || tx.originalCurrency !== undefined || tx.fxRate !== undefined || tx.toAmount !== undefined;
      const currencyFields = currencyChanged
        ? {
            originalAmount: normalizedTx.originalAmount ?? null,
            originalCurrency: normalizedTx.originalCurrency ?? null,
            fxRate: normalizedTx.fxRate ?? null,
            toAmount: nextType === 'transfer' ? normalizedTx.toAmount ?? null : null,
          }
        : null;
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
          currencyChanged ||
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
              ...(currencyFields ?? {}),
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

      const nextWallets = readWalletsSafe(get().wallets);
      const hasInStore = get().transactionsList.some((item) => item.id === id);
      if (hasInStore) {
        set((state) => {
          const latest = state.transactionsList.find((item) => item.id === id);
          if (!latest) {
            return {
              wallets: nextWallets,
              isSaving: false,
              transactionsDirty: true,
              dataVersion: state.dataVersion + 1,
            };
          }
          const updatedTx = mapTransactionRowToModel({
            id,
            merchantName: tx.merchantName !== undefined ? normalizedTx.merchantName : latest.merchantName,
            totalAmount: tx.totalAmount !== undefined ? tx.totalAmount : latest.totalAmount,
            type: tx.type !== undefined ? nextType : latest.type,
            date: tx.date !== undefined ? tx.date : latest.date,
            imageUri: tx.imageUri !== undefined ? tx.imageUri : latest.imageUri ?? null,
            note: tx.note !== undefined ? normalizedTx.note : latest.note ?? null,
            lineItemsText: tx.lineItemsText !== undefined ? normalizedTx.lineItemsText : latest.lineItemsText ?? null,
            category:
              nextType === 'transfer'
                ? TRANSFER_CATEGORY_LABEL
                : tx.category !== undefined
                  ? nextCategory ?? latest.category
                  : latest.category,
            walletId: accounts ? accounts.walletId : latest.walletId ?? DEFAULT_WALLET_ID,
            toWalletId: accounts ? accounts.toWalletId : latest.toWalletId ?? null,
            originalAmount: currencyFields ? currencyFields.originalAmount : latest.originalAmount ?? null,
            originalCurrency: currencyFields ? currencyFields.originalCurrency : latest.originalCurrency ?? null,
            fxRate: currencyFields ? currencyFields.fxRate : latest.fxRate ?? null,
            toAmount: currencyFields ? currencyFields.toAmount : latest.toAmount ?? null,
          });
          return {
            transactionsList: insertTransactionSorted(state.transactionsList, updatedTx),
            wallets: nextWallets,
            isSaving: false,
            transactionsDirty: state.transactionsDirty,
            dataVersion: state.dataVersion + 1,
          };
        });
      } else {
        const transactionsList = readTransactionsList();
        set((state) => ({
          transactionsList,
          wallets: nextWallets,
          isSaving: false,
          hasLoadedTransactions: true,
          transactionsDirty: false,
          dataVersion: state.dataVersion + 1,
        }));
      }
    } catch (error) {
      console.error('Failed to update transaction:', error);
      set({ error: error instanceof Error ? error.message : String(error), isSaving: false });
      throw error;
    }
  },

  deleteTransaction: async (id) => {
    try {
      await db.transaction(async (tx) => {
        await tx.delete(transactionItems).where(eq(transactionItems.transactionId, id));
        await tx.delete(transactions).where(eq(transactions.id, id));
      });
      const nextWallets = readWalletsSafe(get().wallets);
      set((state) => ({
        transactionsList: state.transactionsList.filter((item) => item.id !== id),
        wallets: nextWallets,
        transactionsDirty: state.transactionsDirty,
        dataVersion: state.dataVersion + 1,
      }));
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
