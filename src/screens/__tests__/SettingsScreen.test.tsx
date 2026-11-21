import React from 'react';
import { Alert, Text } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as DocumentPicker from 'expo-document-picker';
import { SettingsScreen } from '../SettingsScreen';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useAIStore, createInitialProvisioningSnapshot, createInitialRuntimeSnapshot } from '../../store/useAIStore';
import { useTransactionStore } from '../../store/useTransactionStore';
import * as modelLifecycle from '../../services/ai/modelLifecycle';
import * as backupService from '../../services/backup';
import * as notificationService from '../../services/notifications';

const ReactTestRenderer = require('react-test-renderer');

jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');

jest.mock('../../db/index', () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => []),
    })),
    insert: jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoUpdate: jest.fn(() => Promise.resolve()),
      })),
    })),
    delete: jest.fn(() => ({
      where: jest.fn(() => Promise.resolve()),
    })),
  },
  expoDb: {
    execSync: jest.fn(),
    getAllSync: jest.fn(() => []),
    getFirstSync: jest.fn(() => null),
    runSync: jest.fn(() => ({ lastInsertRowId: 1, changes: 1 })),
    withTransactionSync: jest.fn((cb: () => void) => cb()),
  },
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: jest.fn(),
    goBack: jest.fn(),
  }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
  };
});

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///data/user/0/com.silo.app/files/',
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
  EncodingType: { UTF8: 'utf8' },
}));

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(true),
  shareAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../services/ai/modelLifecycle', () => ({
  getModelLifecycleManager: jest.fn(() => ({
    retryProvisioning: jest.fn(),
    cancelDownload: jest.fn(),
    deleteInstalledModel: jest.fn(),
  })),
  isActiveModelInstalled: jest.fn().mockResolvedValue(true),
  isVisionProjectorInstalled: jest.fn().mockResolvedValue(false),
  downloadVisionProjector: jest.fn().mockResolvedValue(undefined),
  cancelVisionProjectorDownload: jest.fn().mockResolvedValue(undefined),
  deleteVisionProjector: jest.fn().mockResolvedValue(undefined),
}));

