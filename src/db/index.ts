import { openDatabaseSync } from 'expo-sqlite';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import * as schema from './schema';
import { DEFAULT_APP_SETTINGS } from '../features/transactions/constants';
import { DEFAULT_CATEGORY_SEEDS, inferCategoryType, serializeSettingValue } from '../features/transactions/categories';

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

const DB_SCHEMA_VERSION = 7;

function createBaseSchema() {
  expoDb.execSync(`
    CREATE TABLE IF NOT EXISTS wallets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL, is_active INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS budgets (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, limit_amount REAL NOT NULL, period TEXT DEFAULT 'monthly', wallet_id INTEGER REFERENCES wallets(id));
    CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet_id INTEGER NOT NULL REFERENCES wallets(id), merchant_name TEXT NOT NULL, total_amount REAL NOT NULL, type TEXT NOT NULL, date INTEGER NOT NULL, image_uri TEXT, note TEXT, line_items_text TEXT);
    CREATE TABLE IF NOT EXISTS transaction_items (id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_id INTEGER NOT NULL REFERENCES transactions(id), category TEXT NOT NULL, amount REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL, is_system INTEGER DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shared_splits (id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_id INTEGER NOT NULL REFERENCES transactions(id), person_name TEXT NOT NULL, amount_owed REAL NOT NULL, is_settled INTEGER DEFAULT 0);

    INSERT OR IGNORE INTO wallets (id, name, type) VALUES (1, 'Main Wallet', 'cash');
  `);
}

function hasColumn(tableName: string, columnName: string): boolean {
  const columns = expoDb.getAllSync<{ name: string }>(`PRAGMA table_info(${tableName});`);
  return columns.some((column) => column.name === columnName);
}

