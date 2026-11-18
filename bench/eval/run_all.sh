#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

source "$REPO_ROOT/bench/rig/env.sh"
PY="$OCR_VENV/bin/python"

echo "=== 1. Building RapidOCR cache ==="
"$PY" "$SCRIPT_DIR/build_ocr_cache.py"

echo "=== 2. Building deterministic subsets (seed 0) ==="
"$PY" "$SCRIPT_DIR/subsets.py"

echo "=== 3. Running Approach A (TS heuristic on full dataset) ==="
"$PY" "$SCRIPT_DIR/run_heuristic.py"

echo "=== 4. Running Text-LLM approaches (B, C, C2 on S) ==="
"$PY" "$SCRIPT_DIR/run_llm.py" --approach B
"$PY" "$SCRIPT_DIR/run_llm.py" --approach C
"$PY" "$SCRIPT_DIR/run_llm.py" --approach C2

echo "=== 5. Running VLM approaches (D, D2, E on V) ==="
"$PY" "$SCRIPT_DIR/run_vlm.py" --approach D
"$PY" "$SCRIPT_DIR/run_vlm.py" --approach D2
"$PY" "$SCRIPT_DIR/run_vlm.py" --approach E

echo "=== 6. Evaluating and generating report ==="
"$PY" "$SCRIPT_DIR/evaluate.py"
