#!/usr/bin/env python3
"""Runs CORD-fine-tuned receipt models and writes runs/<name>.jsonl in the same format as run_vlm.py.

  llama:  python run_finetuned.py llama <name> --model M.gguf --mmproj P.gguf [--lora L.gguf] --prompt mehdi|xiaomi
  donut:  python run_finetuned.py donut <name>          (naver-clova-ix/donut-base-finetuned-cord-v2, transformers)

Both models emit CORD-schema JSON (menu[].nm/cnt/price, total.total_price); this maps it to {total, items}.
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import LABELS_PATH, LLAMA_BIN_DIR, REPO_ROOT, parse_indonesian_number  # noqa: E402

PROMPTS = {
    # github.com/N-Mehdi/receipt-vlm src/receipt_vlm/prompts.py (CORD_PROMPT), the string the model was trained on.
    "mehdi": (
        'Extract the content of this receipt as a single JSON object.\nUse only these keys and omit any key that does not appear on the receipt:\n'
        '- "menu": list of purchased items, each with "nm" (item name), "num" (item code),\n  "unitprice", "cnt" (quantity), "discountprice", "price" (line total), "itemsubtotal",\n'
        '  "vatyn", "etc", and "sub" (list of sub-items with "nm", "unitprice", "cnt", "price", "etc").\n'
        '- "void_menu": list of cancelled items with "nm" and "price".\n'
        '- "sub_total": object with "subtotal_price", "discount_price", "service_price",\n  "othersvc_price", "tax_price", "etc".\n'
        '- "total": object with "total_price", "total_etc", "cashprice", "changeprice",\n  "creditcardprice", "emoneyprice", "menutype_cnt", "menuqty_cnt".\n'
        "Copy every value as a string exactly as printed. Answer with the JSON only."
    ),
    # huggingface.co/Lucasgitguy-co/Xiaomi-OCR-0-CORD-LoRA-GGUF usage example.
    "xiaomi": (
        "Extract this receipt as JSON using the CORD schema: menu, sub_total, total. Use CORD field names such as nm, cnt, "
        "price, subtotal_price, tax_price, and total_price. Preserve printed values as strings, omit absent fields, and return only JSON."
    ),
}


def money(v) -> int | None:
    if isinstance(v, list):
        v = v[0] if v else None
    if isinstance(v, (int, float)):
        return int(v)
    if not isinstance(v, str):
        return None
    m = re.search(r"\d+(?:[.,]\d+)*", v)
    return parse_indonesian_number(m.group(0)) if m else None


def first_json(text: str):
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    for i, ch in enumerate(text[start:], start):
        depth += ch == "{"
        depth -= ch == "}"
        if depth == 0:
            try:
                return json.loads(text[start : i + 1])
            except ValueError:
                return None
    return None


def to_record(parsed) -> tuple[int | None, list[dict]]:
    if not isinstance(parsed, dict):
        return None, []
    total = parsed.get("total")
    total = money(total.get("total_price")) if isinstance(total, dict) else money(total)
    menu = parsed.get("menu") or []
    if isinstance(menu, dict):
        menu = [menu]
    items = []
    for it in menu if isinstance(menu, list) else []:
        if isinstance(it, dict) and it.get("nm"):
            cnt = money(it.get("cnt"))
            items.append({"name": str(it["nm"] if not isinstance(it["nm"], list) else it["nm"][0]), "qty": cnt or 1, "price": money(it.get("price"))})
    return total, items


def run_llama(args, labels, out):
    cmd = [str(LLAMA_BIN_DIR / "llama-server"), "-m", args.model, "--mmproj", args.mmproj, "-c", "4096", "--port", str(args.port),
           "-t", str(args.threads), "--temp", "0", "--image-max-tokens", "1024", "--jinja"]
    if args.lora:
        cmd += ["--lora", args.lora]
    server = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=open(out.with_suffix(".server.log"), "w"))
    url = f"http://127.0.0.1:{args.port}"
    import requests

    try:
        for _ in range(300):
            try:
                if requests.get(url + "/health", timeout=2).ok:
                    break
            except requests.RequestException:
                pass
            time.sleep(1)
        for g in labels:
            img = REPO_ROOT / g["image"]
            b64 = base64.b64encode(img.read_bytes()).decode()
            body = {"messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                {"type": "text", "text": PROMPTS[args.prompt]}]}],
                "temperature": 0, "max_tokens": 1024, "chat_template_kwargs": {"enable_thinking": False}}
            t0 = time.time()
            r = requests.post(url + "/v1/chat/completions", json=body, timeout=900).json()
            dt = time.time() - t0
            content = r.get("choices", [{}])[0].get("message", {}).get("content", "") if "choices" in r else json.dumps(r)
            yield g, content, dt
    finally:
        server.terminate()


def run_donut(args, labels, out):
    import torch
    from PIL import Image
    from transformers import DonutProcessor, VisionEncoderDecoderModel

    torch.set_num_threads(args.threads)
    name = "naver-clova-ix/donut-base-finetuned-cord-v2"
    processor = DonutProcessor.from_pretrained(name)
    model = VisionEncoderDecoderModel.from_pretrained(name).eval()
    prompt_ids = processor.tokenizer("<s_cord-v2>", add_special_tokens=False, return_tensors="pt").input_ids
    for g in labels:
        image = Image.open(REPO_ROOT / g["image"]).convert("RGB")
        t0 = time.time()
        with torch.inference_mode():
            pv = processor(image, return_tensors="pt").pixel_values
            seq = model.generate(pv, decoder_input_ids=prompt_ids, max_length=model.decoder.config.max_position_embeddings,
                                 pad_token_id=processor.tokenizer.pad_token_id, eos_token_id=processor.tokenizer.eos_token_id,
                                 use_cache=True, num_beams=1, bad_words_ids=[[processor.tokenizer.unk_token_id]])
        text = processor.batch_decode(seq)[0].replace(processor.tokenizer.eos_token, "").replace(processor.tokenizer.pad_token, "")
        text = re.sub(r"<.*?>", "", text, count=1).strip()
        yield g, json.dumps(processor.token2json(text)), time.time() - t0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["llama", "donut"])
    ap.add_argument("name")
    ap.add_argument("--model"); ap.add_argument("--mmproj"); ap.add_argument("--lora")
    ap.add_argument("--prompt", choices=list(PROMPTS), default="mehdi")
    ap.add_argument("--port", type=int, default=8095)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--ids", help="file with one id per line (default: all labels)")
    args = ap.parse_args()
    labels = [json.loads(l) for l in LABELS_PATH.read_text().splitlines() if l.strip()]
    if args.ids:
        want = set(Path(args.ids).read_text().split())
        labels = [g for g in labels if g["id"] in want]
    out = REPO_ROOT / "bench" / "results" / "runs" / f"{args.name}.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    done = {json.loads(l)["id"] for l in out.read_text().splitlines()} if out.exists() else set()
    labels = [g for g in labels if g["id"] not in done]
    runner = run_llama if args.kind == "llama" else run_donut
    with out.open("a") as f:
        for g, content, dt in runner(args, labels, out):
            total, items = to_record(first_json(content))
            f.write(json.dumps({"id": g["id"], "source": g["source"], "doc_type": g.get("doc_type"), "merchant": None, "date": None,
                                "total": total, "items": items, "raw_response": content, "model_time_s": round(dt, 3),
                                "total_time_s": round(dt, 3)}) + "\n")
            f.flush()
            print(g["id"], total, g.get("total"), f"{dt:.1f}s", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
