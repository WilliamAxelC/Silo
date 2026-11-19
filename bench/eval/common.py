#!/usr/bin/env python3
"""Shared utilities for Silo receipt extraction benchmark."""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

import requests

REPO_ROOT = Path(__file__).resolve().parents[2]
LABELS_PATH = Path(os.environ.get("SILO_LABELS") or REPO_ROOT / "bench" / "labels.jsonl")
OCR_CACHE_DIR = Path(os.environ.get("SILO_OCR_CACHE") or REPO_ROOT / "bench" / "cache" / "ocr")
SUBSETS_PATH = Path(__file__).resolve().parent / "subsets.json"
RESULTS_DIR = REPO_ROOT / "bench" / "results"
RUNS_DIR = Path(os.environ.get("SILO_RUNS_DIR") or REPO_ROOT / "bench" / "results" / "runs")

LLAMA_BIN_DIR = Path(os.environ.get("LLAMA_BIN_DIR", "/home/agent/.cache/silo-bench/llama"))
MODEL_TEXT_2B = os.environ.get("MODEL_TEXT_2B", "/home/agent/.cache/silo-bench/models/Qwen3.5-2B-Q4_K_M.gguf")
MODEL_TEXT_SMALL = os.environ.get("MODEL_TEXT_SMALL", "/home/agent/.cache/silo-bench/models/Qwen3.5-0.8B-Q4_K_M.gguf")
MMPROJ_2B = os.environ.get("MMPROJ_2B", "/home/agent/.cache/silo-bench/models/mmproj-2B-F16.gguf")
MMPROJ_SMALL = os.environ.get("MMPROJ_SMALL", "/home/agent/.cache/silo-bench/models/mmproj-0.8B-F16.gguf")

RECEIPT_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "merchant": {"type": ["string", "null"]},
        "date": {"type": ["string", "null"]},
        "total": {"type": "integer"},
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "qty": {"type": ["integer", "null"]},
                    "price": {"type": "integer"},
                },
                "required": ["name", "qty", "price"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["merchant", "date", "total", "items"],
    "additionalProperties": False,
}


def load_labels() -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for line in LABELS_PATH.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rec = json.loads(line)
            out[rec["id"]] = rec
    return out


def load_subsets() -> dict[str, Any]:
    return json.loads(SUBSETS_PATH.read_text(encoding="utf-8"))


def load_ocr_cache(rec_id: str) -> dict[str, Any]:
    return json.loads((OCR_CACHE_DIR / f"{rec_id}.json").read_text(encoding="utf-8"))


def load_existing_jsonl(path: Path) -> dict[str, dict[str, Any]]:
    records: dict[str, dict[str, Any]] = {}
    if not path.exists():
        return records
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
            if "id" in obj and not obj.get("error"):
                records[obj["id"]] = obj
        except json.JSONDecodeError:
            continue
    return records


