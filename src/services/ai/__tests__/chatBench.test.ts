/**
 * Chat benchmark, retrieval half: for every benchmark question, the prompt Silo would send to the local model
 * must already contain the facts needed to answer it. A 0.8B model cannot add up transactions, so if the fact
 * is not in the prompt the answer will be wrong or invented. The model half is chatBench.model.test.ts.
 */
import { useSettingsStore } from '../../../store/useSettingsStore';
import { useAIStore } from '../../../store/useAIStore';
import { idr } from '../chatBench/fixture';
import { BENCH_CASES, BENCH_TRUTH, type BenchCase, type BenchTerm } from '../chatBench/cases';
import { buildBenchMessages, openBenchDb } from '../chatBench/harness';
import { finalizeLocalChatReply, resolveFollowUpPrompt } from '../agent';

jest.mock('../../../store/useSettingsStore', () => ({
  useSettingsStore: { getState: jest.fn() },
}));

jest.mock('../../../store/useAIStore', () => {
  const storeState: any = {
    runtime: { runtimeInfo: { backend: 'llama.rn', loadedModelFamily: 'qwen' } },
    chatHistory: [],
    updateContextWindow: jest.fn(),
  };
  return { useAIStore: { getState: jest.fn(() => storeState) } };
});

const termInText = (term: BenchTerm, text: string) =>
  typeof term === 'number' ? text.includes(idr(term)) : text.toLowerCase().includes(term.toLowerCase());

/** Explicit `needsFacts` must all be present; otherwise each `expect` group with numbers needs one of them. */
function missingFacts(benchCase: BenchCase, system: string): BenchTerm[] {
  if (benchCase.needsFacts) return benchCase.needsFacts.filter((term) => !termInText(term, system));
  return (benchCase.expect ?? [])
    .map((group) => group.filter((t): t is number => typeof t === 'number'))
    .filter((numbers) => numbers.length > 0 && !numbers.some((n) => termInText(n, system)))
    .map((numbers) => numbers[0]);
}

describe('chat benchmark: retrieval puts the answer in the prompt', () => {
  let db: ReturnType<typeof openBenchDb>;
  const store = () => useAIStore.getState() as any;

  beforeAll(() => {
    (useSettingsStore.getState as jest.Mock).mockReturnValue({
      localSystemPrompt: '',
      currencyCode: 'IDR',
      useThousandsSeparator: true,
      monthStartDay: 1,
    });
    db = openBenchDb();
  });

  it('dataset sanity: totals are plausible for a salaried Jakarta user', () => {
    expect(BENCH_TRUTH.incomeThis).toBe(12_500_000 + 2_750_000);
    expect(BENCH_TRUTH.biggestThis).toEqual({ merchant: 'Erafone', amount: 4_899_000 });
    expect(BENCH_TRUTH.shoppingOver).toBeGreaterThan(0);
    expect(BENCH_TRUTH.transportRemaining).toBeLessThan(0);
    expect(BENCH_TRUTH.totalBalance).toBeGreaterThan(0);
  });

  const factCases = BENCH_CASES.filter((c) => c.needsFacts || (c.expect ?? []).flat().some((t) => typeof t === 'number'));
  it.each(factCases.map((c) => [c.id, c] as const))('%s', (_id, benchCase) => {
    const system = buildBenchMessages(db, benchCase, store())[0].content;
    expect({ prompt: benchCase.prompt, missing: missingFacts(benchCase, system), system }).toEqual({
      prompt: benchCase.prompt,
      missing: [],
      system,
    });
  });

  it.each(BENCH_CASES.flatMap((c) => (c.forbid ?? []).filter((t) => typeof t === 'number').map((term) => [c.id, c, term] as const)))(
    '%s: the prompt does not feed a fact the answer must not use',
    (_id, benchCase, term) => {
      const messages = buildBenchMessages(db, benchCase, store());
      // Only the current question and its facts: a tiny model copies earlier (possibly wrong) answers.
      expect(messages.map((m) => m.content).some((content) => termInText(term, content))).toBe(false);
    },
  );

  it('regression 2026-11-25: replies with invented amounts are replaced by the facts', () => {
    const benchCase = BENCH_CASES.find((c) => c.id === 'top-category')!;
    const messages = buildBenchMessages(db, benchCase, store());
    // The real 0.8B reply from the screenshot: categories and amounts that are not in the user's records.
    const invented = '1. Food and Dining: Rp 419.518 (13 transactions)\n2. Transport: Rp 15.20 (1 transaction)';
    const finalized = finalizeLocalChatReply(invented, messages);
    expect(finalized).not.toContain('419.518');
    expect(finalized).not.toContain('15.20');
    expect(finalized).toContain(BENCH_TRUTH.topCatThis.category);
    expect(finalized).toContain(idr(BENCH_TRUTH.topCatThis.total));
  });

  it('follow-ups keep the earlier topic; full questions stand alone', () => {
    expect(resolveFollowUpPrompt('And last month?', ['How much did I spend on food this month?'])).toBe(
      'How much did I spend on food. And last month?',
    );
    expect(resolveFollowUpPrompt('What category was that?', ['What was my biggest expense this month?'])).toBe(
      'What was my biggest expense this month. What category was that?',
    );
    expect(resolveFollowUpPrompt('How much did I spend on transport?', ['What is my balance?'])).toBe(
      'How much did I spend on transport?',
    );
    expect(resolveFollowUpPrompt('And last month?', [])).toBe('And last month?');
  });

  it('a grounded reply passes through the guard unchanged', () => {
    const benchCase = BENCH_CASES.find((c) => c.id === 'biggest-expense')!;
    const messages = buildBenchMessages(db, benchCase, store());
    const reply = `Your biggest expense this month was Erafone at Rp ${idr(4_899_000)}.`;
    expect(finalizeLocalChatReply(reply, messages)).toBe(reply);
  });
});
