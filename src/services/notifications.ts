import { Platform } from 'react-native';
import type * as NotificationsTypes from 'expo-notifications';

export const DAILY_REMINDER_ID = 'silo-daily-reminder';
export const DAILY_REMINDER_CHANNEL_ID = 'daily-reminder';
export const DAILY_REMINDER_DEEP_LINK = 'silo://add';
export const DAILY_REMINDER_KIND = 'daily-reminder';
export const DAILY_REMINDER_TITLE = 'Daily reminder';
export const DAILY_REMINDER_BODY = 'Did you spend anything today? Tap to add it.';

const DEFAULT_HOUR = 20;
const DEFAULT_MINUTE = 0;
const REMINDER_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

type NotificationsModule = typeof NotificationsTypes;

export type ReminderPermissionOutcome = 'granted' | 'denied' | 'unavailable';

export interface SyncDailyReminderResult {
  ok: boolean;
  reason?: 'unavailable' | 'permission-denied' | 'failed';
}

let cachedNotificationsModule: NotificationsModule | null | undefined;

/**
 * Lazily loads `expo-notifications` so builds without the native
 * `ExpoNotificationsEmitter` module (e.g. older dev clients or Expo Go)
 * never crash during app startup or Settings import.
 */
function getNotificationsModule(): NotificationsModule | null {
  if (cachedNotificationsModule !== undefined) {
    return cachedNotificationsModule;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-notifications') as NotificationsModule | null | undefined;
    cachedNotificationsModule = mod ?? null;
  } catch {
    cachedNotificationsModule = null;
  }
  return cachedNotificationsModule;
}

export function isNotificationsAvailable(): boolean {
  const Notifications = getNotificationsModule();
  return Boolean(
    Notifications &&
      typeof Notifications.getPermissionsAsync === 'function' &&
      typeof Notifications.scheduleNotificationAsync === 'function'
  );
}

export function parseReminderTime(time: string | null | undefined): { hour: number; minute: number } {
  if (typeof time !== 'string') {
    return { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE };
  }
  const match = REMINDER_TIME_RE.exec(time.trim());
  if (!match) {
    return { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE };
  }
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
}

export function formatReminderTime(hour: number, minute: number): string {
  const safeHour = Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.trunc(hour))) : DEFAULT_HOUR;
  const safeMinute = Number.isFinite(minute) ? Math.min(59, Math.max(0, Math.trunc(minute))) : DEFAULT_MINUTE;
  return `${String(safeHour).padStart(2, '0')}:${String(safeMinute).padStart(2, '0')}`;
}

export function reminderTimeToDate(time: string | null | undefined, baseDate: Date = new Date()): Date {
  const { hour, minute } = parseReminderTime(time);
  return new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), hour, minute, 0, 0);
}

/**
 * Configures how incoming local notifications are displayed while the app is open.
 * Does not request permission and never throws when native notifications are unavailable.
 */
export function configureNotificationHandler(): void {
  const Notifications = getNotificationsModule();
  if (!Notifications || typeof Notifications.setNotificationHandler !== 'function') {
    return;
  }
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
  } catch {
    // Ignore if the native notification handler is unavailable on this runtime.
  }
}

export async function ensureAndroidReminderChannel(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  const Notifications = getNotificationsModule();
  if (!Notifications || typeof Notifications.setNotificationChannelAsync !== 'function') {
    return;
  }
  try {
    const defaultImportance =
      Notifications.AndroidImportance?.DEFAULT ?? (5 as NotificationsTypes.AndroidImportance.DEFAULT);
    await Notifications.setNotificationChannelAsync(DAILY_REMINDER_CHANNEL_ID, {
      name: 'Daily reminder',
      importance: defaultImportance,
      sound: 'default',
    });
  } catch {
    // Ignore channel setup failures when native notifications are unavailable.
  }
}

/**
 * On Android 13+, `expo-notifications` sets `granted: true` from the POST_NOTIFICATIONS
 * runtime grant even when app notifications are disabled in Android System Settings
 * (`status: 'denied'`). Treat explicit `status === 'denied'` as not granted.
 */
