import React, { useState } from 'react';
import { Alert } from 'react-native';

import { SettleSplitModal } from '../../components/SettleSplitModal';
import { formatCachedLocaleDate } from '../transactions/periods';
import { useSplitsStore } from './store';
import type { CurrencyTotal, SplitEntry } from './types';

interface SettleTarget {
  personName: string;
  subtitle: string;
  totals: CurrencyTotal[];
  defaultWalletId: number | null;
  entries: SplitEntry[];
}

/**
 * Mark a person's share paid (with the optional repayment income) or reopen it. Shared by the per-expense
 * split page and All Splits so both behave the same. Render `modal` once in the screen.
 */
export function useSplitPaidToggle(locale: string) {
  const markSplitSettled = useSplitsStore((s) => s.markSplitSettled);
  const markAllForPersonSettled = useSplitsStore((s) => s.markAllForPersonSettled);
  const markSplitUnsettled = useSplitsStore((s) => s.markSplitUnsettled);
  const [target, setTarget] = useState<SettleTarget | null>(null);

  const toggle = (entry: SplitEntry) => {
    if (!entry.isSettled) {
      setTarget({
        personName: entry.personName,
        subtitle: `${entry.merchantName} · ${formatCachedLocaleDate(entry.transactionDate, locale, { day: 'numeric', month: 'short', year: 'numeric' })}`,
        totals: [{ currency: entry.currency, amount: entry.amountOwed }],
        defaultWalletId: entry.transactionWalletId,
        entries: [entry],
      });
      return;
    }
    if (entry.repaymentTransactionId != null) {
      Alert.alert(
        'Mark as unpaid?',
        `${entry.personName}'s share has a logged repayment transaction. Do you want to keep or remove that repayment?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Keep repayment', onPress: () => void markSplitUnsettled(entry.id, { deleteRepayment: false }) },
          { text: 'Delete repayment', style: 'destructive', onPress: () => void markSplitUnsettled(entry.id, { deleteRepayment: true }) },
        ]
      );
      return;
    }
    Alert.alert('Mark as unpaid?', `Reopen ${entry.personName}'s share on ${entry.merchantName}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Mark unpaid', onPress: () => void markSplitUnsettled(entry.id) },
    ]);
  };

  const modal = (
    <SettleSplitModal
      visible={target !== null}
      personName={target?.personName ?? ''}
      subtitle={target?.subtitle ?? ''}
      totals={target?.totals ?? []}
      defaultWalletId={target?.defaultWalletId ?? null}
      onConfirm={async (options) => {
        if (!target) return;
        if (target.entries.length === 1) await markSplitSettled(target.entries[0].id, options);
        else await markAllForPersonSettled(target.entries, options);
      }}
      onClose={() => setTarget(null)}
    />
  );

  return { toggle, modal };
}
