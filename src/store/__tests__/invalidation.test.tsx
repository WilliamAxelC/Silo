import React from 'react';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import * as schema from '../../db/schema';

const mockTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'silo-invalidation-'));

function wrapSqlite(raw: DatabaseSync) {
  const execSql = (sql: string, params: any[] = []) => {
    const stmt = raw.prepare(sql);
    const normalized = params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p));
    return { stmt, normalized };
  };

  return {
    execSync: (sql: string) => raw.exec(sql),
    getAllSync: <T = any>(sql: string, params: any[] = []): T[] => {
      const { stmt, normalized } = execSql(sql, params);
      return stmt.all(...normalized) as T[];
    },
    getFirstSync: <T = any>(sql: string, params: any[] = []): T | null => {
      const { stmt, normalized } = execSql(sql, params);
      return (stmt.get(...normalized) as T) ?? null;
    },
    runSync: (sql: string, params: any[] = []) => {
      const { stmt, normalized } = execSql(sql, params);
      const r = stmt.run(...normalized);
      return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    withTransactionSync: (cb: () => void) => {
      raw.exec('BEGIN;');
      try {
        cb();
        raw.exec('COMMIT;');
      } catch (error) {
        raw.exec('ROLLBACK;');
        throw error;
      }
    },
    prepareSync: (sql: string) => ({
      executeSync: (params: any[] = []) => {
        const isQuery = /^\s*(select|pragma|with)\b/i.test(sql) || /\breturning\b/i.test(sql);
        const { stmt, normalized } = execSql(sql, params);
        if (isQuery) {
          const rows = stmt.all(...normalized);
          return {
            changes: 0,
            lastInsertRowId: 0,
            getAllSync: () => rows,
            getFirstSync: () => rows[0] ?? null,
          };
        }
        const r = stmt.run(...normalized);
        return {
          changes: Number(r.changes),
          lastInsertRowId: Number(r.lastInsertRowid),
          getAllSync: () => [],
          getFirstSync: () => null,
        };
      },
      executeForRawResultSync: (params: any[] = []) => {
        const { stmt, normalized } = execSql(sql, params);
        const rows = stmt.all(...normalized) as Record<string, unknown>[];
        const rawRows = rows.map((row) => Object.values(row));
        return {
          getAllSync: () => rawRows,
          getFirstSync: () => rawRows[0] ?? null,
        };
      },
      finalizeSync: () => {},
    }),
  };
}

function makeDrizzle(expoDbWrapper: ReturnType<typeof wrapSqlite>) {
  const drizzleDb = drizzle(expoDbWrapper as any, { schema });
  (drizzleDb as any).transaction = async (cb: (tx: typeof drizzleDb) => Promise<unknown>) => {
    expoDbWrapper.execSync('BEGIN;');
    try {
      const res = await cb(drizzleDb);
      expoDbWrapper.execSync('COMMIT;');
      return res;
    } catch (error) {
      expoDbWrapper.execSync('ROLLBACK;');
      throw error;
    }
  };
  return drizzleDb;
}

jest.mock('../../db/index', () => {
  const actual = jest.requireActual('../../db/index');
  const mod = { ...actual, __esModule: true };
  Object.defineProperty(mod, 'expoDb', {
    get: () => (globalThis as any).__siloInvalidationExpoDb,
    enumerable: true,
  });
  Object.defineProperty(mod, 'db', {
    get: () => (globalThis as any).__siloInvalidationDrizzleDb,
    enumerable: true,
  });
  return mod;
});

jest.mock('expo-file-system/legacy', () => {
  const nodeFs = require('fs');
  const nodeOs = require('os');
  const nodePath = require('path');
  const ensureTmp = () => {
    if (!(globalThis as any).__siloInvalidationTmp) {
      (globalThis as any).__siloInvalidationTmp = nodeFs.mkdtempSync(
        nodePath.join(nodeOs.tmpdir(), 'silo-invalidation-'),
      );
    }
    return (globalThis as any).__siloInvalidationTmp as string;
  };
  const strip = (uri: string) => uri.replace(/^file:\/\//, '');
  return {
    get documentDirectory() {
      return `file://${ensureTmp()}/docs/`;
    },
    get cacheDirectory() {
      return `file://${ensureTmp()}/cache/`;
    },
    makeDirectoryAsync: jest.fn(async (dir: string) => {
      nodeFs.mkdirSync(strip(dir), { recursive: true });
    }),
    copyAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
      nodeFs.mkdirSync(nodePath.dirname(strip(to)), { recursive: true });
      nodeFs.copyFileSync(strip(from), strip(to));
    }),
    moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
      nodeFs.mkdirSync(nodePath.dirname(strip(to)), { recursive: true });
      if (nodeFs.existsSync(strip(from))) {
        nodeFs.renameSync(strip(from), strip(to));
      } else {
        nodeFs.writeFileSync(strip(to), 'thumb');
      }
    }),
    deleteAsync: jest.fn(async (uri: string) => {
      nodeFs.rmSync(strip(uri), { force: true });
    }),
    getInfoAsync: jest.fn(async (uri: string) => ({ exists: true, size: 1024, md5: `md5-${uri}` })),
  };
});

