import { DatabaseSync } from 'node:sqlite';

jest.mock('../../../db/index', () => {
  const actual = jest.requireActual('../../../db/index');
  return Object.defineProperty({ ...actual, __esModule: true }, 'expoDb', {
    get: () => (globalThis as any).__siloTestDb,
    enumerable: true,
  });
});

import { runMigrations } from '../../../db/index';
import { useTransactionStore } from '../../../store/useTransactionStore';
import { hasForeignCurrencyData, rebaseHomeCurrency } from '../rebaseHomeCurrency';

function wrap(raw: DatabaseSync) {
  return {
    execSync: (sql: string) => raw.exec(sql),
    getAllSync: (sql: string, params: any[] = []) => raw.prepare(sql).all(...params),
    getFirstSync: (sql: string, params: any[] = []) => raw.prepare(sql).get(...params) ?? null,
    runSync: (sql: string, params: any[] = []) => {
      const r = raw.prepare(sql).run(...params);
      return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    withTransactionSync: (cb: () => void) => {
      raw.exec('BEGIN;');
      try {
        cb();
        raw.exec('COMMIT;');
      } catch (e) {
        raw.exec('ROLLBACK;');
        throw e;
      }
    },
  };
}

describe('rebaseHomeCurrency', () => {
  let raw: DatabaseSync;
  let db: ReturnType<typeof wrap>;
  const insert = (cols: Record<string, unknown>) => {
    const keys = Object.keys(cols);
    const r = db.runSync(
      `INSERT INTO transactions (merchant_name, date, ${keys.join(', ')}) VALUES ('x', 1, ${keys.map(() => '?').join(', ')});`,
      Object.values(cols) as any[],
    );
    db.runSync('INSERT INTO transaction_items (transaction_id, category, amount) VALUES (?, ?, ?);', [
      r.lastInsertRowId, 'Food & Dining', Math.abs(cols.total_amount as number),
    ]);
    return r.lastInsertRowId;
  };
  const balances = () => {
    useTransactionStore.getState().fetchWallets();
    return Object.fromEntries(useTransactionStore.getState().wallets.map((w) => [w.name, [w.currency, w.balance]]));
  };

  beforeEach(() => {
    raw = new DatabaseSync(':memory:');
    db = wrap(raw);
    (globalThis as any).__siloTestDb = db;
    runMigrations(db as any);
    useTransactionStore.setState({ wallets: [] });
  });
  afterEach(() => raw.close());

  it('keeps every past amount and account balance in its real currency when switching IDR -> USD', () => {
    const { addWallet } = useTransactionStore.getState();
    const bca = addWallet({ name: 'BCA', type: 'bank', initialBalance: 1_000_000 });
    const gopay = addWallet({ name: 'GoPay', type: 'ewallet', initialBalance: 0 });
    const usd = addWallet({ name: 'USD card', type: 'card', initialBalance: 0, currency: 'USD' });
    const yen = addWallet({ name: 'Yen', type: 'cash', initialBalance: 0, currency: 'JPY' });

    const lunch = insert({ wallet_id: bca, type: 'expense', total_amount: -50_000 });
    insert({ wallet_id: bca, to_wallet_id: gopay, type: 'transfer', total_amount: -200_000 });
    insert({ wallet_id: bca, to_wallet_id: yen, type: 'transfer', total_amount: -1_000_000, to_amount: 10_000, fx_rate: 100 });
    const ramen = insert({ wallet_id: yen, type: 'expense', total_amount: -320_000, original_amount: -3_200, original_currency: 'JPY', fx_rate: 100 });
    const book = insert({ wallet_id: usd, type: 'expense', total_amount: -160_000, original_amount: -10, original_currency: 'USD', fx_rate: 16_000 });
    db.runSync(`INSERT INTO budgets (category, limit_amount, wallet_id) VALUES ('Food & Dining', 3200000, 1);`);
    db.runSync(`INSERT INTO recurring_rules (template_json, frequency, start_date, created_at) VALUES (?, 'monthly', 1, 1);`, [
      JSON.stringify({ merchantName: 'Netflix', totalAmount: -186_000, type: 'expense', walletId: bca }),
    ]);

    const before = balances();
    rebaseHomeCurrency(db as any, 'IDR', 'USD', 1 / 16_000);
    const after = balances();

    // Balances are unchanged in each account's own currency; the old home accounts are now labelled IDR.
    expect(after).toEqual({
      'Main Wallet': ['IDR', before['Main Wallet'][1]],
      BCA: ['IDR', before.BCA[1]],
      GoPay: ['IDR', before.GoPay[1]],
      'USD card': [null, -10],
      Yen: ['JPY', before.Yen[1]],
    });

    const tx = (id: number) =>
      (db as any).getFirstSync('SELECT total_amount AS total, original_amount AS original, original_currency AS cur, fx_rate AS fx FROM transactions WHERE id = ?;', [id]);
    expect(tx(lunch)).toEqual({ total: -3.13, original: -50_000, cur: 'IDR', fx: 0.0000625 });
    expect(tx(ramen)).toEqual({ total: -20, original: -3_200, cur: 'JPY', fx: 0.00625 });
    expect(tx(book)).toEqual({ total: -10, original: null, cur: null, fx: null });
    expect((db as any).getFirstSync('SELECT amount FROM transaction_items WHERE transaction_id = ?;', [lunch])?.amount).toBe(3.13);
    expect((db as any).getFirstSync('SELECT limit_amount AS l FROM budgets;')?.l).toBe(200);
    expect(JSON.parse((db as any).getFirstSync('SELECT template_json AS j FROM recurring_rules;')!.j)).toMatchObject({
      totalAmount: -11.63, originalAmount: -186_000, originalCurrency: 'IDR',
    });
    expect((db as any).getFirstSync(`SELECT value FROM app_settings WHERE key = 'currencyCode';`)?.value).toBe('USD');
  });

  it('detects when a plain relabel would be wrong', () => {
    expect(hasForeignCurrencyData(db as any)).toBe(false);
    useTransactionStore.getState().addWallet({ name: 'Yen', type: 'cash', initialBalance: 0, currency: 'JPY' });
    expect(hasForeignCurrencyData(db as any)).toBe(true);
  });
});
