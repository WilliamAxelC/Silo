import { DatabaseSync } from 'node:sqlite';

jest.mock('../../db/index', () => {
  const actual = jest.requireActual('../../db/index');
  return Object.defineProperty({ ...actual, __esModule: true }, 'expoDb', {
    get: () => (globalThis as any).__siloTestDb,
    enumerable: true,
  });
});

import { runMigrations } from '../../db/index';
import {
  createTransactionTemplate,
  deleteTransactionTemplate,
  listTransactionTemplates,
} from '../templates';

describe('transaction templates service', () => {
  let raw: DatabaseSync;

  beforeEach(() => {
    raw = new DatabaseSync(':memory:');
    const db = {
      execSync: (sql: string) => raw.exec(sql),
      getAllSync: (sql: string, p: any[] = []) => raw.prepare(sql).all(...p),
      getFirstSync: (sql: string, p: any[] = []) => raw.prepare(sql).get(...p) ?? null,
      runSync: (sql: string, p: any[] = []) => {
        const r = raw.prepare(sql).run(...p);
        return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
      },
      withTransactionSync: (cb: () => void) => cb(),
    };
    (globalThis as any).__siloTestDb = db;
    runMigrations(db as any);
  });

  afterEach(() => raw.close());

  it('creates, lists, and deletes templates without storing date or imageUri', () => {
    expect(listTransactionTemplates()).toEqual([]);

    const coffee = createTransactionTemplate('Morning Coffee', {
      merchantName: 'Kopi Kenangan',
      totalAmount: -25000,
      type: 'expense',
      category: 'Food & Dining',
      note: 'Oat latte',
      lineItemsText: '',
      walletId: 1,
      toWalletId: null,
    });

    const transfer = createTransactionTemplate('', {
      merchantName: '',
      totalAmount: -150.5,
      type: 'transfer',
      category: 'Transfer',
      note: 'Top up',
      lineItemsText: '',
      walletId: 1,
      toWalletId: 2,
    });

    const all = listTransactionTemplates();
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.id)).toEqual([transfer.id, coffee.id]);
    expect(all[0]).toMatchObject({
      name: 'Transfer',
      template: {
        merchantName: 'Transfer',
        totalAmount: -150.5,
        type: 'transfer',
        walletId: 1,
        toWalletId: 2,
      },
    });
    expect((all[1].template as any).date).toBeUndefined();
    expect((all[1].template as any).imageUri).toBeUndefined();

    deleteTransactionTemplate(coffee.id);
    const remaining = listTransactionTemplates();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(transfer.id);
  });
});
