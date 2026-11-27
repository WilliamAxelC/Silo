const mockFiles = new Map<string, number>();
let mockDownloadStatus = 200;
const mockOpenURL = jest.fn(async () => true);

jest.mock('react-native', () => ({ Linking: { openURL: (...a: unknown[]) => mockOpenURL(...(a as [])) } }));
jest.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));
jest.mock('../errorLog', () => ({ recordError: jest.fn() }));
const mockSettings = new Map<string, string>();
jest.mock('../../db/index', () => ({
  expoDb: {
    getFirstSync: (_sql: string, params: string[]) => (mockSettings.has(params[0]) ? { value: mockSettings.get(params[0]) } : null),
    runSync: (sql: string, params: string[]) => {
      if (sql.startsWith('DELETE')) mockSettings.delete(params[0]);
      else mockSettings.set(params[0], params[1]);
    },
  },
}));
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

import { __setUpdateNativeForTests, cleanUpInstalledUpdates, resumePendingUpdate, SILO_PACKAGE, useAppUpdateStore } from '../appUpdate';
import { useUpdateStore } from '../updates';
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
    inspectApk: jest.fn(() => ({ packageName: 'dev.cuang.silo', versionCode: 11, versionName: '1.3.4' })),
    installApk: jest.fn(() => true),
    ...over,
  };
}

beforeEach(() => {
  mockSettings.clear();
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
    for (const info of [{ packageName: 'com.evil.app', versionCode: 11 }, { packageName: 'dev.cuang.silo', versionCode: 9 }, null]) {
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

  // Regression (emulator 2026-11-23): granting "Install unknown apps" makes Android restart Silo, which lost
  // the update sheet and left the user on the home screen with nothing happening.
  it('regression: resumes the update after Android restarts Silo for the install permission', async () => {
    let allowed = false;
    const native = fakeNative({ canInstallPackages: jest.fn(() => allowed) });
    __setUpdateNativeForTests(native as any);
    await useAppUpdateStore.getState().start(manifest);
    expect(useAppUpdateStore.getState().status).toBe('needs-permission');

    // "Process restart": in-memory state gone, files and settings remain.
    useAppUpdateStore.setState({ status: 'idle', fileUri: null, sheet: null });
    useUpdateStore.setState({ latest: manifest as any });
    allowed = true;
    expect(await resumePendingUpdate()).toBe(true);
    expect(useAppUpdateStore.getState().sheet).toEqual(manifest);
    expect(native.installApk).toHaveBeenCalledWith('file:///cache/updates/silo-1.3.4-11.apk');
    expect(native.sha256File).toHaveBeenCalled(); // re-verified before installing
    expect(await resumePendingUpdate()).toBe(false); // cleared once handed to the installer
  });

  it('forgets a pending update that is no longer offered', async () => {
    mockSettings.set('pendingUpdateInstall', '11');
    useUpdateStore.setState({ latest: { ...manifest, versionCode: 12 } as any });
    __setUpdateNativeForTests(fakeNative() as any);
    expect(await resumePendingUpdate()).toBe(false);
    expect(mockSettings.has('pendingUpdateInstall')).toBe(false);
  });
});

describe('package id', () => {
  it('the updater only installs APKs with the package id the app is built with', () => {
    const appConfig = jest.requireActual('../../../app.json');
    expect(SILO_PACKAGE).toBe(appConfig.expo.android.package);
    expect(SILO_PACKAGE).toBe('dev.cuang.silo');
  });

  it('regression: a Google Play build never downloads or installs an APK itself', async () => {
    const Constants = require('expo-constants').default;
    const before = Constants.expoConfig.extra;
    Constants.expoConfig.extra = { distribution: 'play' };
    try {
      const native = fakeNative();
      __setUpdateNativeForTests(native as any);
      useAppUpdateStore.getState().openSheet(manifest);
      expect(useAppUpdateStore.getState().sheet).toBeNull();
      await useAppUpdateStore.getState().start(manifest);
      expect(native.sha256File).not.toHaveBeenCalled();
      expect(native.installApk).not.toHaveBeenCalled();
    } finally {
      Constants.expoConfig.extra = before;
    }
  });
});
