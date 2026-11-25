/**
 * Chat benchmark dataset: three months of realistic Indonesian personal-finance records for a fictional user,
 * seeded into a real SQLite database (node:sqlite in tests) with Silo's own migrations.
 *
 * "Today" is Wednesday 2026-11-25 12:00 local time. Every number the benchmark expects is computed here in
 * plain JS from the seed list (never through agent.ts SQL), so the retrieval layer is checked independently.
 */

export const BENCH_NOW = new Date(2026, 10, 25, 12, 0, 0, 0);

export interface SeedWallet {
  id: number;
  name: string;
  type: string;
  initial: number;
}

export interface SeedTx {
  id: number;
  wallet: number;
  toWallet?: number;
  merchant: string;
  /** Signed home-currency amount: negative for expenses and transfers out, positive for income. */
  amount: number;
  type: 'expense' | 'income' | 'transfer';
  date: number;
  category: string;
  note?: string;
  items?: string;
}

export interface SeedBudget {
  name: string;
  amount: number;
  categories: string[];
}

export const BENCH_WALLETS: SeedWallet[] = [
  { id: 1, name: 'Main Wallet', type: 'cash', initial: 300_000 },
  { id: 2, name: 'Bank BCA', type: 'bank', initial: 6_000_000 },
  { id: 3, name: 'GoPay', type: 'ewallet', initial: 150_000 },
];

export const BENCH_BUDGETS: SeedBudget[] = [
  { name: 'Food & Dining', amount: 2_500_000, categories: ['Food & Dining'] },
  { name: 'Transport', amount: 600_000, categories: ['Transport'] },
  { name: 'Shopping', amount: 1_000_000, categories: ['Shopping'] },
];

const at = (month1: number, day: number, hour = 12, minute = 0) =>
  new Date(2026, month1 - 1, day, hour, minute, 0, 0).getTime();

