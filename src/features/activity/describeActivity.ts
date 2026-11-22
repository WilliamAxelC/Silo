import { formatDisplayCurrency } from '../transactions/amount';
import type { ActivityEntry } from './activityLog';

export interface ActivityContext {
  homeCurrency: string;
  useThousands: boolean;
  dateLocale: string;
  walletName: (id: number | null | undefined) => string | undefined;
}

export interface ActivityDescription {
  title: string;
  detail: string;
  icon: 'add-circle-outline' | 'create-outline' | 'trash-outline' | 'archive-outline';
}

type Snapshot = Record<string, any>;

const SOURCE_LABEL: Record<string, string> = {
  receipt: 'from Receipt Inbox',
  scan: 'scanned receipt',
  recurring: 'repeat',
  template: 'from template',
};

function amountOf(tx: Snapshot, ctx: ActivityContext): string {
  const foreign = tx.originalCurrency && tx.originalCurrency !== ctx.homeCurrency && tx.originalAmount != null;
  const value = foreign ? tx.originalAmount : tx.totalAmount;
  return formatDisplayCurrency(Math.abs(Number(value) || 0), foreign ? tx.originalCurrency : ctx.homeCurrency, ctx.useThousands);
}

function dayOf(time: unknown, ctx: ActivityContext): string {
  const n = Number(time);
  if (!Number.isFinite(n)) return '';
  return new Date(n).toLocaleDateString(ctx.dateLocale, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** What changed between two transaction snapshots, in words ("Date 22 Nov 2025 → 22 Nov 2026"). */
function transactionChanges(before: Snapshot, after: Snapshot, ctx: ActivityContext): string[] {
  const changes: string[] = [];
  if ((before.merchantName ?? '') !== (after.merchantName ?? '')) changes.push(`Title "${before.merchantName}" → "${after.merchantName}"`);
  if (amountOf(before, ctx) !== amountOf(after, ctx)) changes.push(`Amount ${amountOf(before, ctx)} → ${amountOf(after, ctx)}`);
  if (dayOf(before.date, ctx) !== dayOf(after.date, ctx)) changes.push(`Date ${dayOf(before.date, ctx)} → ${dayOf(after.date, ctx)}`);
  if ((before.category ?? '') !== (after.category ?? '') && after.type !== 'transfer') changes.push(`Category ${before.category} → ${after.category}`);
  if (before.walletId !== after.walletId) {
    changes.push(`Account ${ctx.walletName(before.walletId) ?? '?'} → ${ctx.walletName(after.walletId) ?? '?'}`);
  }
  const tagsBefore = ((before.tags as string[] | undefined) ?? []).join(', ');
  const tagsAfter = ((after.tags as string[] | undefined) ?? []).join(', ');
  if (tagsBefore !== tagsAfter) changes.push(`Tags ${tagsBefore || 'none'} → ${tagsAfter || 'none'}`);
  return changes;
}

export function describeActivity(entry: ActivityEntry, ctx: ActivityContext): ActivityDescription {
  const before = (entry.before ?? {}) as Snapshot;
  const after = (entry.after ?? {}) as Snapshot;
  const icon: ActivityDescription['icon'] =
    entry.action === 'create' ? 'add-circle-outline' : entry.action === 'delete' ? 'trash-outline' : 'create-outline';

  if (entry.entity === 'transaction') {
    const tx = entry.action === 'delete' ? before : after;
    const name = tx.merchantName || 'Transaction';
    const source = entry.source ? SOURCE_LABEL[entry.source] : undefined;
    if (entry.action === 'update') {
      const changes = transactionChanges(before, after, ctx);
      return { icon, title: `Edited ${name}`, detail: changes.length ? changes.join(' · ') : 'Details changed' };
    }
    const verb = entry.action === 'create' ? (tx.type === 'transfer' ? 'Added transfer' : 'Added') : 'Deleted';
    const detail = [amountOf(tx, ctx), `dated ${dayOf(tx.date, ctx)}`, source].filter(Boolean).join(' · ');
    return { icon, title: `${verb} ${name}`, detail };
  }

  if (entry.entity === 'budget') {
    const plan = entry.action === 'delete' ? before : after;
    const verb = entry.action === 'create' ? 'Created budget' : entry.action === 'delete' ? 'Deleted budget' : 'Edited budget';
    const amount = formatDisplayCurrency(Number(plan.amount) || 0, plan.currency ?? ctx.homeCurrency, ctx.useThousands);
    return { icon, title: `${verb} ${plan.name ?? ''}`.trim(), detail: amount };
  }

  if (entry.entity === 'account') {
    const account = entry.action === 'delete' ? before : after;
    if (entry.action === 'update' && before.isActive && after.isActive === false) {
      return { icon: 'archive-outline', title: `Archived account ${account.name}`, detail: 'Its transactions are kept' };
    }
    if (entry.action === 'update' && before.isActive === false && after.isActive) {
      return { icon, title: `Restored account ${account.name}`, detail: '' };
    }
    const verb = entry.action === 'create' ? 'Added account' : entry.action === 'delete' ? 'Removed account' : 'Edited account';
    const renamed = entry.action === 'update' && before.name !== after.name ? `Renamed from ${before.name}` : '';
    return { icon, title: `${verb} ${account.name ?? ''}`.trim(), detail: renamed || (account.currency ? account.currency : '') };
  }

  // tag
  if (entry.action === 'update') return { icon, title: `Renamed tag #${before.name}`, detail: `Now #${after.name}` };
  if (after.mergedInto) return { icon, title: `Merged tag #${before.name}`, detail: `Into #${after.mergedInto}` };
  const count = Array.isArray(before.transactionIds) ? before.transactionIds.length : 0;
  return { icon, title: `Deleted tag #${before.name}`, detail: count ? `Removed from ${count} transaction${count === 1 ? '' : 's'}` : '' };
}
