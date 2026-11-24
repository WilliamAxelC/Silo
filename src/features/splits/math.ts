import { getCurrencyDecimals, roundCurrency, splitAmount } from '../transactions/amount';
import type { SplitBreakdown, SplitItemShare } from './types';

export const SELF_PARTICIPANT_ID = '__self__';

export interface EqualSplitResult {
  shares: Record<string, number>;
  selfShare: number;
}

export interface CustomSplitResult {
  othersTotal: number;
  selfShare: number;
  assignedTotal: number;
  remaining: number;
  isBalanced: boolean;
}

export interface SplitLineItemInput {
  id: string;
  name: string;
  price: number;
}

export interface ItemizedSplitResult {
  shares: Record<string, number>;
  selfShare: number;
  breakdowns: Record<string, SplitBreakdown>;
  unassignedItemIds: string[];
  itemsSubtotal: number;
  adjustmentTotal: number;
}

function toMinorUnits(amount: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(amount * factor);
}

function fromMinorUnits(minor: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return roundCurrency(minor / factor, decimals);
}

/**
 * Distributes an integer minor-unit adjustment proportionally across `weights` using the
 * largest-remainder method so distributed minor units sum to exactly `adjustmentMinor`.
 */
function distributeMinorProportionally(
  adjustmentMinor: number,
  keys: string[],
  weights: Record<string, number>
): Record<string, number> {
  const result: Record<string, number> = {};
  if (keys.length === 0 || adjustmentMinor === 0) {
    keys.forEach((k) => {
      result[k] = 0;
    });
    return result;
  }

  const totalWeight = keys.reduce((sum, k) => sum + Math.max(0, weights[k] ?? 0), 0);
  if (totalWeight <= 0) {
    const base = Math.trunc(adjustmentMinor / keys.length);
    let rem = adjustmentMinor - base * keys.length;
    const step = rem >= 0 ? 1 : -1;
    keys.forEach((k) => {
      const extra = rem !== 0 ? step : 0;
      if (rem !== 0) rem -= step;
      result[k] = base + extra;
    });
    return result;
  }

  const sign = adjustmentMinor >= 0 ? 1 : -1;
  const absTotal = Math.abs(adjustmentMinor);
  const rows = keys.map((key, index) => {
    const exact = (absTotal * Math.max(0, weights[key] ?? 0)) / totalWeight;
    const floored = Math.floor(exact);
    return { key, index, floored, remainder: exact - floored };
  });

  let leftover = absTotal - rows.reduce((sum, r) => sum + r.floored, 0);
  const byRemainder = [...rows].sort((a, b) =>
    b.remainder !== a.remainder ? b.remainder - a.remainder : a.index - b.index
  );
  for (let i = 0; i < leftover; i += 1) {
    byRemainder[i % byRemainder.length].floored += 1;
  }

  rows.forEach((r) => {
    result[r.key] = sign * r.floored;
  });
  return result;
}

/**
 * Splits `totalAmount` equally across `participantIds` (plus self when `includeSelf` is true).
 * Any rounding remainder is distributed cleanly so all parts sum to `totalAmount`.
 */
export function computeEqualSplit(
  totalAmount: number,
  participantIds: string[],
  includeSelf: boolean,
  currency: string
): EqualSplitResult {
  const decimals = getCurrencyDecimals(currency);
  const safeTotal = roundCurrency(Math.max(0, Number.isFinite(totalAmount) ? totalAmount : 0), decimals);
  const orderedIds = includeSelf ? [...participantIds, SELF_PARTICIPANT_ID] : [...participantIds];

  if (orderedIds.length === 0) {
    return { shares: {}, selfShare: 0 };
  }

  const parts = splitAmount(safeTotal, orderedIds.length, decimals);
  const shares: Record<string, number> = {};
  let selfShare = 0;

  orderedIds.forEach((id, index) => {
    const part = parts[index] ?? 0;
    if (id === SELF_PARTICIPANT_ID) {
      selfShare = part;
    } else {
      shares[id] = part;
    }
  });

  return { shares, selfShare };
}

/**
 * Evaluates manual custom amounts entered per participant (including `SELF_PARTICIPANT_ID` when
 * `includeSelf` is true) against `totalAmount`.
 */
export function computeCustomSplit(
  totalAmount: number,
  customAmounts: Record<string, number>,
  includeSelf: boolean,
  currency: string
): CustomSplitResult {
  const decimals = getCurrencyDecimals(currency);
  const safeTotal = roundCurrency(Math.max(0, Number.isFinite(totalAmount) ? totalAmount : 0), decimals);

  let othersTotal = 0;
  let selfShare = 0;

  for (const [key, raw] of Object.entries(customAmounts)) {
    const val = roundCurrency(Math.max(0, Number.isFinite(raw) ? raw : 0), decimals);
    if (key === SELF_PARTICIPANT_ID) {
      if (includeSelf) {
        selfShare = val;
      }
    } else {
      othersTotal = roundCurrency(othersTotal + val, decimals);
    }
  }

  const assignedTotal = roundCurrency(othersTotal + (includeSelf ? selfShare : 0), decimals);
  const remaining = roundCurrency(safeTotal - assignedTotal, decimals);

  return {
    othersTotal,
    selfShare,
    assignedTotal,
    remaining,
    isBalanced: remaining === 0,
  };
}

