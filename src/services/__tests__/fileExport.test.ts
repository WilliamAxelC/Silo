import { Platform } from 'react-native';
import { File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import {
  deleteLocalFileQuietly,
  isAndroidSafSupported,
  saveBinaryFileToDevice,
  saveTextFileToDevice,
  shareLocalFile,
} from '../fileExport';

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));

describe('fileExport SAF direct saving & secondary share (F-04)', () => {
  const originalOS = Platform.OS;

  beforeEach(() => {
    jest.clearAllMocks();
    Platform.OS = 'android';
  });

  afterAll(() => {
    Platform.OS = originalOS;
  });

  it('saves UTF-8 text files directly to a user-chosen Android folder via SAF', async () => {
    expect(isAndroidSafSupported()).toBe(true);

    const res = await saveTextFileToDevice({
      fileName: 'Silo_Transactions_2026-11-21',
      mimeType: 'text/csv',
      content: 'Date,Merchant Name\n21/11/2026,"Coffee"\n',
    });

    expect(res.status).toBe('saved');
    expect(FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.StorageAccessFramework.createFileAsync).toHaveBeenCalledWith(
      'content://com.android.externalstorage.documents/tree/primary%3ADownload',
      'Silo_Transactions_2026-11-21',
      'text/csv'
    );
    expect(FileSystem.writeAsStringAsync).toHaveBeenCalledWith(
      expect.stringContaining('Silo_Transactions_2026-11-21'),
      'Date,Merchant Name\n21/11/2026,"Coffee"\n',
      { encoding: FileSystem.EncodingType.UTF8 }
    );
  });

  it('returns cancelled without creating a file when directory permission is declined', async () => {
    (FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync as jest.Mock).mockResolvedValueOnce({
      granted: false,
    });

    const res = await saveTextFileToDevice({
      fileName: 'Silo_Transactions_2026-11-21',
      mimeType: 'text/csv',
      content: 'header\n',
    });

    expect(res).toEqual({ status: 'cancelled' });
    expect(FileSystem.StorageAccessFramework.createFileAsync).not.toHaveBeenCalled();
    expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
  });

  it('saves binary backup files directly via SAF using SDK 54 File raw bytes without loading Base64 strings (R3A-03)', async () => {
    const payload = new Uint8Array([83, 81, 76, 105, 116, 101, 32, 102, 111, 114, 109, 97, 116]);
    (File.prototype.bytes as jest.Mock).mockResolvedValueOnce(payload);

    const res = await saveBinaryFileToDevice({
      sourceUri: 'file:///cache/backups/silo-backup-2026-11-21.db',
      fileName: 'silo-backup-2026-11-21.db',
      mimeType: 'application/octet-stream',
    });

    expect(res.status).toBe('saved');
    expect(File.prototype.bytes).toHaveBeenCalledTimes(1);
    expect(FileSystem.StorageAccessFramework.createFileAsync).toHaveBeenCalledWith(
      'content://com.android.externalstorage.documents/tree/primary%3ADownload',
      'silo-backup-2026-11-21.db',
      'application/octet-stream'
    );
    expect(File.prototype.write).toHaveBeenCalledWith(payload);
    // Must NEVER encode or transfer the whole database as a Base64 JS string
    expect(FileSystem.readAsStringAsync).not.toHaveBeenCalled();
    expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
  });

  it('deletes the created SAF destination file if binary write fails so no 0-byte orphan remains (R3A-03)', async () => {
    (File.prototype.write as jest.Mock).mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    await expect(
      saveBinaryFileToDevice({
        sourceUri: 'file:///cache/backups/silo-backup-2026-11-21.db',
        fileName: 'silo-backup-2026-11-21.db',
        mimeType: 'application/octet-stream',
      })
    ).rejects.toThrow('ENOSPC');

    expect(File.prototype.delete).toHaveBeenCalledTimes(1);
  });

  it('does not create a SAF file when reading the source backup fails (R3A-03)', async () => {
    (File.prototype.bytes as jest.Mock).mockRejectedValueOnce(new Error('Source file missing'));

    await expect(
      saveBinaryFileToDevice({
        sourceUri: 'file:///cache/backups/missing.db',
        fileName: 'missing.db',
        mimeType: 'application/octet-stream',
      })
    ).rejects.toThrow('Source file missing');

    expect(FileSystem.StorageAccessFramework.createFileAsync).not.toHaveBeenCalled();
  });

  it('deletes the created SAF destination file if UTF-8 CSV write fails (R3A-03)', async () => {
    (FileSystem.writeAsStringAsync as jest.Mock).mockRejectedValueOnce(new Error('SAF write failed'));

    await expect(
      saveTextFileToDevice({
        fileName: 'Silo_Transactions_2026-11-21',
        mimeType: 'text/csv',
        content: 'Date,Merchant\n',
      })
    ).rejects.toThrow('SAF write failed');

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      expect.stringContaining('Silo_Transactions_2026-11-21'),
      { idempotent: true }
    );
  });

  it('deletes temporary local files quietly via deleteLocalFileQuietly without throwing', async () => {
    (FileSystem.deleteAsync as jest.Mock).mockRejectedValueOnce(new Error('already gone'));
    await expect(deleteLocalFileQuietly('file:///cache/tmp.db')).resolves.toBeUndefined();
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///cache/tmp.db', { idempotent: true });
  });

  it('returns false gracefully from shareLocalFile when sharing is unavailable', async () => {
    (Sharing.isAvailableAsync as jest.Mock).mockResolvedValueOnce(false);
    const shared = await shareLocalFile('file:///tmp/backup.db', {
      mimeType: 'application/octet-stream',
      dialogTitle: 'Share backup',
    });
    expect(shared).toBe(false);
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
  });
});