jest.mock('../../services/ai/agent', () => ({
  analyzeReceiptImage: jest.fn(async () => ({
    merchantName: 'Receipt Cafe',
    totalAmount: 42000,
    category: 'Food & Dining',
    confidence: 'high',
  })),
}));

const mockFocusCallbacks = new Map<string, () => void>();
let mockCurrentScreenTag = '';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
  useFocusEffect: (cb: () => void) => {
    mockFocusCallbacks.set(mockCurrentScreenTag, cb);
  },
}));

jest.mock('react-native-safe-area-context', () => {
  const R = require('react');
  return {
    SafeAreaView: (props: any) => R.createElement('SafeAreaView', props, props.children),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});

jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('react-native-gifted-charts', () => {
  const R = require('react');
  return {
    PieChart: (props: any) => R.createElement('PieChart', props, props.centerLabelComponent?.() ?? null),
  };
});

import { runMigrations } from '../../db/index';
import { useTransactionStore } from '../useTransactionStore';
import { useSettingsStore } from '../useSettingsStore';
import { useReceiptQueueStore } from '../useReceiptQueueStore';
import { createRecurringRule, materializeDueRecurring } from '../../services/recurring';
import { createTransactionTemplate } from '../../services/templates';
import { restoreBackupFile } from '../../services/backup';
import { CashflowScreen } from '../../screens/CashflowScreen';
import { ReportsScreen } from '../../screens/ReportsScreen';
import { BudgetScreen } from '../../screens/BudgetScreen';

const ReactTestRenderer = require('react-test-renderer');

describe('Store invalidation & single-scan data freshness (real SQLite)', () => {
  let raw: DatabaseSync;
  let expoDbWrapper: ReturnType<typeof wrapSqlite>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockFocusCallbacks.clear();

    raw = new DatabaseSync(':memory:');
    expoDbWrapper = wrapSqlite(raw);
    (globalThis as any).__siloInvalidationExpoDb = expoDbWrapper;
    (globalThis as any).__siloInvalidationDrizzleDb = makeDrizzle(expoDbWrapper);

    runMigrations(expoDbWrapper as any);

    useSettingsStore.setState({
      isLoaded: true,
      hasCompletedOnboarding: true,
      currencyCode: 'IDR',
      dateFormat: 'en-GB',
      monthStartDay: 1,
      weekStartDay: 'monday',
    });
    useTransactionStore.setState({
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
    });
    useReceiptQueueStore.setState({ items: [], isProcessing: false });

    await useTransactionStore.getState().initDB();
  });

  afterEach(() => {
    raw.close();
  });

  afterAll(() => {
    fs.rmSync(mockTmp, { recursive: true, force: true });
    if ((globalThis as any).__siloInvalidationTmp) {
      fs.rmSync((globalThis as any).__siloInvalidationTmp, { recursive: true, force: true });
      delete (globalThis as any).__siloInvalidationTmp;
    }
  });

  it('skips redundant SQLite full-table scans on tab focus when data is clean, and re-scans once invalidated', async () => {
    const getAllSpy = jest.spyOn(expoDbWrapper, 'getAllSync');

    // Mount all three data tabs while store is already loaded & clean
    mockCurrentScreenTag = 'Cashflow';
    let cashflowRenderer: any;
    ReactTestRenderer.act(() => {
      cashflowRenderer = ReactTestRenderer.create(<CashflowScreen />);
    });
    mockCurrentScreenTag = 'Reports';
    let reportsRenderer: any;
    ReactTestRenderer.act(() => {
      reportsRenderer = ReactTestRenderer.create(<ReportsScreen />);
    });
    mockCurrentScreenTag = 'Budget';
    let budgetRenderer: any;
    ReactTestRenderer.act(() => {
      budgetRenderer = ReactTestRenderer.create(<BudgetScreen />);
    });

    getAllSpy.mockClear();

    // Simulate switching across Cashflow -> Reports -> Budget -> Cashflow with no data changes
    await ReactTestRenderer.act(async () => {
      mockFocusCallbacks.get('Cashflow')?.();
      mockFocusCallbacks.get('Reports')?.();
      mockFocusCallbacks.get('Budget')?.();
      mockFocusCallbacks.get('Cashflow')?.();
      await Promise.resolve();
    });

    expect(getAllSpy).not.toHaveBeenCalled();

    // Mark dirty via invalidateData() -> next tab focus MUST re-scan SQLite and clear dirty flag
    const now = Date.now();
    expoDbWrapper.runSync(
      `INSERT INTO transactions (wallet_id, merchant_name, total_amount, type, date) VALUES (1, 'External Write', -15000, 'expense', ?);`,
      [now],
    );
    ReactTestRenderer.act(() => {
      useTransactionStore.getState().invalidateData({ transactions: true });
    });
    expect(useTransactionStore.getState().transactionsDirty).toBe(true);

    await ReactTestRenderer.act(async () => {
      mockFocusCallbacks.get('Reports')?.();
      await Promise.resolve();
    });

    expect(getAllSpy).toHaveBeenCalled();
    expect(useTransactionStore.getState().transactionsDirty).toBe(false);
    expect(useTransactionStore.getState().transactionsList.map((t) => t.merchantName)).toContain('External Write');

    // Subsequent focus after cleaning does zero scans again
    getAllSpy.mockClear();
    await ReactTestRenderer.act(async () => {
      mockFocusCallbacks.get('Cashflow')?.();
      await Promise.resolve();
    });
    expect(getAllSpy).not.toHaveBeenCalled();

    ReactTestRenderer.act(() => {
      cashflowRenderer.unmount();
      reportsRenderer.unmount();
      budgetRenderer.unmount();
    });
  });

  it('refreshes store state immediately across add, update, delete, transfers, templates, and receipt inbox saves without full-table scans', async () => {
    const store = useTransactionStore.getState();
    const bankId = store.addWallet({ name: 'BCA', type: 'bank', initialBalance: 1_000_000 });
    const gopayId = store.addWallet({ name: 'GoPay', type: 'ewallet', initialBalance: 50_000 });
    const now = Date.now();

    const fetchTxSpy = jest.spyOn(useTransactionStore.getState(), 'fetchTransactions');

    // 1. Add expense
    await useTransactionStore.getState().addTransaction({
      merchantName: 'Kopi Kenangan',
      totalAmount: 30_000,
      type: 'expense',
      category: 'Food & Dining',
      date: now,
      walletId: bankId,
    });
    expect(fetchTxSpy).not.toHaveBeenCalled();
    expect(useTransactionStore.getState().transactionsList).toHaveLength(1);
    expect(useTransactionStore.getState().wallets.find((w) => w.id === bankId)?.balance).toBe(970_000);

    // 2. Transfer between accounts updates list AND both wallet balances
    await useTransactionStore.getState().addTransaction({
      merchantName: 'Top up GoPay',
      totalAmount: -200_000,
      type: 'transfer',
      category: 'Transfer',
      date: now + 1000,
      walletId: bankId,
      toWalletId: gopayId,
    });
    expect(fetchTxSpy).not.toHaveBeenCalled();
    expect(useTransactionStore.getState().transactionsList).toHaveLength(2);
    expect(useTransactionStore.getState().wallets.find((w) => w.id === bankId)?.balance).toBe(770_000);
    expect(useTransactionStore.getState().wallets.find((w) => w.id === gopayId)?.balance).toBe(250_000);

    // 3. Save from a template
    const tpl = createTransactionTemplate(
      'Daily Lunch',
      {
        merchantName: 'Warteg',
        totalAmount: -25_000,
        type: 'expense',
        category: 'Food & Dining',
        walletId: gopayId,
      },
      expoDbWrapper as any,
    );
    await useTransactionStore.getState().addTransaction({
      ...tpl.template,
      date: now + 2000,
    });
    expect(fetchTxSpy).not.toHaveBeenCalled();
    expect(useTransactionStore.getState().transactionsList[0].merchantName).toBe('Warteg');
    expect(useTransactionStore.getState().wallets.find((w) => w.id === gopayId)?.balance).toBe(225_000);

    // 4. Receipt Inbox save: enqueue -> save tx -> remove from inbox with deleteImage=false
    const sampleReceipt = path.join(mockTmp, 'inbox-sample.jpg');
    fs.writeFileSync(sampleReceipt, 'fake-jpeg');
    await useReceiptQueueStore.getState().enqueue([`file://${sampleReceipt}`]);
    for (let i = 0; i < 20 && useReceiptQueueStore.getState().isProcessing; i++) {
      await Promise.resolve();
    }
    const queued = useReceiptQueueStore.getState().items[0];
    expect(queued).toBeDefined();
    expect(queued.thumbnailUri).toBeTruthy();

    await useTransactionStore.getState().addTransaction({
      merchantName: queued.result?.merchantName ?? 'Receipt Cafe',
      totalAmount: -(queued.result?.totalAmount ?? 42_000),
      type: 'expense',
      category: 'Food & Dining',
      date: now + 3000,
      imageUri: queued.imageUri,
      walletId: 1,
    });
    await useReceiptQueueStore.getState().remove(queued.id, false);
    expect(fetchTxSpy).not.toHaveBeenCalled();
    expect(useTransactionStore.getState().transactionsList[0].merchantName).toBe('Receipt Cafe');
    expect(useReceiptQueueStore.getState().items).toHaveLength(0);

    // 5. Update and delete transaction
    const savedId = useTransactionStore.getState().transactionsList[0].id;
    await useTransactionStore.getState().updateTransaction(savedId, {
      merchantName: 'Receipt Cafe Edited',
      totalAmount: -50_000,
    });
    expect(fetchTxSpy).not.toHaveBeenCalled();
    expect(useTransactionStore.getState().transactionsList[0].merchantName).toBe('Receipt Cafe Edited');
    expect(useTransactionStore.getState().wallets.find((w) => w.id === 1)?.balance).toBe(-50_000);

    await useTransactionStore.getState().deleteTransaction(savedId);
    expect(fetchTxSpy).not.toHaveBeenCalled();
    expect(useTransactionStore.getState().transactionsList.some((tx) => tx.id === savedId)).toBe(false);
    expect(useTransactionStore.getState().wallets.find((w) => w.id === 1)?.balance).toBe(0);
  });

  it('invalidates transactions on recurring catch-up so screens refresh materialized occurrences', async () => {
    const startMs = Date.now() - 3 * 24 * 60 * 60 * 1000;
    createRecurringRule(
      {
        merchantName: 'Daily Gym Pass',
        totalAmount: -20_000,
        type: 'expense',
        category: 'Food & Dining',
        walletId: 1,
      },
      'daily',
      startMs,
    );

    // materializeDueRecurring calls addTransaction with { skipRefresh: true }
    const created = await materializeDueRecurring(useTransactionStore.getState().addTransaction, Date.now());
    expect(created).toBeGreaterThanOrEqual(3);
    expect(useTransactionStore.getState().transactionsDirty).toBe(true);

    // Focusing any screen (fetchTransactionsIfNeeded) now refreshes and exposes all materialized rows
    await useTransactionStore.getState().fetchTransactionsIfNeeded();
    expect(useTransactionStore.getState().transactionsDirty).toBe(false);
    expect(
      useTransactionStore.getState().transactionsList.filter((t) => t.merchantName === 'Daily Gym Pass').length,
    ).toBe(created);
  });

  it('invalidates all slices on backup restore so screens refresh restored transactions, categories, and budgets', async () => {
    // Build a standalone backup SQLite file containing distinct data
    const backupFile = path.join(mockTmp, 'restorable-backup.db');
    const backupRaw = new DatabaseSync(backupFile);
    const backupDb = wrapSqlite(backupRaw);
    runMigrations(backupDb as any);
    backupDb.runSync(
      `INSERT INTO transactions (wallet_id, merchant_name, total_amount, type, date) VALUES (1, 'Restored Flight', -1500000, 'expense', ?);`,
      [Date.now()],
    );
    const insertedId = backupDb.getFirstSync<{ id: number }>('SELECT last_insert_rowid() AS id;')?.id ?? 1;
    backupDb.runSync(
      `INSERT INTO transaction_items (transaction_id, category, amount) VALUES (?, 'Transport', 1500000);`,
      [insertedId],
    );
    backupDb.runSync(`INSERT INTO budgets (category, limit_amount, wallet_id) VALUES ('Transport', 2000000, 1);`);
    backupRaw.close();

    // Before restore: store is loaded & clean
    expect(useTransactionStore.getState().transactionsDirty).toBe(false);
    expect(useTransactionStore.getState().budgetsDirty).toBe(false);
    expect(useTransactionStore.getState().categoriesDirty).toBe(false);

    // Run real restoreBackupFile
    const res = await restoreBackupFile(`file://${backupFile}`);
    expect(res.transactions).toBe(1);

    // Backup restore MUST have marked all slices dirty
    expect(useTransactionStore.getState().transactionsDirty).toBe(true);
    expect(useTransactionStore.getState().categoriesDirty).toBe(true);
    expect(useTransactionStore.getState().budgetsDirty).toBe(true);

    // Focusing BudgetScreen triggers refresh because slices are dirty
    mockCurrentScreenTag = 'Budget';
    let budgetRenderer: any;
    ReactTestRenderer.act(() => {
      budgetRenderer = ReactTestRenderer.create(<BudgetScreen />);
    });
    await ReactTestRenderer.act(async () => {
      mockFocusCallbacks.get('Budget')?.();
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });

    expect(useTransactionStore.getState().transactionsList.map((t) => t.merchantName)).toEqual(['Restored Flight']);
    expect(useTransactionStore.getState().budgets.Transport).toBe(2000000);
    expect(useTransactionStore.getState().transactionsDirty).toBe(false);

    ReactTestRenderer.act(() => {
      budgetRenderer.unmount();
    });
  });
});
