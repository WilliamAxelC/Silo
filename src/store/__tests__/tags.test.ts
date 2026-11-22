import { DatabaseSync } from 'node:sqlite';

function wrap(raw: DatabaseSync) {
  return {
    execSync: (sql: string) => raw.exec(sql),
    getAllSync: (sql: string, params: any[] = []) => raw.prepare(sql).all(...params),
    getFirstSync: (sql: string, params: any[] = []) => raw.prepare(sql).get(...params) ?? null,
    runSync: (sql: string, params: any[] = []) => {
      const r = raw.prepare(sql).run(...params);
      return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    withTransactionSync: (cb: () => void) => cb(),
  };
}

jest.mock('../../db/index', () => {
  const actual = jest.requireActual('../../db/index');
  return Object.defineProperty({ ...actual, __esModule: true }, 'expoDb', {
    get: () => (globalThis as any).__siloTestDb,
    enumerable: true,
  });
});

import { runMigrations, searchTransactions, summarizeSearchTransactions } from '../../db/index';
import { useTransactionStore } from '../useTransactionStore';
import { normalizeTagNames } from '../../features/transactions/factories';

describe('tags', () => {
  let raw: DatabaseSync;
  let db: ReturnType<typeof wrap>;
  const insertTx = (name: string, amount: number, tags: string[]) => {
    const { lastInsertRowId: id } = db.runSync(
      `INSERT INTO transactions (wallet_id, merchant_name, total_amount, type, date) VALUES (1, ?, ?, 'expense', ?);`,
      [name, amount, Date.now()],
    );
    db.runSync(`INSERT INTO transaction_items (transaction_id, category, amount) VALUES (?, 'Food & Dining', ?);`, [id, -amount]);
    for (const tag of tags) {
      db.runSync('INSERT OR IGNORE INTO tags (name, created_at) VALUES (?, 1);', [tag]);
      const row = db.getFirstSync('SELECT id FROM tags WHERE name = ? COLLATE NOCASE;', [tag]) as { id: number };
      db.runSync('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?);', [id, row.id]);
    }
    return id;
  };

  beforeEach(() => {
    raw = new DatabaseSync(':memory:');
    db = wrap(raw);
    (globalThis as any).__siloTestDb = db;
    runMigrations(db as any);
    useTransactionStore.setState({ transactionsList: [], tags: [] } as any);
  });
  afterEach(() => raw.close());

  it('normalizes tag names: strips #, trims, dedupes case-insensitively', () => {
    expect(normalizeTagNames(['#date', ' Date ', 'Japan  2026', '', '##work'])).toEqual(['date', 'Japan 2026', 'work']);
  });

  it('lists tags on transactions, counts usage, and filters search and totals by tag', async () => {
    insertTx('Sushi dinner', -450_000, ['date', 'Japan 2026']);
    insertTx('Cinema', -120_000, ['Date']);
    insertTx('Groceries', -300_000, []);
    await useTransactionStore.getState().fetchTransactions();

    const { tags, transactionsList } = useTransactionStore.getState();
    expect(tags.map((t) => [t.name, t.usage])).toEqual([['date', 2], ['Japan 2026', 1]]);
    expect(transactionsList.find((t) => t.merchantName === 'Sushi dinner')?.tags).toEqual(['date', 'Japan 2026']);
    expect(transactionsList.find((t) => t.merchantName === 'Groceries')?.tags).toEqual([]);

    const dates = searchTransactions('', { tag: 'DATE' }, db as any);
    expect(dates.map((t) => t.merchantName).sort()).toEqual(['Cinema', 'Sushi dinner']);
    expect(summarizeSearchTransactions('', { tag: 'date' }, db as any).totalOut).toBe(570_000);
    expect(searchTransactions('sushi', { tag: 'date' }, db as any).map((t) => t.merchantName)).toEqual(['Sushi dinner']);
  });

  it('renames (merging into an existing tag) and deletes tags', async () => {
    insertTx('Sushi dinner', -450_000, ['date', 'romance']);
    insertTx('Flowers', -80_000, ['romance']);
    await useTransactionStore.getState().fetchTransactions();
    const id = (name: string) => useTransactionStore.getState().tags.find((t) => t.name === name)!.id;

    useTransactionStore.getState().renameTag(id('romance'), 'Date');
    expect(useTransactionStore.getState().tags.map((t) => [t.name, t.usage])).toEqual([['date', 2]]);

    useTransactionStore.getState().deleteTag(id('date'));
    expect(useTransactionStore.getState().tags).toEqual([]);
    expect(useTransactionStore.getState().transactionsList.every((t) => (t.tags ?? []).length === 0)).toBe(true);
  });
});
