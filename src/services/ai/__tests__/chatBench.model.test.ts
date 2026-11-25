/**
 * Chat benchmark, model half: runs every benchmark question through a real llama-server with the same GGUF and
 * chat-mode sampling the phone uses, applies the app's reply guard, and scores raw and final answers.
 * Skipped unless SILO_CHAT_BENCH_URL is set. See bench/chat/README.md.
 */
import { request } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { useAIStore } from '../../../store/useAIStore';
import { finalizeLocalChatReply } from '../agent';
import {
  QWEN_MODEL_DEFAULT_TEMPERATURE,
  QWEN_MODEL_DEFAULT_TOP_P,
  QWEN_MODEL_MAX_OUTPUT_TOKENS,
  QWEN_MODEL_STOP_TOKENS,
} from '../config';
import { BENCH_CASES, NO_DATA_PHRASES, type BenchTier } from '../chatBench/cases';
import { buildBenchMessages, openBenchDb } from '../chatBench/harness';
import { scoreAnswer, type BenchScore } from '../chatBench/score';

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

const URL_ENV = process.env.SILO_CHAT_BENCH_URL;
const SAMPLES = Number(process.env.SILO_CHAT_BENCH_SAMPLES ?? 3);
const LABEL = process.env.SILO_CHAT_BENCH_LABEL ?? 'run';
const ONLY = process.env.SILO_CHAT_BENCH_ONLY?.split(',');
const RESULTS_DIR = join(__dirname, '../../../../bench/chat/results');

function chat(messages: unknown, seed: number): Promise<string> {
  const url = new URL('/v1/chat/completions', URL_ENV);
  const body = JSON.stringify({
    messages,
    temperature: QWEN_MODEL_DEFAULT_TEMPERATURE,
    top_p: QWEN_MODEL_DEFAULT_TOP_P,
    max_tokens: QWEN_MODEL_MAX_OUTPUT_TOKENS,
    stop: [...QWEN_MODEL_STOP_TOKENS],
    seed,
    chat_template_kwargs: { enable_thinking: false },
  });
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const text: string = JSON.parse(data).choices[0].message.content ?? '';
            resolve(text.replace(/<think>[\s\S]*?<\/think>/g, '').trim());
          } catch (err) {
            reject(new Error(`bad llama-server reply: ${data.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const describeIfServer = URL_ENV ? describe : describe.skip;

describeIfServer('chat benchmark against a real model', () => {
  it(
    'scores every case',
    async () => {
      (useSettingsStore.getState as jest.Mock).mockReturnValue({
        localSystemPrompt: '',
        currencyCode: 'IDR',
        useThousandsSeparator: true,
        monthStartDay: 1,
      });
      const db = openBenchDb();
      const store = useAIStore.getState() as any;
      const rows: Array<{ id: string; tier: BenchTier; sample: number; prompt: string; raw: string; final: string; secs: number; rawScore: BenchScore; finalScore: BenchScore }> = [];

      for (const benchCase of BENCH_CASES.filter((c) => !ONLY || ONLY.includes(c.id))) {
        const messages = buildBenchMessages(db, benchCase, store);
        const context = messages.map((m) => m.content).join('\n');
        for (let sample = 0; sample < SAMPLES; sample += 1) {
          const started = Date.now();
          const raw = await chat(messages, 1000 + sample);
          const final = finalizeLocalChatReply(raw, messages);
          rows.push({
            id: benchCase.id,
            tier: benchCase.tier,
            sample,
            prompt: benchCase.prompt,
            raw,
            final,
            secs: (Date.now() - started) / 1000,
            rawScore: scoreAnswer(benchCase, raw, context, NO_DATA_PHRASES),
            finalScore: scoreAnswer(benchCase, final, context, NO_DATA_PHRASES),
          });
        }
      }

      const pct = (n: number, d: number) => `${((100 * n) / Math.max(d, 1)).toFixed(1)}%`;
      const tiers = Array.from(new Set(rows.map((r) => r.tier)));
      const line = (name: string, list: typeof rows) =>
        `| ${name} | ${list.filter((r) => r.rawScore.pass).length}/${list.length} (${pct(list.filter((r) => r.rawScore.pass).length, list.length)}) | ${list.filter((r) => r.finalScore.pass).length}/${list.length} (${pct(list.filter((r) => r.finalScore.pass).length, list.length)}) | ${list.filter((r) => r.rawScore.invented.length).length} | ${list.filter((r) => r.finalScore.invented.length).length} |`;
      const summary = [
        `# Chat benchmark: ${LABEL}`,
        '',
        `${rows.length} answers (${SAMPLES} per case). "Raw" is the model's text; "shown" is after the app's reply guard.`,
        '',
        '| Tier | Raw pass | Shown pass | Raw invented amounts | Shown invented amounts |',
        '|---|---|---|---|---|',
        ...tiers.map((tier) => line(tier, rows.filter((r) => r.tier === tier))),
        line('**overall**', rows),
        '',
        `Median latency ${rows.map((r) => r.secs).sort((a, b) => a - b)[Math.floor(rows.length / 2)]?.toFixed(2)}s on the bench host.`,
        '',
        '## Failures (shown answer)',
        '',
        ...rows
          .filter((r) => !r.finalScore.pass)
          .map((r) => `- **${r.id}#${r.sample}** ${JSON.stringify(r.finalScore.checks)}: ${r.final.replace(/\s+/g, ' ').slice(0, 240)}`),
      ].join('\n');

      mkdirSync(RESULTS_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      writeFileSync(join(RESULTS_DIR, `${LABEL}-${stamp}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      writeFileSync(join(RESULTS_DIR, `${LABEL}-${stamp}.md`), summary + '\n');
      // eslint-disable-next-line no-console
      console.log(summary);
      expect(rows.length).toBeGreaterThan(0);
    },
    60 * 60 * 1000,
  );
});
