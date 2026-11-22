import { roundCurrency, getCurrencyDecimals } from '../transactions/amount';

export type BudgetUnit = 'day' | 'week' | 'month' | 'year';
export type BudgetKind = 'once' | 'recurring';
export type BudgetRollover = 'reset' | 'carry';

/**
 * A budget: an amount for one date range (a holiday) or for every N days/weeks/months/years from a start
 * date. Filters combine: a budget with categories and accounts counts spending that matches both.
 */
export interface BudgetPlan {
  id: number;
  name: string;
  amount: number;
  /** ISO code; null = home currency. */
  currency: string | null;
  kind: BudgetKind;
  /** Local midnight of the first day. */
  startDate: number;
  /** Once: last day (inclusive, local midnight). Recurring: optional last day after which it stops. */
  endDate: number | null;
  every: number;
  unit: BudgetUnit;
  rollover: BudgetRollover;
  /** With rollover 'carry': also carry overspending into the next period (reducing it). */
  carryOverspend: boolean;
  categories: string[];
  walletIds: number[];
  tags: string[];
  archived: boolean;
}

export interface BudgetStatus {
  plan: BudgetPlan;
  currency: string;
  periodIndex: number;
  periodStart: number;
  /** Exclusive end of the period. */
  periodEnd: number;
  spent: number;
  /** Carried in from earlier periods (negative when overspending carries). */
  carried: number;
  available: number;
  remaining: number;
  isOver: boolean;
  /** Days left in the period including today (0 once it has ended). */
  daysLeft: number;
  /** Remaining divided by days left, when there is money left. */
  perDayLeft: number | null;
  notStarted: boolean;
  ended: boolean;
  /** Spending in another currency that could not be converted (no exchange rate yet), in home currency. */
  unconvertedHome: number;
}

