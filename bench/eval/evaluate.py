#!/usr/bin/env python3
"""Evaluate all benchmark runs and write bench/results/results.json and bench/results/REPORT.md."""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (
    RESULTS_DIR,
    RUNS_DIR,
    extract_ocr_numbers,
    load_labels,
    load_ocr_cache,
    load_subsets,
    parse_line_items_text,
)


def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    if len(s) == 1:
        return round(s[0], 3)
    k = (len(s) - 1) * (p / 100.0)
    f = int(k)
    c = min(f + 1, len(s) - 1)
    val = s[f] + (k - f) * (s[c] - s[f])
    return round(val, 3)


def norm_text(s: str | None) -> str:
    if not s:
        return ""
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def merchant_matches(gt: str | None, pred: str | None) -> bool:
    ng = norm_text(gt)
    np_ = norm_text(pred)
    if not ng or not np_:
        return False
    if ng == np_:
        return True
    if len(np_) >= 5 and (np_ in ng or ng in np_):
        return True
    return SequenceMatcher(None, ng, np_).ratio() >= 0.75


def score_items(gt_items: list[dict[str, Any]], pred_items: list[dict[str, Any]]) -> tuple[int, int, int, int]:
    """Return (price_hits, price_total, name_hits, name_total) using 1-to-1 matching."""
    pred_prices = Counter(
        int(it["price"])
        for it in (pred_items or [])
        if isinstance(it, dict) and isinstance(it.get("price"), (int, float)) and it.get("price") is not None
    )
    price_hits = 0
    price_total = 0
    for gt in gt_items or []:
        gp = gt.get("price")
        if gp is None:
            continue
        price_total += 1
        if pred_prices[int(gp)] > 0:
            pred_prices[int(gp)] -= 1
            price_hits += 1

    pred_names = [
        norm_text(it.get("name"))
        for it in (pred_items or [])
        if isinstance(it, dict) and norm_text(it.get("name"))
    ]
    used = [False] * len(pred_names)
    name_hits = 0
    name_total = 0
    for gt in gt_items or []:
        gn = norm_text(gt.get("name"))
        if not gn:
            continue
        name_total += 1
        best_idx = -1
        best_r = 0.0
        for idx, pn in enumerate(pred_names):
            if used[idx]:
                continue
            r = SequenceMatcher(None, gn, pn).ratio()
            if r >= 0.8 and r > best_r:
                best_r = r
                best_idx = idx
        if best_idx >= 0:
            used[best_idx] = True
            name_hits += 1

    return price_hits, price_total, name_hits, name_total


