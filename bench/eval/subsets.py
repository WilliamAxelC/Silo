#!/usr/bin/env python3
"""Build deterministic evaluation subsets S and V (seed 0) and write subsets.json."""

from __future__ import annotations

import json
import random
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
LABELS_PATH = REPO_ROOT / "bench" / "labels.jsonl"
SUBSETS_PATH = Path(__file__).resolve().parent / "subsets.json"


def build_subsets(seed: int = 0) -> dict[str, list[str]]:
    records = [json.loads(line) for line in LABELS_PATH.read_text(encoding="utf-8").splitlines() if line.strip()]
    rng = random.Random(seed)

    cord_clean = [r["id"] for r in records if r["source"] == "cord" and r["total"] is not None]
    cord_deg = [r["id"] for r in records if r["source"] == "cord_deg" and r["total"] is not None]
    commons_all = [r["id"] for r in records if r["source"] == "commons"]
    commons_receipts = [
        r["id"]
        for r in records
        if r["source"] == "commons" and r["doc_type"] not in ("train_ticket", "entrance_ticket")
    ]

    s_cord = rng.sample(cord_clean, 20)
    s_deg = rng.sample(cord_deg, 12)
    s_ids = s_cord + s_deg + commons_all

    v_cord = rng.sample(s_cord, 6)
    v_deg = rng.sample(s_deg, 3)
    v_commons = rng.sample(commons_receipts, 3)
    v_ids = v_cord + v_deg + v_commons

    return {
        "seed": seed,
        "full": [r["id"] for r in records],
        "S": s_ids,
        "V": v_ids,
    }


def main() -> None:
    subsets = build_subsets(0)
    SUBSETS_PATH.write_text(json.dumps(subsets, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {SUBSETS_PATH}: full={len(subsets['full'])}, S={len(subsets['S'])}, V={len(subsets['V'])}")
    print("V IDs:", subsets["V"])


if __name__ == "__main__":
    main()