describe('SettingsScreen - Receipt reading mode & Vision projector', () => {
  let renderer: any;

  beforeEach(() => {
    jest.clearAllMocks();
    (modelLifecycle.isActiveModelInstalled as jest.Mock).mockResolvedValue(true);
    (modelLifecycle.isVisionProjectorInstalled as jest.Mock).mockResolvedValue(false);

    ReactTestRenderer.act(() => {
      useSettingsStore.setState({
        receiptReadingMode: 'ocr',
        aiInferenceMode: 'local',
        fontScale: 1.0,
        dailyReminderEnabled: false,
        dailyReminderTime: '20:00',
        monthStartDay: 1,
        weekStartDay: 'monday',
      });

      const readyProvisioning = createInitialProvisioningSnapshot();
      readyProvisioning.status = 'ready';
      useAIStore.setState({
        provisioning: readyProvisioning,
        runtime: createInitialRuntimeSnapshot(),
      });

      useTransactionStore.setState({
        transactionsList: [],
        categories: [],
      });
    });
  });

  afterEach(() => {
    if (renderer) {
      ReactTestRenderer.act(() => {
        renderer.unmount();
      });
      renderer = null;
    }
  });

  it('renders receipt reading mode options with explanation', async () => {
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const fastChip = renderer.root.findByProps({ accessibilityLabel: 'Fast (text OCR)' });
    const visionChip = renderer.root.findByProps({ accessibilityLabel: 'Accurate (AI vision)' });
    expect(fastChip).toBeTruthy();
    expect(visionChip).toBeTruthy();

    const texts = renderer.root.findAllByType(Text).map((t: any) => t.props.children);
    const joined = texts.flat().join(' ');
    expect(joined).toContain('Receipt reading');
    expect(joined).toContain('AI vision reads the photo directly: more accurate');
  });

  it('shows download vision add-on button when vision is selected and projector is not installed', async () => {
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ receiptReadingMode: 'vision' });
    });

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const downloadBtn = renderer.root.findByProps({ accessibilityLabel: 'Download vision add-on (670 MB)' });
    expect(downloadBtn).toBeTruthy();
    expect(downloadBtn.props.accessibilityRole).toBe('button');
  });

  it('handles download, progress, cancel, and success flow for vision projector', async () => {
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ receiptReadingMode: 'vision' });
    });

    let progressCb: ((fraction: number) => void) | undefined;
    (modelLifecycle.downloadVisionProjector as jest.Mock).mockImplementation((cb) => {
      progressCb = cb;
      return new Promise(() => {}); // stays in progress
    });

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const downloadBtn = renderer.root.findByProps({ accessibilityLabel: 'Download vision add-on (670 MB)' });

    await ReactTestRenderer.act(async () => {
      downloadBtn.props.onPress();
    });

    expect(modelLifecycle.downloadVisionProjector).toHaveBeenCalled();

    // Trigger progress
    if (progressCb) {
      await ReactTestRenderer.act(async () => {
        progressCb!(0.45);
      });
    }

    const cancelBtn = renderer.root.findByProps({ accessibilityLabel: 'Cancel vision download' });
    expect(cancelBtn).toBeTruthy();

    const texts = renderer.root.findAllByType(Text).map((t: any) => t.props.children).flat().join(' ');
    expect(texts).toContain('45% completed');

    // Test cancel
    await ReactTestRenderer.act(async () => {
      cancelBtn.props.onPress();
    });
    expect(modelLifecycle.cancelVisionProjectorDownload).toHaveBeenCalled();
  });

  it('shows installed badge and remove button when projector is installed, and confirms deletion', async () => {
    (modelLifecycle.isVisionProjectorInstalled as jest.Mock).mockResolvedValue(true);
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ receiptReadingMode: 'vision' });
    });

    const alertSpy = jest.spyOn(Alert, 'alert');

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const removeBtn = renderer.root.findByProps({ accessibilityLabel: 'Remove vision add-on' });
    expect(removeBtn).toBeTruthy();

    const texts = renderer.root.findAllByType(Text).map((t: any) => t.props.children).flat().join(' ');
    expect(texts).toContain('Vision add-on installed');

    // Click remove button -> triggers Alert
    await ReactTestRenderer.act(async () => {
      removeBtn.props.onPress();
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'Remove Vision Add-on',
      expect.stringContaining('670 MB'),
      expect.any(Array)
    );

    // Trigger the destructive action in Alert
    const alertButtons = alertSpy.mock.calls[0][2] as any[];
    const destructiveBtn = alertButtons.find((b) => b.style === 'destructive');
    expect(destructiveBtn).toBeTruthy();

    await ReactTestRenderer.act(async () => {
      await destructiveBtn.onPress();
    });

    expect(modelLifecycle.deleteVisionProjector).toHaveBeenCalled();
  });

  it('shows retry button and error text when projector download fails', async () => {
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ receiptReadingMode: 'vision' });
    });
    (modelLifecycle.downloadVisionProjector as jest.Mock).mockRejectedValueOnce(new Error('Network connection timed out'));

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const downloadBtn = renderer.root.findByProps({ accessibilityLabel: 'Download vision add-on (670 MB)' });
    await ReactTestRenderer.act(async () => {
      await downloadBtn.props.onPress();
    });

    const retryBtn = renderer.root.findByProps({ accessibilityLabel: 'Retry vision download' });
    expect(retryBtn).toBeTruthy();

    const texts = renderer.root.findAllByType(Text).map((t: any) => t.props.children).flat().join(' ');
    expect(texts).toContain('Network connection timed out');
  });

  it('notifies user that AI model must be downloaded first if local model is not installed', async () => {
    (modelLifecycle.isActiveModelInstalled as jest.Mock).mockResolvedValue(false);

    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ receiptReadingMode: 'vision', aiInferenceMode: 'local' });
      const notInstalledProvisioning = createInitialProvisioningSnapshot();
      notInstalledProvisioning.status = 'not-installed';
      useAIStore.setState({ provisioning: notInstalledProvisioning });
    });

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const texts = renderer.root.findAllByType(Text).map((t: any) => t.props.children).flat().join(' ');
    expect(texts).toContain('AI model must be downloaded first');
  });

  it('shows that external mode needs no download', async () => {
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ receiptReadingMode: 'vision', aiInferenceMode: 'external' });
    });

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const texts = renderer.root.findAllByType(Text).map((t: any) => t.props.children).flat().join(' ');
    expect(texts).toContain('External mode needs no download.');
  });

  it('exports CSV with Transfer type and Account / To Account columns', async () => {
    const { writeAsStringAsync } = require('expo-file-system/legacy');
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ dateFormat: 'en-GB' });
      useTransactionStore.setState({
        wallets: [
          { id: 1, name: 'BCA', type: 'bank', isActive: true, initialBalance: 0, balance: 0 },
          { id: 2, name: 'GoPay', type: 'ewallet', isActive: true, initialBalance: 0, balance: 0 },
        ],
        transactionsList: [
          {
            id: 1,
            merchantName: 'Top up',
            totalAmount: -250000,
            type: 'transfer',
            category: 'Transfer',
            date: new Date(2026, 10, 15).getTime(),
            note: '',
            lineItemsText: '',
            walletId: 1,
            toWalletId: 2,
          },
        ],
      } as any);
    });

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const exportBtn = renderer.root.findByProps({ accessibilityLabel: 'Export Transactions CSV' });
    await ReactTestRenderer.act(async () => {
      await exportBtn.props.onPress();
    });

    expect(writeAsStringAsync).toHaveBeenCalledTimes(1);
    const writtenCsv: string = (writeAsStringAsync as jest.Mock).mock.calls[0][1];
    expect(writtenCsv).toContain('Date,Merchant Name,Category,Amount,Type,Account,To Account,Description,Receipt Items');
    expect(writtenCsv).toContain(',Transfer,"BCA","GoPay",');
  });

  it('turns daily reminder on when permission is granted, reschedules on time change, and cancels when turned off', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'undetermined', granted: false });
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'granted', granted: true });

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    // Does NOT ask for notification permission merely on mount
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();

    const reminderSwitch = renderer.root.findByProps({ accessibilityLabel: 'Daily reminder' });
    await ReactTestRenderer.act(async () => {
      reminderSwitch.props.onValueChange(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('silo-daily-reminder');
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          body: 'Did you spend anything today? Tap to add it.',
          data: expect.objectContaining({ url: 'silo://add' }),
        }),
        trigger: expect.objectContaining({ hour: 20, minute: 0 }),
      })
    );
    expect(useSettingsStore.getState().dailyReminderEnabled).toBe(true);

    // Change reminder time to 08:45 -> idempotently cancels previous and reschedules
    (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockClear();
    (Notifications.scheduleNotificationAsync as jest.Mock).mockClear();

    const timeRow = renderer.root.findByProps({ accessibilityLabel: 'Reminder time' });
    ReactTestRenderer.act(() => {
      timeRow.props.onPress();
    });
    const picker = renderer.root.findByType('DateTimePicker');
    await ReactTestRenderer.act(async () => {
      picker.props.onChange({ type: 'set' }, new Date(2026, 10, 21, 8, 45));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useSettingsStore.getState().dailyReminderTime).toBe('08:45');
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('silo-daily-reminder');
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: expect.objectContaining({ hour: 8, minute: 45 }),
      })
    );

    // Turn off -> cancels schedule
    (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockClear();
    const switchAfter = renderer.root.findByProps({ accessibilityLabel: 'Daily reminder' });
    await ReactTestRenderer.act(async () => {
      switchAfter.props.onValueChange(false);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useSettingsStore.getState().dailyReminderEnabled).toBe(false);
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('silo-daily-reminder');
  });

  it('turns daily reminder back off and explains how to enable notifications when permission is denied', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'undetermined', granted: false });
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'denied', granted: false });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const reminderSwitch = renderer.root.findByProps({ accessibilityLabel: 'Daily reminder' });
    await ReactTestRenderer.act(async () => {
      reminderSwitch.props.onValueChange(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useSettingsStore.getState().dailyReminderEnabled).toBe(false);
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      'Notifications are turned off',
      expect.stringContaining('Settings'),
      expect.any(Array)
    );
    alertSpy.mockRestore();
  });

  it('lets the user configure Month starts on day (1-28) and Week starts on (Monday / Sunday)', async () => {
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const monthStartRow = renderer.root.findByProps({ accessibilityLabel: 'Month starts on day' });
    ReactTestRenderer.act(() => {
      monthStartRow.props.onPress();
    });

    const day25Btn = renderer.root.findByProps({ accessibilityLabel: 'Month start day 25' });
    await ReactTestRenderer.act(async () => {
      day25Btn.props.onPress();
      await Promise.resolve();
    });
    expect(useSettingsStore.getState().monthStartDay).toBe(25);

    const sundayBtn = renderer.root.findByProps({ accessibilityLabel: 'Week starts on Sunday' });
    await ReactTestRenderer.act(async () => {
      sundayBtn.props.onPress();
      await Promise.resolve();
    });
    expect(useSettingsStore.getState().weekStartDay).toBe('sunday');
  });

  it('completes restore and refreshes stores with a non-blocking message even if reminder rescheduling fails (R2B-2)', async () => {
    const fetchTransactions = jest.fn().mockResolvedValue(undefined);
    const fetchCategories = jest.fn().mockResolvedValue(undefined);
    const fetchBudgets = jest.fn().mockResolvedValue(undefined);
    const restoreSpy = jest.spyOn(backupService, 'restoreBackupFile').mockResolvedValueOnce({ transactions: 4 } as any);
    const loadSettingsSpy = jest.spyOn(useSettingsStore.getState(), 'loadSettings').mockImplementationOnce(async () => {
      useSettingsStore.setState({ dailyReminderEnabled: true, dailyReminderTime: '20:00' });
    });
    const syncSpy = jest.spyOn(notificationService, 'syncDailyReminder').mockRejectedValueOnce(
      new Error('ExpoNotificationsEmitter unavailable')
    );
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///backup.silo' }],
    });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    ReactTestRenderer.act(() => {
      useTransactionStore.setState({
        fetchTransactions,
        fetchCategories,
        fetchBudgets,
      } as any);
    });

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const restoreBtn = renderer.root.findByProps({ accessibilityLabel: 'Restore From Backup' });
    await ReactTestRenderer.act(async () => {
      await restoreBtn.props.onPress();
    });

    const confirmCall = alertSpy.mock.calls.find((call) => call[0] === 'Replace all data?');
    expect(confirmCall).toBeDefined();
    const restoreAction = (confirmCall![2] as any[]).find((btn) => btn.text === 'Restore');
    expect(restoreAction).toBeDefined();

    await ReactTestRenderer.act(async () => {
      await restoreAction.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(restoreSpy).toHaveBeenCalledWith('file:///backup.silo');
    expect(fetchTransactions).toHaveBeenCalledTimes(1);
    expect(fetchCategories).toHaveBeenCalledTimes(1);
    expect(fetchBudgets).toHaveBeenCalledTimes(1);

    expect(alertSpy).toHaveBeenCalledWith(
      'Backup restored',
      expect.stringContaining('4 transactions restored.')
    );
    expect(alertSpy).toHaveBeenCalledWith(
      'Backup restored',
      expect.stringContaining('Daily reminder could not be rescheduled')
    );
    expect(alertSpy.mock.calls.some((call) => call[0] === 'Restore failed')).toBe(false);

    const texts = renderer.root.findAllByType(Text).map((t: any) => t.props.children).flat().join(' ');
    expect(texts).toContain('Daily reminder could not be rescheduled on this device.');

    restoreSpy.mockRestore();
    loadSettingsSpy.mockRestore();
    syncSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it('saves reminder time and surfaces a non-blocking message if rescheduling fails after write (R2B-2)', async () => {
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ dailyReminderEnabled: true, dailyReminderTime: '20:00' });
    });
    (Notifications.scheduleNotificationAsync as jest.Mock).mockRejectedValueOnce(new Error('UnavailabilityError'));
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const timeRow = renderer.root.findByProps({ accessibilityLabel: 'Reminder time' });
    ReactTestRenderer.act(() => {
      timeRow.props.onPress();
    });

    const picker = renderer.root.findByType('DateTimePicker');
    await ReactTestRenderer.act(async () => {
      picker.props.onChange({ type: 'set' }, new Date(2026, 10, 21, 9, 30));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useSettingsStore.getState().dailyReminderTime).toBe('09:30');
    expect(alertSpy).not.toHaveBeenCalled();

    const texts = renderer.root.findAllByType(Text).map((t: any) => t.props.children).flat().join(' ');
    expect(texts).toContain('Reminder time saved, but the notification could not be rescheduled on this device.');

    alertSpy.mockRestore();
  });

  it('handles Android 13+ status="denied" with granted=true by keeping switch off and alerting (R2B-3)', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'denied', granted: true });
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'denied', granted: true });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const reminderSwitch = renderer.root.findByProps({ accessibilityLabel: 'Daily reminder' });
    await ReactTestRenderer.act(async () => {
      reminderSwitch.props.onValueChange(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useSettingsStore.getState().dailyReminderEnabled).toBe(false);
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      'Notifications are turned off',
      expect.stringContaining('Settings'),
      expect.any(Array)
    );
    alertSpy.mockRestore();
  });

  it('keeps Settings working with a non-blocking message when native notification APIs fail (R2B-1)', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockRejectedValueOnce(new Error('UnavailabilityError'));
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const reminderSwitch = renderer.root.findByProps({ accessibilityLabel: 'Daily reminder' });
    await ReactTestRenderer.act(async () => {
      reminderSwitch.props.onValueChange(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useSettingsStore.getState().dailyReminderEnabled).toBe(false);
    expect(alertSpy).not.toHaveBeenCalled();
    const texts = renderer.root.findAllByType(Text).map((t: any) => t.props.children).flat().join(' ');
    expect(texts).toContain('Daily reminders are not available on this device.');

    alertSpy.mockRestore();
  });

  it('imports SettingsScreen without loading expo-notifications at startup when native module is missing (R2B-1)', () => {
    const originalNotificationsMock = Notifications;
    const throwingFactory = jest.fn(() => {
      throw new Error("Cannot find native module 'ExpoNotificationsEmitter'");
    });

    try {
      jest.resetModules();
      jest.doMock('expo-notifications', throwingFactory);
      const isolatedSettings = require('../SettingsScreen');
      expect(isolatedSettings.SettingsScreen).toBeDefined();
      expect(throwingFactory).not.toHaveBeenCalled();
    } finally {
      jest.resetModules();
      jest.doMock('expo-notifications', () => originalNotificationsMock);
    }
  });
});
