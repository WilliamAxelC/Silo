# Silo AI chat benchmark

Measures how well the on-device chat (Qwen 3.5 0.8B, Chat mode) answers real questions about a user's money.
Started 2026-11-25 after the model answered "What is my most spent category" with the total balance twice and
then with a made-up category list ("Transport: Rp 15.20").

## What it tests

- **Dataset** (`src/services/ai/chatBench/fixture.ts`): three months (Sep 1 to Nov 25 2026) of a salaried
  Jakarta user: 3 accounts (cash, BCA, GoPay), salary and a freelance payment, rent, utilities, Netflix, weekly
  groceries, weekday lunches, coffee, GoFood, Gojek/Grab, fuel, a Bali trip, a new phone, 3 monthly budgets
  (Shopping and Transport over budget in November) plus a large Bills budget, so all budgets together are
  under while two are over. That trap fooled the model on the 1.3.6 emulator check. Seeded into real SQLite with Silo's own migrations.
  Expected answers are computed in plain JS from the seed list, not through the app's SQL.
- **Questions** (`src/services/ai/chatBench/cases.ts`), 59 cases in 7 tiers: `typical` (one fact, as people
  type it, typos included), `hard` (comparisons, averages, synonyms like "coffee" or "subscriptions"), `abstract`
  ("Am I doing okay?", "Can I afford a 5 million laptop?"), `advice` (planning that needs worked-out numbers:
  "How can I save 20% of my income?", "Make me a budget for next month", "How long to save 10 million?"; the reply
  must be the model's own, not the facts fallback), `followup` (earlier turns in history, including the
  exact screenshot conversation), `indonesian`, `offtopic` (weather, things the user never bought, "hi").
- **Scoring** (`src/services/ai/chatBench/score.ts`): an answer passes when it states the expected facts
  (amounts matched numerically, so "Rp 4.899.000", "4,899,000" and "4.9 juta" all count), avoids forbidden ones,
  and every amount in it appears in what the model was shown (no invented money). No-data cases must say so.

## Two halves

1. **Retrieval** (runs in CI, no model): `npx jest src/services/ai/__tests__/chatBench.test.ts`. For each case,
   the prompt Silo builds must already contain the facts that answer it. A 0.8B model cannot add up
   transactions; if the fact is not in the prompt, the answer will be wrong or invented.
2. **Model** (manual): `src/services/ai/__tests__/chatBench.model.test.ts`, skipped unless
   `SILO_CHAT_BENCH_URL` is set. Sends each case's exact app prompt to llama-server with the app's chat-mode
   sampling (temperature 0.3, top_p 0.85, 150 tokens, thinking off), runs the reply through the app's guard
   (`finalizeLocalChatReply`), and scores both the raw and the shown text.

## Running the model half

The GGUFs and a llama.cpp build live on ai-renderer (10.20.20.194):
`~/silo-build/bench-models/Qwen3.5-{0.8B,2B}-Q4_K_M.gguf`, `~/silo-build/silo-bench/llama/llama-server`.

```bash
# on ai-renderer: start llama-server on 127.0.0.1:8090 (script: ~/silo-build/chat-bench/serve.sh 0.8B|2B)
cd ~/silo-build/silo-bench/llama && LD_LIBRARY_PATH=$PWD ./llama-server \
  -m ~/silo-build/bench-models/Qwen3.5-0.8B-Q4_K_M.gguf -c 2048 -t 8 --host 127.0.0.1 --port 8090 --jinja -np 1

# on orca: tunnel and run (about 4 minutes for 0.8B, 3 samples per case)
ssh -f -N -L 8090:127.0.0.1:8090 agent@10.20.20.194
SILO_CHAT_BENCH_URL=http://127.0.0.1:8090 SILO_CHAT_BENCH_LABEL=my-change \
  npx jest src/services/ai/__tests__/chatBench.model.test.ts
```

Options: `SILO_CHAT_BENCH_SAMPLES` (default 3), `SILO_CHAT_BENCH_ONLY=id1,id2`. Results land in
`bench/chat/results/<label>-<time>.{md,jsonl}`: the `.md` has the per-tier table and every failing answer.

With 3 samples of 50 cases, a difference of about 3 points is noise; rerun before trusting a small change.

## Results (2026-11-25, Q4_K_M, 150 answers each)

Full tables and every failing answer: `bench/chat/results/*.md`. "Shown" is what the user sees after the guard.
Latency is on the 20-core bench host, not a phone; compare runs with each other only.

| Run | typical | hard | abstract | follow-up | Indonesian | off-topic | **Shown pass** | Invented amounts shown | Median latency |
|---|---|---|---|---|---|---|---|---|---|
| 0.8B, 1.3.5 code (baseline) | 88.9% | 41.7% | 61.9% | 41.7% | 80.0% | 58.3% | **66.7%** | 25 | 2.30s |
| 0.8B, 1.3.6 (51 cases, 153 answers) | 100% | 100% | 81.0% | 91.7% | 100% | 100% | **96.7%** | 0 | 1.11s |
| 0.8B, 1.3.7 (59 cases, 177 answers) | 100% | 100% | 95.2% | 100% | 100% | 100% | **97.7%** | 0 | 1.64s |
| 2B, 1.3.6 before the budget-trap cases (50 cases) | 94.4% | 100% | 100% | 100% | 100% | 100% | **98.0%** | 0 | 2.59s |

The 0.8B model answers "Ada anggaran yang kelewatan?" with "Tidak ada" even with an explicit "Answer: Yes"
fact, so the reply guard also replaces replies that name none of the over-budget categories. Remaining 0.8B
misses are judgement questions ("Was buying the new phone a bad idea?" answered without its cost)
and one follow-up that named the expense but not its category. The 2B model handles judgement questions well.

What moved the score (in order of effect): fixing retrieval so the answer is in the prompt (the top-categories
pattern never matched "category"; comparisons, top merchants, averages, merchant groups like coffee), dropping
earlier answers from the local prompt (the model copied them), putting the answer first in budget facts
("nothing left, OVER budget by"), and the reply guard. Quoting a canned refusal in the system prompt made the
model refuse real questions (-9 points); keep off-topic instructions descriptive.

1.3.7 adds an `advice` column (not in the table above): 29.2% on 1.3.6, 87.5% on 1.3.7. The facts fallback
dropped from 15 to 7 of 177 answers with the guard retry.

### Advice and planning (1.3.7)

- Retrieval works the numbers out (`detectPlanningIntent` in `agent.ts`): a share of income or of a named category
  ("20%", "half"), months to a savings goal, months of spending the balance covers, and a suggested budget for
  next month (this month's spending rounded to Rp 50.000, over-budget categories cut to their limit). They arrive
  as a "Worked out" fact. Left to itself the model said "5.05 years" to save 10 million at Rp 1.970.500 a month.
- When the guard rejects a reply, the app retries once at temperature 0.1 with "write amounts exactly as they
  appear in the facts", and shows the facts only if the retry fails too.
- **Thinking mode does not work here.** With Qwen thinking on, 0.8B and 2B both loop ("Wait, let's check the
  math again") until the 2048-token context is full and never answer: 0/45 (0.8B, 700 tokens, 22s each), 0/4
  (2B, 1800 tokens, 98s each). The app keeps thinking off; `SILO_CHAT_BENCH_THINKING=1` reruns the experiment.

## Adding a case

Add it to `BENCH_CASES` with the facts it needs. If the retrieval test fails, fix retrieval in `agent.ts`
(`buildRetrievedContext`) first, then rerun the model half to see whether the model uses the fact.
