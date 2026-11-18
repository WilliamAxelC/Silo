#!/usr/bin/env python3
"""VLM approaches on subset V:
  D  : vlm_2b (image <=768px -> 2B + MMPROJ_2B, json_schema, no OCR)
  D2 : vlm_0.8b (image <=768px -> 0.8B + MMPROJ_SMALL, json_schema, no OCR)
  E  : hybrid_2b (image <=768px + rows OCR -> 2B + MMPROJ_2B, json_schema + grounding check)
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import sys
import time
from pathlib import Path
from typing import Any

import requests
from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (
    MMPROJ_2B,
    MMPROJ_SMALL,
    MODEL_TEXT_2B,
    MODEL_TEXT_SMALL,
    RECEIPT_JSON_SCHEMA,
    REPO_ROOT,
    RUNS_DIR,
    LlamaServer,
    append_jsonl,
    extract_ocr_numbers,
    load_existing_jsonl,
    load_labels,
    load_ocr_cache,
    load_subsets,
    parse_receipt_json_with_repair,
)

VLM_SYSTEM_PROMPT = (
    "You extract structured fields from Indonesian receipt images. Output JSON matching the schema. "
    "Indonesian amounts like 60.000 or 60,000 mean 60000 IDR (integers, no decimals). "
    "Use null for unknown merchant or date (YYYY-MM-DD)."
)

HYBRID_SYSTEM_PROMPT = (
    "You extract structured fields from Indonesian receipt images and OCR text. Output JSON matching the schema. "
    "Indonesian amounts like 60.000 or 60,000 mean 60000 IDR (integers, no decimals). "
    "Cross-check the image against the provided OCR rows. Use null for unknown merchant or date (YYYY-MM-DD)."
)


def encode_image_768_b64(img_path: Path) -> tuple[str, tuple[int, int]]:
    with Image.open(img_path) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        w, h = im.size
        longest = max(w, h)
        if longest > 768:
            scale = 768.0 / longest
            new_w = max(1, int(round(w * scale)))
            new_h = max(1, int(round(h * scale)))
            im = im.resize((new_w, new_h), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=88)
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return f"data:image/jpeg;base64,{b64}", im.size


def load_heuristic_map() -> dict[str, dict[str, Any]]:
    path = RUNS_DIR / "A_heuristic.jsonl"
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            obj = json.loads(line)
            out[obj["id"]] = obj
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--approach", required=True, choices=["D", "D2", "E"])
    parser.add_argument("--port", type=int, default=8089)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--subset", choices=["V", "S"], default="V")
    args = parser.parse_args()

    labels = load_labels()
    subsets = load_subsets()
    heur_map = load_heuristic_map() if args.approach == "E" else {}
    target_ids = subsets[args.subset][: args.limit] if args.limit > 0 else subsets[args.subset]

    if args.approach == "D":
        model_path, mmproj_path, out_name = MODEL_TEXT_2B, MMPROJ_2B, "D_vlm_2b.jsonl"
    elif args.approach == "D2":
        model_path, mmproj_path, out_name = MODEL_TEXT_SMALL, MMPROJ_SMALL, "D2_vlm_0.8b.jsonl"
    else:
        model_path, mmproj_path, out_name = MODEL_TEXT_2B, MMPROJ_2B, "E_hybrid_2b.jsonl"

    out_path = RUNS_DIR / out_name
    meta_path = RUNS_DIR / f"{args.approach}_meta.json"
    existing = load_existing_jsonl(out_path)
    todo = [i for i in target_ids if i not in existing]
    print(f"[{args.approach}] total={len(target_ids)}, done={len(existing)}, todo={len(todo)}", flush=True)
    if not todo:
        return 0

    log_path = RUNS_DIR / f"{args.approach}_server.log"
    with LlamaServer(
        model_path=model_path,
        mmproj_path=mmproj_path,
        port=args.port,
        ctx_size=4096,
        threads=4,
        log_path=log_path,
    ) as server:
        for idx, rec_id in enumerate(todo, 1):
            rec = labels[rec_id]
            img_path = REPO_ROOT / rec["image"]
            data_url, scaled_size = encode_image_768_b64(img_path)

            if args.approach == "E":
                ocr = load_ocr_cache(rec_id)
                rows_text = ocr["rows"]
                ocr_nums = extract_ocr_numbers(rows_text)
                ocr_s = float(ocr["ocr_time_s"])
                sys_prompt = HYBRID_SYSTEM_PROMPT
                user_text = (
                    "Extract merchant, date (YYYY-MM-DD or null), total (integer IDR), "
                    f"and items (name, qty, price in integer IDR).\n\nOCR rows:\n{rows_text}"
                )
            else:
                ocr = None
                ocr_nums = set()
                ocr_s = 0.0
                sys_prompt = VLM_SYSTEM_PROMPT
                user_text = (
                    "Extract merchant, date (YYYY-MM-DD or null), total (integer IDR), "
                    "and items (name, qty, price in integer IDR)."
                )

            try:
                t0 = time.perf_counter()
                resp = requests.post(
                    f"{server.base_url}/v1/chat/completions",
                    json={
                        "messages": [
                            {"role": "system", "content": sys_prompt},
                            {
                                "role": "user",
                                "content": [
                                    {"type": "image_url", "image_url": {"url": data_url}},
                                    {"type": "text", "text": user_text},
                                ],
                            },
                        ],
                        "max_tokens": 384,
                        "temperature": 0.0,
                        "cache_prompt": False,
                        "chat_template_kwargs": {"enable_thinking": False},
                        "response_format": {
                            "type": "json_schema",
                            "json_schema": {
                                "name": "receipt",
                                "strict": True,
                                "schema": RECEIPT_JSON_SCHEMA,
                            },
                        },
                    },
                    timeout=900,
                )
                resp.raise_for_status()
                model_s = time.perf_counter() - t0
                data = resp.json()
                server.update_rss()

                usage = data.get("usage") or {}
                content = data["choices"][0]["message"]["content"]
                parsed, _was_repaired = parse_receipt_json_with_repair(content)
                raw_llm_total = parsed.get("total")
                final_total = raw_llm_total
                guard_fired = False
                heur_total = None

                if args.approach == "E":
                    heur_total = heur_map[rec_id].get("total")
                    if raw_llm_total is None or raw_llm_total <= 0 or raw_llm_total not in ocr_nums:
                        guard_fired = True
                        final_total = heur_total

                row = {
                    "id": rec_id,
                    "source": rec["source"],
                    "doc_type": rec["doc_type"],
                    "scaled_size": list(scaled_size),
                    "merchant": parsed.get("merchant"),
                    "date": parsed.get("date"),
                    "total": final_total,
                    "raw_llm_total": raw_llm_total,
                    "heuristic_total": heur_total,
                    "guard_fired": guard_fired,
                    "items": parsed.get("items") or [],
                    "raw_response": content,
                    "prompt_tokens": usage.get("prompt_tokens"),
                    "completion_tokens": usage.get("completion_tokens"),
                    "ocr_time_s": ocr_s,
                    "model_time_s": round(model_s, 4),
                    "total_time_s": round(ocr_s + model_s, 4),
                }
                append_jsonl(out_path, row)
                print(
                    f"[{args.approach} {idx}/{len(todo)}] {rec_id}: total={row['total']} "
                    f"(gt={rec['total']}) model={model_s:.1f}s rss={server.peak_rss_mb:.0f}MB",
                    flush=True,
                )
            except Exception as exc:
                print(f"[{args.approach} {idx}/{len(todo)}] ERROR {rec_id}: {exc}", flush=True)
                append_jsonl(out_path, {"id": rec_id, "error": str(exc)})

        meta = {
            "approach": args.approach,
            "model_path": model_path,
            "mmproj_path": mmproj_path,
            "peak_rss_mb": round(server.peak_rss_mb, 1),
        }
        if meta_path.exists():
            prev = json.loads(meta_path.read_text(encoding="utf-8"))
            meta["peak_rss_mb"] = max(meta["peak_rss_mb"], prev.get("peak_rss_mb", 0.0))
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    return 0


if __name__ == "__main__":
    sys.exit(main())
