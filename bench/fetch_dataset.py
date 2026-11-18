"""Build the Indonesian receipt benchmark dataset (CORD v2 + degraded + Wikimedia Commons)."""

from __future__ import annotations

import io
import json
import os
import random
import re
import shutil
import time
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq
import requests
from huggingface_hub import HfApi, hf_hub_download
from PIL import Image, ImageEnhance, ImageFilter

BENCH_DIR = Path(__file__).resolve().parent
REPO_ROOT = BENCH_DIR.parent
IMAGES_DIR = BENCH_DIR / "data" / "images"
CACHE_DIR = BENCH_DIR / "cache"
LABELS_PATH = BENCH_DIR / "labels.jsonl"
COMMONS_LABELS_PATH = BENCH_DIR / "commons_labels.json"
WC_INSPECT_DIR = Path("/tmp/wc_inspect")
HF_CACHE_DIR = Path(os.path.expanduser("~")) / ".cache" / "silo-bench"

CORD_REPO_ID = "naver-clova-ix/cord-v2"
CORD_LICENSE = "CC-BY-4.0"
CORD_ATTRIBUTION = "Naver Clova (Park et al., 2019, CORD: A Consolidated Receipt Dataset for Post-OCR Parsing)"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
HTTP_HEADERS = {
    "User-Agent": "SiloReceiptBench/1.0 (https://commons.wikimedia.org/wiki/Commons:API; research-dataset)"
}

MIN_FREE_BYTES = int(2.5 * 1024**3)
DEGRADED_COUNT = 40
SEED = 42


def normalize_rupiah(val: Any) -> int | None:
    """Normalize CORD/Indonesian money strings (e.g. 'Rp 60.000,-', '60.000.00') to int rupiah."""
    if val is None:
        return None
    if isinstance(val, list):
        for item in val:
            parsed = normalize_rupiah(item)
            if parsed is not None:
                return parsed
        return None
    if isinstance(val, bool):
        return None
    if isinstance(val, (int, float)):
        return int(round(val))
    if not isinstance(val, str):
        return None

    s = val.strip()
    if not s:
        return None
    s = re.sub(r"(?i)\b(?:rp\.?|idr)\b", "", s)
    s = s.replace("*", "").strip()
    s = re.sub(r"[,-]+$", "", s).strip()
    s = re.sub(r"[.,]00$", "", s)
    s = s.replace(".", "").replace(",", "").replace(" ", "")
    if re.fullmatch(r"-?\d+", s):
        return int(s)
    return None


def parse_qty(val: Any) -> int | None:
    """Parse quantity strings like '2', '1 x', 'x2' into an integer."""
    if val is None:
        return None
    if isinstance(val, list):
        for item in val:
            parsed = parse_qty(item)
            if parsed is not None:
                return parsed
        return None
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        return int(round(val))
    if not isinstance(val, str):
        return None
    m = re.search(r"\d+(?:\.\d+)?", val)
    return int(round(float(m.group(0)))) if m else None


def parse_cord_gt(raw_gt: str) -> dict[str, Any]:
    """Extract menu items, subtotal, and total from CORD ground_truth JSON."""
    gt_parse = json.loads(raw_gt).get("gt_parse") or {}

    menu_raw = gt_parse.get("menu")
    if isinstance(menu_raw, dict):
        menu_list = [menu_raw]
    elif isinstance(menu_raw, list):
        menu_list = menu_raw
    else:
        menu_list = []

    items: list[dict[str, Any]] = []
    for entry in menu_list:
        if not isinstance(entry, dict):
            continue
        name = entry.get("nm")
        if isinstance(name, list):
            name = " ".join(str(x) for x in name if x)
        items.append(
            {
                "name": str(name).strip() if name is not None else "",
                "qty": parse_qty(entry.get("cnt")),
                "price": normalize_rupiah(entry.get("price")),
            }
        )

    sub_block = gt_parse.get("sub_total")
    subtotal = normalize_rupiah(sub_block.get("subtotal_price")) if isinstance(sub_block, dict) else None

    tot_block = gt_parse.get("total")
    total = normalize_rupiah(tot_block.get("total_price")) if isinstance(tot_block, dict) else None

    return {"subtotal": subtotal, "total": total, "items": items}


