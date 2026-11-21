import * as Notifications from 'expo-notifications';
import {
  cancelDailyReminder,
  configureNotificationHandler,
  DAILY_REMINDER_BODY,
  DAILY_REMINDER_CHANNEL_ID,
  DAILY_REMINDER_DEEP_LINK,
  DAILY_REMINDER_ID,
  DAILY_REMINDER_KIND,
  formatReminderTime,
  getInitialNotificationDeepLink,
  getNotificationDeepLink,
  isNotificationsAvailable,
  parseReminderTime,
  reminderTimeToDate,
  requestDailyReminderPermission,
  requestDailyReminderPermissionStatus,
  scheduleDailyReminder,
  subscribeToNotificationDeepLinks,
  syncDailyReminder,
} from '../notifications';

describe('notifications service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted', granted: true });
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted', granted: true });
    (Notifications.getAllScheduledNotificationsAsync as jest.Mock).mockResolvedValue([]);
    (Notifications.scheduleNotificationAsync as jest.Mock).mockResolvedValue(DAILY_REMINDER_ID);
  });

  describe('time parsing and formatting', () => {
    it('parses valid 24h HH:MM strings and defaults invalid strings to 20:00', () => {
      expect(parseReminderTime('20:00')).toEqual({ hour: 20, minute: 0 });
      expect(parseReminderTime('08:30')).toEqual({ hour: 8, minute: 30 });
      expect(parseReminderTime('23:59')).toEqual({ hour: 23, minute: 59 });
      expect(parseReminderTime('00:00')).toEqual({ hour: 0, minute: 0 });
      expect(parseReminderTime('25:00')).toEqual({ hour: 20, minute: 0 });
      expect(parseReminderTime('invalid')).toEqual({ hour: 20, minute: 0 });
      expect(parseReminderTime(undefined)).toEqual({ hour: 20, minute: 0 });
    });

    it('formats hours and minutes with zero padding and converts to local Date', () => {
      expect(formatReminderTime(8, 5)).toBe('08:05');
      expect(formatReminderTime(20, 0)).toBe('20:00');
      expect(formatReminderTime(99, -5)).toBe('23:00');

      const d = reminderTimeToDate('09:45', new Date(2026, 10, 21));
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(10);
      expect(d.getDate()).toBe(21);
      expect(d.getHours()).toBe(9);
      expect(d.getMinutes()).toBe(45);
    });
  });

  describe('configureNotificationHandler', () => {
    it('registers foreground notification handler without asking for permissions', () => {
      configureNotificationHandler();
      expect(Notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
      expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    });
  });

  describe('requestDailyReminderPermission', () => {
    it('returns true immediately without re-prompting when already granted', async () => {
      (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'granted', granted: true });

      const granted = await requestDailyReminderPermission();

      expect(granted).toBe(true);
      expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
        DAILY_REMINDER_CHANNEL_ID,
        expect.objectContaining({ name: 'Daily reminder' })
      );
      expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    });

    it('requests permission when not yet granted and returns false if denied', async () => {
      (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'undetermined', granted: false });
      (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'denied', granted: false });

      const granted = await requestDailyReminderPermission();

      expect(granted).toBe(false);
      expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    });

    it('treats Android 13+ status="denied" with granted=true as denied (R2B-3)', async () => {
      (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'denied', granted: true });
      (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'denied', granted: true });

      const outcome = await requestDailyReminderPermissionStatus();

      expect(outcome).toBe('denied');
      expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    });
  });

  describe('scheduleDailyReminder & cancelDailyReminder (idempotent)', () => {
    it('cancels any previous daily reminder schedules before scheduling the new repeating notification', async () => {
      const callOrder: string[] = [];
      (Notifications.getAllScheduledNotificationsAsync as jest.Mock).mockResolvedValueOnce([
        { identifier: 'legacy-reminder-1', content: { data: { kind: DAILY_REMINDER_KIND } } },
        { identifier: 'unrelated-notif', content: { data: { kind: 'other' } } },
      ]);
      (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockImplementation(async (id: string) => {
        callOrder.push(`cancel:${id}`);
      });
      (Notifications.scheduleNotificationAsync as jest.Mock).mockImplementation(async () => {
        callOrder.push('schedule');
        return DAILY_REMINDER_ID;
      });

      const id = await scheduleDailyReminder('21:15');

      expect(id).toBe(DAILY_REMINDER_ID);
      expect(callOrder).toEqual([`cancel:${DAILY_REMINDER_ID}`, 'cancel:legacy-reminder-1', 'schedule']);
      expect(Notifications.cancelScheduledNotificationAsync).not.toHaveBeenCalledWith('unrelated-notif');
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
        identifier: DAILY_REMINDER_ID,
        content: {
          title: 'Daily reminder',
          body: DAILY_REMINDER_BODY,
          sound: 'default',
          data: {
            url: DAILY_REMINDER_DEEP_LINK,
            kind: DAILY_REMINDER_KIND,
          },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DAILY,
          channelId: DAILY_REMINDER_CHANNEL_ID,
          hour: 21,
          minute: 15,
        },
      });
    });

    it('cancels existing schedules cleanly when disabled', async () => {
      await cancelDailyReminder();
      expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(DAILY_REMINDER_ID);
    });
  });

  describe('syncDailyReminder', () => {
    it('cancels when disabled without asking for permission', async () => {
      await syncDailyReminder(false, '20:00');
      expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(DAILY_REMINDER_ID);
      expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
      expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    });

    it('does not prompt or schedule when enabled in settings but permission is denied', async () => {
      (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'denied', granted: false });

      const result = await syncDailyReminder(true, '20:00');

      expect(result).toEqual({ ok: false, reason: 'permission-denied' });
      expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
      expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    });

    it('does not schedule when Android 13+ reports status="denied" with granted=true (R2B-3)', async () => {
      (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'denied', granted: true });

      const result = await syncDailyReminder(true, '20:00');

      expect(result).toEqual({ ok: false, reason: 'permission-denied' });
      expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    });

    it('reschedules when enabled and permission is already granted', async () => {
      (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'granted', granted: true });

      const result = await syncDailyReminder(true, '19:30');

      expect(result).toEqual({ ok: true });
      expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: expect.objectContaining({ hour: 19, minute: 30 }),
        })
      );
    });

    it('returns non-throwing failure result when native permission or schedule call rejects (R2B-2)', async () => {
      (Notifications.getPermissionsAsync as jest.Mock).mockRejectedValueOnce(new Error('Native module error'));

      await expect(syncDailyReminder(true, '20:00')).resolves.toEqual({ ok: false, reason: 'failed' });

      (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'granted', granted: true });
      (Notifications.scheduleNotificationAsync as jest.Mock).mockRejectedValueOnce(new Error('Schedule rejected'));

      await expect(syncDailyReminder(true, '20:00')).resolves.toEqual({ ok: false, reason: 'failed' });
    });
  });

  describe('getNotificationDeepLink', () => {
    it('extracts valid silo:// deep links and ignores invalid or missing URLs', () => {
      const validResponse = {
        notification: {
          request: {
            content: {
              data: { url: 'silo://add', kind: DAILY_REMINDER_KIND },
            },
          },
        },
      } as any;
      expect(getNotificationDeepLink(validResponse)).toBe('silo://add');

      const externalResponse = {
        notification: {
          request: {
            content: {
              data: { url: 'https://example.com' },
            },
          },
        },
      } as any;
      expect(getNotificationDeepLink(externalResponse)).toBeNull();
      expect(getNotificationDeepLink(null)).toBeNull();
      expect(getNotificationDeepLink(undefined)).toBeNull();
    });
  });

  describe('missing or failing native expo-notifications module (R2B-1)', () => {
    it('lazy-loads expo-notifications without crashing when ExpoNotificationsEmitter is missing', async () => {
      const originalNotificationsMock = Notifications;
      const throwingFactory = jest.fn(() => {
        throw new Error("Cannot find native module 'ExpoNotificationsEmitter'");
      });

      try {
        jest.resetModules();
        jest.doMock('expo-notifications', throwingFactory);
        const isolated = require('../notifications') as typeof import('../notifications');

        // Must NOT touch expo-notifications at module import time.
        expect(throwingFactory).not.toHaveBeenCalled();

        // First runtime call lazily requires expo-notifications, catches the missing native module, and degrades safely.
        expect(isolated.isNotificationsAvailable()).toBe(false);
        expect(throwingFactory).toHaveBeenCalledTimes(1);

        expect(() => isolated.configureNotificationHandler()).not.toThrow();
        await expect(isolated.requestDailyReminderPermissionStatus()).resolves.toBe('unavailable');
        await expect(isolated.requestDailyReminderPermission()).resolves.toBe(false);
        await expect(isolated.scheduleDailyReminder('20:00')).resolves.toBeNull();
        await expect(isolated.cancelDailyReminder()).resolves.toBeUndefined();
        await expect(isolated.syncDailyReminder(true, '20:00')).resolves.toEqual({
          ok: false,
          reason: 'unavailable',
        });
        await expect(isolated.syncDailyReminder(false, '20:00')).resolves.toEqual({ ok: true });
        await expect(isolated.getInitialNotificationDeepLink()).resolves.toBeNull();

        const unsubscribe = isolated.subscribeToNotificationDeepLinks(jest.fn());
        expect(typeof unsubscribe).toBe('function');
        expect(() => unsubscribe()).not.toThrow();
      } finally {
        jest.resetModules();
        jest.doMock('expo-notifications', () => originalNotificationsMock);
      }
    });

    it('guards every native call when expo-notifications methods throw UnavailabilityError', async () => {
      expect(isNotificationsAvailable()).toBe(true);

      (Notifications.setNotificationHandler as jest.Mock).mockImplementationOnce(() => {
        throw new Error('UnavailabilityError');
      });
      expect(() => configureNotificationHandler()).not.toThrow();

      (Notifications.getLastNotificationResponse as jest.Mock).mockImplementationOnce(() => {
        throw new Error('UnavailabilityError');
      });
      await expect(getInitialNotificationDeepLink()).resolves.toBeNull();

      (Notifications.getLastNotificationResponse as jest.Mock).mockReturnValueOnce({
        notification: { request: { content: { data: { url: 'silo://add' } } } },
      });
      (Notifications.clearLastNotificationResponse as jest.Mock).mockImplementationOnce(() => {
        throw new Error('UnavailabilityError');
      });
      await expect(getInitialNotificationDeepLink()).resolves.toBe('silo://add');

      (Notifications.addNotificationResponseReceivedListener as jest.Mock).mockImplementationOnce(() => {
        throw new Error('UnavailabilityError');
      });
      const unsub = subscribeToNotificationDeepLinks(jest.fn());
      expect(() => unsub()).not.toThrow();

      (Notifications.getPermissionsAsync as jest.Mock).mockRejectedValueOnce(new Error('UnavailabilityError'));
      await expect(requestDailyReminderPermissionStatus()).resolves.toBe('unavailable');

      (Notifications.scheduleNotificationAsync as jest.Mock).mockRejectedValueOnce(new Error('UnavailabilityError'));
      await expect(scheduleDailyReminder('20:00')).resolves.toBeNull();
    });
  });
});
