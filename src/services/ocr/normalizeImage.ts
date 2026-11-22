import { requireOptionalNativeModule } from 'expo-modules-core';

interface ReceiptNormalizeNative {
  normalize(uri: string): Promise<string>;
}

// Local Expo module in modules/receipt-normalize (Android only); absent in Expo Go, iOS and Jest.
const native = requireOptionalNativeModule<ReceiptNormalizeNative>('ReceiptNormalize');

/**
 * Produces a document-scanner style grayscale copy of a receipt photo (upright, shadows flattened,
 * ink darkened). Resolves null when the native module is unavailable or the image cannot be processed.
 */
export async function normalizeReceiptImage(uri: string): Promise<string | null> {
  if (!native || !uri) return null;
  try {
    const normalized = await native.normalize(uri);
    return typeof normalized === 'string' && normalized ? normalized : null;
  } catch (error) {
    console.warn('Receipt normalization failed; using the original photo:', error);
    return null;
  }
}