function isPermissionGranted(status: { granted?: boolean; status?: string } | null | undefined): boolean {
  return Boolean(status && status.status !== 'denied' && (status.granted || status.status === 'granted'));
}

/**
 * Checks notification permission and asks the OS only if not yet granted.
 * Distinguishes `'unavailable'` (missing/failing native module) from `'denied'`.
 */
export async function requestDailyReminderPermissionStatus(): Promise<ReminderPermissionOutcome> {
  const Notifications = getNotificationsModule();
  if (!Notifications || typeof Notifications.getPermissionsAsync !== 'function') {
    return 'unavailable';
  }
  await ensureAndroidReminderChannel();
  try {
    const current = await Notifications.getPermissionsAsync();
    if (isPermissionGranted(current)) {
      return 'granted';
    }
    if (typeof Notifications.requestPermissionsAsync !== 'function') {
      return 'unavailable';
    }
    const requested = await Notifications.requestPermissionsAsync();
    return isPermissionGranted(requested) ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}

/**
 * Asks for notification permission (Android 13+) when the user starts an AI model download, so the download's
 * progress notification can show. Asks only if Android has never been asked; a "no" is respected.
 * Never throws.
 */
export async function requestDownloadNotificationPermission(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  const Notifications = getNotificationsModule();
  if (!Notifications || typeof Notifications.getPermissionsAsync !== 'function') {
    return;
  }
  try {
    const current = await Notifications.getPermissionsAsync();
    if (isPermissionGranted(current) || current.status !== 'undetermined' || current.canAskAgain === false) {
      return;
    }
    if (typeof Notifications.requestPermissionsAsync === 'function') {
      await Notifications.requestPermissionsAsync();
    }
  } catch {
    // Notifications unavailable: the download still runs, just without a visible notification.
  }
}

/**
 * Checks notification permission and asks the OS only if not yet granted.
 * Call only in response to the user explicitly turning on the daily reminder switch.
 */
export async function requestDailyReminderPermission(): Promise<boolean> {
  return (await requestDailyReminderPermissionStatus()) === 'granted';
}

/**
 * Cancels any previously scheduled Silo daily reminder notifications.
 * Never throws when notifications are unavailable.
 */
export async function cancelDailyReminder(): Promise<void> {
  const Notifications = getNotificationsModule();
  if (!Notifications) {
    return;
  }
  const idsToCancel = new Set<string>([DAILY_REMINDER_ID]);

  try {
    if (typeof Notifications.getAllScheduledNotificationsAsync === 'function') {
      const scheduled = await Notifications.getAllScheduledNotificationsAsync();
      for (const item of scheduled) {
        const data = item?.content?.data as { kind?: unknown } | undefined;
        if (item?.identifier === DAILY_REMINDER_ID || data?.kind === DAILY_REMINDER_KIND) {
          if (item?.identifier) {
            idsToCancel.add(item.identifier);
          }
        }
      }
    }
  } catch {
    // Fall back to cancelling the deterministic identifier directly.
  }

  if (typeof Notifications.cancelScheduledNotificationAsync !== 'function') {
    return;
  }
  for (const id of idsToCancel) {
    try {
      await Notifications.cancelScheduledNotificationAsync(id);
    } catch {
      // Ignore if not currently scheduled or native module is unavailable.
    }
  }
}

/**
 * Idempotently schedules the repeating local daily reminder at `time` (HH:MM local).
 * Cancels any existing daily reminder first so repeated calls never leave duplicate schedules.
 * Returns the notification identifier, or `null` if notifications are unavailable or scheduling fails.
 */
export async function scheduleDailyReminder(time: string): Promise<string | null> {
  const Notifications = getNotificationsModule();
  if (!Notifications || typeof Notifications.scheduleNotificationAsync !== 'function') {
    return null;
  }

  await cancelDailyReminder();
  await ensureAndroidReminderChannel();

  const { hour, minute } = parseReminderTime(time);

  try {
    const dailyTriggerType =
      Notifications.SchedulableTriggerInputTypes?.DAILY ??
      ('daily' as NotificationsTypes.SchedulableTriggerInputTypes.DAILY);

    return await Notifications.scheduleNotificationAsync({
      identifier: DAILY_REMINDER_ID,
      content: {
        title: DAILY_REMINDER_TITLE,
        body: DAILY_REMINDER_BODY,
        sound: 'default',
        data: {
          url: DAILY_REMINDER_DEEP_LINK,
          kind: DAILY_REMINDER_KIND,
        },
      },
      trigger: {
        type: dailyTriggerType,
        channelId: DAILY_REMINDER_CHANNEL_ID,
        hour,
        minute,
      },
    });
  } catch {
    return null;
  }
}

/**
 * Synchronizes the local schedule with persisted settings without prompting for permissions.
 * Never throws so callers (such as backup restore) cannot fail after persisting data.
 */
export async function syncDailyReminder(enabled: boolean, time: string): Promise<SyncDailyReminderResult> {
  if (!enabled) {
    await cancelDailyReminder();
    return { ok: true };
  }

  const Notifications = getNotificationsModule();
  if (
    !Notifications ||
    typeof Notifications.getPermissionsAsync !== 'function' ||
    typeof Notifications.scheduleNotificationAsync !== 'function'
  ) {
    return { ok: false, reason: 'unavailable' };
  }

  try {
    const current = await Notifications.getPermissionsAsync();
    if (!isPermissionGranted(current)) {
      return { ok: false, reason: 'permission-denied' };
    }
    const scheduledId = await scheduleDailyReminder(time);
    return scheduledId ? { ok: true } : { ok: false, reason: 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Extracts a safe `silo://` deep link from a tapped notification response, if present.
 */
export function getNotificationDeepLink(
  response: NotificationsTypes.NotificationResponse | null | undefined
): string | null {
  const rawUrl = response?.notification?.request?.content?.data?.url;
  if (typeof rawUrl === 'string' && rawUrl.startsWith('silo://')) {
    return rawUrl;
  }
  return null;
}

/**
 * Reads and clears the last tapped notification response (cold launch), returning a safe
 * `silo://` deep link if present. Returns `null` when unavailable or if native calls throw.
 */
export async function getInitialNotificationDeepLink(): Promise<string | null> {
  const Notifications = getNotificationsModule();
  if (!Notifications) {
    return null;
  }
  try {
    const response =
      typeof Notifications.getLastNotificationResponse === 'function'
        ? Notifications.getLastNotificationResponse()
        : typeof Notifications.getLastNotificationResponseAsync === 'function'
          ? await Notifications.getLastNotificationResponseAsync()
          : null;
    const deepLink = getNotificationDeepLink(response);
    if (deepLink) {
      try {
        if (typeof Notifications.clearLastNotificationResponse === 'function') {
          Notifications.clearLastNotificationResponse();
        } else if (typeof Notifications.clearLastNotificationResponseAsync === 'function') {
          await Notifications.clearLastNotificationResponseAsync();
        }
      } catch {
        // Ignore cleanup failures if native clear method is unavailable.
      }
      return deepLink;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Subscribes to notification tap responses and forwards safe `silo://` deep links to `listener`.
 * Returns a safe no-op cleanup function when notifications are unavailable or throw.
 */
export function subscribeToNotificationDeepLinks(listener: (url: string) => void): () => void {
  const Notifications = getNotificationsModule();
  if (!Notifications || typeof Notifications.addNotificationResponseReceivedListener !== 'function') {
    return () => {};
  }
  try {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      try {
        const deepLink = getNotificationDeepLink(response);
        if (deepLink) {
          listener(deepLink);
        }
      } catch {
        // Ignore malformed notification payloads.
      }
    });
    return () => {
      try {
        subscription?.remove?.();
      } catch {
        // Ignore teardown errors when native module is unavailable.
      }
    };
  } catch {
    return () => {};
  }
}
