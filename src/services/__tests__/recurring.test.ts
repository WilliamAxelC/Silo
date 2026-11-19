import { DatabaseSync } from 'node:sqlite';

jest.mock('../../db/index', () => {
  const actual = jest.requireActual('../../db/index');
  return Object.defineProperty({ ...actual, __esModule: true }, 'expoDb', {
    get: () => (globalThis as any).__siloTestDb,
    enumerable: true,
  });
});

import { runMigrations } from '../../db/index';
import { createRecurringRule, listRecurringRules, materializeDueRecurring, occurrenceDate, setRecurringRuleActive } from '../recurring';

const template = { merchantName: 'Netflix', totalAmount: -186000, type: 'expense' as const, category: 'Entertainment', note: '', lineItemsText: '', walletId: 1, toWalletId: null };

describe('recurring transactions', () => {
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

  it('keeps monthly rules anchored to the start day across short months', () => {
    const jan31 = new Date(2026, 0, 31, 9).getTime();
    const dates = [1, 2, 3].map((n) => new Date(occurrenceDate(jan31, 'monthly', n)));
    expect(dates.map((d) => [d.getMonth(), d.getDate()])).toEqual([[1, 28], [2, 31], [3, 30]]);
  });

  it('creates each due occurrence once, catching up after time away', async () => {
    const start = new Date(2026, 7, 1, 9).getTime();
    createRecurringRule(template, 'monthly', start);
    const add = jest.fn(async (_tx: any) => undefined);

    const created = await materializeDueRecurring(add, new Date(2026, 10, 19).getTime());
    expect(created).toBe(3); // Sep, Oct, Nov (Aug was saved by the user)
    expect(add.mock.calls.map((c: any) => new Date(c[0].date).getMonth())).toEqual([8, 9, 10]);
    expect(add.mock.calls[0][0]).toMatchObject({ merchantName: 'Netflix', totalAmount: -186000, imageUri: null });

    expect(await materializeDueRecurring(add, new Date(2026, 10, 19).getTime())).toBe(0);
    expect(new Date(listRecurringRules()[0].nextDate).getMonth()).toBe(11);
  });

  it('skips paused rules and keeps going when one rule fails', async () => {
    const start = new Date(2026, 9, 1).getTime();
    const paused = createRecurringRule(template, 'weekly', start);
    setRecurringRuleActive(paused, false);
    createRecurringRule({ ...template, merchantName: 'Broken' }, 'weekly', start);
    createRecurringRule({ ...template, merchantName: 'Gym' }, 'monthly', start);
    const add = jest.fn(async (tx: any) => {
      if (tx.merchantName === 'Broken') throw new Error('account removed');
    });

    await materializeDueRecurring(add, new Date(2026, 10, 2).getTime());
    const names = add.mock.calls.map((c: any) => c[0].merchantName);
    expect(names).not.toContain('Netflix');
    expect(names).toContain('Gym');
  });
});
