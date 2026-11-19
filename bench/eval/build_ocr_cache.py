#!/usr/bin/env python3
"""Run RapidOCR once over all images in bench/labels.jsonl and cache results.

Each image gets bench/cache/ocr/<id>.json containing raw boxes, scores,
timing, `mlkit_like` text, and `rows` text. Resumable: existing valid JSON
files are skipped unless --force is passed.
"""

from __future__ import annotations

import argparse
import os
import json
import sys
import time
from pathlib import Path
from typing import Any

from PIL import Image
from rapidocr_onnxruntime import RapidOCR

REPO_ROOT = Path(__file__).resolve().parents[2]
LABELS_PATH = Path(os.environ.get("SILO_LABELS") or REPO_ROOT / "bench" / "labels.jsonl")
OCR_CACHE_DIR = Path(os.environ.get("SILO_OCR_CACHE") or REPO_ROOT / "bench" / "cache" / "ocr")


def build_mlkit_like(boxes: list[dict[str, Any]]) -> str:
    """Join detected box texts in detector order, mirroring ML Kit result.text."""
    lines = [b["text"].strip() for b in boxes if b.get("text") and b["text"].strip()]
    return "\n".join(lines)


def build_rows_text(boxes: list[dict[str, Any]]) -> str:
    """Group boxes into visual rows by vertical overlap, sorted left->right."""
    if not boxes:
        return ""

    enriched = []
    for b in boxes:
        text = (b.get("text") or "").strip()
        if not text:
            continue
        pts = b["box"]
        xs = [float(p[0]) for p in pts]
        ys = [float(p[1]) for p in pts]
        y_min, y_max = min(ys), max(ys)
        x_min = min(xs)
        h = max(1.0, y_max - y_min)
        y_mid = 0.5 * (y_min + y_max)
        enriched.append({
            "text": text,
            "x_min": x_min,
            "y_min": y_min,
            "y_max": y_max,
            "y_mid": y_mid,
            "h": h,
        })

    enriched.sort(key=lambda item: (item["y_mid"], item["x_min"]))

    rows: list[dict[str, Any]] = []
    for item in enriched:
        best_row = None
        best_score = -1.0
        for row in rows:
            overlap = min(item["y_max"], row["y_max"]) - max(item["y_min"], row["y_min"])
            min_h = min(item["h"], row["avg_h"])
            ratio = overlap / min_h if min_h > 0 else 0.0
            center_dist = abs(item["y_mid"] - row["y_mid"])
            if ratio >= 0.35 or center_dist <= 0.45 * min_h:
                score = ratio - 0.01 * center_dist
                if score > best_score:
                    best_score = score
                    best_row = row

        if best_row is None:
            rows.append({
                "items": [item],
                "y_min": item["y_min"],
                "y_max": item["y_max"],
                "y_mid": item["y_mid"],
                "avg_h": item["h"],
            })
        else:
            best_row["items"].append(item)
            n = len(best_row["items"])
            best_row["y_min"] = sum(x["y_min"] for x in best_row["items"]) / n
            best_row["y_max"] = sum(x["y_max"] for x in best_row["items"]) / n
            best_row["y_mid"] = sum(x["y_mid"] for x in best_row["items"]) / n
            best_row["avg_h"] = sum(x["h"] for x in best_row["items"]) / n

    rows.sort(key=lambda r: r["y_mid"])
    out_lines = []
    for row in rows:
        row["items"].sort(key=lambda x: x["x_min"])
        out_lines.append("  ".join(x["text"] for x in row["items"]))
    return "\n".join(out_lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="Re-run OCR even if cached.")
    parser.add_argument("--limit", type=int, default=0, help="Optional limit for testing.")
    args = parser.parse_args()

    OCR_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    records = [json.loads(line) for line in LABELS_PATH.read_text(encoding="utf-8").splitlines() if line.strip()]
    if args.limit > 0:
        records = records[: args.limit]

    ocr = RapidOCR()
    processed = 0
    skipped = 0
    t_all = time.perf_counter()

    for idx, rec in enumerate(records, 1):
        rec_id = rec["id"]
        out_path = OCR_CACHE_DIR / f"{rec_id}.json"
        if not args.force and out_path.exists():
            try:
                existing = json.loads(out_path.read_text(encoding="utf-8"))
                if "mlkit_like" in existing and "rows" in existing:
                    skipped += 1
                    continue
            except json.JSONDecodeError:
                pass

        img_path = REPO_ROOT / rec["image"]
        with Image.open(img_path) as im:
            width, height = im.size

        t0 = time.perf_counter()
        res, elapse = ocr(str(img_path))
        dt = time.perf_counter() - t0

        boxes = []
        if res:
            for item in res:
                pts, text, score = item
                boxes.append({
                    "box": [[round(float(p[0]), 2), round(float(p[1]), 2)] for p in pts],
                    "text": str(text),
                    "score": round(float(score), 5),
                })

        payload = {
            "id": rec_id,
            "image": rec["image"],
            "width": width,
            "height": height,
            "ocr_time_s": round(dt, 4),
            "elapse": [round(float(e), 4) for e in elapse] if isinstance(elapse, (list, tuple)) else elapse,
            "boxes": boxes,
            "mlkit_like": build_mlkit_like(boxes),
            "rows": build_rows_text(boxes),
        }
        tmp_path = out_path.with_suffix(".json.tmp")
        tmp_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp_path.replace(out_path)
        processed += 1

        if processed % 20 == 0 or idx == len(records):
            elapsed_total = time.perf_counter() - t_all
            print(f"[{idx}/{len(records)}] processed={processed} skipped={skipped} last={rec_id} ({dt:.2f}s) wall={elapsed_total:.1f}s", flush=True)

    print(f"Done: total={len(records)} processed={processed} skipped={skipped} wall={time.perf_counter() - t_all:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
