# Silo Receipt Extraction Benchmark Report

## Method & Environment
- **Dataset**: 197 images (`cord`: 150, `cord_deg`: 40, `commons`: 7). Text-LLM subset `S` (seed 0, n=39): 20 `cord` + 12 `cord_deg` + 7 `commons`. VLM subset `V ⊂ S` (seed 0, n=12): 6 `cord` + 3 `cord_deg` + 3 `commons` receipts (non-tickets).
- **OCR**: `rapidocr_onnxruntime` (PP-OCR ONNX) run once per image and cached (`bench/cache/ocr/<id>.json`). **Caveat**: Android ML Kit cannot run on Linux desktop, so RapidOCR stands in for OCR; `mlkit_like` joins detector boxes in order (like ML Kit `result.text`), while `rows` groups boxes by vertical overlap and joins columns with two spaces.
- **TS Heuristic (A)**: Runs Silo's exact `src/services/ocr/MlKitEngine.ts` (`parseReceiptTextHeuristic`) in Node via `sucrase` with stubbed RN/Expo modules.
- **LLM / VLM Runtime**: `llama-server` (`-c 4096 -t 4`, temperature `0`, thinking disabled via `--reasoning off` and `chat_template_kwargs: {"enable_thinking": false}` except raw ChatML in `B`). Models: `Qwen3.5-2B-Q4_K_M` and `Qwen3.5-0.8B-Q4_K_M` (+ F16 `mmproj` for VLMs, images downscaled to ≤768px longest side).

## Results on Subset S (n=39: 20 clean, 12 deg, 7 commons)

| Approach | Clean Exact | Deg Exact | Commons Exact | Overall Exact | ±1% | Halluc Total | Item Price Rec | Item Name Match | Merch Acc (C) | Date Acc (C) | Med Lat | p90 Lat | Peak RSS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `A_heuristic` | 60.0% | 41.7% | 28.6% | 48.7% | 48.7% | 0.0% | 7.8% | 20.0% | 28.6% | 20.0% | 2.47s | 4.57s | 792 MB |
| `B_llm_current` | 65.0% | 33.3% | 42.9% | 51.3% | 51.3% | 17.9% | 22.1% | 35.0% | 28.6% | 60.0% | 14.48s | 16.93s | 2942 MB |
| `C_llm_rows_schema_2b` | 80.0% | 41.7% | 42.9% | 61.5% | 61.5% | 0.0% | 61.0% | 57.5% | 42.9% | 20.0% | 23.95s | 53.82s | 2925 MB |
| `C2_llm_rows_schema_0.8b` | 80.0% | 50.0% | 57.1% | 66.7% | 66.7% | 0.0% | 58.4% | 55.0% | 28.6% | 40.0% | 13.21s | 24.07s | 2881 MB |

## Results on Full Dataset (n=197)

| Approach | Clean Exact | Deg Exact | Commons Exact | Overall Exact | ±1% | Halluc Total | Item Price Rec | Item Name Match | Med Lat | p90 Lat |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `A_heuristic` | 60.8% | 53.8% | 28.6% | 58.2% | 58.7% | 0.0% | 1.9% | 15.8% | 2.03s | 3.94s |

## Results on Subset V (n=12: 6 clean, 3 deg, 3 commons receipts)