def append_jsonl(path: Path, obj: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")
        f.flush()


def parse_indonesian_number(token: str) -> int | None:
    """Parse an Indonesian-formatted integer token like '60.000', '60,000', '60.000,00'."""
    s = token.strip()
    if not s:
        return None
    # Strip trailing decimal cents like .00 or ,00 when preceded by thousands or >=3 digits
    if re.fullmatch(r"\d{1,3}(?:[.,]\d{3})+[.,]\d{2}", s):
        s = s[:-3]
    elif re.fullmatch(r"\d{3,}[.,]00", s):
        s = s[:-3]
    digits = re.sub(r"[.,]", "", s)
    if digits.isdigit():
        return int(digits)
    return None


def extract_ocr_numbers(ocr_text: str) -> set[int]:
    """Extract all plausible integer amounts present in Indonesian OCR text."""
    nums: set[int] = set()
    if not ocr_text:
        return nums
    for m in re.finditer(r"(?<![A-Za-z0-9])\d+(?:[.,]\d+)*(?![A-Za-z0-9])", ocr_text):
        tok = m.group(0)
        val = parse_indonesian_number(tok)
        if val is not None:
            nums.add(val)
        # Also include raw digits-only interpretation if token had separators
        raw_digits = re.sub(r"[.,]", "", tok)
        if raw_digits.isdigit():
            nums.add(int(raw_digits))
    # Also catch Rp60.000 or @30.000 where letter/symbol touches digit
    for m in re.finditer(r"(?:Rp|IDR|@)\s*\.?\s*(\d+(?:[.,]\d+)*)", ocr_text, flags=re.IGNORECASE):
        val = parse_indonesian_number(m.group(1))
        if val is not None:
            nums.add(val)
    return nums


def parse_receipt_json_with_repair(content: str) -> tuple[dict[str, Any], bool]:
    """Parse schema JSON, repairing cleanly if truncated at max_tokens mid-items."""
    try:
        return json.loads(content), False
    except json.JSONDecodeError:
        pass

    # Try trimming back to the last complete item object inside "items": [...]
    items_idx = content.find('"items"')
    if items_idx != -1:
        bracket_idx = content.find("[", items_idx)
        if bracket_idx != -1:
            last_brace = content.rfind("}", bracket_idx)
            if last_brace != -1:
                candidate = content[: last_brace + 1] + "\n  ]\n}"
                try:
                    return json.loads(candidate), True
                except json.JSONDecodeError:
                    pass
            candidate_empty = content[: bracket_idx + 1] + "]" + "\n}"
            try:
                return json.loads(candidate_empty), True
            except json.JSONDecodeError:
                pass

    # Regex fallback for merchant, date, total
    m_merch = re.search(r'"merchant"\s*:\s*(".*?"|null)', content)
    m_date = re.search(r'"date"\s*:\s*(".*?"|null)', content)
    m_total = re.search(r'"total"\s*:\s*(-?\d+)', content)
    if m_total:
        return {
            "merchant": json.loads(m_merch.group(1)) if m_merch else None,
            "date": json.loads(m_date.group(1)) if m_date else None,
            "total": int(m_total.group(1)),
            "items": [],
        }, True
    raise json.JSONDecodeError("Could not parse or repair receipt JSON", content, 0)


def parse_line_items_text(text: str | None) -> list[dict[str, Any]]:
    """Parse comma-separated lineItemsText (from A or B) into structured items."""
    if not text or not isinstance(text, str):
        return []
    parts = re.split(r",(?!\d{3}(?:\D|$))\s*|\n+|;\s*", text.strip())
    items: list[dict[str, Any]] = []
    for part in parts:
        seg = part.strip()
        if not seg:
            continue
        price = None
        name_part = seg
        # Look for trailing price token >= 100
        matches = list(re.finditer(r"(?:Rp\.?\s*)?(\d+(?:[.,]\d+)*)\b", seg, flags=re.IGNORECASE))
        for m in reversed(matches):
            val = parse_indonesian_number(m.group(1))
            if val is not None and val >= 100:
                price = val
                name_part = (seg[: m.start()] + " " + seg[m.end() :]).strip()
                break
        qty = 1
        qm = re.match(r"^(\d+)\s*[xX*]?\s+(.+)$", name_part)
        if qm:
            qty = int(qm.group(1))
            name_part = qm.group(2).strip()
        name_part = re.sub(r"\s+", " ", name_part).strip(" -:@")
        if name_part or price is not None:
            items.append({"name": name_part or seg, "qty": qty, "price": price})
    return items


def get_mem_available_mb() -> int:
    for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
        if line.startswith("MemAvailable:"):
            kb = int(line.split()[1])
            return kb // 1024
    return 0


def wait_for_clean_memory(min_avail_mb: int = 3000) -> None:
    """Wait until no jest/tsc workers are running and >= min_avail_mb RAM is available."""
    while True:
        pgrep = subprocess.run(["pgrep", "-f", r"jest|tsc --noEmit"], capture_output=True, text=True)
        busy = bool(pgrep.stdout.strip())
        avail_mb = get_mem_available_mb()
        if not busy and avail_mb >= min_avail_mb:
            print(f"[mem-check] OK: avail={avail_mb} MB, no jest/tsc running.", flush=True)
            return
        print(f"[mem-check] Waiting 60s (jest/tsc busy={busy}, avail={avail_mb} MB < {min_avail_mb} MB)...", flush=True)
        time.sleep(60)


def get_proc_rss_mb(pid: int) -> tuple[float, float]:
    """Return (current_rss_mb, peak_hwm_mb) from /proc/<pid>/status."""
    rss_kb = 0
    hwm_kb = 0
    try:
        for line in Path(f"/proc/{pid}/status").read_text(encoding="utf-8").splitlines():
            if line.startswith("VmRSS:"):
                rss_kb = int(line.split()[1])
            elif line.startswith("VmHWM:"):
                hwm_kb = int(line.split()[1])
    except FileNotFoundError:
        pass
    return rss_kb / 1024.0, hwm_kb / 1024.0


class LlamaServer:
    """Context manager for a single llama-server instance with -c 4096 -t 4."""

    def __init__(
        self,
        model_path: str,
        mmproj_path: str | None = None,
        port: int = 8089,
        ctx_size: int = 4096,
        threads: int = 4,
        log_path: Path | None = None,
    ) -> None:
        self.model_path = model_path
        self.mmproj_path = mmproj_path
        self.port = port
        self.ctx_size = ctx_size
        self.threads = threads
        self.log_path = log_path
        self.proc: subprocess.Popen[str] | None = None
        self.peak_rss_mb: float = 0.0
        self.base_url = f"http://127.0.0.1:{port}"

    def __enter__(self) -> "LlamaServer":
        wait_for_clean_memory(3000)
        cmd = [
            str(LLAMA_BIN_DIR / "llama-server"),
            "-m",
            self.model_path,
            "-c",
            str(self.ctx_size),
            "-t",
            str(self.threads),
            "-tb",
            str(self.threads),
            "--host",
            "127.0.0.1",
            "--port",
            str(self.port),
            "--reasoning",
            "off",
            "--jinja",
        ]
        if self.mmproj_path:
            cmd.extend(["--mmproj", self.mmproj_path])

        env = os.environ.copy()
        env["LD_LIBRARY_PATH"] = f"{LLAMA_BIN_DIR}:{env.get('LD_LIBRARY_PATH', '')}"

        log_f = open(self.log_path, "w", encoding="utf-8") if self.log_path else subprocess.DEVNULL
        self._log_f = log_f if self.log_path else None
        self.proc = subprocess.Popen(cmd, stdout=log_f, stderr=subprocess.STDOUT, env=env, text=True)

        # Wait for /health
        deadline = time.time() + 600
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"llama-server exited early with code {self.proc.returncode}")
            try:
                r = requests.get(f"{self.base_url}/health", timeout=2)
                if r.status_code == 200 and r.json().get("status") == "ok":
                    self.update_rss()
                    return self
            except Exception:
                pass
            time.sleep(1.0)
        self.__exit__(None, None, None)
        raise TimeoutError("llama-server did not become healthy within 600s")

    def update_rss(self) -> float:
        if self.proc is not None:
            rss, hwm = get_proc_rss_mb(self.proc.pid)
            self.peak_rss_mb = max(self.peak_rss_mb, rss, hwm)
        return self.peak_rss_mb

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        if self.proc is not None:
            self.update_rss()
            if self.proc.poll() is None:
                self.proc.send_signal(signal.SIGTERM)
                try:
                    self.proc.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait()
            self.proc = None
        if getattr(self, "_log_f", None) is not None:
            self._log_f.close()
            self._log_f = None
