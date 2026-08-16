import Constants from 'expo-constants';
import { Alert } from 'react-native';
import { IOcrEngine, OcrResult } from './types';

// Auto-detects: true in Custom Dev Clients, false in Expo Go
export const IS_NATIVE_OCR_SUPPORTED = Constants.appOwnership !== 'expo'; 

// Manual override: switch to 'false' when you build your native client
export const FORCE_DISABLE_OCR = false; 

export const scanReceiptNative = async (imageUri: string): Promise<string | null> => {
  if (FORCE_DISABLE_OCR || !IS_NATIVE_OCR_SUPPORTED) {
    Alert.alert(
      "OCR Disabled", 
      "Native OCR is currently disabled to maintain Expo Go compatibility."
    );
    return null;
  }

  try {
    const TextRecognition = require('@react-native-ml-kit/text-recognition').default;
    const result = await TextRecognition.recognize(imageUri);
    return result.text;
  } catch (error: any) {
    console.error("Native OCR Error:", error);
    Alert.alert("OCR Error", "Ensure you are running a custom dev client, not Expo Go.");
    return null;
  }
};


/**
 * Auto-reconstructs multi-column OCR blocks where ML Kit separated text columns from numeric columns.
 */
export function reconstructMultiColumnOcrText(rawText: string): string {
  const rawBlocks = rawText.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (rawBlocks.length < 2) return rawText;

  const reconstructedBlocks: string[] = [];
  let i = 0;
  while (i < rawBlocks.length) {
    if (i + 1 < rawBlocks.length) {
      const block1Lines = rawBlocks[i].split('\n').map((l) => l.trim()).filter(Boolean);
      const block2Lines = rawBlocks[i + 1].split('\n').map((l) => l.trim()).filter(Boolean);

      const block1IsText = block1Lines.filter((l) => /[a-zA-Z]{3,}/.test(l)).length >= block1Lines.length * 0.5;
      const block2IsNumbers = block2Lines.filter((l) => /^[\d.,\sRp+-]+$/.test(l)).length >= block2Lines.length * 0.6;

      if (block1IsText && block2IsNumbers && Math.abs(block1Lines.length - block2Lines.length) <= 3) {
        const merged: string[] = [];
        const count = Math.max(block1Lines.length, block2Lines.length);
        for (let j = 0; j < count; j++) {
          const text = block1Lines[j] || '';
          const num = block2Lines[j] || '';
          merged.push(`${text} ${num}`.trim());
        }
        reconstructedBlocks.push(merged.join('\n'));
        i += 2;
        continue;
      }
    }
    reconstructedBlocks.push(rawBlocks[i]);
    i++;
  }

  return reconstructedBlocks.join('\n\n');
}


/**
 * Parses raw OCR text with specialized heuristics for Indonesian & international receipts.
 * Handles keywords like TOTAL, GRAND TOTAL, TOTAL BAYAR, AMOUNT DUE, TAGIHAN,
 * ignoring subtotal, tax/PPN/PB1, discount, and cash tendered/change.
 */
