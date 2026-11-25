/**
 * Chat benchmark questions: what a Silo user actually types (typos included), harder multi-fact questions,
 * abstract "how am I doing" questions, follow-ups that lean on chat history, Indonesian, and off-topic prompts.
 *
 * `expect` is a list of groups; an answer passes a group when it contains any one of its alternatives.
 * Numbers are matched as amounts (so "Rp 4.899.000", "4,899,000" and "4899000" all match 4899000);
 * strings are matched case-insensitively. `forbid` lists things the answer must not contain.
 * `needsFacts` (default: every number in `expect`) must be present in the prompt the model receives, so the
 * jest test can check retrieval without running a model.
 */
import {
  RANGES,
  biggestExpense,
  categoryTotals,
  count,
  income,
  merchantTotals,
  spent,
  totalBalance,
  walletBalances,
  BENCH_BUDGETS,
} from './fixture';

export type BenchTier = 'typical' | 'hard' | 'abstract' | 'followup' | 'indonesian' | 'offtopic';
export type BenchTerm = string | number;

export interface BenchCase {
  id: string;
  tier: BenchTier;
  prompt: string;
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  expect?: BenchTerm[][];
  forbid?: BenchTerm[];
  /** Facts (amounts or names) that retrieval must put in front of the model. Defaults to the numbers in `expect`. */
  needsFacts?: BenchTerm[];
  /** The answer should say plainly that nothing matched / it does not know (checked with NO_DATA_PHRASES). */
  expectNoData?: boolean;
  note?: string;
}

export const NO_DATA_PHRASES = [
  "don't have",
  'do not have',
  "couldn't find",
  'could not find',
  "can't find",
  'no record',
  'no transaction',
  'no matching',
  'not found',
  "haven't",
  'have not',
  'none',
  'no spending',
  'not able',
  "can't",
  'cannot',
  'unable',
  'rp 0',
  'only help',
  'tidak ada',
  'belum ada',
];

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

const balances = walletBalances();
const balanceOf = (name: string) => balances.find((w) => w.name === name)!.balance;
const catThis = categoryTotals(RANGES.thisMonth);
const catLast = categoryTotals(RANGES.lastMonth);
const catTotal = (list: typeof catThis, name: string) => list.find((c) => c.category === name)?.total ?? 0;
const budgetLimit = (name: string) => BENCH_BUDGETS.find((b) => b.name === name)!.amount;

const spentThis = spent(RANGES.thisMonth);
const spentLast = spent(RANGES.lastMonth);
const incomeThis = income(RANGES.thisMonth);
const biggestThis = biggestExpense(RANGES.thisMonth);
const topCatThis = catThis[0];
const foodThis = catTotal(catThis, 'Food & Dining');
const foodLast = catTotal(catLast, 'Food & Dining');
const transportThis = catTotal(catThis, 'Transport');
const transportLast = catTotal(catLast, 'Transport');
const groceriesLast = catTotal(catLast, 'Groceries');
const shoppingThis = catTotal(catThis, 'Shopping');
const merchantsThis = merchantTotals(RANGES.thisMonth);
const merchantThis = (name: string) => merchantsThis.find((m) => m.merchant === name);
const coffeeThis = spent(RANGES.thisMonth, (t) => ['Kopi Kenangan', 'Starbucks', 'Fore Coffee'].includes(t.merchant));

export const BENCH_TRUTH = {
  totalBalance: totalBalance(),
  bcaBalance: balanceOf('Bank BCA'),
  mainWalletBalance: balanceOf('Main Wallet'),
  spentThis,
  spentLast,
  incomeThis,
  netThis: incomeThis - spentThis,
  topCatThis,
  biggestThis: { merchant: biggestThis.merchant, amount: -biggestThis.amount },
  foodThis,
  foodLast,
  foodRemaining: budgetLimit('Food & Dining') - foodThis,
  /** Negative: the user is over the transport budget. */
  transportRemaining: budgetLimit('Transport') - transportThis,
  shoppingOver: shoppingThis - budgetLimit('Shopping'),
  coffeeThis,
};

