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
import { normalizeTagNames, normalizeTransactionInput } from '../features/transactions/factories';
import type { BudgetPlan } from '../features/budgets/engine';
import {
  logActivity,
  markActivityUndone,
  pruneActivity,
  readActivity,
  type ActivityEntry,
  type ActivitySource,
} from '../features/activity/activityLog';
import {
  deleteBudgetPlan as deleteBudgetPlanDb,
  readBudgetPlans,
  renameCategoryInPlans,
  saveBudgetPlan as saveBudgetPlanDb,
  type BudgetPlanInput,
} from '../features/budgets/plans';
import { mapTransactionRowToModel, type TransactionListRow } from '../features/transactions/mappers';
import type { CategoryRecord, CategoryType, TagRecord, Transaction, TransactionInput, TransactionUpdate, TransactionType, Wallet, WalletType } from '../features/transactions/types';

export type { Transaction, TransactionInput, TransactionUpdate } from '../features/transactions/types';

/** skipLog: don't record in the activity log (used by undo and bulk/demo imports). */
export interface LogOptions {
  skipLog?: boolean;
  source?: ActivitySource;
}

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
  /** Tags with how many transactions use them, most used first. */
  tags: TagRecord[];
  fetchTags: () => void;
  /** General budgets (one-off or repeating, any currency, category/account/tag filters). */
  budgetPlans: BudgetPlan[];
  fetchBudgetPlans: () => void;
  saveBudgetPlan: (id: number | null, input: BudgetPlanInput, options?: LogOptions) => number;
  deleteBudgetPlan: (id: number, options?: LogOptions) => void;
  /** Recent changes (newest first), for the Activity screen. */
  activity: ActivityEntry[];
  fetchActivity: () => void;
  /** Reverts a logged change; resolves why it couldn't be undone otherwise. */
  undoActivity: (id: number) => Promise<{ ok: boolean; message?: string }>;
  renameTag: (id: number, name: string, options?: LogOptions) => void;
  /** Removes the tag from every transaction and deletes it. */
  deleteTag: (id: number, options?: LogOptions) => void;
  addWallet: (input: WalletInput, options?: LogOptions) => number;
  updateWallet: (id: number, input: Partial<WalletInput> & { isActive?: boolean }, options?: LogOptions) => void;
  /** Deletes an unused account; one with transactions is archived instead. Returns what happened. */
  removeWallet: (id: number, options?: LogOptions) => { ok: boolean; archived?: boolean; message?: string };
  searchTransactions: (query: string, options?: SearchTransactionsOptions) => Promise<Transaction[]>;
  summarizeSearchTransactions: (query: string, options?: SearchTransactionsOptions) => Promise<TransactionFilterSummary>;
  getDailyTotals: (startMs: number, endMs: number) => DailyTotal[];
  /** Saves a transaction and resolves its new id (null if it could not be determined). */
  addTransaction: (
    tx: TransactionInput,
    options?: { skipRefresh?: boolean; skipLog?: boolean; source?: ActivitySource }
  ) => Promise<number | null>;
  updateTransaction: (id: number, tx: TransactionUpdate, options?: LogOptions) => Promise<void>;
  deleteTransaction: (id: number, options?: LogOptions) => Promise<void>;
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
    t.to_amount AS toAmount,
    (SELECT group_concat(tg.name, char(31)) FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id
     WHERE tt.transaction_id = t.id) AS tagNames
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
      currency && (row.costUnits ?? 0) > 0 && (row.costHome ?? 0) > 0 ? (row.costHome ?? 0) / (row.costUnits ?? 1) : null;
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

const TAG_SEPARATOR = '\u001f';
const ACTIVITY_LOOKUP_LIMIT = 5000;

function readTags(): TagRecord[] {
  try {
    return expoDb.getAllSync<TagRecord>(
      `SELECT tg.id AS id, tg.name AS name, COUNT(tt.transaction_id) AS usage
       FROM tags tg LEFT JOIN transaction_tags tt ON tt.tag_id = tg.id
       GROUP BY tg.id
       ORDER BY usage DESC, tg.name COLLATE NOCASE ASC;`,
    ).map((row) => ({ id: row.id, name: row.name, usage: Number(row.usage ?? 0) }));
  } catch (error) {
    console.warn('Failed to read tags:', error);
    return [];
  }
}

