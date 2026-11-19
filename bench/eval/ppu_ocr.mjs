#!/usr/bin/env node
// Runs ppu-paddle-ocr (the library Silo's PaddleOcrEngine wraps) over bench images and writes an OCR cache in the
// same format as build_ocr_cache.py: {boxes:[{text, box:[[x,y]x4], score}], ms}.
// usage: node ppu_ocr.mjs <labels.jsonl> <images_root> <out_dir> [preset=v6-tiny] [threads=4]
import fs from 'node:fs';
import path from 'node:path';
import { PaddleOcrService, MODEL_PRESETS } from 'ppu-paddle-ocr';

const [labelsPath, root, outDir, preset = 'v6-tiny', threads = '4'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const model = MODEL_PRESETS[preset];
if (!model) throw new Error(`unknown preset ${preset}`);
const service = new PaddleOcrService({
  model,
  session: { intraOpNumThreads: Number(threads), interOpNumThreads: 1, graphOptimizationLevel: 'all' },
});
await service.initialize();
const labels = fs.readFileSync(labelsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
for (const g of labels) {
  const out = path.join(outDir, `${g.id}.json`);
  if (fs.existsSync(out)) continue;
  const img = path.join(root, g.image.replace(/^bench\//, ''));
  const t0 = performance.now();
  const buf = fs.readFileSync(img);
  const r = await service.recognize(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const ms = Math.round(performance.now() - t0);
  const boxes = (r.lines ?? []).flat().map(({ text, box: b, confidence }) => ({
    text,
    box: [[b.x, b.y], [b.x + b.width, b.y], [b.x + b.width, b.y + b.height], [b.x, b.y + b.height]],
    score: confidence,
  }));
  fs.writeFileSync(out, JSON.stringify({ boxes, ms }));
  process.stdout.write(`${g.id} ${ms}ms ${boxes.length}\n`);
}
await service.destroy();