def download_cord_parquets() -> dict[str, list[Path]]:
    """Download only test and validation parquet shards of CORD v2 into HF_CACHE_DIR."""
    HF_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    free_bytes = shutil.disk_usage("/").free
    if free_bytes < MIN_FREE_BYTES:
        raise RuntimeError(f"Insufficient free disk space: {free_bytes / 1024**3:.2f} GB < 2.5 GB")

    api = HfApi()
    repo_files = api.list_repo_files(CORD_REPO_ID, repo_type="dataset")
    shards: dict[str, list[Path]] = {"test": [], "validation": []}
    for split in ("test", "validation"):
        matching = sorted(f for f in repo_files if f.startswith(f"data/{split}-") and f.endswith(".parquet"))
        if not matching:
            raise RuntimeError(f"No parquet shards found for split={split} in {CORD_REPO_ID}")
        for rel_path in matching:
            local_path = hf_hub_download(
                repo_id=CORD_REPO_ID,
                filename=rel_path,
                repo_type="dataset",
                cache_dir=str(HF_CACHE_DIR),
            )
            shards[split].append(Path(local_path))
    return shards


def process_cord_split(split: str, shard_paths: list[Path], limit: int) -> list[dict[str, Any]]:
    """Stream parquet rows, save RGB JPEGs, and return label records."""
    records: list[dict[str, Any]] = []
    idx = 0
    for shard_path in shard_paths:
        pf = pq.ParquetFile(shard_path)
        for batch in pf.iter_batches(batch_size=16, columns=["image", "ground_truth"]):
            images_col = batch.column("image").to_pylist()
            gt_col = batch.column("ground_truth").to_pylist()
            for img_cell, raw_gt in zip(images_col, gt_col):
                if idx >= limit:
                    return records
                img_bytes = img_cell["bytes"] if isinstance(img_cell, dict) else img_cell
                rec_id = f"cord_{split}_{idx:03d}"
                out_path = IMAGES_DIR / f"{rec_id}.jpg"
                with Image.open(io.BytesIO(img_bytes)) as im:
                    im.convert("RGB").save(out_path, format="JPEG", quality=92)

                parsed = parse_cord_gt(raw_gt)
                records.append(
                    {
                        "id": rec_id,
                        "source": "cord",
                        "license": CORD_LICENSE,
                        "attribution": CORD_ATTRIBUTION,
                        "image": str(out_path.relative_to(REPO_ROOT)),
                        "doc_type": "receipt",
                        "total": parsed["total"],
                        "subtotal": parsed["subtotal"],
                        "merchant": None,
                        "date": None,
                        "items": parsed["items"],
                        "label_source": "cord_gt",
                    }
                )
                idx += 1
    return records


