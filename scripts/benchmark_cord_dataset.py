import urllib.request
import json
import re
import time
from typing import Dict, Any, List, Optional, Tuple

def parse_price_str(price_str: Optional[str]) -> Optional[int]:
    if not price_str:
        return None
    # Remove currency prefixes and non-digit characters except dots/commas
    clean = re.sub(r'[^\d]', '', str(price_str))
    if not clean:
        return None
    try:
        val = int(clean)
        return val if val > 0 else None
    except ValueError:
        return None

def reconstruct_multi_column_ocr_text(raw_text: str) -> str:
    raw_blocks = [b.strip() for b in re.split(r'\n\s*\n', raw_text) if b.strip()]
    if len(raw_blocks) < 2:
        return raw_text

    reconstructed_blocks = []
    i = 0
    while i < len(raw_blocks):
        if i + 1 < len(raw_blocks):
            block1_lines = [l.strip() for l in raw_blocks[i].split('\n') if l.strip()]
            block2_lines = [l.strip() for l in raw_blocks[i+1].split('\n') if l.strip()]

            b1_has_text = sum(1 for l in block1_lines if re.search(r'[a-zA-Z]{3,}', l)) >= len(block1_lines) * 0.5
            b2_is_numbers = sum(1 for l in block2_lines if re.match(r'^[\d.,\sRp+-]+$', l)) >= len(block2_lines) * 0.6

            if b1_has_text and b2_is_numbers and abs(len(block1_lines) - len(block2_lines)) <= 3:
                merged = []
                count = max(len(block1_lines), len(block2_lines))
                for j in range(count):
                    t = block1_lines[j] if j < len(block1_lines) else ''
                    n = block2_lines[j] if j < len(block2_lines) else ''
                    merged.append(f"{t} {n}".strip())
                reconstructed_blocks.append('\n'.join(merged))
                i += 2
                continue
        reconstructed_blocks.append(raw_blocks[i])
        i += 1
    return '\n\n'.join(reconstructed_blocks)

def parse_receipt_heuristic(raw_text: str) -> Dict[str, Any]:
    reconstructed = reconstruct_multi_column_ocr_text(raw_text)
    lines = [l.strip() for l in reconstructed.split('\n') if l.strip()]
    if not lines:
        return {"extractedTotal": None, "extractedMerchant": None, "extractedDate": None}

    # 1. Merchant candidate
    merchant = None
    for line in lines[:6]:
        if (not re.match(r'^\d+$', line) and
            not re.match(r'^[\d\W]+$', line) and
            not re.search(r'\b(jl\.?|jalan|telp\.?|phone|npwp|receipt|struk|nota|order|table|meja|kasir|cashier|pos|date|tanggal|tgl)\b', line, re.I) and
            3 <= len(line) <= 40):
            merchant = line
            break

    # 2. Total extraction
    extracted_total = None

    # Pass 1: Explicit Grand Total / Total Bayar / Total Belanja / Total / Due / TL
    for i in range(len(lines) - 1, -1, -1):
        line = lines[i]
        if re.search(r'\b(grand\s*total|total\s*bayar|total\s*belanja|total\s*akhir|total\s*harga|total\s*tagihan|total\s*amount|amount\s*due|tagihan|total|due|tl)\b', line, re.I) or re.search(r'\b(total\.)\b', line, re.I):
            if not re.search(r'\b(sub\s*total|subtotal|subttl|disc|discount|diskon|item|items|qty|ppn|tax|pajak|pb-?1|charge|service|kembali|change|kembalian)\b', line, re.I):
                nums = re.findall(r'\b\d[\d.,]*\d\b|\b\d+\b', line)
                if not nums and i + 1 < len(lines):
                    nums = re.findall(r'\b\d[\d.,]*\d\b|\b\d+\b', lines[i + 1])
                if nums:
                    clean = int(re.sub(r'[^\d]', '', nums[-1]))
                    if clean >= 100:
                        extracted_total = clean
                        break

    # Pass 2: Fallback to Subtotal if no tax/discount
    if not extracted_total:
        for i in range(len(lines) - 1, -1, -1):
            line = lines[i]
            if re.search(r'\b(sub\s*total|subtotal|subttl)\b', line, re.I):
                if not re.search(r'\b(kembali|change|kembalian|disc|discount|diskon|ppn|tax|pajak|pb-?1)\b', line, re.I):
                    nums = re.findall(r'\b\d[\d.,]*\d\b|\b\d+\b', line)
                    if not nums and i + 1 < len(lines):
                        nums = re.findall(r'\b\d[\d.,]*\d\b|\b\d+\b', lines[i + 1])
                    if nums:
                        clean = int(re.sub(r'[^\d]', '', nums[-1]))
                        if clean >= 100:
                            extracted_total = clean
                            break

    # Pass 3: Fallback to payment method settlement excluding change
    if not extracted_total:
        for i in range(len(lines) - 1, -1, -1):
            line = lines[i]
            if re.search(r'\b(debit|qris|gopay|ovo|shopeepay|dana|bca|mandiri|cimb|bni|bri|edc|visa|master|credit|non\s*tunai|tunai|cash|tendered)\b', line, re.I):
                if not re.search(r'\b(kembali|change|kembalian|disc|discount|diskon|ppn|tax|pajak|pb-?1)\b', line, re.I):
                    nums = re.findall(r'\b\d[\d.,]*\d\b|\b\d+\b', line)
                    if not nums and i + 1 < len(lines):
                        nums = re.findall(r'\b\d[\d.,]*\d\b|\b\d+\b', lines[i + 1])
                    if nums:
                        clean = int(re.sub(r'[^\d]', '', nums[-1]))
                        if clean >= 100:
                            extracted_total = clean
                            break

    # 3. Date
    extracted_date = None
    iso_m = re.search(r'\b(20\d{2})[-/.](0[1-9]|1[0-2])[-/.](0[1-9]|[12]\d|3[01])\b', raw_text)
    if iso_m:
        extracted_date = f"{iso_m.group(1)}-{iso_m.group(2)}-{iso_m.group(3)}"
    else:
        dmy_m = re.search(r'\b(0[1-9]|[12]\d|3[01])[-/.](0[1-9]|1[0-2])[-/.](20\d{2}|\d{2})\b', raw_text)
        if dmy_m:
            yr = dmy_m.group(3)
            if len(yr) == 2:
                yr = f"20{yr}"
            extracted_date = f"{yr}-{dmy_m.group(2)}-{dmy_m.group(1)}"

    return {
        "extractedTotal": extracted_total,
        "extractedMerchant": merchant,
        "extractedDate": extracted_date,
    }

