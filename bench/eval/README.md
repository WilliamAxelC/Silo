# Silo End-to-End Receipt Extraction Evaluation

Scripts in `bench/eval/` benchmark receipt extraction pipelines on the 197-image Indonesian receipt dataset (`bench/labels.jsonl`) using `rapidocr_onnxruntime`, Silo's real TypeScript heuristics (`src/services/ocr/MlKitEngine.ts` + `src/services/ai/agent.ts`), and `llama-server` (`Qwen3.5-2B-Q4_K_M`, `Qwen3.5-0.8B-Q4_K_M`, and F16 `mmproj`).

## Scripts

- `build_ocr_cache.py`: Runs RapidOCR once per image and caches `bench/cache/ocr/<id>.json` with boxes, scores, timing, `mlkit_like` (detector order), and `rows` (boxes grouped into visual rows by vertical overlap, joined with two spaces).
- `subsets.py`: Generates deterministic subsets (`seed=0`) in `bench/eval/subsets.json`:
  - `S` (39): 20 CORD clean + 12 CORD degraded + all 7 Commons.
  - `V` (12, `V ⊂ S`): 6 CORD clean + 3 CORD degraded + 3 Commons non-ticket receipts.
- `ts_bridge.js`: Executes Silo's actual `parseReceiptTextHeuristic` and `filterReceiptOcrTextForAi` via `node` + `sucrase` from `node_modules` with stubbed RN/Expo dependencies.
- `run_heuristic.py`: Approach **A (`heuristic`)** on all 197 images.
- `run_llm.py`: Approaches **B (`llm_current`)**, **C (`llm_rows_schema_2b`)**, and **C2 (`llm_rows_schema_0.8b`)** on `S`.
- `run_vlm.py`: Approaches **D (`vlm_2b`)**, **D2 (`vlm_0.8b`)**, and **E (`hybrid_2b`)** on `V`.
- `evaluate.py`: Computes per-approach × source metrics and writes `bench/results/results.json` and `bench/results/REPORT.md`.
- `run_all.sh`: End-to-end reproducible runner (resumable per-item JSONL outputs).

## Re-running

```bash
chmod +x bench/eval/run_all.sh
./bench/eval/run_all.sh
```

Note: Each `llama-server` stage waits until no `jest`/`tsc --noEmit` processes are active and ≥3000 MB RAM is available before starting, and runs only one `llama-server` instance at a time (`-c 4096 -t 4`).

## Line items on real ML Kit output (`items_eval.js`)

`bench/mlkit-harness/run_on_emulator.sh` runs real ML Kit text recognition on the emulator over every benchmark image
(plus the private `user_crop` / `user_raw` photos) and writes `bench/cache/ocr_mlkit/<id>.json` (gitignored). On API
30 images pushed with adb are unreadable to the app, so the script copies them into `/data/media` as root and hands
them to the app's uid.

`node bench/eval/items_eval.js` runs each file through the app's own path (`buildOcrResultFromLines`: visual rows,
then `extractReceiptItems`) and scores items against the labels: recall (labelled items found, by price), precision
(listed items that are real), exact (every item and nothing else) and whether the items add up to the total.
`--show <id part> --rows` prints the rows and wanted/got items; `--repo <worktree>` scores another checkout.

| Reader (2026-11-26) | CORD exact | CORD recall / precision | Private user receipts, cropped: exact | recall / precision |
|---|---:|---:|---:|---:|
| One-row reader (1.3.9) | 29.3% | 71.1% / 65.9% | 0.0% | 51.5% / 27.9% |
| `extractReceiptItems` (names and prices on any row) | 75.3% | 88.3% / 91.2% | 68.8% | 90.9% / 90.9% |

The user receipts were also used to develop the reader, so their numbers flatter it; CORD (190 receipts) is the
fairer check. Known misses: skewed photos where every price sits one row above its name, two receipts in one photo,
Wingstop's multi-column print, and totals too garbled to read.
