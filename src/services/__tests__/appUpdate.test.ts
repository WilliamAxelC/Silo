const mockFiles = new Map<string, number>();
let mockDownloadStatus = 200;
const mockOpenURL = jest.fn(async () => true);

jest.mock('react-native', () => ({ Linking: { openURL: (...a: unknown[]) => mockOpenURL(...(a as [])) } }));
jest.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));
jest.mock('../errorLog', () => ({ recordError: jest.fn() }));
jest.mock('../../db/index', () => ({ expoDb: { getFirstSync: () => null, runSync: () => undefined } }));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '1.3.3', android: { versionCode: 10 } } } }));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  makeDirectoryAsync: jest.fn(async () => undefined),
  getInfoAsync: jest.fn(async (uri: string) => (mockFiles.has(uri) ? { exists: true, size: mockFiles.get(uri) } : { exists: false })),
  deleteAsync: jest.fn(async (uri: string) => {
    mockFiles.delete(uri);
  }),
  readDirectoryAsync: jest.fn(async () => [...mockFiles.keys()].map((k) => k.split('/').pop())),
  createDownloadResumable: jest.fn((_url: string, fileUri: string, _o: unknown, cb: (p: any) => void) => ({
    downloadAsync: async () => {
      cb({ totalBytesWritten: 50, totalBytesExpectedToWrite: 100 });
      mockFiles.set(fileUri, 100);
      return { status: mockDownloadStatus, uri: fileUri };
    },
    pauseAsync: jest.fn(),
  })),
}));

import { __setUpdateNativeForTests, cleanUpInstalledUpdates, useAppUpdateStore } from '../appUpdate';
import { parseApk, parseManifest } from '../updates';

const SHA = 'a'.repeat(64);
const manifest = {
  version: '1.3.4',
  versionCode: 11,
  url: 'https://cuang.dev/projects/silo/',
  apk: { url: 'https://cuang.dev/projects/silo/silo-1.3.4.apk', sha256: SHA, sizeBytes: 100 },
};

function fakeNative(over: Partial<Record<string, any>> = {}) {
  return {
    sha256File: jest.fn(async () => SHA),
    canInstallPackages: jest.fn(() => true),
    openInstallPermissionSettings: jest.fn(() => true),
    inspectApk: jest.fn(() => ({ packageName: 'com.LCSdev.silo', versionCode: 11, versionName: '1.3.4' })),
    installApk: jest.fn(() => true),
    ...over,
  };
}

beforeEach(() => {
  mockFiles.clear();
  mockDownloadStatus = 200;
  mockOpenURL.mockClear();
  useAppUpdateStore.setState({ status: 'idle', progress: 0, error: null, fileUri: null });
});

describe('update manifest: installable APK', () => {
  it('accepts only APKs on the download site with a proper SHA-256', () => {
    expect(parseApk(manifest.apk)).toEqual(manifest.apk);
    expect(parseApk({ ...manifest.apk, url: 'https://evil.example/silo.apk' })).toBeUndefined();
    expect(parseApk({ ...manifest.apk, url: 'https://cuang.dev/projects/silo/page.html' })).toBeUndefined();
    expect(parseApk({ ...manifest.apk, sha256: 'abc' })).toBeUndefined();
    expect(parseApk({ ...manifest.apk, sizeBytes: -1 })).toBeUndefined();
    expect(parseManifest({ ...manifest, apk: { url: 'http://cuang.dev/x.apk', sha256: SHA, sizeBytes: 1 } })?.apk).toBeUndefined();
  });
});

