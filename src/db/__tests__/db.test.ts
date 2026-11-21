import { DatabaseSync } from 'node:sqlite';
import {
  initDatabasePragmas,
  createBaseSchema,
  runMigrations,
  buildFtsSearchQuery,
  searchTransactions,
  summarizeSearchTransactions,
  getDailyTotalsForRange,
  DEFAULT_SEARCH_LIMIT,
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

    it('handles unbalanced, leading, trailing, and repeated quotes gracefully', () => {
      expect(buildFtsSearchQuery('"unclosed')).toBe('"unclosed"*');
      expect(buildFtsSearchQuery('unclosed"')).toBe('"unclosed"*');
      expect(buildFtsSearchQuery('"""""')).toBe('');
      expect(buildFtsSearchQuery('"quoted" "terms"')).toBe('"quoted"* OR "terms"*');
      expect(buildFtsSearchQuery("'''single''' 'quotes'")).toBe('"single"* OR "quotes"*');
    });

    it('handles asterisks and wildcards without crashing or creating invalid syntax', () => {
      expect(buildFtsSearchQuery('*')).toBe('');
      expect(buildFtsSearchQuery('***')).toBe('');
      expect(buildFtsSearchQuery('coffee*')).toBe('"coffee"*');
      expect(buildFtsSearchQuery('*coffee*')).toBe('"coffee"*');
    });

    it('handles brackets, braces, and math/regex symbols safely', () => {
      expect(buildFtsSearchQuery('[groceries]')).toBe('"[groceries]"*');
      expect(buildFtsSearchQuery('{household}')).toBe('"household"*');
      expect(buildFtsSearchQuery('(salary OR bonus)')).toBe('"salary"* OR "OR"* OR "bonus"*');
      expect(buildFtsSearchQuery('^start $end ~approx')).toBe('"start"* OR "$end"* OR "approx"*');
      expect(buildFtsSearchQuery('a+b=c & d|e')).toBe('"a"* OR "b=c"* OR "&"* OR "d|e"*');
    });

    it('handles unicode, accents, and emojis correctly', () => {
      expect(buildFtsSearchQuery('Café Résumé ☕ 🛒')).toBe('"Café"* OR "Résumé"* OR "☕"* OR "🛒"*');
      expect(buildFtsSearchQuery('ラーメン 100%')).toBe('"ラーメン"* OR "100%"*');
    });

    it('handles SQL injection patterns safely', () => {
      const sqlInject = buildFtsSearchQuery("' OR 1=1 --; DROP TABLE transactions;");
      expect(sqlInject).not.toContain("'");
      expect(sqlInject).toContain('"OR"*');
      expect(sqlInject).toContain('"DROP"*');
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
      expect(versionRow?.user_version).toBe(13);

      const templatesTable = testDb.getFirstSync<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='transaction_templates';`
      );
      expect(templatesTable?.name).toBe('transaction_templates');
    });

    it('migrates an existing v11 database to v12 by adding transaction_templates without losing data', () => {
      // Simulate a v11 database that predates transaction_templates & onboarding flag
      testDb.execSync('DROP TABLE IF EXISTS transaction_templates;');
      testDb.execSync(`DELETE FROM app_settings WHERE key = 'hasCompletedOnboarding';`);
      testDb.runSync(
        `INSERT INTO transactions (id, wallet_id, merchant_name, total_amount, type, date) VALUES (?, ?, ?, ?, ?, ?);`,
        [500, 1, 'Legacy Entry', -15000, 'expense', 1710000000000]
      );
      testDb.execSync('PRAGMA user_version = 11;');

      runMigrations(testDb as any);

      expect(testDb.getFirstSync<{ user_version: number }>('PRAGMA user_version;')?.user_version).toBe(13);
      const tbl = testDb.getFirstSync<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='transaction_templates';`
      );
      expect(tbl?.name).toBe('transaction_templates');
      const existing = testDb.getFirstSync<{ merchant_name: string }>(
        'SELECT merchant_name FROM transactions WHERE id = 500;'
      );
      expect(existing?.merchant_name).toBe('Legacy Entry');

      // v13 marks onboarding completed automatically for upgraded DBs with existing transactions
      const onboardingRow = testDb.getFirstSync<{ value: string }>(
        `SELECT value FROM app_settings WHERE key = 'hasCompletedOnboarding';`
      );
      expect(onboardingRow?.value).toBe('true');

      // v13 adds image_hash column on receipt_queue
      const queueCols = testDb.getAllSync<{ name: string }>('PRAGMA table_info(receipt_queue);');
      expect(queueCols.some((c) => c.name === 'image_hash')).toBe(true);
    });

    it('skips migrations, seeding, and view recreation on steady-state launch when user_version is current', () => {
      const execSpy = jest.spyOn(testDb, 'execSync');
      const runSpy = jest.spyOn(testDb, 'runSync');

      runMigrations(testDb as any);

      const execCalls = execSpy.mock.calls.map((c) => c[0]);
      expect(execCalls.some((sql) => sql.includes('DROP VIEW IF EXISTS'))).toBe(false);
      expect(execCalls.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS'))).toBe(false);
      expect(runSpy).not.toHaveBeenCalled();

      execSpy.mockRestore();
      runSpy.mockRestore();
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

      it('handles search queries with special characters, quotes, brackets, and asterisks without crashing', () => {
        // Double quotes
        const quoteRes = searchTransactions('"Superindo"', undefined, testDb as any);
        expect(quoteRes.length).toBe(1);
        expect(quoteRes[0].merchantName).toBe('Superindo Market');

        // Unbalanced quotes
        const unclosedQuoteRes = searchTransactions('"Superindo', undefined, testDb as any);
        expect(unclosedQuoteRes.length).toBe(1);

        // Asterisks only (stripped -> fallback to LIKE %***%)
        expect(() => searchTransactions('***', undefined, testDb as any)).not.toThrow();

        // Colons, brackets, and parentheses
        const bracketRes = searchTransactions('(Superindo) [Groceries] : 50%', undefined, testDb as any);
        expect(bracketRes.length).toBeGreaterThanOrEqual(1);

        // SQL injection payload
        const sqlRes = searchTransactions("' OR '1'='1' --", undefined, testDb as any);
        expect(Array.isArray(sqlRes)).toBe(true);
      });

      it('handles unicode, accented characters, and emojis in transactions and queries', () => {
        testDb.runSync(
          `INSERT INTO transactions (id, wallet_id, merchant_name, total_amount, type, date, note, line_items_text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
          [4, 1, 'Café Délices ☕', -60000, 'expense', 1710000003000, 'French bakery 🥐', 'Croissant | 30000\nCafé au lait | 30000']
        );
        testDb.runSync(`INSERT INTO transaction_items (transaction_id, category, amount) VALUES (?, ?, ?);`, [4, 'Food & Dining', 60000]);

        const cafeRes = searchTransactions('Café', undefined, testDb as any);
        expect(cafeRes.length).toBe(1);
        expect(cafeRes[0].merchantName).toBe('Café Délices ☕');

        const croissantRes = searchTransactions('Croissant', undefined, testDb as any);
        expect(croissantRes.length).toBe(1);
        expect(croissantRes[0].id).toBe(4);
      });

      it('respects limit and offset pagination correctly', () => {
        const paged = searchTransactions('Market OR Kenangan OR Corp', { limit: 1, offset: 0 }, testDb as any);
        expect(paged.length).toBe(1);

        const pagedOffset = searchTransactions('Market OR Kenangan OR Corp', { limit: 1, offset: 1 }, testDb as any);
        expect(pagedOffset.length).toBe(1);
        expect(pagedOffset[0].id).not.toBe(paged[0].id);

        const outOfRange = searchTransactions('Superindo', { limit: 10, offset: 50 }, testDb as any);
        expect(outOfRange.length).toBe(0);
      });

      it('filters transactions with an empty query by type, account (wallet_id OR to_wallet_id), category, and date range', () => {
        // Add a second account and a transfer between account 1 -> account 2 plus an expense on account 2
        testDb.runSync(`INSERT INTO wallets (id, name, type) VALUES (?, ?, ?);`, [2, 'GoPay', 'ewallet']);
        testDb.runSync(
          `INSERT INTO transactions (id, wallet_id, to_wallet_id, merchant_name, total_amount, type, date, note, line_items_text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [4, 1, 2, 'Top up GoPay', -200000, 'transfer', 1710000005000, 'Wallet top-up', '']
        );
        testDb.runSync(`INSERT INTO transaction_items (transaction_id, category, amount) VALUES (?, ?, ?);`, [4, 'Transfer', 200000]);

        testDb.runSync(
          `INSERT INTO transactions (id, wallet_id, merchant_name, total_amount, type, date, note, line_items_text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
          [5, 2, 'GoFood Lunch', -55000, 'expense', 1710000010000, 'Nasi padang', '']
        );
        testDb.runSync(`INSERT INTO transaction_items (transaction_id, category, amount) VALUES (?, ?, ?);`, [5, 'Food & Dining', 55000]);

        // Empty query + type filter
        const transfers = searchTransactions('', { type: 'transfer' }, testDb as any);
        expect(transfers.map((t) => t.id)).toEqual([4]);
        expect(transfers[0].walletId).toBe(1);
        expect(transfers[0].toWalletId).toBe(2);

        // Empty query + account filter matches wallet_id OR to_wallet_id
        const wallet2Txns = searchTransactions('', { walletId: 2 }, testDb as any);
        expect(wallet2Txns.map((t) => t.id)).toEqual([5, 4]);

        const wallet1Transfers = searchTransactions('', { walletId: 1, type: 'transfer' }, testDb as any);
        expect(wallet1Transfers.map((t) => t.id)).toEqual([4]);

        // Empty query + category filter
        const foodTxns = searchTransactions('', { category: 'Food & Dining' }, testDb as any);
        expect(foodTxns.map((t) => t.id)).toEqual([5, 3]);

        // Empty query + date range filter (inclusive bounds)
        const ranged = searchTransactions(
          '',
          { dateFrom: 1710000001000, dateTo: 1710000005000 },
          testDb as any
        );
        expect(ranged.map((t) => t.id)).toEqual([4, 3, 2]);

        // Search text combined with account & category filters
        const combined = searchTransactions(
          'GoFood',
          { walletId: 2, category: 'Food & Dining', type: 'expense' },
          testDb as any
        );
        expect(combined.map((t) => t.id)).toEqual([5]);

        const combinedMiss = searchTransactions('GoFood', { walletId: 1 }, testDb as any);
        expect(combinedMiss).toEqual([]);
      });

      it('drives FTS+filter queries from FTS on 5,000 rows and computes uncapped SQL summary totals', () => {
        // Seed 5,000 additional transactions where every merchant matches "Merchant"
        // so an inverted join plan (secondary index -> FTS virtual table scan) degrades to O(N^2).
        testDb.runSync(`INSERT OR IGNORE INTO wallets (id, name, type) VALUES (?, ?, ?);`, [2, 'GoPay', 'ewallet']);

        let expectedExpenseCount = 0;
        let expectedExpenseOut = 0;
        let expectedWallet2Count = 0;
        let expectedWallet2In = 0;
        let expectedWallet2Out = 0;
        let expectedFoodWallet1Count = 0;
        let expectedFoodWallet1Out = 0;

        testDb.withTransactionSync(() => {
          for (let i = 1; i <= 5000; i++) {
            const type = i % 10 === 0 ? 'income' : i % 15 === 0 ? 'transfer' : 'expense';
            const walletId = i % 3 === 0 ? 2 : 1;
            const toWalletId = type === 'transfer' ? (walletId === 1 ? 2 : 1) : null;
            const amount = type === 'income' ? 50000 : type === 'transfer' ? -20000 : -15000;
            const category =
              type === 'income'
                ? 'Salary'
                : type === 'transfer'
                  ? 'Transfer'
                  : i % 2 === 0
                    ? 'Food & Dining'
                    : 'Groceries';

            const res = testDb.runSync(
              `INSERT INTO transactions (wallet_id, to_wallet_id, merchant_name, total_amount, type, date, note, line_items_text)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
              [walletId, toWalletId, `Merchant ${i}`, amount, type, 1720000000000 + i * 1000, `note ${i}`, '']
            );
            testDb.runSync(
              `INSERT INTO transaction_items (transaction_id, category, amount) VALUES (?, ?, ?);`,
              [res.lastInsertRowId, category, Math.abs(amount)]
            );

            if (type === 'expense') {
              expectedExpenseCount += 1;
              expectedExpenseOut += 15000;
            }
            if (walletId === 2 || toWalletId === 2) {
              expectedWallet2Count += 1;
              if (type === 'income') expectedWallet2In += 50000;
              if (type === 'expense') expectedWallet2Out += 15000;
            }
            if (category === 'Food & Dining' && walletId === 1) {
              expectedFoodWallet1Count += 1;
              expectedFoodWallet1Out += 15000;
            }
          }
        });

        // Verify FTS+type query plan drives from transactions_fts, not idx_transactions_type
        const plan = testDb.getAllSync<{ detail: string }>(
          `EXPLAIN QUERY PLAN
          WITH fts_matches AS (
            SELECT rowid AS id, rank
            FROM transactions_fts
            WHERE transactions_fts MATCH ?
          )
          SELECT t.id
          FROM fts_matches fts
          CROSS JOIN transactions t ON fts.id = t.id
          LEFT JOIN transaction_items i ON t.id = i.transaction_id
          WHERE t.type = ?
          ORDER BY fts.rank, t.date DESC
          LIMIT 500 OFFSET 0;`,
          ['"Merchant"*', 'expense']
        );
        expect(plan[0]?.detail).toMatch(/SCAN transactions_fts VIRTUAL TABLE/i);
        expect(plan[1]?.detail).toMatch(/SEARCH t USING INTEGER PRIMARY KEY/i);

        // R-01: FTS + type filter executes quickly and returns correct capped page
        const t0 = performance.now();
        const ftsExpensePage = searchTransactions('Merchant', { type: 'expense' }, testDb as any);
        const ftsExpenseMs = performance.now() - t0;
        expect(ftsExpensePage).toHaveLength(DEFAULT_SEARCH_LIMIT);
        expect(ftsExpensePage.every((t) => t.type === 'expense')).toBe(true);
        expect(ftsExpenseMs).toBeLessThan(250);

        // R-01: FTS + walletId filter executes quickly and returns correct capped page
        const t1 = performance.now();
        const ftsWallet2Page = searchTransactions('Merchant', { walletId: 2 }, testDb as any);
        const ftsWallet2Ms = performance.now() - t1;
        expect(ftsWallet2Page).toHaveLength(DEFAULT_SEARCH_LIMIT);
        expect(ftsWallet2Page.every((t) => t.walletId === 2 || t.toWalletId === 2)).toBe(true);
        expect(ftsWallet2Ms).toBeLessThan(250);

        // R-02: Uncapped SQL summary covers ALL matching transactions (> 500), not just the 500-row page
        expect(expectedExpenseCount).toBeGreaterThan(DEFAULT_SEARCH_LIMIT);
        expect(expectedWallet2Count).toBeGreaterThan(DEFAULT_SEARCH_LIMIT);

        // FTS + type summary (must ignore limit/offset and match all 4,333 seeded Merchant expenses)
        const ftsExpenseSummary = summarizeSearchTransactions(
          'Merchant',
          { type: 'expense', limit: 10, offset: 5 },
          testDb as any
        );
        expect(ftsExpenseSummary).toEqual({
          count: expectedExpenseCount,
          totalIn: 0,
          totalOut: expectedExpenseOut,
          net: -expectedExpenseOut,
        });

        // FTS + walletId summary (includes transfers in count, excludes transfers from totalIn/totalOut)
        const ftsWallet2Summary = summarizeSearchTransactions('Merchant', { walletId: 2 }, testDb as any);
        expect(ftsWallet2Summary).toEqual({
          count: expectedWallet2Count,
          totalIn: expectedWallet2In,
          totalOut: expectedWallet2Out,
          net: expectedWallet2In - expectedWallet2Out,
        });

        // Filter-only (empty query) summary covers all wallet 2 transactions (> 500)
        const filterOnlyWallet2Page = searchTransactions('', { walletId: 2 }, testDb as any);
        expect(filterOnlyWallet2Page).toHaveLength(DEFAULT_SEARCH_LIMIT);
        const filterOnlyWallet2Summary = summarizeSearchTransactions('', { walletId: 2 }, testDb as any);
        expect(filterOnlyWallet2Summary).toEqual({
          count: expectedWallet2Count,
          totalIn: expectedWallet2In,
          totalOut: expectedWallet2Out,
          net: expectedWallet2In - expectedWallet2Out,
        });

        // LIKE fallback summary (category substring "Dining" not indexed in FTS) covers all > 500 matches
        // (+1 for the initial Kopi Kenangan Food & Dining row on wallet 1 from beforeEach, total -45000)
        expect(expectedFoodWallet1Count).toBeGreaterThan(DEFAULT_SEARCH_LIMIT);
        const likeCategorySummary = summarizeSearchTransactions('Dining', { walletId: 1 }, testDb as any);
        expect(likeCategorySummary.count).toBe(expectedFoodWallet1Count + 1);
        expect(likeCategorySummary.totalOut).toBe(expectedFoodWallet1Out + 45000);
        expect(likeCategorySummary.totalIn).toBe(0);
        expect(likeCategorySummary.net).toBe(-(expectedFoodWallet1Out + 45000));

        // Empty query with no filters returns zeros
        expect(summarizeSearchTransactions('', undefined, testDb as any)).toEqual({
          count: 0,
          totalIn: 0,
          totalOut: 0,
          net: 0,
        });
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

    it('aggregates daily income and expense totals in SQL grouped by local day and excludes transfers', () => {
      testDb.runSync(`INSERT INTO wallets (id, name, type) VALUES (?, ?, ?);`, [2, 'GoPay', 'ewallet']);

      // Day 1: 2026-11-10 (morning income + evening expense + transfer)
      const nov10Morning = new Date(2026, 10, 10, 8, 30, 0, 0).getTime();
      const nov10Late = new Date(2026, 10, 10, 23, 59, 59, 999).getTime();
      // Day 2: 2026-11-11 (midnight boundary + transfer-only check on Nov 12)
      const nov11Start = new Date(2026, 10, 11, 0, 0, 0, 0).getTime();
      const nov12Noon = new Date(2026, 10, 12, 12, 0, 0, 0).getTime();
      // Outside range: 2026-10-31
      const oct31End = new Date(2026, 9, 31, 23, 59, 59, 999).getTime();

      testDb.runSync(
        `INSERT INTO transactions (wallet_id, merchant_name, total_amount, type, date) VALUES (?, ?, ?, ?, ?);`,
        [1, 'Client Invoice', 1200000, 'income', nov10Morning]
      );
      testDb.runSync(
        `INSERT INTO transactions (wallet_id, merchant_name, total_amount, type, date) VALUES (?, ?, ?, ?, ?);`,
        [1, 'Late Dinner', -45000, 'expense', nov10Late]
      );
      testDb.runSync(
        `INSERT INTO transactions (wallet_id, to_wallet_id, merchant_name, total_amount, type, date) VALUES (?, ?, ?, ?, ?, ?);`,
        [1, 2, 'Top up GoPay', -300000, 'transfer', nov10Late]
      );
      testDb.runSync(
        `INSERT INTO transactions (wallet_id, merchant_name, total_amount, type, date) VALUES (?, ?, ?, ?, ?);`,
        [1, 'Midnight Snack', -15000, 'expense', nov11Start]
      );
      testDb.runSync(
        `INSERT INTO transactions (wallet_id, to_wallet_id, merchant_name, total_amount, type, date) VALUES (?, ?, ?, ?, ?, ?);`,
        [1, 2, 'Savings Transfer', -500000, 'transfer', nov12Noon]
      );
      testDb.runSync(
        `INSERT INTO transactions (wallet_id, merchant_name, total_amount, type, date) VALUES (?, ?, ?, ?, ?);`,
        [1, 'Previous Month Expense', -99000, 'expense', oct31End]
      );

      const novStart = new Date(2026, 10, 1, 0, 0, 0, 0).getTime();
      const novEnd = new Date(2026, 10, 30, 23, 59, 59, 999).getTime();

      // Verify index usage on date range
      const plan = testDb.getAllSync<{ detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT strftime('%Y-%m-%d', CAST(t.date AS INTEGER) / 1000, 'unixepoch', 'localtime') AS dayKey
         FROM transactions t
         WHERE t.date >= ? AND t.date <= ?
         GROUP BY dayKey;`,
        [novStart, novEnd]
      );
      expect(plan.some((p) => /idx_transactions_date/i.test(p.detail))).toBe(true);

      const totals = getDailyTotalsForRange(novStart, novEnd, testDb as any);
      expect(totals).toEqual([
        { dayKey: '2026-11-10', income: 1200000, expense: 45000, count: 3 },
        { dayKey: '2026-11-11', income: 0, expense: 15000, count: 1 },
        { dayKey: '2026-11-12', income: 0, expense: 0, count: 1 },
      ]);
    });
  });
});
