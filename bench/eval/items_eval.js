#!/usr/bin/env node
/**
 * Receipt line-item benchmark on real ML Kit output.
 *
 * Input: bench/cache/ocr_mlkit/<id>.json from bench/mlkit-harness (ML Kit lines with boxes, in the order ML Kit
 * returns them). Each file is run through the app's own code path (buildOcrResultFromLines: visual rows, then
 * parseReceiptTextHeuristic) and its items are scored against the labels:
 *   bench/labels.jsonl (CORD, Commons), bench/data/user_labels_crop.jsonl (usercrop_*), bench/data/user_labels.jsonl (userraw_*).
 * The user files are private and gitignored; the script runs on whatever is present.
 *
 * Usage: node bench/eval/items_eval.js [--repo <path>] [--show <substring>] [--source user]
 *   --repo  run another checkout's src (e.g. a worktree of the previous commit) for a before/after comparison.
 *   --show  print wanted vs got for receipts whose id contains the substring ("all" for every receipt).
 *   --rows  with --show, also print the OCR rows the parser saw.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const BENCH = path.resolve(__dirname, '..');
const REPO = path.resolve(opt('--repo') ?? path.join(BENCH, '..'));
const SHOW = opt('--show');
const ONLY_SOURCE = opt('--source');
const ROWS = args.includes('--rows');

const { transform } = require(path.join(BENCH, '..', 'node_modules/sucrase'));
const cache = new Map();
function loadTs(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const { code } = transform(fs.readFileSync(file, 'utf8'), {
    transforms: ['typescript', 'imports'],
  });
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  cache.set(file, mod);
  mod._compile(code, file);
  return mod.exports;
}
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (request === 'expo-constants') return { default: { appOwnership: 'standalone' } };
  if (request.startsWith('@react-native-ml-kit/') || request === 'react-native') return {};
  if (request.startsWith('.') && parent && parent.filename.endsWith('.ts')) {
    const file = path.resolve(path.dirname(parent.filename), request) + '.ts';
    return fs.existsSync(file) ? loadTs(file) : {};
  }
  return origLoad.apply(this, arguments);
};

const engine = loadTs(path.join(REPO, 'src/services/ocr/MlKitEngine.ts'));
const { joinSplitThousands } = loadTs(path.join(REPO, 'src/services/ocr/receiptText.ts'));
const { parseReceiptLineItemsText } = loadTs(
  path.join(REPO, 'src/features/transactions/lineItems.ts'),
);

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
const labels = new Map();
for (const r of readJsonl(path.join(BENCH, 'labels.jsonl'))) labels.set(r.id, r);
for (const r of readJsonl(path.join(BENCH, 'data/user_labels_crop.jsonl')))
  labels.set(`usercrop_${r.id.replace(/^user_/, '')}`, r);
for (const r of readJsonl(path.join(BENCH, 'data/user_labels.jsonl')))
  labels.set(`userraw_${r.id.replace(/^user_/, '')}`, r);

const amount = (s) => {
  const n = Number(String(s).replace(/[^\d-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
// The app folds discounts into the item above ("13.000 - 2.000 Disc"); labels may list the gross price instead.
const grossOf = (item) =>
  amount(item.price) +
  [...` ${item.note}`.matchAll(/ - ([\d.]+)/g)].reduce((s, m) => s + amount(m[1]), 0);

const ocrDir = path.join(BENCH, 'cache/ocr_mlkit');
const agg = new Map();
for (const file of fs.readdirSync(ocrDir).sort()) {
  const id = file.replace(/\.json$/, '');
  const label = labels.get(id);
  if (!label) continue;
  const source = id.startsWith('usercrop_')
    ? 'user_crop'
    : id.startsWith('userraw_')
      ? 'user_raw'
      : label.source;
  if (ONLY_SOURCE && !source.startsWith(ONLY_SOURCE)) continue;
  const data = JSON.parse(fs.readFileSync(path.join(ocrDir, file), 'utf8'));
  const lines = (data.boxes ?? []).map((b) => {
    const xs = b.box.map((p) => p[0]);
    const ys = b.box.map((p) => p[1]);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    return {
      text: joinSplitThousands(b.text),
      frame: { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top },
    };
  });
  const result = engine.buildOcrResultFromLines(lines, lines.map((l) => l.text).join('\n'));
  const got = parseReceiptLineItemsText(result.extractedLineItems ?? '').map((i) => ({
    name: i.name,
    price: amount(i.price),
    gross: grossOf(i),
  }));
  const want = (label.items ?? []).filter((i) => typeof i.price === 'number' && i.price > 0);

  const pool = [...got];
  let hit = 0;
  for (const w of want) {
    const k = pool.findIndex((g) => g.price === w.price || g.gross === w.price);
    if (k >= 0) {
      hit += 1;
      pool.splice(k, 1);
    }
  }
  const sum = got.reduce((s, g) => s + g.price, 0);
  const total = label.total ?? null;
  const a = agg.get(source) ?? {
    n: 0,
    want: 0,
    hit: 0,
    got: 0,
    gotHit: 0,
    exact: 0,
    sumOk: 0,
    withTotal: 0,
  };
  a.n += 1;
  a.want += want.length;
  a.hit += hit;
  a.got += got.length;
  a.gotHit += got.length - pool.length;
  if (want.length > 0 && hit === want.length && pool.length === 0) a.exact += 1;
  if (total) {
    a.withTotal += 1;
    if (got.length > 0 && sum === total) a.sumOk += 1;
  }
  agg.set(source, a);

  if (SHOW && (SHOW === 'all' || id.includes(SHOW))) {
    console.log(
      `== ${id}  total=${total}  sum=${sum}  ${hit}/${want.length} found, ${pool.length} extra`,
    );
    if (ROWS) console.log(result.rows.map((r) => `   | ${r}`).join('\n'));
    console.log('  want:', JSON.stringify(want.map((w) => [w.name.slice(0, 24), w.price])));
    console.log('  got :', JSON.stringify(got.map((g) => [g.name.slice(0, 24), g.price])));
  }
}

const pct = (x, y) => (y ? `${((100 * x) / y).toFixed(1)}%` : '-');
console.log(`repo: ${REPO}`);
console.log('source       n  recall  precision  exact  sum=total');
for (const [source, a] of [...agg.entries()].sort()) {
  console.log(
    `${source.padEnd(10)} ${String(a.n).padStart(3)}  ${pct(a.hit, a.want).padStart(6)}  ${pct(a.gotHit, a.got).padStart(9)}  ` +
      `${pct(a.exact, a.n).padStart(5)}  ${pct(a.sumOk, a.withTotal).padStart(9)}`,
  );
}