| Approach | Clean Exact | Deg Exact | Commons Exact | Overall Exact | ±1% | Halluc Total | Item Price Rec | Item Name Match | Merch Acc (C) | Date Acc (C) | Med Lat | p90 Lat | Peak RSS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `A_heuristic` | 50.0% | 33.3% | 33.3% | 41.7% | 41.7% | 0.0% | 5.0% | 10.0% | 66.7% | 50.0% | 2.32s | 3.94s | 792 MB |
| `B_llm_current` | 50.0% | 33.3% | 33.3% | 41.7% | 41.7% | 16.7% | 35.0% | 30.0% | 66.7% | 50.0% | 14.87s | 16.51s | 2942 MB |
| `C_llm_rows_schema_2b` | 50.0% | 33.3% | 33.3% | 41.7% | 41.7% | 0.0% | 75.0% | 50.0% | 66.7% | 0.0% | 19.43s | 29.51s | 2925 MB |
| `C2_llm_rows_schema_0.8b` | 66.7% | 33.3% | 33.3% | 50.0% | 50.0% | 0.0% | 60.0% | 35.0% | 66.7% | 0.0% | 12.63s | 15.48s | 2881 MB |
| `D_vlm_2b` | 83.3% | 100.0% | 100.0% | 91.7% | 91.7% | 0.0% | 95.0% | 85.0% | 100.0% | 50.0% | 32.18s | 42.99s | 3060 MB |
| `D2_vlm_0.8b` | 100.0% | 100.0% | 66.7% | 91.7% | 91.7% | 8.3% | 90.0% | 80.0% | 100.0% | 50.0% | 15.92s | 28.07s | 2174 MB |
| `E_hybrid_2b` | 66.7% | 66.7% | 33.3% | 58.3% | 58.3% | 0.0% | 85.0% | 85.0% | 100.0% | 50.0% | 43.94s | 68.55s | 3072 MB |

## Diagnostics
- **B (`llm_current`)**: JSON parse OK 33/39, fell back to heuristic 6/39, prompt tokens median=217.0, max=405, overflow `n_ctx=1024` (prompt only / +80 gen)=0 / 0.
- **C_llm_rows_schema_2b grounding guard (S)**: fired 6/39, helped=0, hurt=0.
- **C2_llm_rows_schema_0.8b grounding guard (S)**: fired 5/39, helped=1, hurt=0.
- **E (`hybrid_2b`) grounding guard (V)**: fired 3/12, helped=0, hurt=2.

## Notable Failure Examples
- `cord_test_070` (cord, receipt): GT=1565938, A=1343000, B=1343000, C=1565938, C2=1343000 — RapidOCR read `DU 1,565,938` below `SUBTOTAL 1,343,000`; A/B/C2 picked subtotal, C recovered 1565938.
- `cord_test_035_deg` (cord_deg, receipt): GT=54000, A=104000, B=104000, C=104000, C2=104000, D=54000, D2=54000, E=104000 — ~7° tilt aligned `TOTAL` with `104,000` (cash) and OCR dropped `4` in `54,000`; all OCR methods failed, D/D2 succeeded.
- `commons_borobudur_taxi` (commons, receipt): GT=475000, A=700, B=30, C=700, C2=700, D=475000, D2=47500, E=700 — noisy receipt OCR failed (A/C/C2=700, B=30); D extracted 475000, D2 dropped one zero (47500).
- `commons_kwitansi_ahmad_2018` (commons, kwitansi): GT=360000, A=None, B=120000, C=None, C2=None, D=360000, D2=360000, E=None — handwritten kwitansi defeated OCR (A/C/C2=None, B=120000); D and D2 both read 360000.
- `cord_validation_036` (cord, receipt): GT=18999, A=None, B=18400, C=None, C2=184

## Recommendation for Silo
- **Primary recommendation (VLM-first when device RAM permits)**: Ship **`D2` (`Qwen3.5-0.8B` + `mmproj-0.8B`, ≤768px image, `json_schema`, thinking off)** as the default AI receipt extractor on ≥6 GB RAM devices, with **`D` (`Qwen3.5-2B` + `mmproj-2B`)** optional on ≥8 GB devices. On `V`, both hit **91.7% total exact-match** (vs 41.7% for current `B` and `A`) and **90–95% item price recall** (vs 5% `A`, 35% `B`), handling tilted receipts and handwritten kwitansi where OCR fails. `D2` is **2× faster** (15.9s vs 32.2s median on 4-core CPU) and uses **~0.9 GB less peak RSS** (2174 MB vs 3060 MB) than `D`, though `D` avoided a 1-digit drop on `commons_borobudur_taxi` (475000 vs 47500).
- **OCR + Text-LLM path (low-RAM ≤4 GB or when ML Kit OCR is already required)**: Replace current `B` (`llm_current`) with **`C2` (`0.8B` + visual-row OCR `rows` + `json_schema` + OCR-number grounding guard)**. On `S`, `C2` raises exact-match from **51.3% → 66.7%** (and `C` 2B reaches **61.5%**), cuts hallucinated totals **17.9% → 0.0%**, jumps item price recall **22.1% → 58.4%**, and runs faster than `B` (13.2s vs 14.5s median).
- **Immediate fallback**: Keep **`A` (`parseReceiptTextHeuristic`)** (<5 ms after OCR, 0.0% hallucination, 58.2% full-set exact match) as instant/offline fallback, and upgrade `reconstructMultiColumnOcrText` to group ML Kit bounding boxes by visual row overlap rather than `\n\n` block heuristics.
- **Avoid `E` (`hybrid_2b`) with OCR grounding**: Feeding noisy OCR rows + OCR-number grounding guard into the 2B VLM regressed `V` accuracy from **91.7% → 58.3%** (`guard_hurt=2/3` fires) and raised median latency to 43.9s.

