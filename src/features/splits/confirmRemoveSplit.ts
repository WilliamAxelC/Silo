import { Alert } from 'react-native';

import type { SplitEntry } from './types';

/**
 * Asks before a bill stops being split. When repayments were logged as income, the user chooses whether
 * that income goes too (it is real money received, so it is kept unless they say otherwise).
 */
export function confirmRemoveSplit(
  merchantName: string,
  entries: ReadonlyArray<Pick<SplitEntry, 'repaymentTransactionId'>>,
  remove: (options: { deleteRepayments: boolean }) => void
): void {
  const repayments = entries.filter((e) => e.repaymentTransactionId != null).length;
  const base = `Stop splitting "${merchantName}"? The expense itself stays.`;
  if (repayments === 0) {
    Alert.alert('Remove split?', base, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => remove({ deleteRepayments: false }) },
    ]);
    return;
  }
  const what = repayments === 1 ? '1 repayment was' : `${repayments} repayments were`;
  Alert.alert('Remove split?', `${base}\n\n${what} logged as income. Delete that income too?`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Keep income', onPress: () => remove({ deleteRepayments: false }) },
    { text: 'Delete income too', style: 'destructive', onPress: () => remove({ deleteRepayments: true }) },
  ]);
}