export const BENCH_CASES: BenchCase[] = [
  // ----- Typical: one fact, the way people actually ask -----
  { id: 'balance-total', tier: 'typical', prompt: 'What is my total balance?', expect: [[BENCH_TRUTH.totalBalance]] },
  { id: 'balance-bca', tier: 'typical', prompt: 'How much money do I have in Bank BCA?', expect: [[BENCH_TRUTH.bcaBalance]] },
  { id: 'spent-this-month', tier: 'typical', prompt: 'How much did I spend this month?', expect: [[spentThis]] },
  {
    id: 'top-category',
    tier: 'typical',
    prompt: 'What is my most spent category',
    expect: [[topCatThis.category]],
    needsFacts: [topCatThis.category, topCatThis.total],
    forbid: [BENCH_TRUTH.totalBalance],
    note: 'Screenshot 2026-11-25: answered with the total balance twice.',
  },
  {
    id: 'most-spending-typo',
    tier: 'typical',
    prompt: 'Whats my most spending',
    expect: [[topCatThis.category, biggestThis.merchant]],
    needsFacts: [topCatThis.category],
    forbid: [BENCH_TRUTH.totalBalance],
    note: 'Screenshot 2026-11-25: answered "1. Rp 10.143.197 2. Rp 10.143.197".',
  },
  {
    id: 'biggest-expense',
    tier: 'typical',
    prompt: 'What was my biggest expense this month?',
    expect: [[biggestThis.merchant], [BENCH_TRUTH.biggestThis.amount]],
  },
  { id: 'food-this-month', tier: 'typical', prompt: 'How much did I spend on food this month?', expect: [[foodThis]] },
  { id: 'transport-last-month', tier: 'typical', prompt: 'How much did I spend on transport last month?', expect: [[transportLast]] },
  { id: 'groceries-last-month', tier: 'typical', prompt: 'how much on groceries last month', expect: [[groceriesLast]] },
  {
    id: 'food-budget-left',
    tier: 'typical',
    prompt: 'How much is left in my food budget?',
    expect: [[BENCH_TRUTH.foodRemaining]],
  },
  {
    id: 'over-budget',
    tier: 'typical',
    prompt: 'Am I over budget on anything?',
    expect: [['Shopping']],
    forbid: ['over budget on your Food', 'over budget on Food', 'Food & Dining budget by', 'not over budget', 'no, you'],
    needsFacts: ['OVER budget (melebihi anggaran): Transport, Shopping', BENCH_TRUTH.shoppingOver],
    note: 'All budgets together are under; Transport and Shopping are over (emulator check 2026-11-25).',
  },
  { id: 'income-this-month', tier: 'typical', prompt: 'How much did I earn this month?', expect: [[incomeThis]] },
  {
    id: 'recent',
    tier: 'typical',
    prompt: 'Show my recent transactions',
    expect: [['Kopi Kenangan'], ['Gramedia']],
  },
  {
    id: 'merchant-starbucks',
    tier: 'typical',
    prompt: 'How much did I spend at Starbucks this month?',
    expect: [[merchantThis('Starbucks')?.total ?? 0]],
  },
  {
    id: 'what-bought-erafone',
    tier: 'typical',
    prompt: 'What did I buy at Erafone?',
    expect: [['Galaxy A55', 'Samsung', 'phone']],
    needsFacts: ['Galaxy A55'],
  },
  { id: 'rent', tier: 'typical', prompt: 'How much do I pay for rent?', expect: [[3_200_000]] },
  { id: 'spent-today', tier: 'typical', prompt: 'How much did I spend today?', expect: [[38_000]] },
  { id: 'spent-this-week', tier: 'typical', prompt: 'how much have i spent this week', expect: [[spent(RANGES.thisWeek)]] },

  // ----- Hard: comparisons, derived numbers, synonyms, multiple facts -----
  {
    id: 'compare-months',
    tier: 'hard',
    prompt: 'Did I spend more this month than last month?',
    expect: [
      [spentThis > spentLast ? 'more' : 'less', spentThis > spentLast ? 'yes' : 'no'],
      [spentThis, Math.abs(spentThis - spentLast)],
    ],
    needsFacts: [spentThis, spentLast],
  },
  {
    id: 'savings-this-month',
    tier: 'hard',
    prompt: 'How much did I save this month?',
    expect: [[BENCH_TRUTH.netThis]],
  },
  { id: 'september', tier: 'hard', prompt: 'How much did I spend in September?', expect: [[spent(RANGES.september)]] },
  {
    id: 'top-merchant',
    tier: 'hard',
    prompt: 'Which store did I spend the most at this month?',
    expect: [[merchantsThis[0].merchant]],
    needsFacts: [merchantsThis[0].merchant, merchantsThis[0].total],
  },
  {
    id: 'gofood-count',
    tier: 'hard',
    prompt: 'How many times did I order GoFood this month?',
    expect: [[String(merchantThis('GoFood')?.count ?? 0), NUMBER_WORDS[merchantThis('GoFood')?.count ?? 0]]],
    needsFacts: [`${merchantThis('GoFood')?.count ?? 0} txn`],
  },
  { id: 'coffee', tier: 'hard', prompt: 'How much did I spend on coffee this month?', expect: [[coffeeThis]] },
  {
    id: 'avg-daily',
    tier: 'hard',
    prompt: "What's my average daily spending this month?",
    expect: [[Math.round(spentThis / 25)]],
    needsFacts: [Math.round(spentThis / 25)],
  },
  {
    id: 'bali-trip',
    tier: 'hard',
    prompt: 'How much did my Bali trip cost in total?',
    expect: [[2_450_000 + 1_380_000, 2_450_000, 'Traveloka']],
    needsFacts: ['Traveloka'],
    note: 'Only the flight says "Bali"; the Ubud hotel is a stretch for keyword search.',
  },
  {
    id: 'food-oct-vs-nov',
    tier: 'hard',
    prompt: 'Compare my food spending in October and November',
    expect: [[foodLast, foodThis, Math.abs(foodThis - foodLast)]],
    needsFacts: [foodLast, foodThis],
  },
  {
    id: 'subscriptions',
    tier: 'hard',
    prompt: 'What subscriptions am I paying for?',
    expect: [['Netflix']],
    needsFacts: ['Netflix'],
  },
  {
    id: 'main-wallet-cash',
    tier: 'hard',
    prompt: 'How much cash is in my main wallet?',
    expect: [[BENCH_TRUTH.mainWalletBalance]],
  },
  {
    id: 'transport-budget-left',
    tier: 'hard',
    prompt: 'Can I still take Grab rides this month without blowing my transport budget?',
    expect: [["can't", 'cannot', 'no,', 'not', 'over'], [Math.abs(BENCH_TRUTH.transportRemaining), transportThis]],
    needsFacts: [Math.abs(BENCH_TRUTH.transportRemaining)],
  },

  // ----- Abstract: judgement on top of the data. Scored mostly on not inventing numbers. -----
  {
    id: 'doing-okay',
    tier: 'abstract',
    prompt: 'Am I doing okay financially?',
    expect: [[spentThis, incomeThis, BENCH_TRUTH.netThis, BENCH_TRUTH.totalBalance]],
  },
  {
    id: 'save-more',
    tier: 'abstract',
    prompt: 'How can I save more money?',
    expect: [['Food & Dining', 'food', 'Shopping', 'Bills', 'GoFood', 'coffee']],
    needsFacts: [topCatThis.category],
  },
  {
    id: 'where-money-goes',
    tier: 'abstract',
    prompt: 'Where is my money going?',
    expect: [[topCatThis.category]],
  },
  {
    id: 'afford-laptop',
    tier: 'abstract',
    prompt: 'Can I afford a 5 million laptop next month?',
    expect: [[BENCH_TRUTH.totalBalance, BENCH_TRUTH.netThis, BENCH_TRUTH.bcaBalance]],
  },
  {
    id: 'cut-back',
    tier: 'abstract',
    prompt: 'What should I cut back on?',
    expect: [['Food & Dining', 'food', 'Shopping', 'GoFood', 'coffee', 'eating out']],
    needsFacts: [topCatThis.category],
  },
  {
    id: 'phone-regret',
    tier: 'abstract',
    prompt: 'Was buying the new phone a bad idea?',
    expect: [[4_899_000, 'Erafone', 'Shopping']],
    needsFacts: ['Erafone'],
  },
  {
    id: 'month-summary',
    tier: 'abstract',
    prompt: 'Give me a summary of this month',
    expect: [[spentThis], [incomeThis]],
  },

  // ----- Follow-ups: the earlier turns are in chat history -----
  {
    id: 'followup-after-balance',
    tier: 'followup',
    history: [
      { role: 'user', text: 'What is my total balance?' },
      { role: 'assistant', text: `Your total balance is Rp ${BENCH_TRUTH.totalBalance.toLocaleString('id-ID')}.` },
    ],
    prompt: 'What is my most spent category',
    expect: [[topCatThis.category]],
    needsFacts: [topCatThis.category],
    forbid: [BENCH_TRUTH.totalBalance],
    note: 'Screenshot 2026-11-25 repro: the earlier balance answer leaks into the next one.',
  },
  {
    id: 'followup-bad-history',
    tier: 'followup',
    history: [
      { role: 'user', text: 'What is my total balance?' },
      { role: 'assistant', text: `1. Rp ${BENCH_TRUTH.totalBalance.toLocaleString('id-ID')}` },
      { role: 'user', text: 'Whats my most spending' },
      {
        role: 'assistant',
        text: `1. Rp ${BENCH_TRUTH.totalBalance.toLocaleString('id-ID')}\n2. Rp ${BENCH_TRUTH.totalBalance.toLocaleString('id-ID')}`,
      },
    ],
    prompt: 'What is my most spent category',
    expect: [[topCatThis.category]],
    needsFacts: [topCatThis.category],
    forbid: [BENCH_TRUTH.totalBalance],
    note: 'Exact screenshot history: earlier wrong answers must not be copied.',
  },
  {
    id: 'followup-and-last-month',
    tier: 'followup',
    history: [
      { role: 'user', text: 'How much did I spend on food this month?' },
      { role: 'assistant', text: `You spent Rp ${foodThis.toLocaleString('id-ID')} on Food & Dining this month.` },
    ],
    prompt: 'And last month?',
    expect: [[foodLast]],
  },
  {
    id: 'followup-which-category',
    tier: 'followup',
    history: [
      { role: 'user', text: 'What was my biggest expense this month?' },
      { role: 'assistant', text: `Your biggest expense was Erafone, Rp ${(4_899_000).toLocaleString('id-ID')}, on 20 Nov.` },
    ],
    prompt: 'What category was that?',
    expect: [['Shopping']],
  },

  // ----- Indonesian -----
  { id: 'id-saldo', tier: 'indonesian', prompt: 'Berapa saldo saya?', expect: [[BENCH_TRUTH.totalBalance]] },
  {
    id: 'id-terbesar',
    tier: 'indonesian',
    prompt: 'Pengeluaran terbesar bulan ini apa?',
    expect: [[biggestThis.merchant], [BENCH_TRUTH.biggestThis.amount]],
  },
  {
    id: 'id-over-budget',
    tier: 'indonesian',
    prompt: 'Ada anggaran yang kelewatan bulan ini?',
    expect: [['Shopping', 'Transport']],
    needsFacts: ['OVER budget (melebihi anggaran): Transport, Shopping'],
    forbid: ['tidak ada'],
  },
  { id: 'id-makan-bulan-lalu', tier: 'indonesian', prompt: 'Berapa pengeluaran makan bulan lalu?', expect: [[foodLast]] },
  {
    id: 'id-sisa-transport',
    tier: 'indonesian',
    prompt: 'Sisa anggaran transport berapa?',
    // Over budget: the right answer is "nothing left, over by Rp 41.000", never the limit as "remaining".
    expect: [[Math.abs(BENCH_TRUTH.transportRemaining)]],
  },
  {
    id: 'id-kategori-terbanyak',
    tier: 'indonesian',
    prompt: 'kategori pengeluaran terbanyak bulan ini apa',
    expect: [[topCatThis.category]],
    needsFacts: [topCatThis.category],
  },

  // ----- Off-topic or no data: must not invent anything -----
  { id: 'weather', tier: 'offtopic', prompt: "What's the weather in Jakarta today?", expectNoData: true },
  { id: 'crypto', tier: 'offtopic', prompt: 'How much did I spend on crypto?', expectNoData: true },
  { id: 'spotify', tier: 'offtopic', prompt: 'How much do I pay for Spotify?', expectNoData: true },
  { id: 'greeting', tier: 'offtopic', prompt: 'hi', forbid: [BENCH_TRUTH.totalBalance] },
];
