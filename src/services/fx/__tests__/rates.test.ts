import { DatabaseSync } from 'node:sqlite';

jest.mock('../../../db/index', () => {
  const actual = jest.requireActual('../../../db/index');
  return Object.defineProperty({ ...actual, __esModule: true }, 'expoDb', {
    get: () => (globalThis as any).__siloTestDb,
    enumerable: true,
  });
});

import { runMigrations } from '../../../db/index';
import { getCachedRate, refreshDailyRates } from '../rates';

describe('daily exchange rates', () => {
  let raw: DatabaseSync;
  beforeEach(() => {
    raw = new DatabaseSync(':memory:');
    const db = {
      execSync: (sql: string) => raw.exec(sql),
      getAllSync: (sql: string, params: any[] = []) => raw.prepare(sql).all(...params),
      getFirstSync: (sql: string, params: any[] = []) => raw.prepare(sql).get(...params) ?? null,
      runSync: (sql: string, params: any[] = []) => {
        const r = raw.prepare(sql).run(...params);
        return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
      },
      withTransactionSync: (cb: () => void) => cb(),
    };
    (globalThis as any).__siloTestDb = db;
    runMigrations(db as any);
  });
  afterEach(() => raw.close());

  const response = (body: unknown, ok = true) => Promise.resolve({ ok, json: async () => body });

  it('fetches home-based rates once per day and inverts them to home per foreign unit', async () => {
    const fetchImpl = jest.fn(() => response({ date: '2026-11-22', idr: { jpy: 0.0095602, usd: 0.0000615 } }));
    const now = new Date(2026, 10, 22, 9).getTime();

    await refreshDailyRates('IDR', { now, fetchImpl });
    await refreshDailyRates('IDR', { now: now + 3600_000, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toContain('/currencies/idr.min.json');
    expect(getCachedRate('JPY', 'IDR')).toEqual({ rate: 104.6, date: '2026-11-22' });
    expect(getCachedRate('USD', 'IDR')?.rate).toBe(16260.2);

    await refreshDailyRates('IDR', { now: now + 86_400_000, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to the second source, and to the cached rates when offline', async () => {
    const now = new Date(2026, 10, 22, 9).getTime();
    const fetchImpl = jest
      .fn()
      .mockImplementationOnce(() => response({}, false))
      .mockImplementationOnce(() => response({ date: '2026-11-22', idr: { jpy: 0.01 } }));
    await refreshDailyRates('IDR', { now, fetchImpl });
    expect(getCachedRate('JPY', 'IDR')?.rate).toBe(100);

    const offline = jest.fn(() => Promise.reject(new Error('offline')));
    const cache = await refreshDailyRates('IDR', { now: now + 86_400_000, fetchImpl: offline });
    expect(cache?.rates.jpy).toBe(0.01);
    expect(getCachedRate('JPY', 'IDR')?.rate).toBe(100);
    expect(getCachedRate('EUR', 'IDR')).toBeNull();
  });
});