def load_run(filename: str) -> dict[str, dict[str, Any]]:
    path = RUNS_DIR / filename
    if not path.exists():
        return {}
    out: dict[str, dict[str, Any]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        obj = json.loads(line)
        if "id" in obj and not obj.get("error"):
            out[obj["id"]] = obj
    return out


def eval_slice(
    ids: list[str],
    preds: dict[str, dict[str, Any]],
    labels: dict[str, dict[str, Any]],
    ocr_nums_map: dict[str, set[int]],
) -> dict[str, Any]:
    n = len(ids)
    tot_n = 0
    tot_exact = 0
    tot_1pct = 0
    tot_halluc = 0
    price_hits = 0
    price_total = 0
    name_hits = 0
    name_total = 0
    merch_hits = 0
    merch_total = 0
    date_hits = 0
    date_total = 0
    latencies: list[float] = []
    ocr_latencies: list[float] = []
    model_latencies: list[float] = []
    prompt_tokens: list[int] = []

    b_json_ok = 0
    b_fallback = 0
    b_over_1024 = 0
    b_over_1024_gen = 0
    guard_fired = 0
    guard_helped = 0
    guard_hurt = 0

    for rec_id in ids:
        gt = labels[rec_id]
        pr = preds.get(rec_id)
        if pr is None:
            continue

        if pr.get("total_time_s") is not None:
            latencies.append(float(pr["total_time_s"]))
        if pr.get("ocr_time_s") is not None:
            ocr_latencies.append(float(pr["ocr_time_s"]))
        if pr.get("model_time_s") is not None:
            model_latencies.append(float(pr["model_time_s"]))
        if pr.get("prompt_tokens") is not None:
            prompt_tokens.append(int(pr["prompt_tokens"]))

        if "llm_json_ok" in pr:
            if pr["llm_json_ok"]:
                b_json_ok += 1
            if pr.get("fell_back_to_heuristic"):
                b_fallback += 1
            if pr.get("would_overflow_1024"):
                b_over_1024 += 1
            if pr.get("would_overflow_1024_with_gen"):
                b_over_1024_gen += 1

        if pr.get("guard_fired"):
            guard_fired += 1
            raw_tot = pr.get("raw_llm_total")
            fin_tot = pr.get("total")
            gt_tot = gt.get("total")
            if gt_tot is not None:
                if fin_tot == gt_tot and raw_tot != gt_tot:
                    guard_helped += 1
                elif raw_tot == gt_tot and fin_tot != gt_tot:
                    guard_hurt += 1

        gt_tot = gt.get("total")
        pred_tot = pr.get("total")
        if gt_tot is not None:
            tot_n += 1
            if pred_tot is not None:
                if pred_tot == gt_tot:
                    tot_exact += 1
                if abs(pred_tot - gt_tot) <= 0.01 * max(1, abs(gt_tot)):
                    tot_1pct += 1
                if pred_tot != gt_tot and pred_tot not in ocr_nums_map[rec_id]:
                    tot_halluc += 1

        pred_items = parse_line_items_text(pr["line_items_text"]) if pr.get("line_items_text") else (pr.get("items") or [])
        ph, pt, nh, nt = score_items(gt.get("items") or [], pred_items)
        price_hits += ph
        price_total += pt
        name_hits += nh
        name_total += nt

        if gt["source"] == "commons":
            if gt.get("merchant"):
                merch_total += 1
                if merchant_matches(gt["merchant"], pr.get("merchant")):
                    merch_hits += 1
            if gt.get("date"):
                date_total += 1
                if (pr.get("date") or "").strip() == gt["date"]:
                    date_hits += 1

    res: dict[str, Any] = {
        "n": len([i for i in ids if i in preds]),
        "n_expected": n,
        "total_eval_n": tot_n,
        "total_exact": round(tot_exact / tot_n, 4) if tot_n else None,
        "total_within_1pct": round(tot_1pct / tot_n, 4) if tot_n else None,
        "hallucinated_total_rate": round(tot_halluc / tot_n, 4) if tot_n else None,
        "item_price_recall": round(price_hits / price_total, 4) if price_total else None,
        "item_price_hits": price_hits,
        "item_price_total": price_total,
        "item_name_fuzzy_recall": round(name_hits / name_total, 4) if name_total else None,
        "item_name_hits": name_hits,
        "item_name_total": name_total,
        "merchant_acc": round(merch_hits / merch_total, 4) if merch_total else None,
        "merchant_hits": merch_hits,
        "merchant_total": merch_total,
        "date_acc": round(date_hits / date_total, 4) if date_total else None,
        "date_hits": date_hits,
        "date_total": date_total,
        "latency_median_s": percentile(latencies, 50),
        "latency_p90_s": percentile(latencies, 90),
        "ocr_latency_median_s": percentile(ocr_latencies, 50),
        "model_latency_median_s": percentile(model_latencies, 50),
    }
    if prompt_tokens:
        res["prompt_tokens_median"] = percentile([float(x) for x in prompt_tokens], 50)
        res["prompt_tokens_max"] = max(prompt_tokens)
    if any("llm_json_ok" in preds[i] for i in ids if i in preds):
        res["b_diagnostics"] = {
            "llm_json_ok": b_json_ok,
            "fell_back_to_heuristic": b_fallback,
            "would_overflow_1024": b_over_1024,
            "would_overflow_1024_with_gen": b_over_1024_gen,
        }
    if any("guard_fired" in preds[i] for i in ids if i in preds):
        res["guard_diagnostics"] = {
            "guard_fired": guard_fired,
            "guard_helped": guard_helped,
            "guard_hurt": guard_hurt,
        }
    return res


def eval_approach(
    name: str,
    ids: list[str],
    preds: dict[str, dict[str, Any]],
    labels: dict[str, dict[str, Any]],
    ocr_nums_map: dict[str, set[int]],
    peak_rss_mb: float | None,
) -> dict[str, Any]:
    by_source: dict[str, Any] = {"overall": eval_slice(ids, preds, labels, ocr_nums_map)}
    for src in ("cord", "cord_deg", "commons"):
        sub_ids = [i for i in ids if labels[i]["source"] == src]
        if sub_ids:
            by_source[src] = eval_slice(sub_ids, preds, labels, ocr_nums_map)
    return {
        "name": name,
        "peak_rss_mb": peak_rss_mb,
        "by_source": by_source,
    }


def fmt_pct(v: float | None) -> str:
    return "—" if v is None else f"{v * 100:.1f}%"


def fmt_sec(v: float | None) -> str:
    return "—" if v is None else f"{v:.2f}s"


def find_notable_failures(
    labels: dict[str, dict[str, Any]],
    runs: dict[str, dict[str, dict[str, Any]]],
    s_ids: list[str],
) -> list[dict[str, Any]]:
    examples = []
    # Pick diverse interesting cases from S where A or B failed and C succeeded, or all failed
    for rec_id in s_ids:
        gt = labels[rec_id]
        a = runs.get("A", {}).get(rec_id, {})
        b = runs.get("B", {}).get(rec_id, {})
        c = runs.get("C", {}).get(rec_id, {})
        d = runs.get("D", {}).get(rec_id, {})
        gt_tot = gt.get("total")
        if gt_tot is None:
            continue
        present = [x for x in (a, b, c, d) if x]
        if any(x.get("total") != gt_tot for x in present):
            examples.append({
                "id": rec_id,
                "source": gt["source"],
                "doc_type": gt["doc_type"],
                "gt_total": gt_tot,
                "A_total": a.get("total"),
                "B_total": b.get("total"),
                "C_total": c.get("total"),
                "D_total": d.get("total") if d else None,
            })
    # Prioritize 1 cord, 1 cord_deg, 2 commons, 1 where C helped or failed
    picked: list[dict[str, Any]] = []
    for want_src in ("cord", "cord_deg", "commons"):
        for ex in examples:
            if ex["source"] == want_src and ex not in picked:
                picked.append(ex)
                if len([p for p in picked if p["source"] == want_src]) >= (2 if want_src == "commons" else 1):
                    break
    for ex in examples:
        if len(picked) >= 5:
            break
        if ex not in picked:
            picked.append(ex)
    return picked[:5]


def main() -> int:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    labels = load_labels()
    subsets = load_subsets()
    ocr_nums_map = {rec_id: extract_ocr_numbers(load_ocr_cache(rec_id)["rows"]) for rec_id in subsets["full"]}

    run_specs = [
        ("A", "A_heuristic.jsonl"),
        ("B", "B_llm_current.jsonl"),
        ("C", "C_llm_rows_schema_2b.jsonl"),
        ("C2", "C2_llm_rows_schema_0.8b.jsonl"),
        ("D", "D_vlm_2b.jsonl"),
        ("D2", "D2_vlm_0.8b.jsonl"),
        ("E", "E_hybrid_2b.jsonl"),
    ]
    runs: dict[str, dict[str, dict[str, Any]]] = {}
    metas: dict[str, dict[str, Any]] = {}
    for code, fname in run_specs:
        data = load_run(fname)
        if data:
            runs[code] = data
        meta_path = RUNS_DIR / f"{code}_meta.json"
        if meta_path.exists():
            metas[code] = json.loads(meta_path.read_text(encoding="utf-8"))

    results: dict[str, Any] = {
        "dataset": {
            "full_n": len(subsets["full"]),
            "S_n": len(subsets["S"]),
            "V_n": len(subsets["V"]),
            "seed": subsets["seed"],
            "S_ids": subsets["S"],
            "V_ids": subsets["V"],
        },
        "full": {},
        "S": {},
        "V": {},
    }

    if "A" in runs:
        results["full"]["A_heuristic"] = eval_approach(
            "A_heuristic", subsets["full"], runs["A"], labels, ocr_nums_map, metas.get("A", {}).get("peak_rss_mb")
        )

    for code, label_name in [
        ("A", "A_heuristic"),
        ("B", "B_llm_current"),
        ("C", "C_llm_rows_schema_2b"),
        ("C2", "C2_llm_rows_schema_0.8b"),
    ]:
        if code in runs:
            results["S"][label_name] = eval_approach(
                label_name, subsets["S"], runs[code], labels, ocr_nums_map, metas.get(code, {}).get("peak_rss_mb")
            )

    for code, label_name in [
        ("A", "A_heuristic"),
        ("B", "B_llm_current"),
        ("C", "C_llm_rows_schema_2b"),
        ("C2", "C2_llm_rows_schema_0.8b"),
        ("D", "D_vlm_2b"),
        ("D2", "D2_vlm_0.8b"),
        ("E", "E_hybrid_2b"),
    ]:
        if code in runs:
            results["V"][label_name] = eval_approach(
                label_name, subsets["V"], runs[code], labels, ocr_nums_map, metas.get(code, {}).get("peak_rss_mb")
            )

    failures = find_notable_failures(labels, runs, subsets["S"])
    results["notable_failures"] = failures

    (RESULTS_DIR / "results.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")

    # Build REPORT.md
    lines: list[str] = [
        "# Silo Receipt Extraction Benchmark Report",
        "",
        "## Method & Environment",
        f"- **Dataset**: {len(subsets['full'])} images (`cord`: 150, `cord_deg`: 40, `commons`: 7). "
        f"Text-LLM subset `S` (seed 0, n={len(subsets['S'])}): 20 `cord` + 12 `cord_deg` + 7 `commons`. "
        f"VLM subset `V ⊂ S` (seed 0, n={len(subsets['V'])}): 6 `cord` + 3 `cord_deg` + 3 `commons` receipts (non-tickets).",
        "- **OCR**: `rapidocr_onnxruntime` (PP-OCR ONNX) run once per image and cached (`bench/cache/ocr/<id>.json`). "
        "**Caveat**: Android ML Kit cannot run on Linux desktop, so RapidOCR stands in for OCR; `mlkit_like` joins detector boxes in order (like ML Kit `result.text`), while `rows` groups boxes by vertical overlap and joins columns with two spaces.",
        "- **TS Heuristic (A)**: Runs Silo's exact `src/services/ocr/MlKitEngine.ts` (`parseReceiptTextHeuristic`) in Node via `sucrase` with stubbed RN/Expo modules.",
        "- **LLM / VLM Runtime**: `llama-server` (`-c 4096 -t 4`, temperature `0`, thinking disabled via `--reasoning off` and `chat_template_kwargs: {\"enable_thinking\": false}` except raw ChatML in `B`). Models: `Qwen3.5-2B-Q4_K_M` and `Qwen3.5-0.8B-Q4_K_M` (+ F16 `mmproj` for VLMs, images downscaled to ≤768px longest side).",
        "",
        "## Results on Subset S (n=39: 20 clean, 12 deg, 7 commons)",
        "",
        "| Approach | Clean Exact | Deg Exact | Commons Exact | Overall Exact | ±1% | Halluc Total | Item Price Rec | Item Name Match | Merch Acc (C) | Date Acc (C) | Med Lat | p90 Lat | Peak RSS |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]

    for key, obj in results["S"].items():
        bs = obj["by_source"]
        ov = bs["overall"]
        rss = f"{obj['peak_rss_mb']:.0f} MB" if obj.get("peak_rss_mb") else "—"
        lines.append(
            f"| `{key}` | {fmt_pct(bs.get('cord', {}).get('total_exact'))} | "
            f"{fmt_pct(bs.get('cord_deg', {}).get('total_exact'))} | "
            f"{fmt_pct(bs.get('commons', {}).get('total_exact'))} | "
            f"{fmt_pct(ov.get('total_exact'))} | {fmt_pct(ov.get('total_within_1pct'))} | "
            f"{fmt_pct(ov.get('hallucinated_total_rate'))} | "
            f"{fmt_pct(ov.get('item_price_recall'))} | {fmt_pct(ov.get('item_name_fuzzy_recall'))} | "
            f"{fmt_pct(bs.get('commons', {}).get('merchant_acc'))} | {fmt_pct(bs.get('commons', {}).get('date_acc'))} | "
            f"{fmt_sec(ov.get('latency_median_s'))} | {fmt_sec(ov.get('latency_p90_s'))} | {rss} |"
        )

    lines.extend([
        "",
        "## Results on Full Dataset (n=197)",
        "",
        "| Approach | Clean Exact | Deg Exact | Commons Exact | Overall Exact | ±1% | Halluc Total | Item Price Rec | Item Name Match | Med Lat | p90 Lat |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ])
    for key, obj in results["full"].items():
        bs = obj["by_source"]
        ov = bs["overall"]
        lines.append(
            f"| `{key}` | {fmt_pct(bs.get('cord', {}).get('total_exact'))} | "
            f"{fmt_pct(bs.get('cord_deg', {}).get('total_exact'))} | "
            f"{fmt_pct(bs.get('commons', {}).get('total_exact'))} | "
            f"{fmt_pct(ov.get('total_exact'))} | {fmt_pct(ov.get('total_within_1pct'))} | "
            f"{fmt_pct(ov.get('hallucinated_total_rate'))} | "
            f"{fmt_pct(ov.get('item_price_recall'))} | {fmt_pct(ov.get('item_name_fuzzy_recall'))} | "
            f"{fmt_sec(ov.get('latency_median_s'))} | {fmt_sec(ov.get('latency_p90_s'))} |"
        )

    lines.extend([
        "",
        "## Results on Subset V (n=12: 6 clean, 3 deg, 3 commons receipts)",
        "",
        "| Approach | Clean Exact | Deg Exact | Commons Exact | Overall Exact | ±1% | Halluc Total | Item Price Rec | Item Name Match | Merch Acc (C) | Date Acc (C) | Med Lat | p90 Lat | Peak RSS |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ])
    for key, obj in results["V"].items():
        bs = obj["by_source"]
        ov = bs["overall"]
        rss = f"{obj['peak_rss_mb']:.0f} MB" if obj.get("peak_rss_mb") else "—"
        lines.append(
            f"| `{key}` | {fmt_pct(bs.get('cord', {}).get('total_exact'))} | "
            f"{fmt_pct(bs.get('cord_deg', {}).get('total_exact'))} | "
            f"{fmt_pct(bs.get('commons', {}).get('total_exact'))} | "
            f"{fmt_pct(ov.get('total_exact'))} | {fmt_pct(ov.get('total_within_1pct'))} | "
            f"{fmt_pct(ov.get('hallucinated_total_rate'))} | "
            f"{fmt_pct(ov.get('item_price_recall'))} | {fmt_pct(ov.get('item_name_fuzzy_recall'))} | "
            f"{fmt_pct(bs.get('commons', {}).get('merchant_acc'))} | {fmt_pct(bs.get('commons', {}).get('date_acc'))} | "
            f"{fmt_sec(ov.get('latency_median_s'))} | {fmt_sec(ov.get('latency_p90_s'))} | {rss} |"
        )

    # Diagnostics section
    lines.extend(["", "## Diagnostics"])
    if "B_llm_current" in results["S"]:
        b_ov = results["S"]["B_llm_current"]["by_source"]["overall"]
        bd = b_ov.get("b_diagnostics", {})
        lines.append(
            f"- **B (`llm_current`)**: JSON parse OK {bd.get('llm_json_ok', 0)}/{b_ov['n']}, "
            f"fell back to heuristic {bd.get('fell_back_to_heuristic', 0)}/{b_ov['n']}, "
            f"prompt tokens median={b_ov.get('prompt_tokens_median')}, max={b_ov.get('prompt_tokens_max')}, "
            f"overflow `n_ctx=1024` (prompt only / +80 gen)={bd.get('would_overflow_1024', 0)} / {bd.get('would_overflow_1024_with_gen', 0)}."
        )
    for k in ("C_llm_rows_schema_2b", "C2_llm_rows_schema_0.8b"):
        if k in results["S"]:
            ov = results["S"][k]["by_source"]["overall"]
            gd = ov.get("guard_diagnostics", {})
            lines.append(
                f"- **{k} grounding guard (S)**: fired {gd.get('guard_fired', 0)}/{ov['n']}, "
                f"helped={gd.get('guard_helped', 0)}, hurt={gd.get('guard_hurt', 0)}."
            )
    if "E_hybrid_2b" in results["V"]:
        ov = results["V"]["E_hybrid_2b"]["by_source"]["overall"]
        gd = ov.get("guard_diagnostics", {})
        lines.append(
            f"- **E (`hybrid_2b`) grounding guard (V)**: fired {gd.get('guard_fired', 0)}/{ov['n']}, "
            f"helped={gd.get('guard_helped', 0)}, hurt={gd.get('guard_hurt', 0)}."
        )

    lines.extend(["", "## Notable Failure Examples"])
    for ex in failures:
        extra = ""
        if ex["id"] == "cord_test_070":
            extra = " — RapidOCR read `DU 1,565,938` below `SUBTOTAL 1,343,000`; A/B/C2 picked subtotal, C recovered 1565938."
        elif ex["id"] == "cord_test_035_deg":
            extra = " — ~7° tilt aligned `TOTAL` with `104,000` (cash) and OCR dropped `4` in `54,000`; all OCR methods failed, D/D2 succeeded."
        elif ex["id"] == "cord_validation_027":
            extra = " — OCR missed `17,999` total line; D/D2 read `17999` from pixels, E's OCR grounding guard overwrote it with `1636`."
        elif ex["id"] == "commons_borobudur_taxi":
            extra = " — noisy receipt OCR failed (A/C/C2=700, B=30); D extracted 475000, D2 dropped one zero (47500)."
        elif ex["id"] == "commons_kwitansi_ahmad_2018":
            extra = " — handwritten kwitansi defeated OCR (A/C/C2=None, B=120000); D and D2 both read 360000."
        parts = [f"A={ex['A_total']}", f"B={ex['B_total']}", f"C={ex['C_total']}"]
        if "C2" in runs and ex["id"] in runs["C2"]:
            parts.append(f"C2={runs['C2'][ex['id']]['total']}")
        if "D" in runs and ex["id"] in runs["D"]:
            parts.append(f"D={runs['D'][ex['id']]['total']}")
        if "D2" in runs and ex["id"] in runs["D2"]:
            parts.append(f"D2={runs['D2'][ex['id']]['total']}")
        if "E" in runs and ex["id"] in runs["E"]:
            parts.append(f"E={runs['E'][ex['id']]['total']}")
        lines.append(f"- `{ex['id']}` ({ex['source']}, {ex['doc_type']}): GT={ex['gt_total']}, " + ", ".join(parts) + extra)

    lines.extend([
        "",
        "## Recommendation for Silo",
        "- **Primary recommendation (VLM-first when device RAM permits)**: Ship **`D2` (`Qwen3.5-0.8B` + `mmproj-0.8B`, ≤768px image, `json_schema`, thinking off)** as the default AI receipt extractor on ≥6 GB RAM devices, with **`D` (`Qwen3.5-2B` + `mmproj-2B`)** optional on ≥8 GB devices. On `V`, both hit **91.7% total exact-match** (vs 41.7% for current `B` and `A`) and **90–95% item price recall** (vs 5% `A`, 35% `B`), handling tilted receipts and handwritten kwitansi where OCR fails. `D2` is **2× faster** (15.9s vs 32.2s median on 4-core CPU) and uses **~0.9 GB less peak RSS** (2174 MB vs 3060 MB) than `D`, though `D` avoided a 1-digit drop on `commons_borobudur_taxi` (475000 vs 47500).",
        "- **OCR + Text-LLM path (low-RAM ≤4 GB or when ML Kit OCR is already required)**: Replace current `B` (`llm_current`) with **`C2` (`0.8B` + visual-row OCR `rows` + `json_schema` + OCR-number grounding guard)**. On `S`, `C2` raises exact-match from **51.3% → 66.7%** (and `C` 2B reaches **61.5%**), cuts hallucinated totals **17.9% → 0.0%**, jumps item price recall **22.1% → 58.4%**, and runs faster than `B` (13.2s vs 14.5s median).",
        "- **Immediate fallback**: Keep **`A` (`parseReceiptTextHeuristic`)** (<5 ms after OCR, 0.0% hallucination, 58.2% full-set exact match) as instant/offline fallback, and upgrade `reconstructMultiColumnOcrText` to group ML Kit bounding boxes by visual row overlap rather than `\\n\\n` block heuristics.",
        "- **Avoid `E` (`hybrid_2b`) with OCR grounding**: Feeding noisy OCR rows + OCR-number grounding guard into the 2B VLM regressed `V` accuracy from **91.7% → 58.3%** (`guard_hurt=2/3` fires) and raised median latency to 43.9s.",
        "",
        "## Caveats",
        "- **Desktop CPU ≠ phone**: Measurements ran on a 4-core x86_64 desktop CPU with no GPU/NPU offload (`llama-server -c 4096 -t 4`). Phone latency varies widely by SoC (ARM i8mm/dotprod, Vulkan/OpenCL GPU, thermal throttling) and 3+ GB RSS (`D`) risks OS low-memory kills on 4 GB phones — profile `D2` (`2.17 GB` peak RSS here) on target Android devices first.",
        "- **OCR proxy**: Android ML Kit cannot run on Linux desktop, so `rapidocr_onnxruntime` (PP-OCR ONNX) stood in for OCR.",
    ])

    (RESULTS_DIR / "REPORT.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {RESULTS_DIR / 'results.json'} and {RESULTS_DIR / 'REPORT.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
