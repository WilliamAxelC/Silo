import { openDatabaseSync } from 'expo-sqlite';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import * as schema from './schema';

export const expoDb = openDatabaseSync('silo.db');

// Force SQLite to physically build the tables and views
expoDb.execSync(`
  CREATE TABLE IF NOT EXISTS wallets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL, is_active INTEGER DEFAULT 1);
  CREATE TABLE IF NOT EXISTS budgets (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, limit_amount REAL NOT NULL, period TEXT DEFAULT 'monthly', wallet_id INTEGER REFERENCES wallets(id));
  CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet_id INTEGER NOT NULL REFERENCES wallets(id), merchant_name TEXT NOT NULL, total_amount REAL NOT NULL, type TEXT NOT NULL, date INTEGER NOT NULL, image_uri TEXT);
  CREATE TABLE IF NOT EXISTS transaction_items (id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_id INTEGER NOT NULL REFERENCES transactions(id), category TEXT NOT NULL, amount REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS shared_splits (id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_id INTEGER NOT NULL REFERENCES transactions(id), person_name TEXT NOT NULL, amount_owed REAL NOT NULL, is_settled INTEGER DEFAULT 0);
  
  INSERT OR IGNORE INTO wallets (id, name, type) VALUES (1, 'Main Wallet', 'cash');

  -- NEW: Create a flattened view strictly for the AI Agent to query
  CREATE VIEW IF NOT EXISTS ai_transactions_view AS 
  SELECT 
    t.id, 
    t.merchant_name, 
    t.total_amount, 
    t.type, 
    t.date, 
    i.category 
  FROM transactions t 
  LEFT JOIN transaction_items i ON t.id = i.transaction_id;
`);

export const db = drizzle(expoDb, { schema });