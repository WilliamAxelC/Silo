import Constants from 'expo-constants';
import { create } from 'zustand';

import { expoDb } from '../db/index';
import { isPlayBuild } from './distribution';

/** Published next to the APK on the download page. The test channel reads version-test.json. */
export const UPDATE_MANIFEST_URL = 'https://cuang.dev/projects/silo/version.json';
export const TEST_MANIFEST_URL = 'https://cuang.dev/projects/silo/version-test.json';
export type UpdateChannel = 'stable' | 'test';
const CHANNEL_KEY = 'updateChannel';
export const DOWNLOAD_PAGE_URL = 'https://cuang.dev/projects/silo/';

const CACHE_KEY = 'updateCheck';
const ENABLED_KEY = 'updateChecksEnabled';
const DISMISSED_KEY = 'updateDismissedVersionCode';
/** Links in the manifest must stay on the download site. */
const ALLOWED_LINK_PREFIX = 'https://cuang.dev/';

export interface AppVersion {
  version: string;
  versionCode: number;
}

export interface UpdateApk {
  /** https://cuang.dev/... .apk */
  url: string;
  /** Lower-case hex SHA-256 of the APK; the download is refused unless it matches. */
  sha256: string;
  sizeBytes: number;
}

export interface UpdateManifest extends AppVersion {
  /** Page to open for the update. */
  url: string;
  date?: string;
  notes?: string[];
  /** Present when the update can be installed from inside the app (1.3.3+). */
  apk?: UpdateApk;
}

export interface UpdateCache {
  checkedAt: number;
  latest: UpdateManifest | null;
}

type FetchLike = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** The version of this build, from app.json as embedded at build time. */
export function getInstalledVersion(): AppVersion {
  const config: any = Constants.expoConfig ?? {};
  const versionCode = Number(config?.android?.versionCode ?? 0);
  return { version: String(config?.version ?? '0.0.0'), versionCode: Number.isFinite(versionCode) ? versionCode : 0 };
}

/** Validates the downloaded manifest; anything unexpected is treated as "no information". */
export function parseManifest(body: unknown): UpdateManifest | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  const versionCode = Number(raw.versionCode);
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!/^\d+(\.\d+){0,3}$/.test(version) || !Number.isInteger(versionCode) || versionCode <= 0) return null;
  const safeUrl = url.startsWith(ALLOWED_LINK_PREFIX) ? url : DOWNLOAD_PAGE_URL;
  const notes = Array.isArray(raw.notes)
    ? raw.notes.filter((n): n is string => typeof n === 'string' && n.trim().length > 0).map((n) => n.trim().slice(0, 160)).slice(0, 6)
    : undefined;
  const date = typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : undefined;
  return { version, versionCode, url: safeUrl, date, notes, apk: parseApk(raw.apk) };
}

/** The installable APK, only from the download site and only with a well-formed checksum. */
export function parseApk(value: unknown): UpdateApk | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  const sha256 = typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : '';
  const sizeBytes = Number(raw.sizeBytes);
  if (!url.startsWith(ALLOWED_LINK_PREFIX) || !/\.apk$/i.test(url) || /[\s?#]/.test(url)) return undefined;
  if (!/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > 300 * 1024 * 1024) return undefined;
  return { url, sha256, sizeBytes };
}

export function getUpdateChannel(): UpdateChannel {
  return readSetting(CHANNEL_KEY) === 'test' ? 'test' : 'stable';
}

export function manifestUrlFor(channel: UpdateChannel): string {
  return channel === 'test' ? TEST_MANIFEST_URL : UPDATE_MANIFEST_URL;
}

export function isNewer(latest: AppVersion | null | undefined, installed: AppVersion): boolean {
  return Boolean(latest && latest.versionCode > installed.versionCode);
}

function readSetting(key: string): string | null {
  try {
    return expoDb.getFirstSync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?;', [key])?.value ?? null;
  } catch {
    return null;
  }
}

function writeSetting(key: string, value: string) {
  try {
    expoDb.runSync('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?);', [key, value]);
  } catch {
    // Settings table unavailable (e.g. DB not open yet); the next check tries again.
  }
}

export function readUpdateCache(): UpdateCache | null {
  const raw = readSetting(CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as UpdateCache;
    if (typeof parsed?.checkedAt !== 'number') return null;
    return { checkedAt: parsed.checkedAt, latest: parsed.latest ? parseManifest(parsed.latest) : null };
  } catch {
    return null;
  }
}

const sameLocalDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/**
 * Downloads the version manifest at most once a day (or now, with force). Sends nothing about the user:
 * a plain GET of a static file. Never throws; resolves the cached result when offline.
 */
export async function fetchLatestVersion(
  options: { force?: boolean; now?: number; fetchImpl?: FetchLike; channel?: UpdateChannel } = {},
): Promise<UpdateCache | null> {
  const now = options.now ?? Date.now();
  const cached = readUpdateCache();
  if (!options.force && cached && sameLocalDay(cached.checkedAt, now)) return cached;
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url) => fetch(url, { cache: 'no-store' } as RequestInit));
  try {
    const response = await fetchImpl(manifestUrlFor(options.channel ?? getUpdateChannel()));
    if (!response.ok) return cached;
    const latest = parseManifest(await response.json());
    if (!latest) return cached;
    const next: UpdateCache = { checkedAt: now, latest };
    writeSetting(CACHE_KEY, JSON.stringify(next));
    return next;
  } catch {
    return cached;
  }
}

