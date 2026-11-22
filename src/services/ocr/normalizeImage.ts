import { requireOptionalNativeModule } from 'expo-modules-core';

interface ReceiptNormalizeNative {
  normalize(uri: string): Promise<string>;
  startBackgroundWork?(text: string): boolean;
  stopBackgroundWork?(): boolean;
}

// Local Expo module in modules/receipt-normalize (Android only); absent in Expo Go, iOS and Jest.
const native = requireOptionalNativeModule<ReceiptNormalizeNative>('ReceiptNormalize');

/**
 * Produces a document-scanner style copy of a receipt photo: upright, the receipt found and cropped /
 * straightened when it stands out from the background, shadows flattened, black and white. Resolves null
 * when the native module is unavailable or the image cannot be processed.
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

/**
 * Shows/updates the "Reading receipts" notification and keeps the app alive (foreground service + wake lock)
 * so queued receipts keep being read with the app in the background. No-op where unsupported.
 */
export function startBackgroundWork(text: string): boolean {
  try {
    return Boolean(native?.startBackgroundWork?.(text));
  } catch (error) {
    console.warn('Could not start background receipt work:', error);
    return false;
  }
}

export function stopBackgroundWork(): void {
  try {
    native?.stopBackgroundWork?.();
  } catch (error) {
    console.warn('Could not stop background receipt work:', error);
  }
}
