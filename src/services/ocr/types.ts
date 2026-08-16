// Define the standard output format no matter which OCR engine is used
export interface OcrResult {
  rawText: string;
  extractedTotal: number | null;
  extractedMerchant: string | null;
  extractedDate?: string | null;
  extractedCategory?: string | null;
  extractedLineItems?: string | null;
  success: boolean;
  error?: string;
}

export interface IOcrEngine {
  processImage(imageUri: string): Promise<OcrResult>;
}