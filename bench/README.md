# Silo Indonesian Receipt Benchmark Dataset

A lightweight, reproducible benchmark of **197** Indonesian receipt and payment-document photos for OCR / VLM structured extraction evaluation.

## Contents & Counts

All records are indexed in `bench/labels.jsonl` with images in `bench/data/images/`:

| Source (`source`) | Count | Description | Label Source |
|---|---:|---|---|
| `cord` | 150 | CORD v2 `test` (100) + first 50 of `validation` (50) | `cord_gt` |
| `cord_deg` | 40 | Seeded degraded variants of 40 CORD `test` receipts (rotation ±8°, slight perspective warp, Gaussian blur r=1–2, brightness 0.55–0.80, JPEG q=35) | `cord_gt` |
| `commons` | 7 | Real Indonesian receipts, payment slips, kwitansi, and priced tickets from Wikimedia Commons | `manual` |
| **Total** | **197** | **189** with non-null `total`, **125** with non-null `subtotal` | — |

Document types (`doc_type`):
- `receipt`: 192 (190 CORD/degraded + 2 Commons)
- `entrance_ticket`: 2 (Commons)
- `payment_slip`: 1 (Commons BCA EDC terminal slip)
- `kwitansi`: 1 (Commons handwritten meal kwitansi)
- `train_ticket`: 1 (Commons KAI Bandung Raya ticket)

## Schema (`bench/labels.jsonl`)

Each line is a JSON object:

```json
{
  "id": "cord_test_014",
  "source": "cord | cord_deg | commons",
  "license": "CC-BY-4.0",
  "attribution": "...",
  "image": "bench/data/images/cord_test_014.jpg",
  "doc_type": "receipt",
  "total": 281435,
  "subtotal": 238000,
  "merchant": null,
  "date": null,
  "items": [{"name": "RedVelvet Cheese Slc", "qty": 1, "price": 38000}],
  "label_source": "cord_gt | manual"
}
```

All monetary values (`total`, `subtotal`, item `price`) are normalized to integer IDR (rupiah).

## How to Fetch / Rebuild

Large Hugging Face parquet downloads are cached under `~/.cache/silo-bench/` and only the `test` and `validation` shards are downloaded.

```bash
uv venv bench/.venv
VIRTUAL_ENV=$PWD/bench/.venv uv pip install huggingface_hub pyarrow pillow requests
bench/.venv/bin/python bench/fetch_dataset.py
```

Manual labels and file mappings for the Wikimedia Commons subset live in `bench/commons_labels.json`.

## Licenses & Citation

- **CORD v2** (`190` images: `cord` + `cord_deg`): `CC-BY-4.0`. Please cite:
  > Seunghyun Park, Seung Shin, Bado Lee, Junyeop Lee, Jaeheung Surh, Minjoon Seo, and Hwalsuk Lee. 2019. **CORD: A Consolidated Receipt Dataset for Post-OCR Parsing**. *Document Intelligence Workshop at NeurIPS 2019*.
- **Wikimedia Commons** (`7` images: `commons`): `CC BY 4.0` (2), `CC BY 2.0` (1), `CC BY-SA 4.0` (4). Per-image author, license, and source page URL are recorded in `license` and `attribution` in `bench/labels.jsonl`.

## Caveats

- **CORD has no merchant or date labels**: CORD v2 blurs store headers, addresses, and identifying metadata for privacy, so `merchant` and `date` are `null` for all `cord` and `cord_deg` rows. In addition, 8 CORD rows in this slice lack `total_price` in `gt_parse.total` and therefore have `total: null`.
- **Commons labels are manual**: Labels in `bench/commons_labels.json` were transcribed directly from the images. Fields not printed on the document itself (such as a missing year on `commons_borobudur_taxi` or missing date on `commons_gunung_slamet_entrance`) are left `null`.

## Results

End-to-end extraction benchmark (`bench/eval/`, `bench/results/REPORT.md`, `bench/results/results.json`) using RapidOCR (`rapidocr_onnxruntime`) as desktop proxy for ML Kit, Silo's real `parseReceiptTextHeuristic` (`A`), and `llama-server` (`-c 4096 -t 4`, `Qwen3.5-2B-Q4_K_M` and `Qwen3.5-0.8B-Q4_K_M` + F16 `mmproj` on ≤768px images):

### Subset S (n=39: 20 clean, 12 deg, 7 commons)
| Approach | Clean | Deg | Commons | Overall | Halluc Total | Item Price Rec | Med Lat |
|---|---:|---:|---:|---:|---:|---:|---:|
| `A_heuristic` | 60.0% | 41.7% | 28.6% | 48.7% | 0.0% | 7.8% | 2.47s |
| `B_llm_current` | 65.0% | 33.3% | 42.9% | 51.3% | 17.9% | 22.1% | 14.48s |
| `C_llm_rows_schema_2b` | 80.0% | 41.7% | 42.9% | 61.5% | 0.0% | 61.0% | 23.95s |
| `C2_llm_rows_schema_0.8b` | 80.0% | 50.0% | 57.1% | 66.7% | 0.0% | 58.4% | 13.21s |

*(Full n=197 `A_heuristic`: 60.8% clean, 53.8% deg, 28.6% commons, 58.2% overall, 1.9% item price recall, 2.03s median.)*

### Subset V (n=12: 6 clean, 3 deg, 3 commons receipts)
| Approach | Clean | Deg | Commons | Overall | Halluc Total | Item Price Rec | Med Lat | Peak RSS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `A_heuristic` | 50.0% | 33.3% | 33.3% | 41.7% | 0.0% | 5.0% | 2.32s | 792 MB |
| `B_llm_current` | 50.0% | 33.3% | 33.3% | 41.7% | 16.7% | 35.0% | 14.87s | 2942 MB |
| `C_llm_rows_schema_2b` | 50.0% | 33.3% | 33.3% | 41.7% | 0.0% | 75.0% | 19.43s | 2925 MB |
| `C2_llm_rows_schema_0.8b` | 66.7% | 33.3% | 33.3% | 50.0% | 0.0% | 60.0% | 12.63s | 2881 MB |
| `D_vlm_2b` | 83.3% | 100.0% | 100.0% | 91.7% | 0.0% | 95.0% | 32.18s | 3060 MB |
| `D2_vlm_0.8b` | 100.0% | 100.0% | 66.7% | 91.7% | 8.3% | 90.0% | 15.92s | 2174 MB |
| `E_hybrid_2b` | 66.7% | 66.7% | 33.3% | 58.3% | 0.0% | 85.0% | 43.94s | 3072 MB |

**Takeaway**: Direct VLM (`D2_vlm_0.8b` default on ≥6 GB phones, `D_vlm_2b` optional on ≥8 GB) hits **91.7%** total exact-match and **90–95%** item price recall without OCR. For OCR-first / ≤4 GB phones, **`C2_llm_rows_schema_0.8b`** beats current `B` (66.7% vs 51.3% total, 0.0% vs 17.9% hallucinations, 58.4% vs 22.1% item price recall) with `A_heuristic` as instant fallback. See [bench/results/REPORT.md](results/REPORT.md).
