# Silo AI chat benchmark

Measures how well the on-device chat (Qwen 3.5 0.8B, Chat mode) answers real questions about a user's money.
Started 2026-11-25 after the model answered "What is my most spent category" with the total balance twice and
then with a made-up category list ("Transport: Rp 15.20").

## What it tests

- **Dataset** (`src/services/ai/chatBench/fixture.ts`): three months (Sep 1 to Nov 25 2026) of a salaried
  Jakarta user: 3 accounts (cash, BCA, GoPay), salary and a freelance payment, rent, utilities, Netflix, weekly
  groceries, weekday lunches, coffee, GoFood, Gojek/Grab, fuel, a Bali trip, a new phone, 3 monthly budgets
  (Shopping and Transport over budget in November). Seeded into real SQLite with Silo's own migrations.
  Expected answers are computed in plain JS from the seed list, not through the app's SQL.
- **Questions** (`src/services/ai/chatBench/cases.ts`), 50 cases in 6 tiers: `typical` (one fact, as people
  type it, typos included), `hard` (comparisons, averages, synonyms like "coffee" or "subscriptions"), `abstract`
  ("Am I doing okay?", "Can I afford a 5 million laptop?"), `followup` (earlier turns in history, including the
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
| 0.8B, after this work | 100% | 100% | 81.0% | 91.7% | 100% | 100% | **96.7%** | 0 | 1.10s |
| 2B, after this work | 94.4% | 100% | 100% | 100% | 100% | 100% | **98.0%** | 0 | 2.59s |

Remaining 0.8B misses are judgement questions ("Was buying the new phone a bad idea?" answered without its cost)
and one follow-up that named the expense but not its category. The 2B model handles judgement questions well.

What moved the score (in order of effect): fixing retrieval so the answer is in the prompt (the top-categories
pattern never matched "category"; comparisons, top merchants, averages, merchant groups like coffee), dropping
earlier answers from the local prompt (the model copied them), putting the answer first in budget facts
("nothing left, OVER budget by"), and the reply guard. Quoting a canned refusal in the system prompt made the
model refuse real questions (-9 points); keep off-topic instructions descriptive.

## Adding a case

Add it to `BENCH_CASES` with the facts it needs. If the retrieval test fails, fix retrieval in `agent.ts`
(`buildRetrievedContext`) first, then rerun the model half to see whether the model uses the fact.
