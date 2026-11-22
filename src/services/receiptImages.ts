import * as FileSystem from 'expo-file-system/legacy';
import { normalizeReceiptImage } from './ocr/normalizeImage';

export function getReceiptsDir(): string {
  return `${FileSystem.documentDirectory ?? ''}receipts/`;
}

/**
 * Receipt photos picked or scanned land in cache folders Android may clear. Copies the photo into the
 * app's documents/receipts folder (once) and returns the permanent URI; returns the input on failure.
 */
export async function persistReceiptImage(uri: string | null | undefined): Promise<string | null> {
  if (!uri) return null;
  const dir = getReceiptsDir();
  if (!dir || uri.startsWith(dir) || !uri.startsWith('file://')) return uri;
  try {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
    const extension = /\.(jpe?g|png|heic|webp)$/i.exec(uri)?.[0] ?? '.jpg';
    const dest = `${dir}receipt-${Date.now()}-${Math.round(Math.random() * 1e6)}${extension}`;
    await FileSystem.copyAsync({ from: uri, to: dest });
    return dest;
  } catch (error) {
    console.warn('Could not move receipt photo into app storage:', error);
    return uri;
  }
}

/**
 * Gallery photos get the same treatment as the camera's document scanner: cropped, straightened and
 * cleaned up in black and white (a much smaller file). Falls back to the original photo.
 */
export async function scanGalleryImage(uri: string): Promise<{ uri: string; scanned: boolean }> {
  const scanned = await normalizeReceiptImage(uri);
  return scanned ? { uri: scanned, scanned: true } : { uri, scanned: false };
}