interface UpdateState {
  installed: AppVersion;
  latest: UpdateManifest | null;
  checkedAt: number | null;
  checking: boolean;
  /** Automatic daily checks (the manual button always works). */
  enabled: boolean;
  dismissedVersionCode: number;
  channel: UpdateChannel;
  /** Last manual check failed to reach the site. */
  lastCheckFailed: boolean;
  hydrate: () => void;
  check: (options?: { force?: boolean; fetchImpl?: FetchLike; now?: number }) => Promise<void>;
  setEnabled: (enabled: boolean) => void;
  dismiss: () => void;
  /** Test channel: early builds from the test branch (version-test.json). Re-checks right away. */
  setChannel: (channel: UpdateChannel) => Promise<void>;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  installed: getInstalledVersion(),
  latest: null,
  checkedAt: null,
  checking: false,
  enabled: true,
  dismissedVersionCode: 0,
  channel: 'stable',
  lastCheckFailed: false,
  hydrate: () => {
    // Google Play builds get updates from Play only: never show a cuang.dev version.
    const cache = isPlayBuild() ? null : readUpdateCache();
    set({
      latest: cache?.latest ?? null,
      checkedAt: cache?.checkedAt ?? null,
      enabled: readSetting(ENABLED_KEY) !== 'false',
      dismissedVersionCode: Number(readSetting(DISMISSED_KEY) ?? 0) || 0,
      channel: getUpdateChannel(),
    });
  },
  check: async (options = {}) => {
    if (isPlayBuild() || get().checking) return;
    if (!options.force && !get().enabled) return;
    set({ checking: true });
    const before = get().checkedAt;
    const result = await fetchLatestVersion(options);
    set({
      checking: false,
      latest: result?.latest ?? get().latest,
      checkedAt: result?.checkedAt ?? before,
      lastCheckFailed: Boolean(options.force) && (!result || result.checkedAt === before),
    });
  },
  setEnabled: (enabled) => {
    writeSetting(ENABLED_KEY, enabled ? 'true' : 'false');
    set({ enabled });
  },
  setChannel: async (channel) => {
    if (isPlayBuild()) return;
    writeSetting(CHANNEL_KEY, channel);
    writeSetting(CACHE_KEY, '');
    set({ channel, latest: null, checkedAt: null });
    await get().check({ force: true });
  },
  dismiss: () => {
    const code = get().latest?.versionCode ?? 0;
    writeSetting(DISMISSED_KEY, String(code));
    set({ dismissedVersionCode: code });
  },
}));

/** An update exists and the user has not dismissed the banner for this version. */
export function selectShowUpdateBanner(state: Pick<UpdateState, 'latest' | 'installed' | 'dismissedVersionCode'>): boolean {
  if (isPlayBuild()) return false;
  return isNewer(state.latest, state.installed) && (state.latest?.versionCode ?? 0) > state.dismissedVersionCode;
}