## Caveats
- **Desktop CPU ≠ phone**: Measurements ran on a 4-core x86_64 desktop CPU with no GPU/NPU offload (`llama-server -c 4096 -t 4`). Phone latency varies widely by SoC (ARM i8mm/dotprod, Vulkan/OpenCL GPU, thermal throttling) and 3+ GB RSS (`D`) risks OS low-memory kills on 4 GB phones — profile `D2` (`2.17 GB` peak RSS here) on target Android devices first.
- **OCR proxy**: Android ML Kit cannot run on Linux desktop, so `rapidocr_onnxruntime` (PP-OCR ONNX) stood in for OCR.

## Addendum: VLMs on the full subset S, and the shipped OCR heuristic

The V subset (n=12) is small, so `D` and `D2` were re-run on all of S (n=39; `run_vlm.py --subset S`, quiet machine). Same scoring as above, exact-match totals:

| Approach (S, n=39) | Total exact | clean / deg / commons | Item price recall | Median latency (4-core CPU) |
|---|---:|---|---:|---:|
| `A_heuristic` (legacy app heuristic) | 49% | 12/20 · 5/12 · 2/7 | 7% | 2.5 s |
| `B_llm_current` (legacy app LLM prompt) | 51% | 13/20 · 4/12 · 3/7 | 18% | 14.5 s |
| New app heuristic (`receiptText.ts` rows + keyword pick, legacy fallback) | 62% | 14/20 · 6/12 · 4/7 | n/a | ~2.5 s |
| `C_llm_rows_schema_2b` | 62% | 16/20 · 5/12 · 3/7 | 62% | 23.9 s |
| `C2_llm_rows_schema_0.8b` | 67% | 16/20 · 6/12 · 4/7 | 58% | 13.2 s |
| **`D_vlm_2b`** | **90%** | 19/20 · 9/12 · 7/7 | 79% | 33.6 s |
| **`D2_vlm_0.8b`** | **90%** | 20/20 · 9/12 · 6/7 | 80% | 15.4 s |

On the full dataset (n=189 with totals) the new app heuristic scores 74% (legacy: 58%); RapidOCR's ceiling (GT total appears among parsed OCR amounts) is 89%. Reproduce with `node bench/eval/score_app_heuristic.js`.

Other findings:
- `C2` (0.8B, text) invents a date on 34/39 receipts (date not present in OCR text); the 2B does not. The app now drops any LLM date that isn't visible in the OCR text.
- `D_vlm_2b` read both handwritten Commons receipts (taxi, kwitansi) that OCR cannot.
- Replacing a VLM total with the OCR heuristic when it isn't found in the OCR text (`E`) hurt: OCR misses are more common than VLM misreads. The app keeps the VLM total and asks the user to double-check instead.

**What Silo ships (Nov 2026):** default = ML Kit OCR → visual rows → keyword total → local Qwen3.5-2B with JSON schema + grounding (only if the model is already installed) → heuristic fallback. Opt-in "Accurate (AI vision)" = the same Qwen3.5-2B reading the photo (≤768 px) via its vision projector (+668 MB). Phone latency for vision has not been measured yet — do that on a real device before making it the default.

## Addendum 2: OCR engines, APK size, and CORD-fine-tuned models (Nov 2026)

### OCR engines (receipt total via the app's own `receiptText.ts` pipeline, n=189 with totals)