export interface BudgetDb {
  getAllSync<T>(sql: string, params: (string | number)[]): T[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CARRY_PERIODS = 400;

function startOfLocalDay(time: number): number {
  const d = new Date(time);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Start of period `index`, anchored on the start date so the 31st lands on the last day of short months. */
export function periodStartAt(plan: Pick<BudgetPlan, 'startDate' | 'every' | 'unit'>, index: number): number {
  const anchor = new Date(plan.startDate);
  const steps = index * Math.max(1, Math.floor(plan.every));
  if (plan.unit === 'day' || plan.unit === 'week') {
    const days = steps * (plan.unit === 'week' ? 7 : 1);
    return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + days).getTime();
  }
  const months = steps * (plan.unit === 'year' ? 12 : 1);
  const target = new Date(anchor.getFullYear(), anchor.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(anchor.getDate(), lastDay)).getTime();
}

export function periodBounds(plan: BudgetPlan, index: number): { start: number; end: number } {
  if (plan.kind === 'once') {
    const end = plan.endDate ?? plan.startDate;
    return { start: plan.startDate, end: startOfLocalDay(end) + DAY_MS };
  }
  const start = periodStartAt(plan, index);
  let end = periodStartAt(plan, index + 1);
  if (plan.endDate != null) end = Math.min(end, startOfLocalDay(plan.endDate) + DAY_MS);
  return { start, end };
}

/** Index of the period containing `time` (0 before the start; the last period once a budget has ended). */
export function periodIndexAt(plan: BudgetPlan, time: number): number {
  if (plan.kind === 'once' || time < plan.startDate) return 0;
  const lastTime = plan.endDate != null ? Math.min(time, startOfLocalDay(plan.endDate)) : time;
  const stepMs = (plan.unit === 'day' ? 1 : plan.unit === 'week' ? 7 : plan.unit === 'month' ? 30.44 : 365.25) * DAY_MS * Math.max(1, plan.every);
  let index = Math.max(0, Math.floor((lastTime - plan.startDate) / stepMs) - 1);
  while (periodStartAt(plan, index + 1) <= lastTime) index += 1;
  while (index > 0 && periodStartAt(plan, index) > lastTime) index -= 1;
  return index;
}

function spendingRows(db: BudgetDb, plan: BudgetPlan, from: number, to: number) {
  const where = [`t.type = 'expense'`, 't.date >= ?', 't.date < ?'];
  const params: (string | number)[] = [from, to];
  if (plan.categories.length > 0) {
    where.push(`i.category IN (${plan.categories.map(() => '?').join(', ')})`);
    params.push(...plan.categories);
  }
  if (plan.walletIds.length > 0) {
    where.push(`t.wallet_id IN (${plan.walletIds.map(() => '?').join(', ')})`);
    params.push(...plan.walletIds);
  }
  if (plan.tags.length > 0) {
    where.push(
      `EXISTS (SELECT 1 FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id
               WHERE tt.transaction_id = t.id AND LOWER(tg.name) IN (${plan.tags.map(() => '?').join(', ')}))`
    );
    params.push(...plan.tags.map((t) => t.toLowerCase()));
  }
  return db.getAllSync<{ date: number; total: number; original: number | null; currency: string | null }>(
    `SELECT t.date AS date, t.total_amount AS total, t.original_amount AS original, t.original_currency AS currency
     FROM transactions t LEFT JOIN transaction_items i ON i.transaction_id = t.id
     WHERE ${where.join(' AND ')}
     ORDER BY t.date ASC;`,
    params
  );
}

/**
 * Spent / available / remaining for the period containing `now`. Spending is converted into the budget's
 * currency: exact foreign amounts when a transaction was in that currency, otherwise its home value divided
 * by `rateFor(currency)` (home units per 1 unit). With rollover 'carry' every earlier period is replayed.
 */
export function computeBudgetStatus(
  db: BudgetDb,
  plan: BudgetPlan,
  homeCurrency: string,
  now: number,
  rateFor: (currency: string) => number | null
): BudgetStatus {
  const currency = plan.currency ?? homeCurrency;
  const decimals = getCurrencyDecimals(currency);
  const current = periodIndexAt(plan, now);
  const carries = plan.kind === 'recurring' && plan.rollover === 'carry';
  const first = carries ? Math.max(0, current - MAX_CARRY_PERIODS) : current;
  const bounds = Array.from({ length: current - first + 1 }, (_, k) => periodBounds(plan, first + k));
  const spentByPeriod = bounds.map(() => 0);
  let unconvertedHome = 0;
  const rate = currency === homeCurrency ? 1 : rateFor(currency);

  for (const row of spendingRows(db, plan, bounds[0].start, bounds[bounds.length - 1].end)) {
    let k = bounds.length - 1;
    while (k > 0 && row.date < bounds[k].start) k -= 1;
    let amount: number | null;
    if (currency === homeCurrency) amount = -row.total;
    else if (row.currency === currency && row.original != null) amount = -row.original;
    else amount = rate ? -row.total / rate : null;
    if (amount == null) unconvertedHome += -row.total;
    else spentByPeriod[k] += amount;
  }

  let carried = 0;
  for (let k = 0; k < bounds.length - 1; k += 1) {
    const left = plan.amount + carried - spentByPeriod[k];
    carried = carries ? (plan.carryOverspend ? left : Math.max(0, left)) : 0;
  }
  const spent = roundCurrency(spentByPeriod[bounds.length - 1], decimals);
  const available = roundCurrency(plan.amount + carried, decimals);
  const remaining = roundCurrency(available - spent, decimals);
  const { start, end } = bounds[bounds.length - 1];
  const notStarted = now < plan.startDate;
  const ended = now >= end;
  const daysLeft = ended ? 0 : Math.max(1, Math.ceil((end - Math.max(now, start)) / DAY_MS));

  return {
    plan,
    currency,
    periodIndex: current,
    periodStart: start,
    periodEnd: end,
    spent,
    carried: roundCurrency(carried, decimals),
    available,
    remaining,
    isOver: remaining < 0,
    daysLeft,
    perDayLeft: remaining > 0 && daysLeft > 0 ? roundCurrency(remaining / daysLeft, decimals) : null,
    notStarted,
    ended,
    unconvertedHome: roundCurrency(unconvertedHome, 2),
  };
}
