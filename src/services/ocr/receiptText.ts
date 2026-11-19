import { parseSignedAmount } from '../../features/transactions/amount';

export interface OcrLine {
  text: string;
  frame?: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

interface FramedLine {
  text: string;
  xMin: number;
  yMin: number;
  yMax: number;
  yMid: number;
  height: number;
}

interface RowCluster {
  items: FramedLine[];
  yMin: number;
  yMax: number;
  yMid: number;
  avgHeight: number;
}

const DATE_SLASH_OR_DASH_REGEX = /\b\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b/g;
const DATE_DOT_DMY_REGEX = /\b(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])\.(?:19|20)\d{2}\b/g;
const DATE_DOT_YMD_REGEX = /\b(?:19|20)\d{2}\.(?:0?[1-9]|1[0-2])\.(?:0?[1-9]|[12]\d|3[01])\b/g;
const TIME_REGEX = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
const AMOUNT_TOKEN_REGEX = /(?<![A-Za-z0-9])(?:(?:Rp|IDR|@)\s*\.?\s*)?(\d+(?:[.,]\d+)*)(?![A-Za-z0-9])/gi;

// `TL` is the total line on Casio/Sharp cash registers (e.g. "TL  139,000"); only at row start.
const TOTAL_CANDIDATE_REGEX = /\b(grand\s*total|total\s*belanja|total\s*bayar|total|jumlah|tagihan|amount|netto)\b|^\s*tl\b/i;
const TOTAL_PREFERRED_REGEX = /\b(grand\s*total|total\s*belanja|total\s*bayar)\b/i;
const TOTAL_EXCLUDE_REGEX =
  /\b(sub\s*total|subtotal|sub-total|sub_total|subttl|total\s*items?|total\s*qty|total\s*disc\.?|diskon|discount|kembali|kembalian|change|tunai|cash|ppn|tax|dpp|service)\b/i;

function hasValidFrame(frame: OcrLine['frame']): frame is NonNullable<OcrLine['frame']> {
  return (
    Boolean(frame) &&
    Number.isFinite(frame!.left) &&
    Number.isFinite(frame!.top) &&
    Number.isFinite(frame!.width) &&
    Number.isFinite(frame!.height) &&
    frame!.height > 0
  );
}

/**
 * Groups OCR lines into visual rows using vertical overlap (>= 50% of the smaller height),
 * ordered top-to-bottom, with items inside each row ordered left-to-right and joined by two spaces.
 * Lines without valid frames keep their input order.
 */
export function buildReceiptRows(lines: OcrLine[]): string[] {
  const framed: FramedLine[] = [];
  const unframed: string[] = [];

  for (const line of lines) {
    const text = (line?.text ?? '').trim();
    if (!text) continue;

    if (hasValidFrame(line.frame)) {
      const { left, top, height } = line.frame;
      framed.push({
        text,
        xMin: left,
        yMin: top,
        yMax: top + height,
        yMid: top + height / 2,
        height,
      });
    } else {
      unframed.push(text);
    }
  }

  if (framed.length === 0) {
    return unframed;
  }

  framed.sort((a, b) => a.yMid - b.yMid || a.xMin - b.xMin);

  const clusters: RowCluster[] = [];
  for (const item of framed) {
    let bestCluster: RowCluster | null = null;
    let bestScore = -1;

    for (const cluster of clusters) {
      const overlap = Math.min(item.yMax, cluster.yMax) - Math.max(item.yMin, cluster.yMin);
      const smallerHeight = Math.min(item.height, cluster.avgHeight);
      const overlapRatio = smallerHeight > 0 ? overlap / smallerHeight : 0;

      if (overlapRatio >= 0.5) {
        const score = overlapRatio - 0.001 * Math.abs(item.yMid - cluster.yMid);
        if (score > bestScore) {
          bestScore = score;
          bestCluster = cluster;
        }
      }
    }

    if (!bestCluster) {
      clusters.push({
        items: [item],
        yMin: item.yMin,
        yMax: item.yMax,
        yMid: item.yMid,
        avgHeight: item.height,
      });
    } else {
      bestCluster.items.push(item);
      const count = bestCluster.items.length;
      bestCluster.yMin = bestCluster.items.reduce((sum, x) => sum + x.yMin, 0) / count;
      bestCluster.yMax = bestCluster.items.reduce((sum, x) => sum + x.yMax, 0) / count;
      bestCluster.yMid = bestCluster.items.reduce((sum, x) => sum + x.yMid, 0) / count;
      bestCluster.avgHeight = bestCluster.items.reduce((sum, x) => sum + x.height, 0) / count;
    }
  }

  clusters.sort((a, b) => a.yMid - b.yMid);

  const rowStrings = clusters.map((cluster) => {
    cluster.items.sort((a, b) => a.xMin - b.xMin);
    return cluster.items.map((item) => item.text).join('  ');
  });

  return unframed.length > 0 ? [...rowStrings, ...unframed] : rowStrings;
}

/**
 * Extracts all money-like numbers from text as integer Rupiah amounts.
 */
export function extractAmounts(text: string): number[] {
  if (!text) return [];

  const sanitized = text
    .replace(DATE_SLASH_OR_DASH_REGEX, ' ')
    .replace(DATE_DOT_DMY_REGEX, ' ')
    .replace(DATE_DOT_YMD_REGEX, ' ')
    .replace(TIME_REGEX, ' ');

  const amounts: number[] = [];
  AMOUNT_TOKEN_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = AMOUNT_TOKEN_REGEX.exec(sanitized)) !== null) {
    const token = match[1];
    if (!token || /^0\d/.test(token)) {
      continue;
    }
    const parsed = Math.round(Math.abs(parseSignedAmount(token)));
    if (Number.isFinite(parsed) && parsed >= 100) {
      amounts.push(parsed);
    }
  }

  return amounts;
}

/**
 * Picks the most likely receipt total from visual rows using Indonesian/English keyword rules.
 */
export function pickTotalFromRows(rows: string[]): number | null {
  let preferredTotal: number | null = null;
  let fallbackTotal: number | null = null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !TOTAL_CANDIDATE_REGEX.test(row) || TOTAL_EXCLUDE_REGEX.test(row)) {
      continue;
    }

    const rowAmounts = extractAmounts(row);
    let candidate: number | null = rowAmounts.length > 0 ? rowAmounts[rowAmounts.length - 1] : null;

    if (candidate === null && i + 1 < rows.length) {
      const nextAmounts = extractAmounts(rows[i + 1]);
      if (nextAmounts.length > 0) {
        candidate = nextAmounts[0];
      }
    }

    if (candidate === null) {
      continue;
    }

    if (TOTAL_PREFERRED_REGEX.test(row)) {
      preferredTotal = candidate;
    } else {
      fallbackTotal = candidate;
    }
  }

  if (preferredTotal !== null || fallbackTotal !== null) {
    return preferredTotal ?? fallbackTotal;
  }

  // Tickets/slips often have no TOTAL row, just one "Rp 10.000" price.
  const rupiahAmounts = new Set(rows.filter((row) => /\b(rp|idr)\b/i.test(row)).flatMap(extractAmounts));
  return rupiahAmounts.size === 1 ? [...rupiahAmounts][0] : null;
}

/**
 * Checks whether a candidate total exists among the amounts extracted from the OCR rows.
 */
export function isGrounded(total: number, rows: string[]): boolean {
  if (!Number.isFinite(total) || total <= 0) {
    return false;
  }
  return extractAmounts(rows.join('\n')).includes(Math.round(total));
}