export function parseReceiptTextHeuristic(rawText: string): {
  extractedTotal: number | null;
  extractedMerchant: string | null;
  extractedDate: string | null;
} {
  const reconstructedText = reconstructMultiColumnOcrText(rawText);
  const lines = reconstructedText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return { extractedTotal: null, extractedMerchant: null, extractedDate: null };
  }

  // 1. Extract Merchant Name candidate from top header lines
  let extractedMerchant: string | null = null;
  for (const line of lines.slice(0, 6)) {
    // Ignore lines that look like numbers, dates, addresses, tax IDs (NPWP), or transaction codes
    if (
      !/^\d+$/.test(line) &&
      !/^[\d\W]+$/.test(line) &&
      !/\b(jl\.?|jalan|telp\.?|phone|npwp|receipt|struk|nota|order|table|meja|kasir|cashier|pos|date|tanggal|tgl)\b/i.test(line) &&
      line.length >= 3 &&
      line.length <= 40
    ) {
      extractedMerchant = line;
      break;
    }
  }

  // 2. Extract Total Amount
  let extractedTotal: number | null = null;

  // Pass 1: explicit TOTAL / GRAND TOTAL / TOTAL BAYAR / AMOUNT DUE / TAGIHAN / TOTAL BELANJA / TOTAL AKHIR / TOTAL HARGA
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (
      /\b(grand\s*total|total\s*bayar|total\s*belanja|total\s*sales|total\s*amount|total\s*akhir|total\s*harga|total\s*tagihan|amount\s*due|tagihan|total|due|tl)\b/i.test(
        line
      ) || /\b(total\.)\b/i.test(line)
    ) {
      if (
        !/\b(sub\s*total|subtotal|subttl|disc|discount|diskon|item|items|qty|ppn|tax|pajak|pb-?1|charge|service|kembali|change|kembalian)\b/i.test(
          line
        )
      ) {
        let nums = line.match(/\b\d[\d.,]*\d\b|\b\d+\b/g);
        // If keyword line has no numbers, check immediately adjacent next line
        if (!nums && i + 1 < lines.length) {
          nums = lines[i + 1].match(/\b\d[\d.,]*\d\b|\b\d+\b/g);
        }
        if (nums && nums.length > 0) {
          const clean = parseInt(nums[nums.length - 1].replace(/[^\d]/g, ''), 10);
          if (!isNaN(clean) && clean >= 100) {
            extractedTotal = clean;
            break;
          }
        }
      }
    }
  }

  // Pass 2: Fallback to Subtotal if no tax/discount or payment methods
  if (!extractedTotal) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (/\b(sub\s*total|subtotal|subttl)\b/i.test(line)) {
        if (!/\b(kembali|change|kembalian|disc|discount|diskon|ppn|tax|pajak|pb-?1)\b/i.test(line)) {
          let nums = line.match(/\b\d[\d.,]*\d\b|\b\d+\b/g);
          if (!nums && i + 1 < lines.length) {
            nums = lines[i + 1].match(/\b\d[\d.,]*\d\b|\b\d+\b/g);
          }
          if (nums && nums.length > 0) {
            const clean = parseInt(nums[nums.length - 1].replace(/[^\d]/g, ''), 10);
            if (!isNaN(clean) && clean >= 100) {
              extractedTotal = clean;
              break;
            }
          }
        }
      }
    }
  }

  // Pass 3: Fallback to payment method settlement (QRIS, Card, Debit, Cash) excluding change
  if (!extractedTotal) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (
        /\b(debit|qris|gopay|ovo|shopeepay|dana|bca|mandiri|cimb|bni|bri|edc|visa|master|credit|non\s*tunai|tunai|cash|tendered)\b/i.test(
          line
        )
      ) {
        if (!/\b(kembali|change|kembalian|disc|discount|diskon|ppn|tax|pajak|pb-?1)\b/i.test(line)) {
          let nums = line.match(/\b\d[\d.,]*\d\b|\b\d+\b/g);
          if (!nums && i + 1 < lines.length) {
            nums = lines[i + 1].match(/\b\d[\d.,]*\d\b|\b\d+\b/g);
          }
          if (nums && nums.length > 0) {
            const clean = parseInt(nums[nums.length - 1].replace(/[^\d]/g, ''), 10);
            if (!isNaN(clean) && clean >= 100) {
              extractedTotal = clean;
              break;
            }
          }
        }
      }
    }
  }

  // 3. Extract Date (DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, YYYY-MM-DD)
  let extractedDate: string | null = null;
  const isoMatch = rawText.match(/\b(20\d{2})[-/.](0[1-9]|1[0-2])[-/.](0[1-9]|[12]\d|3[01])\b/);
  if (isoMatch) {
    extractedDate = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  } else {
    const dmyMatch = rawText.match(/\b(0[1-9]|[12]\d|3[01])[-/.](0[1-9]|1[0-2])[-/.](20\d{2}|\d{2})\b/);
    if (dmyMatch) {
      let year = dmyMatch[3];
      if (year.length === 2) year = `20${year}`;
      extractedDate = `${year}-${dmyMatch[2]}-${dmyMatch[1]}`;
    }
  }

  return {
    extractedTotal,
    extractedMerchant,
    extractedDate,
  };
}

export class MlKitEngine implements IOcrEngine {
  async processImage(imageUri: string): Promise<OcrResult> {
    try {
      const rawText = await scanReceiptNative(imageUri);

      if (!rawText) {
        return {
          rawText: '',
          extractedTotal: null,
          extractedMerchant: null,
          extractedDate: null,
          success: false,
          error: 'Empty text returned',
        };
      }

      const { extractedTotal, extractedMerchant, extractedDate } = parseReceiptTextHeuristic(rawText);

      return {
        rawText,
        extractedTotal,
        extractedMerchant,
        extractedDate,
        success: true,
      };
    } catch (error: any) {
      return {
        rawText: '',
        extractedTotal: null,
        extractedMerchant: null,
        extractedDate: null,
        success: false,
        error: error?.message || 'Unknown OCR Error',
      };
    }
  }
}

export const defaultOcrEngine = new MlKitEngine();