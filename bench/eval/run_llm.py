#!/usr/bin/env python3
"""Text-LLM approaches on subset S:
  B  : llm_current (exact app raw ChatML prompt + /completion + JSON repair + heuristic fallback)
  C  : llm_rows_schema_2b (rows text + json_schema + grounding check)
  C2 : llm_rows_schema_0.8b (same as C with 0.8B model)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (
    MODEL_TEXT_2B,
    MODEL_TEXT_SMALL,
    RECEIPT_JSON_SCHEMA,
    RUNS_DIR,
    LlamaServer,
    append_jsonl,
    extract_ocr_numbers,
    load_existing_jsonl,
    load_labels,
    load_ocr_cache,
    load_subsets,
    parse_line_items_text,
    parse_receipt_json_with_repair,
)

APP_SYSTEM_PROMPT = (
    'You are a fast financial receipt parser. Extract fields from the receipt into a single raw JSON object '
    'with keys: "merchantName" (string), "totalAmount" (integer number), '
    '"category" (one of ["Food & Dining","Groceries","Transport","Bills","Entertainment","Shopping"]), '
    '"date" (YYYY-MM-DD), "lineItemsText" (comma-separated items). '
    'In Indonesian receipts, amounts with dots like 60.000 mean 60000. '
    'Do NOT think or explain. Output JSON directly.'
)

SCHEMA_SYSTEM_PROMPT = (
    "You extract structured fields from Indonesian receipt OCR text. Output JSON matching the schema. "
    "Indonesian amounts like 60.000 or 60,000 mean 60000 IDR (integers, no decimals). "
    "Do not invent numbers not present in the OCR text. Use null for unknown merchant or date (YYYY-MM-DD)."
)


def load_heuristic_map() -> dict[str, dict[str, Any]]:
    path = RUNS_DIR / "A_heuristic.jsonl"
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            obj = json.loads(line)
            out[obj["id"]] = obj
    return out


def parse_app_json_and_fallback(response_text: str, heur: dict[str, Any]) -> tuple[dict[str, Any], bool, bool]:
    """Replicate agent.ts lines 1050-1092 JSON repair & heuristic fallback."""
    full_json = response_text.strip()
    if not full_json.startswith("{"):
        full_json = '{"merchantName":' + full_json
    if not full_json.endswith("}"):
        full_json = full_json + "}"

    m = re.search(r"\{[\s\S]*\}", full_json)
    if m:
        try:
            parsed = json.loads(m.group(0))
            total_amount: int | None = None
            raw_tot = parsed.get("totalAmount")
            if isinstance(raw_tot, (int, float)) and not isinstance(raw_tot, bool):
                total_amount = int(round(raw_tot))
            elif isinstance(raw_tot, str):
                digits = re.sub(r"[^\d]", "", raw_tot)
                if digits:
                    val = int(digits)
                    if val > 0:
                        total_amount = val

            used_fallback_total = total_amount is None
            final_total = total_amount if total_amount is not None else heur.get("total")
            line_items_text = parsed.get("lineItemsText") or heur.get("line_items_text")
            return (
                {
                    "merchant": parsed.get("merchantName") or heur.get("merchant"),
                    "total": final_total,
                    "category": parsed.get("category") or heur.get("category"),
                    "line_items_text": line_items_text,
                    "items": parse_line_items_text(line_items_text),
                    "date": parsed.get("date") or heur.get("date"),
                    "raw_llm_total": total_amount,
                },
                True,
                used_fallback_total,
            )
        except json.JSONDecodeError:
            pass

    return (
        {
            "merchant": heur.get("merchant"),
            "total": heur.get("total"),
            "category": heur.get("category"),
            "line_items_text": heur.get("line_items_text"),
            "items": heur.get("items", []),
            "date": heur.get("date"),
            "raw_llm_total": None,
        },
        False,
        True,
    )


def run_b(server: LlamaServer, rec_id: str, rec: dict[str, Any], ocr: dict[str, Any], heur: dict[str, Any]) -> dict[str, Any]:
    filtered = heur["filtered_ocr_text"]
    prompt = (
        f"<|im_start|>system\n{APP_SYSTEM_PROMPT}<|im_end|>\n"
        f"<|im_start|>user\nReceipt text:\n{filtered}<|im_end|>\n"
        f'<|im_start|>assistant\n{{"merchantName":'
    )
    t0 = time.perf_counter()
    resp = requests.post(
        f"{server.base_url}/completion",
        json={
            "prompt": prompt,
            "n_predict": 80,
            "temperature": 0.0,
            "stop": ["}", "<|im_end|>"],
            "cache_prompt": False,
        },
        timeout=300,
    )
    resp.raise_for_status()
    model_s = time.perf_counter() - t0
    data = resp.json()
    server.update_rss()

    timings = data.get("timings") or {}
    prompt_tokens = data.get("tokens_evaluated") or timings.get("prompt_n")
    completion_tokens = data.get("tokens_predicted") or timings.get("predicted_n")
    raw_content = data.get("content", "")

    parsed, json_ok, fell_back_total = parse_app_json_and_fallback(raw_content, heur)
    ocr_s = float(ocr["ocr_time_s"])
    return {
        "id": rec_id,
        "source": rec["source"],
        "doc_type": rec["doc_type"],
        **parsed,
        "raw_response": raw_content,
        "llm_json_ok": json_ok,
        "fell_back_to_heuristic": (not json_ok) or fell_back_total,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "would_overflow_1024": (prompt_tokens is not None and prompt_tokens > 1024),
        "would_overflow_1024_with_gen": (prompt_tokens is not None and (prompt_tokens + 80) > 1024),
        "ocr_time_s": ocr_s,
        "model_time_s": round(model_s, 4),
        "total_time_s": round(ocr_s + model_s, 4),
    }


def run_c(server: LlamaServer, rec_id: str, rec: dict[str, Any], ocr: dict[str, Any], heur: dict[str, Any]) -> dict[str, Any]:
    rows_text = ocr["rows"]
    ocr_nums = extract_ocr_numbers(rows_text)
    t0 = time.perf_counter()
    resp = requests.post(
        f"{server.base_url}/v1/chat/completions",
        json={
            "messages": [
                {"role": "system", "content": SCHEMA_SYSTEM_PROMPT},
                {"role": "user", "content": f"OCR text (visual rows):\n{rows_text}"},
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
        timeout=300,
    )
    resp.raise_for_status()
    model_s = time.perf_counter() - t0
    data = resp.json()
    server.update_rss()

    usage = data.get("usage") or {}
    content = data["choices"][0]["message"]["content"]
    parsed, was_repaired = parse_receipt_json_with_repair(content)
    raw_llm_total = parsed.get("total")
    heur_total = heur.get("total")

    guard_fired = False
    final_total = raw_llm_total
    if raw_llm_total is None or raw_llm_total <= 0 or raw_llm_total not in ocr_nums:
        guard_fired = True
        final_total = heur_total

    ocr_s = float(ocr["ocr_time_s"])
    return {
        "id": rec_id,
        "source": rec["source"],
        "doc_type": rec["doc_type"],
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--approach", required=True, choices=["B", "C", "C2"])
    parser.add_argument("--port", type=int, default=8089)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    labels = load_labels()
    subsets = load_subsets()
    heur_map = load_heuristic_map()
    target_ids = subsets["S"][: args.limit] if args.limit > 0 else subsets["S"]

    if args.approach == "B":
        model_path = MODEL_TEXT_2B
        out_name = "B_llm_current.jsonl"
    elif args.approach == "C":
        model_path = MODEL_TEXT_2B
        out_name = "C_llm_rows_schema_2b.jsonl"
    else:
        model_path = MODEL_TEXT_SMALL
        out_name = "C2_llm_rows_schema_0.8b.jsonl"

    out_path = RUNS_DIR / out_name
    meta_path = RUNS_DIR / f"{args.approach}_meta.json"
    existing = load_existing_jsonl(out_path)
    todo = [i for i in target_ids if i not in existing]
    print(f"[{args.approach}] total={len(target_ids)}, done={len(existing)}, todo={len(todo)}", flush=True)
    if not todo:
        return 0

    log_path = RUNS_DIR / f"{args.approach}_server.log"
    with LlamaServer(model_path=model_path, port=args.port, ctx_size=4096, threads=4, log_path=log_path) as server:
        for idx, rec_id in enumerate(todo, 1):
            rec = labels[rec_id]
            ocr = load_ocr_cache(rec_id)
            heur = heur_map[rec_id]
            try:
                if args.approach == "B":
                    row = run_b(server, rec_id, rec, ocr, heur)
                else:
                    row = run_c(server, rec_id, rec, ocr, heur)
                append_jsonl(out_path, row)
                print(
                    f"[{args.approach} {idx}/{len(todo)}] {rec_id}: total={row['total']} "
                    f"(gt={rec['total']}) model={row['model_time_s']:.2f}s rss={server.peak_rss_mb:.0f}MB",
                    flush=True,
                )
            except Exception as exc:
                print(f"[{args.approach} {idx}/{len(todo)}] ERROR {rec_id}: {exc}", flush=True)
                append_jsonl(out_path, {"id": rec_id, "error": str(exc)})

        meta = {
            "approach": args.approach,
            "model_path": model_path,
            "peak_rss_mb": round(server.peak_rss_mb, 1),
        }
        if meta_path.exists():
            prev = json.loads(meta_path.read_text(encoding="utf-8"))
            meta["peak_rss_mb"] = max(meta["peak_rss_mb"], prev.get("peak_rss_mb", 0.0))
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    return 0


if __name__ == "__main__":
    sys.exit(main())
