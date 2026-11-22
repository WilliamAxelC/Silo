const DAY_MS = 24 * 60 * 60 * 1000;
/** Transactions older than this get a confirmation before saving. */
export const UNREALISTIC_PAST_YEARS = 2;

function describeSpan(ms: number): string {
  const days = Math.round(ms / DAY_MS);
  if (days < 60) return `${days} day${days === 1 ? '' : 's'}`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} months`;
  return `${Math.round(days / 365.25)} years`;
}

/**
 * Returns a short explanation when a transaction date is implausible (later than tomorrow, or more than
 * UNREALISTIC_PAST_YEARS ago), e.g. a receipt's 1997 tax-registration date read as 2097. Null when it looks fine.
 */
export function getUnrealisticDateWarning(date: Date, now: Date = new Date()): string | null {
  const time = date.getTime();
  if (!Number.isFinite(time)) return 'The date is not valid.';

  const endOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2).getTime() - 1;
  if (time > endOfTomorrow) {
    return `That is ${describeSpan(time - now.getTime())} in the future.`;
  }

  const earliest = new Date(now.getFullYear() - UNREALISTIC_PAST_YEARS, now.getMonth(), now.getDate()).getTime();
  if (time < earliest) {
    return `That is ${describeSpan(now.getTime() - time)} ago.`;
  }
  return null;
}