def degrade_cord_test(test_records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Create 40 deterministically degraded variants from CORD test receipts."""
    rng = random.Random(SEED)
    chosen = rng.sample(test_records, min(DEGRADED_COUNT, len(test_records)))
    degraded: list[dict[str, Any]] = []

    for rec in chosen:
        src_path = REPO_ROOT / rec["image"]
        deg_id = f"{rec['id']}_deg"
        out_path = IMAGES_DIR / f"{deg_id}.jpg"

        with Image.open(src_path) as im:
            img = im.convert("RGB")
            angle = rng.uniform(-8.0, 8.0)
            img = img.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=(210, 205, 195))

            w, h = img.size
            dx, dy = w * 0.04, h * 0.04
            quad = (
                rng.uniform(-dx, dx),
                rng.uniform(-dy, dy),
                rng.uniform(-dx, dx),
                h + rng.uniform(-dy, dy),
                w + rng.uniform(-dx, dx),
                h + rng.uniform(-dy, dy),
                w + rng.uniform(-dx, dx),
                rng.uniform(-dy, dy),
            )
            img = img.transform((w, h), Image.Transform.QUAD, quad, resample=Image.Resampling.BICUBIC)
            img = img.filter(ImageFilter.GaussianBlur(radius=rng.uniform(1.0, 2.0)))
            img = ImageEnhance.Brightness(img).enhance(rng.uniform(0.55, 0.80))
            img.save(out_path, format="JPEG", quality=35)

        degraded.append(
            {
                **rec,
                "id": deg_id,
                "source": "cord_deg",
                "image": str(out_path.relative_to(REPO_ROOT)),
            }
        )
    return degraded


def strip_html(text: str | None) -> str:
    return re.sub(r"<[^>]+>", "", text or "").strip()


def fetch_commons_metadata(filenames: list[str]) -> dict[str, dict[str, str]]:
    """Fetch license, artist, and URLs from the Wikimedia Commons API (with local cache)."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE_DIR / "commons_metadata.json"
    cached: dict[str, dict[str, str]] = {}
    if cache_path.exists():
        cached = json.loads(cache_path.read_text(encoding="utf-8"))

    missing = [name for name in filenames if name not in cached]
    if missing:
        resp = requests.get(
            COMMONS_API,
            params={
                "action": "query",
                "format": "json",
                "prop": "imageinfo",
                "iiprop": "url|extmetadata",
                "titles": "|".join(f"File:{name}" for name in missing),
            },
            headers=HTTP_HEADERS,
            timeout=30,
        )
        resp.raise_for_status()
        pages = resp.json().get("query", {}).get("pages", {})
        for page in pages.values():
            title = page.get("title", "").removeprefix("File:").replace(" ", "_")
            ii_list = page.get("imageinfo") or []
            if not ii_list:
                raise RuntimeError(f"Missing Wikimedia Commons imageinfo for {page.get('title')}")
            ii = ii_list[0]
            em = ii.get("extmetadata") or {}
            cached[title] = {
                "url": str(ii["url"]).split("?")[0],
                "descriptionurl": str(ii.get("descriptionurl") or ""),
                "license": strip_html((em.get("LicenseShortName") or {}).get("value")) or "CC-BY-SA-4.0",
                "artist": strip_html((em.get("Artist") or {}).get("value")) or "Wikimedia Commons contributor",
            }
        cache_path.write_text(json.dumps(cached, indent=2, ensure_ascii=False), encoding="utf-8")
    return cached


def download_with_backoff(url: str) -> bytes:
    """Download a Commons file politely, retrying on HTTP 429."""
    for attempt in range(5):
        time.sleep(1.5)
        resp = requests.get(url, headers=HTTP_HEADERS, timeout=60)
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", 5)) * (attempt + 1)
            time.sleep(wait)
            continue
        resp.raise_for_status()
        return resp.content
    raise RuntimeError(f"Rate-limited fetching {url}")


def process_commons() -> list[dict[str, Any]]:
    """Materialize Commons images (from /tmp/wc_inspect or URL) and attach manual labels."""
    entries = json.loads(COMMONS_LABELS_PATH.read_text(encoding="utf-8"))
    meta_by_file = fetch_commons_metadata([e["commons_file"] for e in entries])
    records: list[dict[str, Any]] = []

    for entry in entries:
        fname = entry["commons_file"]
        meta = meta_by_file[fname]
        rec_id = f"commons_{entry['slug']}"
        out_path = IMAGES_DIR / f"{rec_id}.jpg"
        local_src = WC_INSPECT_DIR / fname

        if not out_path.exists():
            if local_src.exists():
                with Image.open(local_src) as im:
                    im.convert("RGB").save(out_path, format="JPEG", quality=92)
            else:
                raw = download_with_backoff(meta["url"])
                with Image.open(io.BytesIO(raw)) as im:
                    im.convert("RGB").save(out_path, format="JPEG", quality=92)

        source_page = meta["descriptionurl"] or meta["url"]
        records.append(
            {
                "id": rec_id,
                "source": "commons",
                "license": meta["license"],
                "attribution": f"{meta['artist']} via Wikimedia Commons ({source_page})",
                "image": str(out_path.relative_to(REPO_ROOT)),
                "doc_type": entry["doc_type"],
                "total": entry["total"],
                "subtotal": entry["subtotal"],
                "merchant": entry["merchant"],
                "date": entry["date"],
                "items": entry["items"],
                "label_source": "manual",
            }
        )
    return records


def main() -> None:
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    shards = download_cord_parquets()
    cord_test = process_cord_split("test", shards["test"], limit=100)
    cord_val = process_cord_split("validation", shards["validation"], limit=50)
    cord_deg = degrade_cord_test(cord_test)
    commons = process_commons()

    all_records = cord_test + cord_val + cord_deg + commons
    with LABELS_PATH.open("w", encoding="utf-8") as fp:
        for rec in all_records:
            fp.write(json.dumps(rec, ensure_ascii=False) + "\n")

    print(
        f"Wrote {len(all_records)} labels "
        f"(cord_test={len(cord_test)}, cord_val={len(cord_val)}, "
        f"cord_deg={len(cord_deg)}, commons={len(commons)}) to {LABELS_PATH}"
    )


if __name__ == "__main__":
    main()
