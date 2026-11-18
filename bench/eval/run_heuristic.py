#!/usr/bin/env python3
"""Approach A (heuristic): run Silo's real TS parseReceiptTextHeuristic on mlkit_like OCR."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (
    REPO_ROOT,
    RUNS_DIR,
    load_labels,
    load_ocr_cache,
    load_subsets,
    parse_line_items_text,
)

TS_BRIDGE = Path(__file__).resolve().parent / "ts_bridge.js"


def main() -> int:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = RUNS_DIR / "A_heuristic.jsonl"
    labels = load_labels()
    subsets = load_subsets()
    full_ids = subsets["full"]

    payload = []
    ocr_cache_map = {}
    for rec_id in full_ids:
        ocr = load_ocr_cache(rec_id)
        ocr_cache_map[rec_id] = ocr
        payload.append({"id": rec_id, "rawText": ocr["mlkit_like"]})

    t0 = time.perf_counter()
    proc = subprocess.run(
        ["node", str(TS_BRIDGE)],
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        check=True,
    )
    node_wall_s = time.perf_counter() - t0
    ts_results = {item["id"]: item for item in json.loads(proc.stdout)}

    tmp_path = out_path.with_suffix(".jsonl.tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        for rec_id in full_ids:
            ocr = ocr_cache_map[rec_id]
            ts_item = ts_results[rec_id]
            h = ts_item["heuristic"]
            ocr_s = float(ocr["ocr_time_s"])
            heur_s = float(ts_item["heuristicMs"]) / 1000.0
            row = {
                "id": rec_id,
                "source": labels[rec_id]["source"],
                "doc_type": labels[rec_id]["doc_type"],
                "merchant": h.get("extractedMerchant"),
                "date": h.get("extractedDate"),
                "total": h.get("extractedTotal"),
                "category": h.get("extractedCategory"),
                "line_items_text": h.get("extractedLineItems"),
                "items": parse_line_items_text(h.get("extractedLineItems")),
                "filtered_ocr_text": ts_item["filteredOcrText"],
                "ocr_time_s": ocr_s,
                "model_time_s": round(heur_s, 6),
                "total_time_s": round(ocr_s + heur_s, 4),
            }
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    tmp_path.replace(out_path)
    meta_path = RUNS_DIR / "A_meta.json"
    meta_path.write_text(
        json.dumps({"approach": "A", "node_wall_s": round(node_wall_s, 3), "peak_rss_mb": None}, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {out_path} ({len(full_ids)} rows, node_wall={node_wall_s:.2f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