| Engine | Totals correct (all) | S (n=39) | Ceiling* | Median OCR time |
|---|---:|---:|---:|---:|
| RapidOCR (PP-OCRv4 ONNX, desktop stand-in used above) | 68% | 56% | 89% | – |
| ppu-paddle-ocr v6-tiny (the library and default model Silo's PaddleOcrEngine wrapped) | 59% | 44% | 87% | 331 ms |
| ppu-paddle-ocr v6-small | 67% | 51% | 89% | 980 ms |
| ppu-paddle-ocr v5-latin-mobile | 69% | 54% | 92% | 685 ms |
| ML Kit text-recognition 16.0.1 (Android emulator, `bench/mlkit-harness`) | pending | | | |

\*Ceiling = the true total appears among the amounts parsed from the OCR rows. Keyword-pick only (no LLM, no legacy fallback), so these numbers are lower than the 74% "new app heuristic" figure above. Reproduce: `node bench/eval/ppu_ocr.mjs …` then `node bench/eval/score_ocr_engines.js bench/cache/ocr bench/cache/ocr_ppu_*`.

Silo's PaddleOcrEngine never ran on a phone: it imported `PaddleOCR` (ppu-paddle-ocr/mobile exports `PaddleOcrService`) and passed `file://` URIs (the library wants an ArrayBuffer), so every scan fell back to ML Kit. Since even a working PaddleOCR is not better than the alternatives, it was removed.

### APK size (release, arm64-v8a only, `bench`-external build on ai-renderer)

| Build | APK | Δ |
|---|---:|---:|
| Before (ML Kit + PaddleOCR: onnxruntime 36 MB, react-native-skia 13 MB) | 168.2 MB | – |
| PaddleOCR removed | 117.8 MB | −50.4 MB |
| + ML Kit Latin-only (`plugins/withMlKitLatinOnly.js`) | 115.4 MB | −2.4 MB |
| Shipped commit b6d39ef | **115.0 MB** | **−53.2 MB (−32%)** |

Largest remaining item: llama.rn ships 7 CPU-feature variants of llama.cpp (~62 MB together), chosen at runtime.

### CORD-fine-tuned models vs general VLMs (subset S, n=39; totals exact)

| Model | Size on device | Totals | CORD / deg / non-CORD | Item price recall | Median (desktop CPU) |
|---|---:|---:|---|---:|---:|
| Qwen3.5-0.8B + mmproj (D2, general) | 0.74 GB | **90%** | 20/20 · 9/12 · 6/7 | 80% | 15.4 s |
| Qwen3.5-2B + mmproj (D, Silo's "Accurate" mode) | 1.95 GB | **90%** | 19/20 · 9/12 · 7/7 | 79% | 33.6 s |
| `N-Mehdi/qwen3-vl-2b-receipts` Q4_K_M (CORD + French invoices QLoRA) | 1.93 GB | 82% | 19/20 · 9/12 · 4/7 | **93%** | 64 s† |
| `naver-clova-ix/donut-base-finetuned-cord-v2` (PyTorch fp32) | ~0.2 GB (int8 ONNX) | 77% | 20/20 · 10/12 · **0/7** | 91% | 11 s† |
| Xiaomi-OCR-0 Q4_K_M + `Lucasgitguy-co/…-CORD-LoRA` | 0.75 GB | 7% | malformed JSON, Chinese keys | 14% | 40 s† |

†Run on ai-renderer while Android builds shared the CPU; latencies are pessimistic.

Donut on all 197 images: CORD 142/143, CORD-degraded 31/39, non-CORD 0/7. It reads CORD-layout receipts almost perfectly and fails every other receipt; the CORD test split is held out from its training, so this is overfitting to the layout, not leakage. The CORD-tuned Qwen3-VL extracts line items better (93% vs 80%) but loses totals on non-CORD receipts and is 4x slower than the 0.8B. **Decision: keep the general Qwen3.5 VLM for "Accurate" mode.** The 7 non-CORD receipts are too few to rank models on generalization alone; adding the user's own receipt photos to `labels.jsonl` is the most valuable next dataset step.
