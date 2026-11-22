import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../../../db/index';
import { computeBudgetStatus, periodBounds, periodIndexAt, type BudgetPlan } from '../engine';

function wrap(raw: DatabaseSync) {
  return {
    execSync: (sql: string) => raw.exec(sql),
    getAllSync: (sql: string, params: any[] = []) => raw.prepare(sql).all(...params) as any[],
    getFirstSync: (sql: string, params: any[] = []) => raw.prepare(sql).get(...params) ?? null,
    runSync: (sql: string, params: any[] = []) => {
      const r = raw.prepare(sql).run(...params);
      return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    withTransactionSync: (cb: () => void) => cb(),
  };
}

const day = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const midnight = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();
const basePlan = (over: Partial<BudgetPlan>): BudgetPlan => ({
  id: 1, name: 'Food', amount: 1_000_000, currency: null, kind: 'recurring', startDate: midnight(2026, 9, 25), endDate: null,
  every: 1, unit: 'month', rollover: 'reset', carryOverspend: false, categories: [], walletIds: [], tags: [], archived: false,
  ...over,
});

describe('budget engine', () => {
  let raw: DatabaseSync;
  let db: ReturnType<typeof wrap>;
  const spend = (date: number, amount: number, cols: Record<string, unknown> = {}, category = 'Food & Dining', tags: string[] = []) => {
    const extra = Object.keys(cols);
    const { lastInsertRowId: id } = db.runSync(
      `INSERT INTO transactions (wallet_id, merchant_name, type, date, total_amount${extra.map((k) => `, ${k}`).join('')})
       VALUES (?, 'x', 'expense', ?, ?${extra.map(() => ', ?').join('')});`,
      [cols.wallet_id ?? 1, date, -amount, ...Object.values(cols)] as any[],
    );
    db.runSync('INSERT INTO transaction_items (transaction_id, category, amount) VALUES (?, ?, ?);', [id, category, amount]);
    for (const tag of tags) {
      db.runSync('INSERT OR IGNORE INTO tags (name, created_at) VALUES (?, 1);', [tag]);
      const t = db.getFirstSync('SELECT id FROM tags WHERE name = ?;', [tag]) as { id: number };
      db.runSync('INSERT INTO transaction_tags VALUES (?, ?);', [id, t.id]);
    }
  };

  beforeEach(() => {
    raw = new DatabaseSync(':memory:');
    db = wrap(raw);
    runMigrations(db as any);
  });
  afterEach(() => raw.close());

  it('anchors monthly periods on the start day, clamping short months', () => {
    const plan = basePlan({ startDate: midnight(2026, 1, 31) });
    expect(new Date(periodBounds(plan, 1).start).getDate()).toBe(28); // Feb 28
    expect(new Date(periodBounds(plan, 2).start).getDate()).toBe(31); // Mar 31
    expect(periodIndexAt(plan, day(2026, 3, 30))).toBe(1);
    expect(periodIndexAt(basePlan({ every: 2, unit: 'week', startDate: midnight(2026, 11, 2) }), day(2026, 11, 20))).toBe(1);
  });

  it('resets each period by default and filters by category', () => {
    spend(day(2026, 10, 30), 400_000);
    spend(day(2026, 11, 26), 300_000);
    spend(day(2026, 11, 27), 999_000, {}, 'Transport');
    const status = computeBudgetStatus(db, basePlan({ categories: ['Food & Dining'] }), 'IDR', day(2026, 11, 28), () => null);
    expect(status).toMatchObject({ spent: 300_000, carried: 0, available: 1_000_000, remaining: 700_000, periodIndex: 2 });
    expect(new Date(status.periodStart).getDate()).toBe(25);
  });

  it('carries leftovers, and overspending only when the budget says so', () => {
    spend(day(2026, 9, 30), 600_000); // period 0: 400k left
    spend(day(2026, 10, 30), 1_500_000); // period 1: over
    const now = day(2026, 11, 26);
    const leftoverOnly = computeBudgetStatus(db, basePlan({ rollover: 'carry' }), 'IDR', now, () => null);
    expect(leftoverOnly).toMatchObject({ carried: 0, available: 1_000_000 }); // 400k carried into p1, p1 overspent -> 0
    const withOverspend = computeBudgetStatus(db, basePlan({ rollover: 'carry', carryOverspend: true }), 'IDR', now, () => null);
    expect(withOverspend).toMatchObject({ carried: -100_000, available: 900_000 }); // 1.4m available in p1, spent 1.5m
  });

  it('runs a one-off yen holiday budget from a yen account, tags and the daily rate', () => {
    const trip = basePlan({
      kind: 'once', name: 'Japan', amount: 150_000, currency: 'JPY',
      startDate: midnight(2026, 12, 1), endDate: midnight(2026, 12, 10), tags: ['japan 2026'],
    });
    spend(day(2026, 12, 2), 336_000, { original_amount: -3_200, original_currency: 'JPY', fx_rate: 105 }, 'Food & Dining', ['Japan 2026']);
    spend(day(2026, 12, 3), 1_046_000, {}, 'Transport', ['Japan 2026']); // card in rupiah: converted at 104.6
    spend(day(2026, 12, 3), 50_000, {}, 'Food & Dining'); // not tagged
    const status = computeBudgetStatus(db, trip, 'IDR', day(2026, 12, 4), (c) => (c === 'JPY' ? 104.6 : null));
    expect(status).toMatchObject({ currency: 'JPY', spent: 13_200, remaining: 136_800, daysLeft: 7, perDayLeft: 19_543, ended: false });
    expect(computeBudgetStatus(db, trip, 'IDR', day(2026, 12, 4), () => null)).toMatchObject({ spent: 3_200, unconvertedHome: 1_046_000 });
    expect(computeBudgetStatus(db, trip, 'IDR', day(2026, 12, 20), () => 104.6)).toMatchObject({ ended: true, daysLeft: 0 });
  });

  it('migrates monthly category limits into monthly plans', () => {
    const raw2 = new DatabaseSync(':memory:');
    const db2 = wrap(raw2);
    runMigrations(db2 as any);
    db2.runSync('PRAGMA user_version = 15;');
    db2.runSync(`INSERT INTO budgets (category, limit_amount, wallet_id) VALUES ('Food & Dining', 3000000, 1), ('Bills', 0, 1);`);
    db2.runSync('DELETE FROM budget_plans;');
    runMigrations(db2 as any);
    const plans = db2.getAllSync('SELECT name, amount, unit, every, categories FROM budget_plans;');
    expect(plans).toEqual([{ name: 'Food & Dining', amount: 3000000, unit: 'month', every: 1, categories: '["Food & Dining"]' }]);
    raw2.close();
  });
});
