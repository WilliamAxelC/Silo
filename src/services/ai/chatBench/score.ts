/**
 * Scoring for the chat benchmark. Amount parsing lives here (not in the app) so the benchmark judges the
 * app's guard instead of sharing its code.
 */
import type { BenchCase, BenchTerm } from './cases';

export interface ParsedAmount {
  value: number;
  hasCurrency: boolean;
  approximate: boolean;
}

const NUMBER_RE =
  /(?<![\p{L}\p{N}])(rp\.?\s*|\$\s*)?[-+]?(\d[\d.,]*\d|\d)(\s*(?:juta|jt|million|mio|ribu|rb|thousand|k)\b)?/giu;

export function parseAmounts(text: string): ParsedAmount[] {
  const out: ParsedAmount[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const prefix = m[1];
    const raw = m[2].replace(/[.,]+$/, '');
    const scale = (m[3] ?? '').trim().toLowerCase();
    let value: number | null = null;
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(raw)) {
      value = Number(raw.replace(/[.,]/g, ''));
    } else if (/^\d+(?:[.,]\d+)?$/.test(raw)) {
      value = Number(raw.replace(',', '.'));
    } else {
      const mixed = raw.match(/^(\d{1,3}(?:[.,]\d{3})+)[.,](\d{1,2})$/);
      if (mixed) value = Number(mixed[1].replace(/[.,]/g, ''));
    }
    if (value === null || !Number.isFinite(value)) continue;
    let approximate = false;
    if (['juta', 'jt', 'million', 'mio'].includes(scale)) {
      value *= 1_000_000;
      approximate = true;
    } else if (['ribu', 'rb', 'thousand', 'k'].includes(scale)) {
      value *= 1_000;
      approximate = true;
    }
    out.push({ value, hasCurrency: Boolean(prefix), approximate });
  }
  return out;
}

const amountMatches = (a: ParsedAmount, target: number) =>
  a.approximate ? Math.abs(a.value - target) <= Math.max(0.06 * target, 1) : Math.abs(a.value - target) < 1;

function termHit(term: BenchTerm, answer: string, amounts: ParsedAmount[]) {
  return typeof term === 'number'
    ? amounts.some((a) => amountMatches(a, term))
    : answer.toLowerCase().includes(term.toLowerCase());
}

export interface BenchScore {
  pass: boolean;
  checks: { facts: boolean; forbid: boolean; grounded: boolean; noData?: boolean; ownAnswer?: boolean };
  invented: number[];
  forbidHits: BenchTerm[];
}

/** `context` is everything the model was shown (system facts, history, question). */
export function scoreAnswer(benchCase: BenchCase, answer: string, context: string, noDataPhrases: string[]): BenchScore {
  const amounts = parseAmounts(answer);
  const allowed = parseAmounts(context).map((a) => a.value);
  const expect = benchCase.expect ?? [];
  const expectedNumbers = expect.flat().filter((t): t is number => typeof t === 'number');

  const facts = expect.every((group) => group.some((term) => termHit(term, answer, amounts)));
  const forbidHits = (benchCase.forbid ?? []).filter((term) => termHit(term, answer, amounts));
  const invented = amounts
    .filter((a) => a.hasCurrency || a.value >= 1000)
    .filter((a) => !allowed.some((v) => amountMatches(a, v)) && !expectedNumbers.some((v) => amountMatches(a, v)))
    .map((a) => a.value);

  const checks: BenchScore['checks'] = { facts, forbid: forbidHits.length === 0, grounded: invented.length === 0 };
  if (benchCase.needsOwnAnswer) checks.ownAnswer = !/^I couldn't put that into words reliably/.test(answer.trim());
  if (benchCase.expectNoData) {
    const low = answer.toLowerCase().replace(/’/g, "'");
    checks.noData = noDataPhrases.some((p) => low.includes(p));
  }
  return { pass: Object.values(checks).every(Boolean), checks, invented, forbidHits };
}