/** Small deterministic PRNG so amounts look organic but never change between runs. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const roundTo = (value: number, step: number) => Math.round(value / step) * step;

function buildTransactions(): SeedTx[] {
  const txs: Omit<SeedTx, 'id'>[] = [];
  const rand = mulberry32(20261125);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const between = (lo: number, hi: number, step = 500) => roundTo(lo + rand() * (hi - lo), step);

  const months: Array<{ m: number; lastDay: number }> = [
    { m: 9, lastDay: 30 },
    { m: 10, lastDay: 31 },
    { m: 11, lastDay: 25 },
  ];

  const lunchSpots = ['Warteg Bahari', 'Solaria', 'Bakmi GM', 'Sate Khas Senayan', 'Nasi Padang Sederhana'] as const;
  const coffeeSpots = ['Kopi Kenangan', 'Starbucks', 'Fore Coffee'] as const;

  for (const { m, lastDay } of months) {
    // Fixed monthly flows.
    txs.push({ wallet: 2, merchant: 'PT Nusantara Digital', amount: 12_500_000, type: 'income', date: at(m, 1, 9), category: 'Salary', note: 'Monthly payroll' });
    txs.push({ wallet: 2, toWallet: 3, merchant: 'Top up GoPay', amount: -1_500_000, type: 'transfer', date: at(m, 2, 8), category: 'Transfer' });
    txs.push({ wallet: 2, merchant: 'Kos Melati', amount: -3_200_000, type: 'expense', date: at(m, 3, 10), category: 'Bills', note: 'Monthly rent' });
    txs.push({ wallet: 2, merchant: 'PLN Listrik', amount: -between(340_000, 420_000, 1000), type: 'expense', date: at(m, 5, 19), category: 'Bills', note: 'Electricity token' });
    txs.push({ wallet: 2, merchant: 'IndiHome', amount: -350_000, type: 'expense', date: at(m, 6, 9), category: 'Bills', note: 'Internet' });
    txs.push({ wallet: 2, merchant: 'Netflix', amount: -186_000, type: 'expense', date: at(m, 10, 21), category: 'Entertainment', note: 'Subscription' });
    if (lastDay >= 15) {
      txs.push({ wallet: 2, toWallet: 1, merchant: 'ATM withdrawal', amount: -1_500_000, type: 'transfer', date: at(m, 15, 17), category: 'Transfer' });
    }

    // Weekly groceries.
    for (const day of [4, 11, 18, 25]) {
      if (day > lastDay) continue;
      txs.push({
        wallet: 2,
        merchant: day === 18 ? 'Indomaret' : 'Superindo',
        amount: -between(260_000, 520_000),
        type: 'expense',
        date: at(m, day, 18, 30),
        category: 'Groceries',
        items: 'Beras 5kg, Telur 1kg, Minyak goreng, Sayur',
      });
    }

    // Weekday lunches (cash) and coffee (GoPay).
    for (let day = 1; day <= lastDay; day += 1) {
      const weekday = new Date(2026, m - 1, day).getDay();
      if (weekday === 0 || weekday === 6) continue;
      if (day === 25 && m === 11) continue; // "today" so far has only the coffee below
      if (rand() < 0.75) {
        txs.push({ wallet: 1, merchant: pick(lunchSpots), amount: -between(25_000, 85_000), type: 'expense', date: at(m, day, 12, 15), category: 'Food & Dining' });
      }
      if (rand() < 0.35) {
        txs.push({ wallet: 3, merchant: pick(coffeeSpots), amount: -between(28_000, 62_000), type: 'expense', date: at(m, day, 9, 20), category: 'Food & Dining' });
      }
    }

    // Weekend dinners out and GoFood.
    for (let day = 1; day <= lastDay; day += 1) {
      const weekday = new Date(2026, m - 1, day).getDay();
      if (weekday !== 6) continue;
      txs.push({ wallet: 3, merchant: 'GoFood', amount: -between(95_000, 210_000), type: 'expense', date: at(m, day, 19, 45), category: 'Food & Dining' });
    }

    // Transport: Gojek rides and fuel.
    for (let day = 2; day <= lastDay; day += 3) {
      txs.push({ wallet: 3, merchant: rand() < 0.6 ? 'Gojek' : 'Grab', amount: -between(18_000, 55_000), type: 'expense', date: at(m, day, 8, 10), category: 'Transport' });
    }
    for (const day of [7, 21]) {
      if (day > lastDay) continue;
      txs.push({ wallet: 1, merchant: 'Pertamina', amount: -between(150_000, 200_000, 1000), type: 'expense', date: at(m, day, 7, 40), category: 'Transport', note: 'Pertalite' });
    }

    // Monthly shopping.
    txs.push({ wallet: 2, merchant: 'Tokopedia', amount: -between(180_000, 450_000), type: 'expense', date: at(m, 12, 22), category: 'Shopping', items: 'Kabel USB-C, Casing HP' });
  }

  // One-off events that make the questions interesting.
  txs.push({ wallet: 2, merchant: 'RS Siloam', amount: -1_250_000, type: 'expense', date: at(9, 17, 14), category: 'Health', note: 'Dental check-up' });
  txs.push({ wallet: 2, merchant: 'Uniqlo', amount: -649_000, type: 'expense', date: at(9, 27, 16), category: 'Shopping', items: 'Kemeja Oxford, Kaos AIRism' });
  txs.push({ wallet: 2, merchant: 'Traveloka', amount: -2_450_000, type: 'expense', date: at(10, 9, 20), category: 'Travel', note: 'Flight to Bali' });
  txs.push({ wallet: 2, merchant: 'Bumi Aki Heritage', amount: -1_380_000, type: 'expense', date: at(10, 18, 15), category: 'Travel', note: 'Hotel in Ubud, 2 nights' });
  txs.push({ wallet: 2, merchant: 'Kimia Farma', amount: -187_500, type: 'expense', date: at(10, 22, 18), category: 'Health', items: 'Paracetamol, Vitamin C' });
  txs.push({ wallet: 2, merchant: 'Kopi Senja Studio', amount: 2_750_000, type: 'income', date: at(11, 14, 10), category: 'Freelance', note: 'Logo design project' });
  txs.push({ wallet: 2, merchant: 'Erafone', amount: -4_899_000, type: 'expense', date: at(11, 20, 13), category: 'Shopping', items: 'Samsung Galaxy A55 1x 4.899.000', note: 'New phone' });
  txs.push({ wallet: 3, merchant: 'CGV Grand Indonesia', amount: -120_000, type: 'expense', date: at(11, 22, 19), category: 'Entertainment', note: 'Movie with Rina' });
  txs.push({ wallet: 2, merchant: 'Gramedia', amount: -265_000, type: 'expense', date: at(11, 23, 15), category: 'Education', items: 'Atomic Habits, Buku catatan' });
  txs.push({ wallet: 3, merchant: 'Kopi Kenangan', amount: -38_000, type: 'expense', date: at(11, 25, 8, 50), category: 'Food & Dining' });

  return txs
    .filter((tx) => tx.date <= BENCH_NOW.getTime()) // nothing after "now" (today's evening groceries)
    .sort((a, b) => a.date - b.date)
    .map((tx, idx) => ({ ...tx, id: idx + 1 }));
}

export const BENCH_TRANSACTIONS: SeedTx[] = buildTransactions();

// ---------------------------------------------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------------------------------------------

export interface BenchSeedDb {
  runSync: (sql: string, params?: any[]) => unknown;
}

export function seedBenchDb(db: BenchSeedDb) {
  db.runSync('DELETE FROM wallets;');
  for (const w of BENCH_WALLETS) {
    db.runSync('INSERT INTO wallets (id, name, type, is_active, initial_balance) VALUES (?, ?, ?, 1, ?);', [w.id, w.name, w.type, w.initial]);
  }
  const budgetStart = new Date(2026, 0, 1).getTime();
  for (const b of BENCH_BUDGETS) {
    db.runSync(
      "INSERT INTO budget_plans (name, amount, kind, start_date, every, unit, rollover, categories, created_at) VALUES (?, ?, 'recurring', ?, 1, 'month', 'reset', ?, 1);",
      [b.name, b.amount, budgetStart, JSON.stringify(b.categories)],
    );
  }
  for (const tx of BENCH_TRANSACTIONS) {
    db.runSync(
      `INSERT INTO transactions (id, wallet_id, to_wallet_id, merchant_name, total_amount, type, date, note, line_items_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [tx.id, tx.wallet, tx.toWallet ?? null, tx.merchant, tx.amount, tx.type, tx.date, tx.note ?? '', tx.items ?? ''],
    );
    db.runSync('INSERT INTO transaction_items (transaction_id, category, amount) VALUES (?, ?, ?);', [tx.id, tx.category, Math.abs(tx.amount)]);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Ground truth (plain JS over the seed list)
// ---------------------------------------------------------------------------------------------------------------

export interface Range {
  from: number;
  to: number;
}

export const RANGES = {
  thisMonth: { from: at(11, 1, 0), to: at(12, 1, 0) },
  lastMonth: { from: at(10, 1, 0), to: at(11, 1, 0) },
  september: { from: at(9, 1, 0), to: at(10, 1, 0) },
  /** Mon 2026-11-23 .. Mon 2026-11-30 */
  thisWeek: { from: at(11, 23, 0), to: at(11, 30, 0) },
  today: { from: at(11, 25, 0), to: at(11, 26, 0) },
  all: { from: 0, to: Number.MAX_SAFE_INTEGER },
} satisfies Record<string, Range>;

