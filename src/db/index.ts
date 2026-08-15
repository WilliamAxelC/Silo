import { openDatabaseSync } from 'expo-sqlite';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import * as schema from './schema';
import { DEFAULT_APP_SETTINGS } from '../features/transactions/constants';
import { DEFAULT_CATEGORY_SEEDS, inferCategoryType, serializeSettingValue } from '../features/transactions/categories';
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

const DB_SCHEMA_VERSION = 8;

export function initDatabasePragmas(sqliteDb: typeof expoDb = expoDb) {
  sqliteDb.execSync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
  `);
}

// Ensure PRAGMAs are executed immediately on load
initDatabasePragmas(expoDb);

export function createBaseSchema(sqliteDb: typeof expoDb = expoDb) {
  sqliteDb.execSync(`
    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      is_active INTEGER DEFAULT 1
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
      line_items_text TEXT
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

export function searchTransactions(
  query: string,
  options?: { limit?: number; offset?: number; type?: string },
  sqliteDb: typeof expoDb = expoDb
): Transaction[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const matchQuery = buildFtsSearchQuery(trimmed);

  if (matchQuery) {
    try {
      const rows = sqliteDb.getAllSync<TransactionListRow>(
        `SELECT
          t.id AS id,
          t.merchant_name AS merchantName,
          t.total_amount AS totalAmount,
          t.type AS type,
          t.date AS date,
          t.image_uri AS imageUri,
          t.note AS note,
          t.line_items_text AS lineItemsText,
          i.category AS category
        FROM transactions_fts fts
        JOIN transactions t ON fts.rowid = t.id
        LEFT JOIN transaction_items i ON t.id = i.transaction_id
        WHERE transactions_fts MATCH ?
        ${options?.type ? 'AND t.type = ?' : ''}
        ORDER BY fts.rank, t.date DESC
        LIMIT ? OFFSET ?;`,
        options?.type ? [matchQuery, options.type, limit, offset] : [matchQuery, limit, offset]
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
      `SELECT
        t.id AS id,
        t.merchant_name AS merchantName,
        t.total_amount AS totalAmount,
        t.type AS type,
        t.date AS date,
        t.image_uri AS imageUri,
        t.note AS note,
        t.line_items_text AS lineItemsText,
        i.category AS category
      FROM transactions t
      LEFT JOIN transaction_items i ON t.id = i.transaction_id
      WHERE (t.merchant_name LIKE ? OR t.note LIKE ? OR t.line_items_text LIKE ? OR i.category LIKE ?)
      ${options?.type ? 'AND t.type = ?' : ''}
      ORDER BY t.date DESC
      LIMIT ? OFFSET ?;`,
      options?.type
        ? [likePattern, likePattern, likePattern, likePattern, options.type, limit, offset]
        : [likePattern, likePattern, likePattern, likePattern, limit, offset]
    );
    return rows.map(mapTransactionRowToModel);
  } catch (error) {
    console.error('Search query failed entirely:', error);
    return [];
  }
}

export function runMigrations(sqliteDb: typeof expoDb = expoDb) {
  initDatabasePragmas(sqliteDb);
  createBaseSchema(sqliteDb);

  const currentVersionRow = sqliteDb.getFirstSync<{ user_version: number }>('PRAGMA user_version;');
  const currentVersion = currentVersionRow?.user_version ?? 0;

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

  seedDefaultSettings(sqliteDb);
  seedDefaultCategories(sqliteDb);
  migrateLegacyCategories(sqliteDb);
  recreateAITransactionsView(sqliteDb);

  sqliteDb.execSync(`PRAGMA user_version = ${DB_SCHEMA_VERSION};`);
}

runMigrations(expoDb);

export const db = drizzle(expoDb, { schema });

