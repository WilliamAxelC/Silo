const mockSettings = new Map<string, string>();
jest.mock('../../db/index', () => ({
  expoDb: {
    getFirstSync: (_sql: string, params: string[]) =>
      mockSettings.has(params[0]) ? { value: mockSettings.get(params[0]) } : null,
    runSync: (_sql: string, params: string[]) => {
      mockSettings.set(params[0], params[1]);
    },
  },
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.3.1', android: { versionCode: 8 } } },
}));

import {
  DOWNLOAD_PAGE_URL,
  fetchLatestVersion,
  getInstalledVersion,
  isNewer,
  parseManifest,
  selectShowUpdateBanner,
  useUpdateStore,
} from '../updates';

const manifest = {
  version: '1.4.0',
  versionCode: 9,
  url: 'https://cuang.dev/projects/silo/',
  date: '2026-12-01',
  notes: ['Faster receipts'],
};
const okFetch = (body: unknown) => jest.fn(async () => ({ ok: true, json: async () => body }));

describe('update checks', () => {
  beforeEach(() => {
    mockSettings.clear();
    useUpdateStore.setState({ latest: null, checkedAt: null, checking: false, enabled: true, dismissedVersionCode: 0, lastCheckFailed: false });
  });

  it('reads the installed version from the build config', () => {
    expect(getInstalledVersion()).toEqual({ version: '1.3.1', versionCode: 8 });
  });

  it('accepts a well-formed manifest and rejects junk', () => {
    expect(parseManifest(manifest)).toMatchObject({ version: '1.4.0', versionCode: 9 });
    expect(parseManifest({ version: 'latest', versionCode: 9 })).toBeNull();
    expect(parseManifest({ version: '1.4.0', versionCode: '9.5' })).toBeNull();
    expect(parseManifest('nope')).toBeNull();
  });

  it('never links anywhere but the download site', () => {
    expect(parseManifest({ ...manifest, url: 'https://evil.example/silo.apk' })!.url).toBe(DOWNLOAD_PAGE_URL);
    expect(parseManifest({ ...manifest, url: 'javascript:alert(1)' })!.url).toBe(DOWNLOAD_PAGE_URL);
  });

  it('compares by build number', () => {
    expect(isNewer({ version: '1.4.0', versionCode: 9 }, { version: '1.3.1', versionCode: 8 })).toBe(true);
    expect(isNewer({ version: '1.3.1', versionCode: 8 }, { version: '1.3.1', versionCode: 8 })).toBe(false);
    expect(isNewer(null, { version: '1.3.1', versionCode: 8 })).toBe(false);
  });

  it('downloads at most once a day unless forced, and keeps the last answer when offline', async () => {
    const now = new Date(2026, 11, 1, 9).getTime();
    const first = okFetch(manifest);
    await fetchLatestVersion({ now, fetchImpl: first });
    const second = okFetch(manifest);
    await fetchLatestVersion({ now: now + 60_000, fetchImpl: second });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    const offline = jest.fn(async () => {
      throw new Error('offline');
    });
    const result = await fetchLatestVersion({ now: now + 60_000, force: true, fetchImpl: offline });
    expect(result?.latest?.versionCode).toBe(9);
  });

  it('shows the banner for a newer version until dismissed, and again for the next one', async () => {
    await useUpdateStore.getState().check({ fetchImpl: okFetch(manifest) });
    expect(selectShowUpdateBanner(useUpdateStore.getState())).toBe(true);
    useUpdateStore.getState().dismiss();
    expect(selectShowUpdateBanner(useUpdateStore.getState())).toBe(false);

    await useUpdateStore.getState().check({ force: true, fetchImpl: okFetch({ ...manifest, version: '1.5.0', versionCode: 10 }) });
    expect(selectShowUpdateBanner(useUpdateStore.getState())).toBe(true);
  });

  it('skips automatic checks when turned off, but Check now still works', async () => {
    useUpdateStore.getState().setEnabled(false);
    const auto = okFetch(manifest);
    await useUpdateStore.getState().check({ fetchImpl: auto });
    expect(auto).not.toHaveBeenCalled();
    const manual = okFetch(manifest);
    await useUpdateStore.getState().check({ force: true, fetchImpl: manual });
    expect(manual).toHaveBeenCalled();
    expect(mockSettings.get('updateChecksEnabled')).toBe('false');
  });

  it('reports a failed manual check', async () => {
    await useUpdateStore.getState().check({ force: true, fetchImpl: jest.fn(async () => ({ ok: false, json: async () => ({}) })) });
    expect(useUpdateStore.getState().lastCheckFailed).toBe(true);
  });

  it('regression: a Google Play build never checks cuang.dev and never shows the update banner', async () => {
    const Constants = require('expo-constants').default;
    const before = Constants.expoConfig.extra;
    Constants.expoConfig.extra = { distribution: 'play' };
    try {
      const fetchImpl = okFetch(manifest);
      await useUpdateStore.getState().check({ force: true, fetchImpl });
      expect(fetchImpl).not.toHaveBeenCalled();
      useUpdateStore.setState({ latest: { ...manifest, version: '9.0.0', versionCode: 99 } as any, dismissedVersionCode: 0 });
      expect(selectShowUpdateBanner(useUpdateStore.getState())).toBe(false);
    } finally {
      Constants.expoConfig.extra = before;
    }
  });
});
