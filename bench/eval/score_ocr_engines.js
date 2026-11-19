#!/usr/bin/env node
// Compares OCR engines on the receipt-total task using the app's own pipeline (receiptText.ts:
// buildReceiptRows -> pickTotalFromRows). Each arg is an OCR cache dir in build_ocr_cache.py format.
// usage: node bench/eval/score_ocr_engines.js bench/cache/ocr bench/cache/ocr_mlkit ...
const fs = require('fs'), path = require('path'), Module = require('module');
const R = path.resolve(__dirname, '../..');
const { transform } = require(R + '/node_modules/sucrase');
function load(p) {
  const m = new Module(p); m.filename = p; m.paths = Module._nodeModulePaths(path.dirname(p));
  const req = (s) => { if (s.startsWith('.')) { const f = path.resolve(path.dirname(p), s); for (const e of ['.ts', '/index.ts']) if (fs.existsSync(f + e)) return load(f + e); } return {}; };
  new Function('exports', 'require', 'module', transform(fs.readFileSync(p, 'utf8'), { transforms: ['typescript', 'imports'] }).code)(m.exports, req, m);
  return m.exports;
}
const rt = load(R + '/src/services/ocr/receiptText.ts');
const labels = fs.readFileSync(R + '/bench/labels.jsonl', 'utf8').trim().split('\n').map(JSON.parse).filter((g) => g.total != null);
const S = new Set(JSON.parse(fs.readFileSync(R + '/bench/eval/subsets.json')).S || []);
const pct = (a, n) => `${a}/${n} = ${n ? Math.round((100 * a) / n) : 0}%`;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
for (const dir of process.argv.slice(2)) {
  const bySrc = {}; let ok = 0, okS = 0, nS = 0, ceil = 0, n = 0; const ms = [];
  for (const g of labels) {
    const f = path.join(dir, `${g.id}.json`); if (!fs.existsSync(f)) continue;
    const o = JSON.parse(fs.readFileSync(f)); if (o.ms != null) ms.push(o.ms);
    const lines = (o.boxes || []).map((b) => { const xs = b.box.map((p) => p[0]), ys = b.box.map((p) => p[1]);
      return { text: b.text, frame: { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } }; });
    const rows = rt.buildReceiptRows(lines); const hit = rt.pickTotalFromRows(rows) === g.total;
    n++; ok += hit; ceil += rt.isGrounded(g.total, rows);
    if (S.has(g.id)) { nS++; okS += hit; }
    (bySrc[g.source] ??= [0, 0])[1]++; bySrc[g.source][0] += hit;
  }
  console.log(`${dir}\n  total correct ALL ${pct(ok, n)}  S ${pct(okS, nS)}  ceiling ${pct(ceil, n)}  median ${median(ms)} ms\n  by source: ${Object.entries(bySrc).map(([k, [a, b]]) => `${k} ${a}/${b}`).join(', ')}`);
}
