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
