import { requireOptionalNativeModule } from 'expo-modules-core';

interface ReceiptNormalizeNative {
  normalize(uri: string): Promise<string>;
  startBackgroundWork?(text: string): boolean;
  stopBackgroundWork?(): boolean;
  takeSharedImages?(): Promise<string[]>;
  addListener?(event: 'onShareReceived', listener: () => void): { remove(): void };
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

/** Images shared to Silo from another app (each share is returned once), as file:// URIs. */
/**
 * Photos that really came through Android's share sheet (copied into Silo's cache by the native module).
 * A silo:// link can set any route param, so Add Transaction only scans a sharedImageUri listed here.
 */
const trustedSharedImages = new Set<string>();

/** True once for a photo handed out by takeSharedImages; anything else (e.g. from a deep link) is refused. */
export function consumeTrustedSharedImage(uri: string | null | undefined): boolean {
  if (!uri || !trustedSharedImages.has(uri)) return false;
  trustedSharedImages.delete(uri);
  return true;
}

export async function takeSharedImages(): Promise<string[]> {
  try {
    const uris = await native?.takeSharedImages?.();
    const list = Array.isArray(uris) ? uris.filter((uri) => typeof uri === 'string' && uri.length > 0) : [];
    list.forEach((uri) => trustedSharedImages.add(uri));
    return list;
  } catch (error) {
    console.warn('Could not read shared images:', error);
    return [];
  }
}

/** Called when images are shared to Silo while it is already open. */
export function addShareListener(listener: () => void): () => void {
  try {
    const subscription = native?.addListener?.('onShareReceived', listener);
    return () => subscription?.remove();
  } catch {
    return () => undefined;
  }
}
