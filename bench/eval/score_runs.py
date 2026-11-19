#!/usr/bin/env python3
"""Score run JSONL files (run_vlm.py format) against a labels file.

usage: SILO_LABELS=bench/data/user_labels.jsonl python3 bench/eval/score_runs.py RUN.jsonl [RUN.jsonl ...] [-v]
Totals accept any value in a label's `total_accept` (photos holding several receipts).
"""
import json, os, re, statistics, sys
from pathlib import Path

labels_path = Path(os.environ.get("SILO_LABELS") or Path(__file__).resolve().parents[1] / "labels.jsonl")
labels = {o["id"]: o for o in map(json.loads, labels_path.read_text().splitlines()) if o}
verbose = "-v" in sys.argv


def norm_date(d):
    """YYYY-MM-DD from ISO or day-first (DD/MM/YYYY, DD-MM-YY) strings, as the app's date parser reads them."""
    if not d:
        return None
    m = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})", d)
    if m:
        return f"{m[1]}-{int(m[2]):02d}-{int(m[3]):02d}"
    m = re.match(r"(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})", d)
    if m:
        y = m[3] if len(m[3]) == 4 else "20" + m[3]
        return f"{y}-{int(m[2]):02d}-{int(m[1]):02d}"
    return d

for run in [a for a in sys.argv[1:] if a != "-v"]:
    rows = [json.loads(l) for l in Path(run).read_text().splitlines() if l.strip()]
    tot = tot_n = date_ok = date_n = item_hit = item_n = 0
    secs = []
    for r in rows:
        g = labels.get(r["id"])
        if not g:
            continue
        secs.append(r.get("total_time_s") or 0)
        if g.get("total") is not None:
            ok = r.get("total") in (g.get("total_accept") or [g["total"]])
            tot += ok; tot_n += 1
            if verbose:
                print(f"  {'ok ' if ok else 'BAD'} {r['id']} want {g['total']} got {r.get('total')}")
        if g.get("date"):
            date_n += 1; date_ok += norm_date(r.get("date")) == g["date"]
        prices = [i.get("price") for i in (r.get("items") or [])]
        for it in g.get("items") or []:
            item_n += 1; item_hit += it["price"] in prices
    pct = lambda a, b: f"{a}/{b} = {round(100 * a / b) if b else 0}%"
    print(f"{Path(run).name}\n  totals {pct(tot, tot_n)}  dates {pct(date_ok, date_n)}  item prices {pct(item_hit, item_n)}  median {statistics.median(secs) if secs else 0:.1f}s")