describe('in-app update', () => {
  it('downloads, verifies the checksum and version, then opens the installer', async () => {
    const native = fakeNative();
    __setUpdateNativeForTests(native as any);
    await useAppUpdateStore.getState().start(manifest);
    expect(native.sha256File).toHaveBeenCalled();
    expect(native.installApk).toHaveBeenCalledWith('file:///cache/updates/silo-1.3.4-11.apk');
    expect(useAppUpdateStore.getState().status).toBe('installing');
  });

  it('refuses and deletes a file whose checksum does not match', async () => {
    const native = fakeNative({ sha256File: jest.fn(async () => 'b'.repeat(64)) });
    __setUpdateNativeForTests(native as any);
    await useAppUpdateStore.getState().start(manifest);
    expect(native.installApk).not.toHaveBeenCalled();
    expect(useAppUpdateStore.getState()).toMatchObject({ status: 'error' });
    expect(useAppUpdateStore.getState().error).toMatch(/checksum/);
    expect(mockFiles.size).toBe(0);
  });

  it('refuses an APK that is not Silo or not the announced version', async () => {
    for (const info of [{ packageName: 'com.evil.app', versionCode: 11 }, { packageName: 'com.LCSdev.silo', versionCode: 9 }, null]) {
      const native = fakeNative({ inspectApk: jest.fn(() => info) });
      __setUpdateNativeForTests(native as any);
      await useAppUpdateStore.getState().start(manifest);
      expect(native.installApk).not.toHaveBeenCalled();
      expect(useAppUpdateStore.getState().error).toMatch(/not the expected Silo/);
      useAppUpdateStore.getState().reset();
    }
  });

  it('asks for the install permission first, then installs once allowed', async () => {
    let allowed = false;
    const native = fakeNative({ canInstallPackages: jest.fn(() => allowed) });
    __setUpdateNativeForTests(native as any);
    await useAppUpdateStore.getState().start(manifest);
    expect(useAppUpdateStore.getState().status).toBe('needs-permission');
    useAppUpdateStore.getState().openPermissionSettings();
    expect(native.openInstallPermissionSettings).toHaveBeenCalled();
    allowed = true;
    useAppUpdateStore.getState().install();
    expect(native.installApk).toHaveBeenCalled();
  });

  it('reuses an already downloaded, verified file instead of downloading again', async () => {
    mockFiles.set('file:///cache/updates/silo-1.3.4-11.apk', 100);
    const fs = require('expo-file-system/legacy');
    fs.createDownloadResumable.mockClear();
    __setUpdateNativeForTests(fakeNative() as any);
    await useAppUpdateStore.getState().start(manifest);
    expect(fs.createDownloadResumable).not.toHaveBeenCalled();
    expect(useAppUpdateStore.getState().status).toBe('installing');
  });

  it('reports a failed download and does not install', async () => {
    mockDownloadStatus = 404;
    const native = fakeNative();
    __setUpdateNativeForTests(native as any);
    await useAppUpdateStore.getState().start(manifest);
    expect(useAppUpdateStore.getState().error).toMatch(/HTTP 404/);
    expect(native.installApk).not.toHaveBeenCalled();
  });

  it('falls back to the download page when the manifest has no APK or the phone lacks native support', async () => {
    __setUpdateNativeForTests(fakeNative() as any);
    await useAppUpdateStore.getState().start({ ...manifest, apk: undefined });
    __setUpdateNativeForTests(null);
    await useAppUpdateStore.getState().start(manifest);
    expect(mockOpenURL).toHaveBeenCalledTimes(2);
  });

  it('never offers a version that is not newer', async () => {
    const native = fakeNative();
    __setUpdateNativeForTests(native as any);
    await useAppUpdateStore.getState().start({ ...manifest, versionCode: 10 });
    expect(native.installApk).not.toHaveBeenCalled();
    expect(useAppUpdateStore.getState().error).toMatch(/already have/);
  });

  it('cleans up downloaded APKs for versions already installed', async () => {
    mockFiles.set('file:///cache/updates/silo-1.3.3-10.apk', 1);
    mockFiles.set('file:///cache/updates/silo-1.3.4-11.apk', 1);
    await cleanUpInstalledUpdates();
    expect([...mockFiles.keys()]).toEqual(['file:///cache/updates/silo-1.3.4-11.apk']);
  });
});