function hasTable(tableName: string): boolean {
  const result = expoDb.getFirstSync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1;`,
    [tableName]
  );
  return Boolean(result?.name);
}

function recreateAITransactionsView() {
  expoDb.execSync(`
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

function seedDefaultSettings() {
  Object.entries(DEFAULT_APP_SETTINGS).forEach(([key, value]) => {
    expoDb.runSync(`INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?);`, [key, serializeSettingValue(value)]);
  });
}

function seedDefaultCategories() {
  const existing = expoDb.getAllSync<{ name: string; type: string }>('SELECT name, type FROM categories;');
  const existingSet = new Set(existing.map((row) => `${row.type}:${row.name.toLowerCase()}`));
  const now = Date.now();

  DEFAULT_CATEGORY_SEEDS.forEach((seed, index) => {
    const key = `${seed.type}:${seed.name.toLowerCase()}`;
    if (!existingSet.has(key)) {
      expoDb.runSync(
        `INSERT INTO categories (name, type, is_system, created_at) VALUES (?, ?, ?, ?);`,
        [seed.name, seed.type, seed.isSystem ? 1 : 0, now + index]
      );
    }
  });
}

function migrateLegacyCategories() {
  const existing = expoDb.getAllSync<{ name: string; type: string }>('SELECT name, type FROM categories;');
  const existingSet = new Set(existing.map((row) => `${row.type}:${row.name.toLowerCase()}`));
  const legacyRows = expoDb.getAllSync<{ category: string | null; type: string | null }>(`
    SELECT DISTINCT i.category as category, t.type as type
    FROM transaction_items i
    LEFT JOIN transactions t ON t.id = i.transaction_id
    WHERE i.category IS NOT NULL AND TRIM(i.category) != '';
  `);
  const budgetRows = expoDb.getAllSync<{ category: string | null }>(`SELECT DISTINCT category FROM budgets WHERE category IS NOT NULL AND TRIM(category) != '';`);
  const now = Date.now();
  let offset = 0;

  legacyRows.forEach((row) => {
    const category = row.category?.trim();
    if (!category) return;

    const type = inferCategoryType(category, row.type);
    const key = `${type}:${category.toLowerCase()}`;
    if (!existingSet.has(key)) {
      expoDb.runSync(`INSERT INTO categories (name, type, is_system, created_at) VALUES (?, ?, ?, ?);`, [category, type, 0, now + offset]);
      existingSet.add(key);
      offset += 1;
    }
  });

  budgetRows.forEach((row) => {
    const category = row.category?.trim();
    if (!category) return;

    const key = `expense:${category.toLowerCase()}`;
    if (!existingSet.has(key)) {
      expoDb.runSync(`INSERT INTO categories (name, type, is_system, created_at) VALUES (?, ?, ?, ?);`, [category, 'expense', 0, now + offset]);
      existingSet.add(key);
      offset += 1;
    }
  });
}

function migrateToVersion2() {
  if (!hasColumn('transactions', 'line_items_text')) {
    expoDb.execSync(`
      ALTER TABLE transactions ADD COLUMN line_items_text TEXT;
      UPDATE transactions SET line_items_text = '' WHERE line_items_text IS NULL;
    `);
  }

  recreateAITransactionsView();
}

function migrateToVersion3() {
  if (!hasColumn('transactions', 'note')) {
    expoDb.execSync(`
      ALTER TABLE transactions ADD COLUMN note TEXT;
      UPDATE transactions SET note = '' WHERE note IS NULL;
    `);
  }

  recreateAITransactionsView();
}

function migrateToVersion4() {
  if (!hasTable('categories')) {
    expoDb.execSync(`
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        is_system INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);
  }

  if (!hasTable('app_settings')) {
    expoDb.execSync(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  seedDefaultSettings();
  seedDefaultCategories();
  migrateLegacyCategories();
  recreateAITransactionsView();
}

function migrateToVersion5() {
  recreateAITransactionsView();
}

function migrateToVersion6() {
  recreateAITransactionsView();
}

function migrateToVersion7() {
  expoDb.execSync(`
    CREATE VIRTUAL TABLE IF NOT EXISTS transactions_fts USING fts5(
      merchant_name,
      note,
      line_items_text,
      content='transactions',
      content_rowid='id'
    );
    
    CREATE TRIGGER IF NOT EXISTS transactions_ai AFTER INSERT ON transactions BEGIN
      INSERT INTO transactions_fts(rowid, merchant_name, note, line_items_text)
      VALUES (new.id, new.merchant_name, new.note, new.line_items_text);
    END;
    
    CREATE TRIGGER IF NOT EXISTS transactions_ad AFTER DELETE ON transactions BEGIN
      INSERT INTO transactions_fts(transactions_fts, rowid, merchant_name, note, line_items_text)
      VALUES ('delete', old.id, old.merchant_name, old.note, old.line_items_text);
    END;
    
    CREATE TRIGGER IF NOT EXISTS transactions_au AFTER UPDATE ON transactions BEGIN
      INSERT INTO transactions_fts(transactions_fts, rowid, merchant_name, note, line_items_text)
      VALUES ('delete', old.id, old.merchant_name, old.note, old.line_items_text);
      INSERT INTO transactions_fts(rowid, merchant_name, note, line_items_text)
      VALUES (new.id, new.merchant_name, new.note, new.line_items_text);
    END;
    
    -- Rebuild the index from existing data
    INSERT INTO transactions_fts(transactions_fts) VALUES('rebuild');
  `);
}

function runMigrations() {
  createBaseSchema();

  const currentVersionRow = expoDb.getFirstSync<{ user_version: number }>('PRAGMA user_version;');
  const currentVersion = currentVersionRow?.user_version ?? 0;

  if (currentVersion < 2) {
    migrateToVersion2();
  }

  if (currentVersion < 3) {
    migrateToVersion3();
  }

  if (currentVersion < 4) {
    migrateToVersion4();
  }

  if (currentVersion < 5) {
    migrateToVersion5();
  }

  if (currentVersion < 6) {
    migrateToVersion6();
  }

  if (currentVersion < 7) {
    migrateToVersion7();
  }

  seedDefaultSettings();
  seedDefaultCategories();
  migrateLegacyCategories();
  recreateAITransactionsView();

  expoDb.execSync(`PRAGMA user_version = ${DB_SCHEMA_VERSION};`);
}

runMigrations();

export const db = drizzle(expoDb, { schema });