/**
 * Splits a receipt by assigning each line item to one or more participants (sharing multi-person items
 * evenly), then proportionally prorates any tax/service fee or discount (`totalAmount - sum(items)`).
 */
export function computeItemizedSplit(
  totalAmount: number,
  items: ReadonlyArray<SplitLineItemInput>,
  itemAssignments: Record<string, string[]>,
  participantIds: string[],
  includeSelf: boolean,
  currency: string
): ItemizedSplitResult {
  const decimals = getCurrencyDecimals(currency);
  const safeTotal = roundCurrency(Math.max(0, Number.isFinite(totalAmount) ? totalAmount : 0), decimals);
  const allActiveKeys = includeSelf ? [...participantIds, SELF_PARTICIPANT_ID] : [...participantIds];
  const activeSet = new Set(allActiveKeys);

  const perKeyItems: Record<string, SplitItemShare[]> = {};
  const perKeyItemSubtotalsMinor: Record<string, number> = {};
  allActiveKeys.forEach((k) => {
    perKeyItems[k] = [];
    perKeyItemSubtotalsMinor[k] = 0;
  });

  const unassignedItemIds: string[] = [];
  let allItemsMinor = 0;
  let assignedItemsMinor = 0;

  for (const item of items) {
    const safePrice = roundCurrency(Math.max(0, Number.isFinite(item.price) ? item.price : 0), decimals);
    const priceMinor = toMinorUnits(safePrice, decimals);
    allItemsMinor += priceMinor;

    const rawAssignees = itemAssignments[item.id] ?? [];
    const seen = new Set<string>();
    const assignees = rawAssignees.filter((id) => {
      if (!activeSet.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    if (assignees.length === 0) {
      if (priceMinor > 0) {
        unassignedItemIds.push(item.id);
      }
      continue;
    }

    assignedItemsMinor += priceMinor;
    const itemParts = splitAmount(safePrice, assignees.length, decimals);
    assignees.forEach((key, idx) => {
      const partAmount = itemParts[idx] ?? 0;
      const partMinor = toMinorUnits(partAmount, decimals);
      perKeyItemSubtotalsMinor[key] = (perKeyItemSubtotalsMinor[key] ?? 0) + partMinor;
      perKeyItems[key].push({
        name: item.name.trim() || 'Item',
        fullPrice: safePrice,
        shareAmount: partAmount,
        sharedWithCount: assignees.length,
      });
    });
  }

  const totalMinor = toMinorUnits(safeTotal, decimals);
  const trueAdjustmentMinor = totalMinor - allItemsMinor;
  const activeParticipantKeys = allActiveKeys.filter((k) => (perKeyItemSubtotalsMinor[k] ?? 0) > 0);
  const prorationKeys = activeParticipantKeys.length > 0 ? activeParticipantKeys : allActiveKeys;

  // When all priced items are assigned, distribute exact (total - assignedItems) so total reconciles 100%.
  // While some items remain unassigned, preview proration of the actual tax/discount only.
  const adjustmentMinorToDistribute = unassignedItemIds.length === 0 ? totalMinor - assignedItemsMinor : trueAdjustmentMinor;
  const adjustmentByKeyMinor = distributeMinorProportionally(
    adjustmentMinorToDistribute,
    prorationKeys,
    perKeyItemSubtotalsMinor
  );

  const shares: Record<string, number> = {};
  const breakdowns: Record<string, SplitBreakdown> = {};
  let selfShare = 0;

  for (const key of allActiveKeys) {
    const itemMinor = perKeyItemSubtotalsMinor[key] ?? 0;
    const adjMinor = adjustmentByKeyMinor[key] ?? 0;
    const finalAmount = Math.max(0, fromMinorUnits(itemMinor + adjMinor, decimals));
    const adjAmount = fromMinorUnits(adjMinor, decimals);

    if (key === SELF_PARTICIPANT_ID) {
      selfShare = finalAmount;
    } else {
      shares[key] = finalAmount;
      breakdowns[key] = {
        items: perKeyItems[key],
        ...(adjMinor !== 0
          ? {
              adjustmentAmount: adjAmount,
              adjustmentLabel: trueAdjustmentMinor >= 0 ? 'Tax & fees' : 'Discount',
            }
          : {}),
        includeSelf,
        totalParticipants: allActiveKeys.length,
      };
    }
  }

  return {
    shares,
    selfShare,
    breakdowns,
    unassignedItemIds,
    itemsSubtotal: fromMinorUnits(allItemsMinor, decimals),
    adjustmentTotal: fromMinorUnits(trueAdjustmentMinor, decimals),
  };
}
