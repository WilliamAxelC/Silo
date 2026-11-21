import { Platform } from 'react-native';
import { File } from 'expo-file-system';
import {
  cacheDirectory,
  deleteAsync,
  documentDirectory,
  EncodingType,
  StorageAccessFramework,
  writeAsStringAsync,
} from 'expo-file-system/legacy';
import { isAvailableAsync, shareAsync } from 'expo-sharing';

export type SaveFileResult =
  | { status: 'saved'; uri: string }
  | { status: 'cancelled' };

export function isAndroidSafSupported(): boolean {
  return (
    Platform.OS === 'android' &&
    Boolean(StorageAccessFramework) &&
    typeof StorageAccessFramework.requestDirectoryPermissionsAsync === 'function' &&
    typeof StorageAccessFramework.createFileAsync === 'function'
  );
}

async function deleteSafFileQuietly(uri: string, file?: File | null): Promise<void> {
  if (file && typeof file.delete === 'function') {
    try {
      file.delete();
      return;
    } catch {
      // Fall back to legacy SAF deleteAsync if File.delete() failed.
    }
  }
  try {
    if (typeof deleteAsync === 'function') {
      await deleteAsync(uri, { idempotent: true });
    }
  } catch {
    // Best-effort cleanup so original write error is never masked.
  }
}

/**
 * Best-effort deletion of a temporary local cache file. Never throws.
 */
export async function deleteLocalFileQuietly(uri?: string | null): Promise<void> {
  if (!uri) return;
  try {
    if (typeof deleteAsync === 'function') {
      await deleteAsync(uri, { idempotent: true });
    }
  } catch {
    // Best-effort cleanup of temporary files.
  }
}

/**
 * Saves a UTF-8 text file (e.g. CSV) directly into a user-selected Android folder via Storage Access Framework.
 * Note: For recognized MIME types like `text/csv`, pass `fileName` without extension so Android doesn't duplicate it.
 * Cleans up the created SAF destination file if writing fails.
 */
export async function saveTextFileToDevice(options: {
  fileName: string;
  mimeType: string;
  content: string;
}): Promise<SaveFileResult> {
  if (!isAndroidSafSupported()) {
    throw new Error('Direct folder saving is unavailable on this platform.');
  }

  const permissions = await StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permissions.granted || !permissions.directoryUri) {
    return { status: 'cancelled' };
  }

  const destUri = await StorageAccessFramework.createFileAsync(
    permissions.directoryUri,
    options.fileName,
    options.mimeType
  );
  try {
    await writeAsStringAsync(destUri, options.content, {
      encoding: EncodingType?.UTF8 ?? 'utf8',
    });
    return { status: 'saved', uri: destUri };
  } catch (error) {
    await deleteSafFileQuietly(destUri);
    throw error;
  }
}

/**
 * Saves a local binary file (e.g. SQLite `.db` backup) into a user-selected Android folder via SAF.
 * Uses SDK 54 `expo-file-system`'s `File.bytes()` + `File.write(Uint8Array)` so binary bytes move via
 * native JSI TypedArray directly into Android's ContentResolver output stream without encoding the whole
 * database as a Base64 JS string. (SDK 54 `FileHandle` / `File.copy()` do not support `content://` URIs.)
 * Cleans up the created SAF destination file if writing fails.
 */
export async function saveBinaryFileToDevice(options: {
  sourceUri: string;
  fileName: string;
  mimeType: string;
}): Promise<SaveFileResult> {
  if (!isAndroidSafSupported()) {
    throw new Error('Direct folder saving is unavailable on this platform.');
  }

  const permissions = await StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permissions.granted || !permissions.directoryUri) {
    return { status: 'cancelled' };
  }

  const sourceFile = new File(options.sourceUri);
  const bytes = await sourceFile.bytes();

  const destUri = await StorageAccessFramework.createFileAsync(
    permissions.directoryUri,
    options.fileName,
    options.mimeType
  );
  let destFile: File | null = null;
  try {
    destFile = new File(destUri);
    destFile.write(bytes);
    return { status: 'saved', uri: destUri };
  } catch (error) {
    await deleteSafFileQuietly(destUri, destFile);
    throw error;
  }
}

/**
 * Writes a UTF-8 text file into app cache storage so it can be passed to the system Share sheet.
 */
export async function writeLocalTextFile(fileName: string, content: string): Promise<string> {
  const baseDir = cacheDirectory ?? documentDirectory ?? '';
  const fileUri = `${baseDir}${fileName}`;
  await writeAsStringAsync(fileUri, content, {
    encoding: EncodingType?.UTF8 ?? 'utf8',
  });
  return fileUri;
}

/**
 * Secondary share helper. Returns false when no sharing target / service is available.
 */
export async function shareLocalFile(
  fileUri: string,
  options: { mimeType: string; dialogTitle: string; UTI?: string }
): Promise<boolean> {
  if (!(await isAvailableAsync())) {
    return false;
  }
  await shareAsync(fileUri, options);
  return true;
}