const inRange = (tx: SeedTx, r: Range) => tx.date >= r.from && tx.date < r.to;
const expensesIn = (r: Range) => BENCH_TRANSACTIONS.filter((t) => t.type === 'expense' && inRange(t, r));

export function spent(r: Range, filter?: (tx: SeedTx) => boolean): number {
  return expensesIn(r)
    .filter((t) => (filter ? filter(t) : true))
    .reduce((s, t) => s - t.amount, 0);
}

export function income(r: Range): number {
  return BENCH_TRANSACTIONS.filter((t) => t.type === 'income' && inRange(t, r)).reduce((s, t) => s + t.amount, 0);
}

export function count(r: Range, filter?: (tx: SeedTx) => boolean): number {
  return expensesIn(r).filter((t) => (filter ? filter(t) : true)).length;
}

export function categoryTotals(r: Range): Array<{ category: string; total: number }> {
  const map = new Map<string, number>();
  for (const t of expensesIn(r)) map.set(t.category, (map.get(t.category) ?? 0) - t.amount);
  return Array.from(map, ([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
}

export function merchantTotals(r: Range): Array<{ merchant: string; total: number; count: number }> {
  const map = new Map<string, { total: number; count: number }>();
  for (const t of expensesIn(r)) {
    const cur = map.get(t.merchant) ?? { total: 0, count: 0 };
    map.set(t.merchant, { total: cur.total - t.amount, count: cur.count + 1 });
  }
  return Array.from(map, ([merchant, v]) => ({ merchant, ...v })).sort((a, b) => b.total - a.total);
}

export function biggestExpense(r: Range): SeedTx {
  return expensesIn(r).sort((a, b) => a.amount - b.amount)[0];
}

export function walletBalances(): Array<{ name: string; balance: number }> {
  return BENCH_WALLETS.map((w) => {
    let balance = w.initial;
    for (const t of BENCH_TRANSACTIONS) {
      if (t.wallet === w.id) balance += t.amount;
      if (t.type === 'transfer' && t.toWallet === w.id) balance -= t.amount;
    }
    return { name: w.name, balance };
  });
}

export function totalBalance(): number {
  return walletBalances().reduce((s, w) => s + w.balance, 0);
}

/** Indonesian display format used by Silo: 1234567 -> "1.234.567". */
export function idr(amount: number): string {
  return String(Math.round(Math.abs(amount))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
