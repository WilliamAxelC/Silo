import { DatabaseSync } from 'node:sqlite';
import {
  initDatabasePragmas,
  createBaseSchema,
  runMigrations,
  buildFtsSearchQuery,
  searchTransactions,
  rebuildFtsIndex,
} from '../index';

interface TestDb {
  execSync: (sql: string) => void;
  getAllSync: <T = any>(sql: string, params?: any[]) => T[];
  getFirstSync: <T = any>(sql: string, params?: any[]) => T | null;
  runSync: (sql: string, params?: any[]) => { lastInsertRowId: number; changes: number };
  withTransactionSync: <T = void>(cb: () => T) => T;
}

describe('Database Layer and SQLite Operations', () => {
  describe('buildFtsSearchQuery', () => {
    it('returns empty string for empty or whitespace query', () => {
      expect(buildFtsSearchQuery('')).toBe('');
      expect(buildFtsSearchQuery('   ')).toBe('');
    });

    it('formats single and multiple terms with prefix wildcard and OR operator', () => {
      expect(buildFtsSearchQuery('Kopi')).toBe('"Kopi"*');
      expect(buildFtsSearchQuery('Kopi Kenangan')).toBe('"Kopi"* OR "Kenangan"*');
    });

    it('strips special FTS control characters safely', () => {
      const sanitized = buildFtsSearchQuery('Superindo* "Groceries" (Milk) +Eggs -Meat: 50%');
      expect(sanitized).toContain('"Superindo"*');
      expect(sanitized).toContain('"Groceries"*');
      expect(sanitized).toContain('"Milk"*');
      expect(sanitized).toContain('"Eggs"*');
      expect(sanitized).toContain('"Meat"*');
      expect(sanitized).not.toContain('(');
      expect(sanitized).not.toContain(')');
      expect(sanitized).not.toContain(':');
    });
  });

  describe('In-Memory SQLite Schema, Migrations, Cascades & FTS5', () => {
    let rawDb: DatabaseSync;
    let testDb: TestDb;

    beforeEach(() => {
      rawDb = new DatabaseSync(':memory:');
      testDb = {
        execSync: (sql: string) => rawDb.exec(sql),
        getAllSync: <T = any>(sql: string, params: any[] = []): T[] => {
          const stmt = rawDb.prepare(sql);
          return stmt.all(...params) as T[];
        },
        getFirstSync: <T = any>(sql: string, params: any[] = []): T | null => {
          const stmt = rawDb.prepare(sql);
          return (stmt.get(...params) as T) ?? null;
        },
        runSync: (sql: string, params: any[] = []) => {
          const stmt = rawDb.prepare(sql);
          const res = stmt.run(...params);
          return { lastInsertRowId: Number(res.lastInsertRowid), changes: Number(res.changes) };
        },
        withTransactionSync: <T = void>(cb: () => T): T => {
          rawDb.exec('BEGIN TRANSACTION;');
          try {
            const res = cb();
            rawDb.exec('COMMIT;');
            return res;
          } catch (err) {
            rawDb.exec('ROLLBACK;');
            throw err;
          }
        },
      };

      // Run database initialization and migrations
      runMigrations(testDb as any);
    });

    afterEach(() => {
      rawDb.close();
    });

    it('configures PRAGMA foreign_keys = ON and WAL/journal pragmas', () => {
      initDatabasePragmas(testDb as any);
      const fkRow = testDb.getFirstSync<{ foreign_keys: number }>('PRAGMA foreign_keys;');
      expect(fkRow?.foreign_keys).toBe(1);
    });

    it('creates base schema, default wallet, seeds categories and app settings', () => {
      const wallet = testDb.getFirstSync<{ id: number; name: string }>('SELECT id, name FROM wallets WHERE id = 1;');
      expect(wallet).toBeDefined();
      expect(wallet?.name).toBe('Main Wallet');

      const categories = testDb.getAllSync<{ name: string; type: string }>('SELECT name, type FROM categories;');
      expect(categories.length).toBeGreaterThan(0);
      expect(categories.some((c: { name: string; type: string }) => c.name === 'Food & Dining')).toBe(true);
      expect(categories.some((c: { name: string; type: string }) => c.name === 'Salary')).toBe(true);

      const settings = testDb.getAllSync<{ key: string; value: string }>('SELECT key, value FROM app_settings;');
      expect(settings.length).toBeGreaterThan(0);
      expect(settings.some((s: { key: string; value: string }) => s.key === 'currencyCode')).toBe(true);

      const versionRow = testDb.getFirstSync<{ user_version: number }>('PRAGMA user_version;');
      expect(versionRow?.user_version).toBe(8);
    });

    it('cascades deletion from transactions to transaction_items and shared_splits', () => {
      testDb.execSync('PRAGMA foreign_keys = ON;');

      // Insert a transaction
      testDb.runSync(
        `INSERT INTO transactions (id, wallet_id, merchant_name, total_amount, type, date, note, line_items_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        [100, 1, 'Superindo Market', -350000, 'expense', Date.now(), 'Weekly food', 'Milk | 35000\nEggs | 30000']
      );

      // Insert items and splits
      testDb.runSync(
        `INSERT INTO transaction_items (transaction_id, category, amount) VALUES (?, ?, ?);`,
        [100, 'Groceries', 350000]
      );
      testDb.runSync(
        `INSERT INTO shared_splits (transaction_id, person_name, amount_owed, is_settled) VALUES (?, ?, ?, ?);`,
        [100, 'Alice', 175000, 0]
      );

      // Verify records exist
      expect(testDb.getAllSync('SELECT * FROM transaction_items WHERE transaction_id = 100').length).toBe(1);
      expect(testDb.getAllSync('SELECT * FROM shared_splits WHERE transaction_id = 100').length).toBe(1);

      // Delete parent transaction
      testDb.runSync('DELETE FROM transactions WHERE id = ?;', [100]);

      // Verify child records cascaded
      expect(testDb.getAllSync('SELECT * FROM transaction_items WHERE transaction_id = 100').length).toBe(0);
      expect(testDb.getAllSync('SELECT * FROM shared_splits WHERE transaction_id = 100').length).toBe(0);
    });

    it('cascades deletion from wallets to transactions and budgets', () => {
      testDb.execSync('PRAGMA foreign_keys = ON;');

      // Create a secondary wallet
      testDb.runSync(`INSERT INTO wallets (id, name, type) VALUES (?, ?, ?);`, [2, 'Second Wallet', 'savings']);

      // Add budget and transaction in wallet 2
      testDb.runSync(
        `INSERT INTO budgets (category, limit_amount, period, wallet_id) VALUES (?, ?, ?, ?);`,
        ['Bills', 1000000, 'monthly', 2]
      );
      testDb.runSync(
        `INSERT INTO transactions (id, wallet_id, merchant_name, total_amount, type, date) VALUES (?, ?, ?, ?, ?, ?);`,
        [200, 2, 'PLN Electric', -500000, 'expense', Date.now()]
      );

      expect(testDb.getAllSync('SELECT * FROM budgets WHERE wallet_id = 2').length).toBe(1);
      expect(testDb.getAllSync('SELECT * FROM transactions WHERE wallet_id = 2').length).toBe(1);

      // Delete wallet 2
      testDb.runSync('DELETE FROM wallets WHERE id = 2;');

      expect(testDb.getAllSync('SELECT * FROM budgets WHERE wallet_id = 2').length).toBe(0);
      expect(testDb.getAllSync('SELECT * FROM transactions WHERE wallet_id = 2').length).toBe(0);
    });

    describe('FTS5 triggers and searchTransactions', () => {
      beforeEach(() => {
        // Insert sample dataset
        testDb.runSync(
          `INSERT INTO transactions (id, wallet_id, merchant_name, total_amount, type, date, note, line_items_text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
          [1, 1, 'PT Mega Corp', 18500000, 'income', 1710000000000, 'Corporate monthly salary payment', 'Salary Base | 18500000']
        );
        testDb.runSync(`INSERT INTO transaction_items (transaction_id, category, amount) VALUES (?, ?, ?);`, [1, 'Salary', 18500000]);

        testDb.runSync(
          `INSERT INTO transactions (id, wallet_id, merchant_name, total_amount, type, date, note, line_items_text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
          [2, 1, 'Superindo Market', -850000, 'expense', 1710000001000, 'Bi-weekly groceries', 'Fresh Milk 1L | 35000\nOrganic Eggs 1kg | 32000']
        );
        testDb.runSync(`INSERT INTO transaction_items (transaction_id, category, amount) VALUES (?, ?, ?);`, [2, 'Groceries', 850000]);

        testDb.runSync(
          `INSERT INTO transactions (id, wallet_id, merchant_name, total_amount, type, date, note, line_items_text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
          [3, 1, 'Kopi Kenangan Mantan', -45000, 'expense', 1710000002000, 'Morning iced coffee meeting', 'Iced Latte Large | 24000\nToast | 21000']
        );
        testDb.runSync(`INSERT INTO transaction_items (transaction_id, category, amount) VALUES (?, ?, ?);`, [3, 'Food & Dining', 45000]);
      });

      it('indexes new transactions automatically via transactions_ai trigger', () => {
        const results = searchTransactions('Superindo', undefined, testDb as any);
        expect(results.length).toBe(1);
        expect(results[0].merchantName).toBe('Superindo Market');
        expect(results[0].category).toBe('Groceries');
      });

      it('searches by note content', () => {
        const results = searchTransactions('salary', undefined, testDb as any);
        expect(results.length).toBe(1);
        expect(results[0].merchantName).toBe('PT Mega Corp');
        expect(results[0].type).toBe('income');
      });

      it('searches by line items text', () => {
        const results = searchTransactions('Milk', undefined, testDb as any);
        expect(results.length).toBe(1);
        expect(results[0].merchantName).toBe('Superindo Market');

        const toastResults = searchTransactions('Toast', undefined, testDb as any);
        expect(toastResults.length).toBe(1);
        expect(toastResults[0].merchantName).toBe('Kopi Kenangan Mantan');
      });

      it('supports prefix wildcard search', () => {
        const results = searchTransactions('Kop', undefined, testDb as any);
        expect(results.length).toBe(1);
        expect(results[0].merchantName).toBe('Kopi Kenangan Mantan');
      });

      it('filters search results by transaction type', () => {
        const incomeResults = searchTransactions('salary', { type: 'income' }, testDb as any);
        expect(incomeResults.length).toBe(1);

        const expenseResults = searchTransactions('salary', { type: 'expense' }, testDb as any);
        expect(expenseResults.length).toBe(0);
      });

      it('updates FTS index on transaction update via transactions_au trigger', () => {
        testDb.runSync(
          `UPDATE transactions SET merchant_name = ?, note = ? WHERE id = ?;`,
          ['Starbucks Reserve', 'Caramel Macchiato with team', 3]
        );

        // Old merchant name should not match
        const oldResults = searchTransactions('Kenangan', undefined, testDb as any);
        expect(oldResults.length).toBe(0);

        // New merchant name should match
        const newResults = searchTransactions('Starbucks', undefined, testDb as any);
        expect(newResults.length).toBe(1);
        expect(newResults[0].merchantName).toBe('Starbucks Reserve');

        // New note keyword should match
        const noteResults = searchTransactions('Macchiato', undefined, testDb as any);
        expect(noteResults.length).toBe(1);
        expect(noteResults[0].id).toBe(3);
      });

      it('removes from FTS index on transaction delete via transactions_ad trigger', () => {
        testDb.runSync('DELETE FROM transactions WHERE id = ?;', [2]);

        const results = searchTransactions('Superindo', undefined, testDb as any);
        expect(results.length).toBe(0);

        const milkResults = searchTransactions('Milk', undefined, testDb as any);
        expect(milkResults.length).toBe(0);
      });

      it('rebuilds FTS index without error', () => {
        expect(() => rebuildFtsIndex(testDb as any)).not.toThrow();
        const results = searchTransactions('Kopi', undefined, testDb as any);
        expect(results.length).toBe(1);
      });

      it('returns empty array when search query is empty', () => {
        expect(searchTransactions('', undefined, testDb as any)).toEqual([]);
        expect(searchTransactions('   ', undefined, testDb as any)).toEqual([]);
      });
    });

    it('populates and queries ai_transactions_view correctly', () => {
      testDb.runSync(
        `INSERT INTO transactions (id, wallet_id, merchant_name, total_amount, type, date, note, line_items_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        [10, 1, 'Netflix', -186000, 'expense', 1710000000000, 'Monthly subscription', 'Netflix 4K | 186000']
      );
      testDb.runSync(`INSERT INTO transaction_items (transaction_id, category, amount) VALUES (?, ?, ?);`, [10, 'Entertainment', 186000]);

      const viewRows = testDb.getAllSync<{ merchant_name: string; category: string }>(
        'SELECT merchant_name, category FROM ai_transactions_view WHERE id = 10;'
      );

      expect(viewRows.length).toBe(1);
      expect(viewRows[0].merchant_name).toBe('Netflix');
      expect(viewRows[0].category).toBe('Entertainment');
    });
  });
});
