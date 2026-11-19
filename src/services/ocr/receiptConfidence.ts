import { isGrounded } from './receiptText';

export type ReceiptConfidence = 'high' | 'medium' | 'low';

export interface ReceiptConfidenceAssessment {
  level: ReceiptConfidence;
  /** User-facing reasons, most important first. Empty for 'high'. */
  reasons: string[];
}

export interface ReceiptConfidenceInput {
  total: number | null | undefined;
  /** OCR visual rows (receiptText.buildReceiptRows). */
  rows: string[];
  /**
   * A total found independently of `total` (the OCR TOTAL-line pick when `total` came from the vision model).
   * Pass null when `total` already is that pick, so it is not counted as its own confirmation.
   */
  independentTotal: number | null;
  itemPrices: number[];
}

// Fewer OCR rows than this means the photo was mostly unreadable (blur, darkness, cropping).
const MIN_READABLE_ROWS = 4;
// Totals vs. item sums: discounts pull the total down, tax/service (PB1 10%, service 5-10%) push it up.
const ITEM_SUM_MIN_RATIO = 0.8;
const ITEM_SUM_MAX_RATIO = 1.3;

/**
 * Rates how far a scanned total can be trusted, from checks that need no extra model call.
 * Calibrated on bench/ (Qwen3.5-0.8B vision): totals found in the OCR text were right 42/43 times,
 * totals not found were right 6/10 times; 'high' was right 37/38 times.
 */
export function assessReceiptConfidence({
  total,
  rows,
  independentTotal,
  itemPrices,
}: ReceiptConfidenceInput): ReceiptConfidenceAssessment {
  const reasons: string[] = [];
  const unreadable = rows.length < MIN_READABLE_ROWS;
  if (unreadable) {
    reasons.push('Very little text could be read. The photo may be blurry, dark, or cropped.');
  }

  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) {
    return { level: 'low', reasons: ['No total was found.', ...reasons] };
  }

  if (!isGrounded(total, rows)) {
    return { level: 'low', reasons: ["This total doesn't appear in the text read from the photo.", ...reasons] };
  }

  if (unreadable) {
    return { level: 'low', reasons };
  }

  const itemSum = itemPrices.reduce((sum, price) => (Number.isFinite(price) && price > 0 ? sum + price : sum), 0);
  const itemsAgree = itemSum > 0 && total / itemSum >= ITEM_SUM_MIN_RATIO && total / itemSum <= ITEM_SUM_MAX_RATIO;
  const totalsAgree = independentTotal !== null && independentTotal === total;

  if (itemsAgree || totalsAgree) {
    return { level: 'high', reasons: [] };
  }

  return {
    level: 'medium',
    reasons: ["The total couldn't be cross-checked against the items or the receipt's TOTAL line."],
  };
}