def run_cord_benchmark(limit: int = 100) -> Dict[str, Any]:
    print(f"[*] Fetching {limit} authentic CORD test receipts from Hugging Face dataset server...")
    url = f"https://datasets-server.huggingface.co/rows?dataset=naver-clova-ix%2Fcord-v1&config=default&split=test&offset=0&limit={limit}"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        rows = data.get('rows', [])

    print(f"[+] Loaded {len(rows)} receipt records from CORD v1/v2.")
    
    results = []
    matched_total_count = 0
    total_evaluable_count = 0
    
    for idx, r in enumerate(rows):
        gt = json.loads(r['row']['ground_truth'])
        gt_parse = gt.get('gt_parse', {})
        total_data = gt_parse.get('total', {})
        
        # Ground truth total price (can be string or dict in CORD)
        gt_total_raw = total_data.get('total_price') if isinstance(total_data, dict) else None
        if not gt_total_raw and isinstance(total_data, dict):
            gt_total_raw = total_data.get('total_price_num') or total_data.get('creditcardprice') or total_data.get('cashprice')
        if not gt_total_raw and isinstance(gt_parse.get('sub_total'), dict):
            gt_total_raw = gt_parse['sub_total'].get('subtotal_price')

        gt_total_num = parse_price_str(gt_total_raw)
        
        # Reconstruct OCR lines from valid_line annotations
        valid_lines = gt.get('valid_line', [])
        full_text_lines = []
        for vline in valid_lines:
            words = [w['text'] for w in vline.get('words', []) if 'text' in w]
            if words:
                full_text_lines.append(' '.join(words))
        
        raw_ocr_text = '\n'.join(full_text_lines)
        
        if gt_total_num and raw_ocr_text:
            total_evaluable_count += 1
            start_t = time.perf_counter()
            parsed = parse_receipt_heuristic(raw_ocr_text)
            elapsed_ms = (time.perf_counter() - start_t) * 1000.0
            
            is_match = (parsed['extractedTotal'] == gt_total_num)
            if is_match:
                matched_total_count += 1
            
            results.append({
                "index": idx + 1,
                "is_match": is_match,
                "expected_total": gt_total_num,
                "extracted_total": parsed['extractedTotal'],
                "extracted_merchant": parsed['extractedMerchant'],
                "latency_ms": elapsed_ms,
                "lines_count": len(full_text_lines),
                "preview_text": full_text_lines[:4]
            })

    accuracy = (matched_total_count / total_evaluable_count * 100.0) if total_evaluable_count > 0 else 0.0
    avg_latency = sum(r['latency_ms'] for r in results) / len(results) if results else 0.0

    print(f"\n==================================================")
    print(f"   CORD v1/v2 BENCHMARK EVALUATION RESULTS")
    print(f"==================================================")
    print(f"Total Evaluated Receipts : {total_evaluable_count}")
    print(f"Exact Total Matches      : {matched_total_count} / {total_evaluable_count}")
    print(f"Extraction Accuracy      : {accuracy:.2f}%")
    print(f"Average Parsing Latency  : {avg_latency:.3f} ms / receipt")
    print(f"==================================================\n")

    mismatches = [r for r in results if not r['is_match']]
    if mismatches:
        print(f"Sample Mismatches (First 5 of {len(mismatches)}):")
        for m in mismatches[:5]:
            print(f"  [Receipt #{m['index']}] Expected: {m['expected_total']} | Got: {m['extracted_total']}")
            print(f"    Preview: {' / '.join(m['preview_text'])}")

    return {
        "total_evaluated": total_evaluable_count,
        "exact_matches": matched_total_count,
        "accuracy_pct": accuracy,
        "avg_latency_ms": avg_latency,
        "mismatches": mismatches
    }

if __name__ == '__main__':
    run_cord_benchmark(100)
