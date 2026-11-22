import { openDatabaseSync } from 'expo-sqlite';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import * as schema from './schema';
import { DEFAULT_APP_SETTINGS } from '../features/transactions/constants';
import { DEFAULT_CATEGORY_SEEDS, inferCategoryType, serializeSettingValue } from '../features/transactions/categories';
import { addAmounts, roundCurrency, type TransactionFilterSummary } from '../features/transactions/amount';
import { mapTransactionRowToModel, TransactionListRow } from '../features/transactions/mappers';
import type { Transaction } from '../features/transactions/types';

export const expoDb = openDatabaseSync('silo.db');

export interface AITransactionRow {
  transaction_id: number;
  merchant_name: string;
  total_amount: number;
  type: string;
  date: number;
  note: string | null;
  line_items_text: string | null;
  category: string | null;
}

const DB_SCHEMA_VERSION = 18;

export function initDatabasePragmas(sqliteDb: typeof expoDb = expoDb) {
  sqliteDb.execSync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
  `);
}

export function createBaseSchema(sqliteDb: typeof expoDb = expoDb) {
  sqliteDb.execSync(`
    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      initial_balance REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      limit_amount REAL NOT NULL,
      period TEXT DEFAULT 'monthly',
      wallet_id INTEGER REFERENCES wallets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
      merchant_name TEXT NOT NULL,
      total_amount REAL NOT NULL,
      type TEXT NOT NULL,
      date INTEGER NOT NULL,
      image_uri TEXT,
      note TEXT,
      line_items_text TEXT,
      to_wallet_id INTEGER REFERENCES wallets(id)
    );

    CREATE TABLE IF NOT EXISTS transaction_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      amount REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      is_system INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shared_splits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      person_name TEXT NOT NULL,
      amount_owed REAL NOT NULL,
      is_settled INTEGER DEFAULT 0
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS transactions_fts USING fts5(
      merchant_name,
      note,
      line_items_text,
      content='transactions',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS transactions_ai AFTER INSERT ON transactions BEGIN
      INSERT INTO transactions_fts(rowid, merchant_name, note, line_items_text)
      VALUES (new.id, new.merchant_name, coalesce(new.note, ''), coalesce(new.line_items_text, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS transactions_ad AFTER DELETE ON transactions BEGIN
      INSERT INTO transactions_fts(transactions_fts, rowid, merchant_name, note, line_items_text)
      VALUES ('delete', old.id, old.merchant_name, coalesce(old.note, ''), coalesce(old.line_items_text, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS transactions_au AFTER UPDATE ON transactions BEGIN
      INSERT INTO transactions_fts(transactions_fts, rowid, merchant_name, note, line_items_text)
      VALUES ('delete', old.id, old.merchant_name, coalesce(old.note, ''), coalesce(old.line_items_text, ''));
      INSERT INTO transactions_fts(rowid, merchant_name, note, line_items_text)
      VALUES (new.id, new.merchant_name, coalesce(new.note, ''), coalesce(new.line_items_text, ''));
    END;

    INSERT OR IGNORE INTO wallets (id, name, type) VALUES (1, 'Main Wallet', 'cash');
  `);
  createReceiptQueueTable(sqliteDb);
  createRecurringTable(sqliteDb);
  createTransactionTemplatesTable(sqliteDb);
}

/**
 * Reusable quick-entry templates shown as chips on Add Transaction.
 * Stored as JSON without date or receipt photo, matching recurring_rules.
 */
export function createTransactionTemplatesTable(sqliteDb: typeof expoDb = expoDb) {
  sqliteDb.execSync(`
    CREATE TABLE IF NOT EXISTS transaction_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      template_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

/**
 * Repeating transactions. Occurrence n falls on start_date + n periods (anchored, so a rule started on the
 * 31st lands on the last day of shorter months); `occurrences` counts how many have been created.
 */
export function createRecurringTable(sqliteDb: typeof expoDb = expoDb) {
  sqliteDb.execSync(`
    CREATE TABLE IF NOT EXISTS recurring_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_json TEXT NOT NULL,
      frequency TEXT NOT NULL,
      start_date INTEGER NOT NULL,
      occurrences INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
  `);
}

/** Receipts imported in bulk and read in the background; rows are removed once saved as transactions. */
export function createReceiptQueueTable(sqliteDb: typeof expoDb = expoDb) {
  sqliteDb.execSync(`
    CREATE TABLE IF NOT EXISTS receipt_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_uri TEXT NOT NULL,
      image_hash TEXT,
      thumbnail_uri TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      result_json TEXT,
      error TEXT,
      created_at INTEGER NOT NULL
    );
  `);
}

export function hasColumn(tableName: string, columnName: string, sqliteDb: typeof expoDb = expoDb): boolean {
  const columns = sqliteDb.getAllSync<{ name: string }>(`PRAGMA table_info(${tableName});`);
  return columns.some((column) => column.name === columnName);
}

export function hasTable(tableName: string, sqliteDb: typeof expoDb = expoDb): boolean {
  const result = sqliteDb.getFirstSync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1;`,
    [tableName]
  );
  return Boolean(result?.name);
}

export function recreateAITransactionsView(sqliteDb: typeof expoDb = expoDb) {
  sqliteDb.execSync(`
    DROP VIEW IF EXISTS ai_transactions_view;
    CREATE VIEW ai_transactions_view AS
    SELECT
      t.id AS id,
      t.id AS transaction_id,
      t.merchant_name,
      t.total_amount,
      t.type,
      t.date,
      t.note,
      t.line_items_text,
      i.category
    FROM transactions t
    LEFT JOIN transaction_items i ON t.id = i.transaction_id;
  `);
}

export function seedDefaultSettings(sqliteDb: typeof expoDb = expoDb) {
  sqliteDb.withTransactionSync(() => {
    Object.entries(DEFAULT_APP_SETTINGS).forEach(([key, value]) => {
      if (key === 'externalApiKey' || key === 'externalApiCustomHeaders') {
        return;
      }
      sqliteDb.runSync(`INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?);`, [key, serializeSettingValue(value)]);
    });
  });
}

export function seedDefaultCategories(sqliteDb: typeof expoDb = expoDb) {
  const existing = sqliteDb.getAllSync<{ name: string; type: string }>('SELECT name, type FROM categories;');
  const existingSet = new Set(existing.map((row) => `${row.type}:${row.name.toLowerCase()}`));
  const now = Date.now();

  sqliteDb.withTransactionSync(() => {
    DEFAULT_CATEGORY_SEEDS.forEach((seed, index) => {
      const key = `${seed.type}:${seed.name.toLowerCase()}`;
      if (!existingSet.has(key)) {
        sqliteDb.runSync(
          `INSERT INTO categories (name, type, is_system, created_at) VALUES (?, ?, ?, ?);`,
          [seed.name, seed.type, seed.isSystem ? 1 : 0, now + index]
        );
      }
    });
  });
}

export function migrateLegacyCategories(sqliteDb: typeof expoDb = expoDb) {
  const existing = sqliteDb.getAllSync<{ name: string; type: string }>('SELECT name, type FROM categories;');
  const existingSet = new Set(existing.map((row) => `${row.type}:${row.name.toLowerCase()}`));
  const legacyRows = sqliteDb.getAllSync<{ category: string | null; type: string | null }>(`
    SELECT DISTINCT i.category as category, t.type as type
    FROM transaction_items i
    LEFT JOIN transactions t ON t.id = i.transaction_id
    WHERE i.category IS NOT NULL AND TRIM(i.category) != '';
  `);
  const budgetRows = sqliteDb.getAllSync<{ category: string | null }>(`SELECT DISTINCT category FROM budgets WHERE category IS NOT NULL AND TRIM(category) != '';`);
  const now = Date.now();
  let offset = 0;

  sqliteDb.withTransactionSync(() => {
    legacyRows.forEach((row) => {
      const category = row.category?.trim();
      if (!category) return;

      const type = inferCategoryType(category, row.type);
      const key = `${type}:${category.toLowerCase()}`;
      if (!existingSet.has(key)) {
        sqliteDb.runSync(`INSERT INTO categories (name, type, is_system, created_at) VALUES (?, ?, ?, ?);`, [category, type, 0, now + offset]);
        existingSet.add(key);
        offset += 1;
      }
    });

    budgetRows.forEach((row) => {
      const category = row.category?.trim();
      if (!category) return;

      const key = `expense:${category.toLowerCase()}`;
      if (!existingSet.has(key)) {
        sqliteDb.runSync(`INSERT INTO categories (name, type, is_system, created_at) VALUES (?, ?, ?, ?);`, [category, 'expense', 0, now + offset]);
        existingSet.add(key);
        offset += 1;
      }
    });
  });
}

function migrateToVersion2(sqliteDb: typeof expoDb = expoDb) {
  if (!hasColumn('transactions', 'line_items_text', sqliteDb)) {
    sqliteDb.execSync(`
      ALTER TABLE transactions ADD COLUMN line_items_text TEXT;
      UPDATE transactions SET line_items_text = '' WHERE line_items_text IS NULL;
    `);
  }

  recreateAITransactionsView(sqliteDb);
}

function migrateToVersion3(sqliteDb: typeof expoDb = expoDb) {
  if (!hasColumn('transactions', 'note', sqliteDb)) {
    sqliteDb.execSync(`
      ALTER TABLE transactions ADD COLUMN note TEXT;
      UPDATE transactions SET note = '' WHERE note IS NULL;
    `);
  }

  recreateAITransactionsView(sqliteDb);
}

function migrateToVersion4(sqliteDb: typeof expoDb = expoDb) {
  if (!hasTable('categories', sqliteDb)) {
    sqliteDb.execSync(`
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        is_system INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);
  }

  if (!hasTable('app_settings', sqliteDb)) {
    sqliteDb.execSync(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  seedDefaultSettings(sqliteDb);
  seedDefaultCategories(sqliteDb);
  migrateLegacyCategories(sqliteDb);
  recreateAITransactionsView(sqliteDb);
}

function migrateToVersion5(sqliteDb: typeof expoDb = expoDb) {
  recreateAITransactionsView(sqliteDb);
}

function migrateToVersion6(sqliteDb: typeof expoDb = expoDb) {
  recreateAITransactionsView(sqliteDb);
}

function migrateToVersion7(sqliteDb: typeof expoDb = expoDb) {
  sqliteDb.execSync(`
    DROP TABLE IF EXISTS transactions_fts;
    DROP TRIGGER IF EXISTS transactions_ai;
    DROP TRIGGER IF EXISTS transactions_ad;
    DROP TRIGGER IF EXISTS transactions_au;

    CREATE VIRTUAL TABLE IF NOT EXISTS transactions_fts USING fts5(
      merchant_name,
      note,
      line_items_text,
      content='transactions',
      content_rowid='id'
    );
    
    CREATE TRIGGER IF NOT EXISTS transactions_ai AFTER INSERT ON transactions BEGIN
      INSERT INTO transactions_fts(rowid, merchant_name, note, line_items_text)
      VALUES (new.id, new.merchant_name, coalesce(new.note, ''), coalesce(new.line_items_text, ''));
    END;
    
    CREATE TRIGGER IF NOT EXISTS transactions_ad AFTER DELETE ON transactions BEGIN
      INSERT INTO transactions_fts(transactions_fts, rowid, merchant_name, note, line_items_text)
      VALUES ('delete', old.id, old.merchant_name, coalesce(old.note, ''), coalesce(old.line_items_text, ''));
    END;
    
    CREATE TRIGGER IF NOT EXISTS transactions_au AFTER UPDATE ON transactions BEGIN
      INSERT INTO transactions_fts(transactions_fts, rowid, merchant_name, note, line_items_text)
      VALUES ('delete', old.id, old.merchant_name, coalesce(old.note, ''), coalesce(old.line_items_text, ''));
      INSERT INTO transactions_fts(rowid, merchant_name, note, line_items_text)
      VALUES (new.id, new.merchant_name, coalesce(new.note, ''), coalesce(new.line_items_text, ''));
    END;
    
    -- Rebuild the index from existing data
    INSERT INTO transactions_fts(transactions_fts) VALUES('rebuild');
  `);
}

function migrateToVersion8(sqliteDb: typeof expoDb = expoDb) {
  sqliteDb.execSync(`
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
    CREATE INDEX IF NOT EXISTS idx_transaction_items_txn_id ON transaction_items(transaction_id);
    CREATE INDEX IF NOT EXISTS idx_budgets_category ON budgets(category);
    CREATE INDEX IF NOT EXISTS idx_categories_type ON categories(type);
  `);
}

function migrateToVersion10(sqliteDb: typeof expoDb = expoDb) {
  if (!hasColumn('wallets', 'initial_balance', sqliteDb)) {
    sqliteDb.execSync('ALTER TABLE wallets ADD COLUMN initial_balance REAL NOT NULL DEFAULT 0;');
  }
  if (!hasColumn('transactions', 'to_wallet_id', sqliteDb)) {
    sqliteDb.execSync('ALTER TABLE transactions ADD COLUMN to_wallet_id INTEGER REFERENCES wallets(id);');
  }
  sqliteDb.execSync('CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON transactions(wallet_id);');
}

function migrateToVersion12(sqliteDb: typeof expoDb = expoDb) {
  createTransactionTemplatesTable(sqliteDb);
  sqliteDb.execSync('CREATE INDEX IF NOT EXISTS idx_transactions_to_wallet ON transactions(to_wallet_id);');
}

function migrateToVersion13(sqliteDb: typeof expoDb = expoDb) {
  if (!hasColumn('receipt_queue', 'image_hash', sqliteDb)) {
    sqliteDb.execSync('ALTER TABLE receipt_queue ADD COLUMN image_hash TEXT;');
  }
  sqliteDb.execSync('CREATE INDEX IF NOT EXISTS idx_receipt_queue_hash ON receipt_queue(image_hash);');
  // Existing installations that already have transactions should not be shown first-launch onboarding.
  const existingTxCount = sqliteDb.getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM transactions;');
  if ((existingTxCount?.n ?? 0) > 0) {
    sqliteDb.runSync(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('hasCompletedOnboarding', 'true');`);
  }
}

function migrateToVersion14(sqliteDb: typeof expoDb = expoDb) {
  if (!hasColumn('receipt_queue', 'thumbnail_uri', sqliteDb)) {
    sqliteDb.execSync('ALTER TABLE receipt_queue ADD COLUMN thumbnail_uri TEXT;');
  }
}

/**
 * Multi-currency accounts and tags. `wallets.currency` NULL means the home currency. Transactions keep
 * `total_amount` in the home currency; foreign amounts live in original_amount/original_currency with the
 * fx_rate used (home per 1 foreign unit). Transfers record `to_amount` in the destination account's currency.
 */
function migrateToVersion15(sqliteDb: typeof expoDb = expoDb) {
  if (!hasColumn('wallets', 'currency', sqliteDb)) {
    sqliteDb.execSync('ALTER TABLE wallets ADD COLUMN currency TEXT;');
  }
  for (const [column, type] of [
    ['original_amount', 'REAL'],
    ['original_currency', 'TEXT'],
    ['fx_rate', 'REAL'],
    ['to_amount', 'REAL'],
  ] as const) {
    if (!hasColumn('transactions', column, sqliteDb)) {
      sqliteDb.execSync(`ALTER TABLE transactions ADD COLUMN ${column} ${type};`);
    }
  }
  createTagTables(sqliteDb);
}

/**
 * General budgets (features/budgets/engine.ts): one date range or every N days/weeks/months/years, own
 * currency, optional rollover, filtered by categories / accounts / tags (JSON arrays). Existing monthly
 * category limits become monthly plans anchored on the billing month start.
 */
export function createBudgetPlansTable(sqliteDb: typeof expoDb = expoDb) {
  sqliteDb.execSync(`
    CREATE TABLE IF NOT EXISTS budget_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT,
      kind TEXT NOT NULL DEFAULT 'recurring',
      start_date INTEGER NOT NULL,
      end_date INTEGER,
      every INTEGER NOT NULL DEFAULT 1,
      unit TEXT NOT NULL DEFAULT 'month',
      rollover TEXT NOT NULL DEFAULT 'reset',
      carry_overspend INTEGER NOT NULL DEFAULT 0,
      categories TEXT NOT NULL DEFAULT '[]',
      wallet_ids TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
}

function migrateToVersion16(sqliteDb: typeof expoDb = expoDb) {
  createBudgetPlansTable(sqliteDb);
  const existing = sqliteDb.getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM budget_plans;');
  if ((existing?.n ?? 0) > 0) return;
  const legacy = sqliteDb.getAllSync<{ category: string; limitAmount: number }>(
    `SELECT category, limit_amount AS limitAmount FROM budgets WHERE limit_amount > 0 AND TRIM(category) != '';`
  );
  if (legacy.length === 0) return;
  const setting = sqliteDb.getFirstSync<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'monthStartDay';`);
  const startDay = Math.min(28, Math.max(1, Number.parseInt(setting?.value ?? '1', 10) || 1));
  const today = new Date();
  const monthOffset = today.getDate() >= startDay ? 0 : -1;
  const anchor = new Date(today.getFullYear(), today.getMonth() + monthOffset, startDay).getTime();
  for (const row of legacy) {
    sqliteDb.runSync(
      `INSERT INTO budget_plans (name, amount, kind, start_date, every, unit, rollover, categories, created_at)
       VALUES (?, ?, 'recurring', ?, 1, 'month', 'reset', ?, ?);`,
      [row.category, row.limitAmount, anchor, JSON.stringify([row.category]), Date.now()]
    );
  }
}

/**
 * Receipt Inbox: needs_scan marks gallery imports to be turned into a document-style scan before reading;
 * saved rows (status 'saved', transaction_id, saved_at) are kept for a while as a "Recently saved" history.
 */
function migrateToVersion17(sqliteDb: typeof expoDb = expoDb) {
  for (const [column, type] of [
    ['needs_scan', 'INTEGER NOT NULL DEFAULT 0'],
    ['transaction_id', 'INTEGER'],
    ['saved_at', 'INTEGER'],
  ] as const) {
    if (!hasColumn('receipt_queue', column, sqliteDb)) {
      sqliteDb.execSync(`ALTER TABLE receipt_queue ADD COLUMN ${column} ${type};`);
    }
  }
}

/** Activity log (features/activity/activityLog.ts): what the user changed, with snapshots for undo. */
function migrateToVersion18(sqliteDb: typeof expoDb = expoDb) {
  sqliteDb.execSync(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id INTEGER,
      source TEXT,
      before_json TEXT,
      after_json TEXT,
      undone INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_activity_log_at ON activity_log(at);
  `);
}

function createTagTables(sqliteDb: typeof expoDb = expoDb) {
  sqliteDb.execSync(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transaction_tags (
      transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (transaction_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_transaction_tags_tag ON transaction_tags(tag_id);
  `);
}

export function rebuildFtsIndex(sqliteDb: typeof expoDb = expoDb) {
  try {
    sqliteDb.execSync(`INSERT INTO transactions_fts(transactions_fts) VALUES('rebuild');`);
  } catch (error) {
    console.warn('Failed to rebuild FTS index:', error);
  }
}

export function buildFtsSearchQuery(rawQuery: string): string {
  if (!rawQuery || !rawQuery.trim()) return '';
  const sanitized = rawQuery
    .replace(/["'*^(){}:~+\-]/g, ' ')
    .trim();
  const tokens = sanitized.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((token) => `"${token}"*`).join(' OR ');
}

export const DEFAULT_SEARCH_LIMIT = 500;

export interface SearchTransactionsOptions {
  limit?: number;
  offset?: number;
  type?: string;
  walletId?: number;
  category?: string;
  /** Only transactions carrying this tag (case-insensitive). */
  tag?: string;
  dateFrom?: number;
  dateTo?: number;
}

const SEARCH_SELECT_COLUMNS = `
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
`;

const SEARCH_SUMMARY_COLUMNS = `
  COUNT(*) AS count,
  COALESCE(SUM(CASE
    WHEN t.type = 'transfer' THEN 0
    WHEN t.type = 'income' THEN ABS(t.total_amount)
    WHEN t.type != 'expense' AND t.total_amount > 0 THEN t.total_amount
    ELSE 0
  END), 0) AS totalIn,
  COALESCE(SUM(CASE
    WHEN t.type = 'transfer' THEN 0
    WHEN t.type = 'expense' THEN ABS(t.total_amount)
    WHEN t.type != 'income' AND t.total_amount < 0 THEN ABS(t.total_amount)
    ELSE 0
  END), 0) AS totalOut
`;

interface SearchSummaryRow {
  count: number | null;
  totalIn: number | null;
  totalOut: number | null;
}

function emptySearchSummary(): TransactionFilterSummary {
  return { count: 0, totalIn: 0, totalOut: 0, net: 0 };
}

function mapSummaryRow(row: SearchSummaryRow | null | undefined): TransactionFilterSummary {
  if (!row) return emptySearchSummary();
  const count = Number(row.count ?? 0);
  const totalIn = roundCurrency(Number(row.totalIn ?? 0));
  const totalOut = roundCurrency(Number(row.totalOut ?? 0));
  return {
    count,
    totalIn,
    totalOut,
    net: addAmounts(totalIn, -totalOut),
  };
}

function buildSearchFilterParts(options?: SearchTransactionsOptions): {
  filterClauses: string[];
  filterParams: (string | number)[];
} {
  const filterClauses: string[] = [];
  const filterParams: (string | number)[] = [];

  if (options?.type) {
    filterClauses.push('t.type = ?');
    filterParams.push(options.type);
  }
  if (typeof options?.walletId === 'number' && Number.isFinite(options.walletId)) {
    filterClauses.push('(t.wallet_id = ? OR t.to_wallet_id = ?)');
    filterParams.push(options.walletId, options.walletId);
  }
  if (options?.category && options.category.trim()) {
    filterClauses.push('i.category = ?');
    filterParams.push(options.category.trim());
  }
  if (options?.tag && options.tag.trim()) {
    filterClauses.push(
      'EXISTS (SELECT 1 FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.transaction_id = t.id AND tg.name = ? COLLATE NOCASE)'
    );
    filterParams.push(options.tag.trim());
  }
  if (typeof options?.dateFrom === 'number' && Number.isFinite(options.dateFrom)) {
    filterClauses.push('t.date >= ?');
    filterParams.push(options.dateFrom);
  }
  if (typeof options?.dateTo === 'number' && Number.isFinite(options.dateTo)) {
    filterClauses.push('t.date <= ?');
    filterParams.push(options.dateTo);
  }

  return { filterClauses, filterParams };
}

export function searchTransactions(
  query: string,
  options?: SearchTransactionsOptions,
  sqliteDb: typeof expoDb = expoDb
): Transaction[] {
  const trimmed = (query ?? '').trim();
  const { filterClauses, filterParams } = buildSearchFilterParts(options);

  if (!trimmed && filterClauses.length === 0) {
    return [];
  }

  const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
  const offset = options?.offset ?? 0;

  // Filter-only query (empty search box)
  if (!trimmed) {
    try {
      const rows = sqliteDb.getAllSync<TransactionListRow>(
        `SELECT ${SEARCH_SELECT_COLUMNS}
        FROM transactions t
        LEFT JOIN transaction_items i ON t.id = i.transaction_id
        WHERE ${filterClauses.join(' AND ')}
        ORDER BY t.date DESC, t.id DESC
        LIMIT ? OFFSET ?;`,
        [...filterParams, limit, offset]
      );
      return rows.map(mapTransactionRowToModel);
    } catch (error) {
      console.error('Filtered search query failed:', error);
      return [];
    }
  }

  const whereClause = filterClauses.length > 0 ? `WHERE ${filterClauses.join(' AND ')}` : '';
  const extraWhere = filterClauses.length > 0 ? `AND ${filterClauses.join(' AND ')}` : '';
  const matchQuery = buildFtsSearchQuery(trimmed);

  if (matchQuery) {
    try {
      // Select FTS rowids first in a CTE and pin join order with CROSS JOIN so SQLite
      // always drives from transactions_fts and looks up transactions by primary key.
      const rows = sqliteDb.getAllSync<TransactionListRow>(
        `WITH fts_matches AS (
          SELECT rowid AS id, rank
          FROM transactions_fts
          WHERE transactions_fts MATCH ?
        )
        SELECT ${SEARCH_SELECT_COLUMNS}
        FROM fts_matches fts
        CROSS JOIN transactions t ON fts.id = t.id
        LEFT JOIN transaction_items i ON t.id = i.transaction_id
        ${whereClause}
        ORDER BY fts.rank, t.date DESC
        LIMIT ? OFFSET ?;`,
        [matchQuery, ...filterParams, limit, offset]
      );

      if (rows && rows.length > 0) {
        return rows.map(mapTransactionRowToModel);
      }
    } catch (e) {
      console.warn('FTS search failed or fell back:', e);
    }
  }

  // Fallback to LIKE search across merchant_name, note, line_items_text, or category
  try {
    const likePattern = `%${trimmed}%`;
    const rows = sqliteDb.getAllSync<TransactionListRow>(
      `SELECT ${SEARCH_SELECT_COLUMNS}
      FROM transactions t
      LEFT JOIN transaction_items i ON t.id = i.transaction_id
      WHERE (t.merchant_name LIKE ? OR t.note LIKE ? OR t.line_items_text LIKE ? OR i.category LIKE ?)
      ${extraWhere}
      ORDER BY t.date DESC
      LIMIT ? OFFSET ?;`,
      [likePattern, likePattern, likePattern, likePattern, ...filterParams, limit, offset]
    );
    return rows.map(mapTransactionRowToModel);
  } catch (error) {
    console.error('Search query failed entirely:', error);
    return [];
  }
}

/**
 * Computes uncapped count, totalIn, totalOut, and net across ALL transactions matching
 * the given search query and filter options (ignoring pagination limit/offset).
 * Transfers are counted in `count` but excluded from `totalIn` and `totalOut`.
 */
export function summarizeSearchTransactions(
  query: string,
  options?: SearchTransactionsOptions,
  sqliteDb: typeof expoDb = expoDb
): TransactionFilterSummary {
  const trimmed = (query ?? '').trim();
  const { filterClauses, filterParams } = buildSearchFilterParts(options);

  if (!trimmed && filterClauses.length === 0) {
    return emptySearchSummary();
  }

  // Filter-only aggregate (empty search box)
  if (!trimmed) {
    try {
      const row = sqliteDb.getFirstSync<SearchSummaryRow>(
        `SELECT ${SEARCH_SUMMARY_COLUMNS}
        FROM transactions t
        LEFT JOIN transaction_items i ON t.id = i.transaction_id
        WHERE ${filterClauses.join(' AND ')};`,
        filterParams
      );
      return mapSummaryRow(row);
    } catch (error) {
      console.error('Filtered summary query failed:', error);
      return emptySearchSummary();
    }
  }

  const whereClause = filterClauses.length > 0 ? `WHERE ${filterClauses.join(' AND ')}` : '';
  const extraWhere = filterClauses.length > 0 ? `AND ${filterClauses.join(' AND ')}` : '';
  const matchQuery = buildFtsSearchQuery(trimmed);

  if (matchQuery) {
    try {
      const row = sqliteDb.getFirstSync<SearchSummaryRow>(
        `WITH fts_matches AS (
          SELECT rowid AS id
          FROM transactions_fts
          WHERE transactions_fts MATCH ?
        )
        SELECT ${SEARCH_SUMMARY_COLUMNS}
        FROM fts_matches fts
        CROSS JOIN transactions t ON fts.id = t.id
        LEFT JOIN transaction_items i ON t.id = i.transaction_id
        ${whereClause};`,
        [matchQuery, ...filterParams]
      );
      const summary = mapSummaryRow(row);
      if (summary.count > 0) {
        return summary;
      }
    } catch (e) {
      console.warn('FTS summary failed or fell back:', e);
    }
  }

  // Fallback to LIKE aggregate across merchant_name, note, line_items_text, or category
  try {
    const likePattern = `%${trimmed}%`;
    const row = sqliteDb.getFirstSync<SearchSummaryRow>(
      `SELECT ${SEARCH_SUMMARY_COLUMNS}
      FROM transactions t
      LEFT JOIN transaction_items i ON t.id = i.transaction_id
      WHERE (t.merchant_name LIKE ? OR t.note LIKE ? OR t.line_items_text LIKE ? OR i.category LIKE ?)
      ${extraWhere};`,
      [likePattern, likePattern, likePattern, likePattern, ...filterParams]
    );
    return mapSummaryRow(row);
  } catch (error) {
    console.error('Search summary query failed entirely:', error);
    return emptySearchSummary();
  }
}

export interface DailyTotal {
  /** Local calendar day in YYYY-MM-DD format. */
  dayKey: string;
  income: number;
  expense: number;
  count: number;
}

interface DailyTotalSqlRow {
  dayKey: string | null;
  income: number | null;
  expense: number | null;
  count: number | null;
}

/**
 * Aggregates income and expense totals grouped by local calendar day directly in SQL
 * for all transactions with `date` in [startMs, endMs].
 * Transfers are excluded from both income and expense totals while still reflected in `count`.
 */
export function getDailyTotalsForRange(
  startMs: number,
  endMs: number,
  sqliteDb: typeof expoDb = expoDb
): DailyTotal[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return [];
  }

  try {
    const rows = sqliteDb.getAllSync<DailyTotalSqlRow>(
      `SELECT
        strftime(
          '%Y-%m-%d',
          CASE WHEN t.date >= 0 THEN CAST(t.date AS INTEGER) / 1000 ELSE (CAST(t.date AS INTEGER) - 999) / 1000 END,
          'unixepoch',
          'localtime'
        ) AS dayKey,
        COALESCE(SUM(CASE
          WHEN t.type = 'transfer' THEN 0
          WHEN t.type = 'income' THEN ABS(t.total_amount)
          WHEN t.type != 'expense' AND t.total_amount > 0 THEN t.total_amount
          ELSE 0
        END), 0) AS income,
        COALESCE(SUM(CASE
          WHEN t.type = 'transfer' THEN 0
          WHEN t.type = 'expense' THEN ABS(t.total_amount)
          WHEN t.type != 'income' AND t.total_amount < 0 THEN ABS(t.total_amount)
          ELSE 0
        END), 0) AS expense,
        COUNT(*) AS count
      FROM transactions t
      WHERE t.date >= ? AND t.date <= ?
      GROUP BY dayKey
      ORDER BY dayKey ASC;`,
      [startMs, endMs]
    );

    return rows
      .filter((row): row is DailyTotalSqlRow & { dayKey: string } => typeof row.dayKey === 'string' && row.dayKey.length > 0)
      .map((row) => ({
        dayKey: row.dayKey,
        income: roundCurrency(Number(row.income ?? 0)),
        expense: roundCurrency(Number(row.expense ?? 0)),
        count: Number(row.count ?? 0),
      }));
  } catch (error) {
    console.error('Failed to aggregate daily totals:', error);
    return [];
  }
}

export function runMigrations(sqliteDb: typeof expoDb = expoDb) {
  initDatabasePragmas(sqliteDb);

  const currentVersionRow = sqliteDb.getFirstSync<{ user_version: number }>('PRAGMA user_version;');
  const currentVersion = currentVersionRow?.user_version ?? 0;

  if (currentVersion >= DB_SCHEMA_VERSION) {
    return;
  }

  createBaseSchema(sqliteDb);

  if (currentVersion < 2) {
    migrateToVersion2(sqliteDb);
  }

  if (currentVersion < 3) {
    migrateToVersion3(sqliteDb);
  }

  if (currentVersion < 4) {
    migrateToVersion4(sqliteDb);
  }

  if (currentVersion < 5) {
    migrateToVersion5(sqliteDb);
  }

  if (currentVersion < 6) {
    migrateToVersion6(sqliteDb);
  }

  if (currentVersion < 7) {
    migrateToVersion7(sqliteDb);
  }

  if (currentVersion < 8) {
    migrateToVersion8(sqliteDb);
  }

  if (currentVersion < 10) {
    migrateToVersion10(sqliteDb);
  }

  if (currentVersion < 12) {
    migrateToVersion12(sqliteDb);
  }

  if (currentVersion < 13) {
    migrateToVersion13(sqliteDb);
  }

  if (currentVersion < 14) {
    migrateToVersion14(sqliteDb);
  }

  if (currentVersion < 15) {
    migrateToVersion15(sqliteDb);
  }

  if (currentVersion < 16) {
    migrateToVersion16(sqliteDb);
  }

  if (currentVersion < 17) {
    migrateToVersion17(sqliteDb);
  }

  if (currentVersion < 18) {
    migrateToVersion18(sqliteDb);
  }

  seedDefaultSettings(sqliteDb);
  seedDefaultCategories(sqliteDb);
  migrateLegacyCategories(sqliteDb);
  recreateAITransactionsView(sqliteDb);

  sqliteDb.execSync(`PRAGMA user_version = ${DB_SCHEMA_VERSION};`);
}

runMigrations(expoDb);

export const db = drizzle(expoDb, { schema });