/** Replaces a transaction's tags, creating tags that don't exist yet (matched case-insensitively). */
function writeTransactionTags(transactionId: number, names: string[]) {
  expoDb.runSync('DELETE FROM transaction_tags WHERE transaction_id = ?;', [transactionId]);
  for (const name of names) {
    expoDb.runSync('INSERT OR IGNORE INTO tags (name, created_at) VALUES (?, ?);', [name, Date.now()]);
    const tag = expoDb.getFirstSync<{ id: number }>('SELECT id FROM tags WHERE name = ? COLLATE NOCASE;', [name]);
    if (tag?.id != null) {
      expoDb.runSync('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?);', [transactionId, tag.id]);
    }
  }
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
  tags: [],
  budgetPlans: [],
  activity: [],
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
        tags: readTags(),
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

  fetchTags: () => {
    set({ tags: readTags() });
  },

  fetchBudgetPlans: () => {
    try {
      set((state) => ({ budgetPlans: readBudgetPlans(expoDb), dataVersion: state.dataVersion + 1 }));
    } catch (error) {
      console.warn('Failed to read budgets:', error);
    }
  },

  saveBudgetPlan: (id, input, options) => {
    const before = id != null ? get().budgetPlans.find((plan) => plan.id === id) ?? null : null;
    const savedId = saveBudgetPlanDb(expoDb, id, input);
    get().fetchBudgetPlans();
    if (!options?.skipLog) {
      const after = get().budgetPlans.find((plan) => plan.id === savedId) ?? null;
      logActivity(expoDb, { action: id == null ? 'create' : 'update', entity: 'budget', entityId: savedId, before, after, source: options?.source });
    }
    return savedId;
  },

  deleteBudgetPlan: (id, options) => {
    const before = get().budgetPlans.find((plan) => plan.id === id) ?? null;
    deleteBudgetPlanDb(expoDb, id);
    get().fetchBudgetPlans();
    if (!options?.skipLog) logActivity(expoDb, { action: 'delete', entity: 'budget', entityId: id, before, source: options?.source });
  },

  fetchActivity: () => {
    pruneActivity(expoDb);
    set({ activity: readActivity(expoDb) });
  },

  undoActivity: async (activityId) => {
    const entry = readActivity(expoDb, ACTIVITY_LOOKUP_LIMIT).find((item) => item.id === activityId);
    if (!entry) return { ok: false, message: 'That change is no longer in the log.' };
    if (entry.undone) return { ok: false, message: 'Already undone.' };
    const quiet: LogOptions = { skipLog: true };
    const before = entry.before as Record<string, any> | null;
    try {
      if (entry.entity === 'transaction') {
        const exists = entry.entityId != null && readTransactionsList().some((t) => t.id === entry.entityId);
        if (entry.action === 'create') {
          if (!exists) return { ok: false, message: 'This transaction was already deleted.' };
          await get().deleteTransaction(entry.entityId as number, quiet);
        } else if (entry.action === 'delete' && before) {
          const { id: _oldId, ...input } = before;
          await get().addTransaction(input as TransactionInput, { skipLog: true });
        } else if (entry.action === 'update' && before) {
          if (!exists) return { ok: false, message: 'This transaction was deleted later.' };
          const { id: _id, ...input } = before;
          await get().updateTransaction(entry.entityId as number, input as TransactionUpdate, quiet);
        }
      } else if (entry.entity === 'budget') {
        if (entry.action === 'create' && entry.entityId != null) get().deleteBudgetPlan(entry.entityId, quiet);
        else if (before) {
          const { id: _id, ...input } = before;
          get().saveBudgetPlan(entry.action === 'update' ? (entry.entityId as number) : null, input as BudgetPlanInput, quiet);
        }
      } else if (entry.entity === 'account') {
        if (entry.action === 'create' && entry.entityId != null) {
          const result = get().removeWallet(entry.entityId, quiet);
          if (!result.ok) return { ok: false, message: result.message };
          if (result.archived) return { ok: true, message: 'The account has transactions, so it was archived instead.' };
        } else if (entry.action === 'update' && before && entry.entityId != null) {
          get().updateWallet(
            entry.entityId,
            { name: before.name, type: before.type, initialBalance: before.initialBalance, isActive: before.isActive, currency: before.currency },
            quiet
          );
        } else if (entry.action === 'delete' && before) {
          get().addWallet({ name: before.name, type: before.type, initialBalance: before.initialBalance, currency: before.currency }, quiet);
        }
      } else if (entry.entity === 'tag' && before) {
        if (entry.action === 'update' && entry.entityId != null) {
          if (!get().tags.some((t) => t.id === entry.entityId)) return { ok: false, message: 'That tag was merged or deleted.' };
          get().renameTag(entry.entityId, String(before.name), quiet);
        } else if (entry.action === 'delete') {
          expoDb.runSync('INSERT OR IGNORE INTO tags (name, created_at) VALUES (?, ?);', [String(before.name), Date.now()]);
          const tag = expoDb.getFirstSync<{ id: number }>('SELECT id FROM tags WHERE name = ? COLLATE NOCASE;', [String(before.name)]);
          for (const txId of (before.transactionIds as number[] | undefined) ?? []) {
            if (tag) expoDb.runSync('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?);', [txId, tag.id]);
          }
          set((state) => ({ tags: readTags(), transactionsList: readTransactionsList(), dataVersion: state.dataVersion + 1 }));
        }
      }
      markActivityUndone(expoDb, activityId);
      get().fetchActivity();
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },

  renameTag: (id, name, options) => {
    const [clean] = normalizeTagNames([name]);
    if (!clean) throw new Error('Give the tag a name.');
    const previous = get().tags.find((t) => t.id === id) ?? null;
    const clash = expoDb.getFirstSync<{ id: number }>('SELECT id FROM tags WHERE name = ? COLLATE NOCASE AND id != ?;', [clean, id]);
    if (clash) {
      // Renaming onto an existing tag merges the two.
      expoDb.runSync('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) SELECT transaction_id, ? FROM transaction_tags WHERE tag_id = ?;', [clash.id, id]);
      expoDb.runSync('DELETE FROM transaction_tags WHERE tag_id = ?;', [id]);
      expoDb.runSync('DELETE FROM tags WHERE id = ?;', [id]);
    } else {
      expoDb.runSync('UPDATE tags SET name = ? WHERE id = ?;', [clean, id]);
    }
    set((state) => ({ tags: readTags(), transactionsList: readTransactionsList(), dataVersion: state.dataVersion + 1 }));
    if (!options?.skipLog && previous) {
      logActivity(expoDb, {
        action: clash ? 'delete' : 'update',
        entity: 'tag',
        entityId: clash ? null : id,
        before: { name: previous.name },
        after: { name: clean, mergedInto: clash ? clean : undefined },
      });
    }
  },

  deleteTag: (id, options) => {
    const previous = get().tags.find((t) => t.id === id) ?? null;
    const transactionIds = expoDb
      .getAllSync<{ transactionId: number }>('SELECT transaction_id AS transactionId FROM transaction_tags WHERE tag_id = ?;', [id])
      .map((row) => row.transactionId);
    expoDb.runSync('DELETE FROM transaction_tags WHERE tag_id = ?;', [id]);
    expoDb.runSync('DELETE FROM tags WHERE id = ?;', [id]);
    set((state) => ({ tags: readTags(), transactionsList: readTransactionsList(), dataVersion: state.dataVersion + 1 }));
    if (!options?.skipLog && previous) {
      logActivity(expoDb, { action: 'delete', entity: 'tag', entityId: id, before: { name: previous.name, transactionIds } });
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

  addWallet: ({ name, type, initialBalance, currency }, options) => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Give the account a name.');
    const result = expoDb.runSync(
      'INSERT INTO wallets (name, type, is_active, initial_balance, currency) VALUES (?, ?, 1, ?, ?);',
      [trimmed, type, Number.isFinite(initialBalance) ? initialBalance : 0, normalizeCurrencyCode(currency)],
    );
    get().fetchWallets();
    const newId = Number(result.lastInsertRowId);
    if (!options?.skipLog) {
      logActivity(expoDb, { action: 'create', entity: 'account', entityId: newId, after: get().wallets.find((w) => w.id === newId) ?? null });
    }
    return newId;
  },

  updateWallet: (id, input, options) => {
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
    if (!options?.skipLog) {
      logActivity(expoDb, { action: 'update', entity: 'account', entityId: id, before: current, after: get().wallets.find((w) => w.id === id) ?? null });
    }
  },

  removeWallet: (id, options) => {
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
      if (!options?.skipLog) {
        logActivity(expoDb, { action: 'update', entity: 'account', entityId: id, before: wallet, after: { ...wallet, isActive: false } });
      }
      return { ok: true, archived: true };
    }
    expoDb.runSync('DELETE FROM wallets WHERE id = ?;', [id]);
    get().fetchWallets();
    if (!options?.skipLog) logActivity(expoDb, { action: 'delete', entity: 'account', entityId: id, before: wallet });
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
      let budgetPlans = get().budgetPlans;
      try {
        budgetPlans = readBudgetPlans(expoDb);
      } catch (planError) {
        console.warn('Failed to read budgets:', planError);
      }
      set((state) => ({
        budgets: normalizeBudgetMap(filteredRows),
        budgetPlans,
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

    const planUsage =
      type === 'expense' ? readBudgetPlans(expoDb).filter((plan) => plan.categories.includes(normalizedName)).length : 0;
    return Number(transactionUsage[0]?.count ?? 0) + Number(budgetUsage[0]?.count ?? 0) + planUsage;
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

    if (current.type === 'expense') {
      renameCategoryInPlans(expoDb, current.name, normalizedName);
      get().fetchBudgetPlans();
    }
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

      const tagNames = normalizedTx.tags ?? [];
      if (insertedId != null && tagNames.length > 0) {
        writeTransactionTags(insertedId, tagNames);
      }
      if (insertedId != null && !options?.skipLog) {
        logActivity(expoDb, {
          action: 'create',
          entity: 'transaction',
          entityId: insertedId,
          source: options?.source ?? (options?.skipRefresh ? 'recurring' : null),
          after: { ...normalizedTx, id: insertedId, category: finalCategory, walletId: accounts.walletId, toWalletId: accounts.toWalletId },
        });
      }

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
          tagNames: tagNames.join(TAG_SEPARATOR),
        });
        const nextWallets = readWalletsSafe(get().wallets);
        set((state) => ({
          transactionsList: insertTransactionSorted(state.transactionsList, createdTx),
          wallets: nextWallets,
          tags: tagNames.length > 0 ? readTags() : state.tags,
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
      return insertedId;
    } catch (error) {
      console.error('Failed to add transaction:', error);
      set({ error: error instanceof Error ? error.message : String(error), isSaving: false });
      throw error;
    }
  },

  updateTransaction: async (id, tx, options) => {
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

      const beforeSnapshot = existingTransaction ?? readTransactionsList().find((item) => item.id === id) ?? null;
      const nextTags = tx.tags !== undefined ? normalizeTagNames(tx.tags) : null;
      if (nextTags) {
        writeTransactionTags(id, nextTags);
        set({ tags: readTags() });
      }

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
            tagNames: (nextTags ?? latest.tags ?? []).join(TAG_SEPARATOR),
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
      if (!options?.skipLog) {
        logActivity(expoDb, {
          action: 'update',
          entity: 'transaction',
          entityId: id,
          source: options?.source,
          before: beforeSnapshot,
          after: get().transactionsList.find((item) => item.id === id) ?? null,
        });
      }
    } catch (error) {
      console.error('Failed to update transaction:', error);
      set({ error: error instanceof Error ? error.message : String(error), isSaving: false });
      throw error;
    }
  },

  deleteTransaction: async (id, options) => {
    try {
      const beforeSnapshot = get().transactionsList.find((item) => item.id === id) ?? readTransactionsList().find((item) => item.id === id) ?? null;
      await db.transaction(async (tx) => {
        await tx.delete(transactionItems).where(eq(transactionItems.transactionId, id));
        await tx.delete(transactions).where(eq(transactions.id, id));
      });
      expoDb.runSync('DELETE FROM transaction_tags WHERE transaction_id = ?;', [id]);
      if (!options?.skipLog && beforeSnapshot) {
        logActivity(expoDb, { action: 'delete', entity: 'transaction', entityId: id, before: beforeSnapshot, source: options?.source });
      }
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

        await get().addTransaction(tx, { skipRefresh: true, skipLog: true });
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
