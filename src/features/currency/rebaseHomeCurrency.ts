import type { expoDb as ExpoDbType } from '../../db/index';
import { getCurrencyDecimals, roundCurrency } from '../transactions/amount';
import { roundRate } from './conversion';
import { normalizeCurrencyCode } from './currencies';

type Db = typeof ExpoDbType;

export interface RebaseSummary {
  transactions: number;
  accounts: number;
}

/**
 * Changes the home (reporting) currency without changing what any past transaction was worth.
 *
 * `rate` is units of the NEW home currency per 1 unit of the OLD one. Accounts that were in the old home
 * currency become accounts in that currency (a BCA account stays IDR), and each of their transactions keeps
 * its exact amount as original_amount / original_currency. Only the home-currency totals used for reports,
 * budgets, splits and saved templates are converted. Transactions already in the new currency drop their
 * foreign side. Runs in a single database transaction.
 */
export function rebaseHomeCurrency(db: Db, fromCurrency: string, toCurrency: string, rate: number): RebaseSummary {
  const from = normalizeCurrencyCode(fromCurrency);
  const to = normalizeCurrencyCode(toCurrency);
  if (!from || !to || from === to) throw new Error('Choose a different currency.');
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Enter a valid exchange rate.');
  const decimals = getCurrencyDecimals(to);
  // Round magnitudes so a refund and its charge convert to the same absolute amount.
  const convert = (amount: number) => Math.sign(amount) * roundCurrency(Math.abs(amount) * rate, decimals);
  const summary: RebaseSummary = { transactions: 0, accounts: 0 };

  db.withTransactionSync(() => {
    const rows = db.getAllSync<{
      id: number;
      total: number;
      original: number | null;
      originalCurrency: string | null;
      fx: number | null;
      type: string;
      toAmount: number | null;
    }>(
      `SELECT id, total_amount AS total, original_amount AS original, original_currency AS originalCurrency,
              fx_rate AS fx, type, to_amount AS toAmount
       FROM transactions;`,
    );

    for (const row of rows) {
      let next: { total: number; original: number | null; currency: string | null; fx: number | null; toAmount: number | null };
      if (!row.originalCurrency) {
        // Was a plain old-home amount: keep it exactly as the original side.
        next = {
          total: convert(row.total),
          original: row.total,
          currency: from,
          fx: roundRate(rate),
          // Home-to-home transfers derived the received amount from total_amount; pin it in the old currency.
          toAmount: row.type === 'transfer' && row.toAmount == null ? -row.total : row.toAmount,
        };
      } else if (row.originalCurrency === to) {
        // Already in the new home currency: its original amount is now the home amount.
        next = { total: row.original ?? convert(row.total), original: null, currency: null, fx: null, toAmount: row.toAmount };
      } else {
        next = {
          total: convert(row.total),
          original: row.original,
          currency: row.originalCurrency,
          fx: row.fx != null ? roundRate(row.fx * rate) : null,
          toAmount: row.toAmount,
        };
      }
      db.runSync(
        `UPDATE transactions SET total_amount = ?, original_amount = ?, original_currency = ?, fx_rate = ?, to_amount = ?
         WHERE id = ?;`,
        [next.total, next.original, next.currency, next.fx, next.toAmount, row.id],
      );
      db.runSync('UPDATE transaction_items SET amount = ? WHERE transaction_id = ?;', [Math.abs(next.total), row.id]);
      summary.transactions += 1;
    }

    const accounts = db.runSync(
      `UPDATE wallets SET currency = CASE WHEN currency IS NULL THEN ? WHEN currency = ? THEN NULL ELSE currency END;`,
      [from, to],
    );
    summary.accounts = Number(accounts.changes ?? 0);

    const budgets = db.getAllSync<{ id: number; limitAmount: number }>('SELECT id, limit_amount AS limitAmount FROM budgets;');
    for (const budget of budgets) {
      db.runSync('UPDATE budgets SET limit_amount = ? WHERE id = ?;', [convert(budget.limitAmount), budget.id]);
    }
    // General budgets keep the currency they were set in (a Rp 3.000.000 food budget stays in rupiah).
    db.runSync(
      `UPDATE budget_plans SET currency = CASE WHEN currency IS NULL THEN ? WHEN currency = ? THEN NULL ELSE currency END;`,
      [from, to],
    );
    db.runSync('UPDATE shared_splits SET currency = ? WHERE currency IS NULL;', [from]);

    // Templates and recurring rules are saved transaction inputs; rebase them the same way so new
    // occurrences keep their old-currency amount on the (now foreign) account.
    for (const table of ['transaction_templates', 'recurring_rules']) {
      const saved = db.getAllSync<{ id: number; json: string }>(`SELECT id, template_json AS json FROM ${table};`);
      for (const item of saved) {
        try {
          const template = JSON.parse(item.json) as Record<string, unknown>;
          const total = typeof template.totalAmount === 'number' ? template.totalAmount : 0;
          if (!template.originalCurrency) {
            template.originalAmount = total;
            template.originalCurrency = from;
            template.fxRate = roundRate(rate);
            if (template.type === 'transfer' && template.toAmount == null) template.toAmount = -total;
          } else if (template.originalCurrency === to) {
            template.totalAmount = template.originalAmount ?? convert(total);
            template.originalAmount = null;
            template.originalCurrency = null;
            template.fxRate = null;
            db.runSync(`UPDATE ${table} SET template_json = ? WHERE id = ?;`, [JSON.stringify(template), item.id]);
            continue;
          } else if (typeof template.fxRate === 'number') {
            template.fxRate = roundRate(template.fxRate * rate);
          }
          template.totalAmount = convert(total);
          db.runSync(`UPDATE ${table} SET template_json = ? WHERE id = ?;`, [JSON.stringify(template), item.id]);
        } catch (error) {
          console.warn(`Skipped rebasing ${table} #${item.id}:`, error);
        }
      }
    }

    db.runSync(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('currencyCode', ?);`, [to]);
  });

  return summary;
}

/** True when the app already holds data in more than one currency, so a plain relabel would be wrong. */
export function hasForeignCurrencyData(db: Db): boolean {
  const wallet = db.getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM wallets WHERE currency IS NOT NULL;');
  const tx = db.getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM transactions WHERE original_currency IS NOT NULL;');
  return (wallet?.n ?? 0) > 0 || (tx?.n ?? 0) > 0;
}
