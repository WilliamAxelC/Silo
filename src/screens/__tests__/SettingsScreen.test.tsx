import React from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text } from 'react-native';
import { File } from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
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
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///data/user/0/com.silo.app/files/',
  cacheDirectory: 'file:///data/user/0/com.silo.app/cache/',
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
  readAsStringAsync: jest.fn().mockResolvedValue('U1FMaXRlIGZvcm1hdCAzAA=='),
  EncodingType: { UTF8: 'utf8', Base64: 'base64' },
  StorageAccessFramework: {
    getUriForDirectoryInRoot: jest.fn((folder: string) => `content://com.android.externalstorage.documents/tree/primary%3A${folder}`),
    requestDirectoryPermissionsAsync: jest.fn().mockResolvedValue({
      granted: true,
      directoryUri: 'content://com.android.externalstorage.documents/tree/primary%3ADownload',
    }),
    createFileAsync: jest.fn().mockResolvedValue(
      'content://com.android.externalstorage.documents/document/primary%3ADownload%2Fsilo-file'
    ),
  },
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
      await picker.props.onChange({ type: 'set' }, new Date(2026, 10, 21, 8, 45));
      for (let i = 0; i < 6; i++) await Promise.resolve();
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
      await picker.props.onChange({ type: 'set' }, new Date(2026, 10, 21, 9, 30));
      for (let i = 0; i < 6; i++) await Promise.resolve();
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

  it('saves CSV and Backup directly via Android SAF even when Sharing is unavailable, with Share as secondary action (F-04)', async () => {
    const { StorageAccessFramework, writeAsStringAsync } = require('expo-file-system/legacy');
    (Sharing.isAvailableAsync as jest.Mock).mockResolvedValue(false);
    const createBackupSpy = jest
      .spyOn(backupService, 'createBackupFile')
      .mockResolvedValue('file:///data/user/0/com.silo.app/cache/silo-backup-2026-11-21.db');
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    ReactTestRenderer.act(() => {
      useTransactionStore.setState({
        wallets: [{ id: 1, name: 'Cash', type: 'cash', isActive: true, initialBalance: 0, balance: 0 }],
        transactionsList: [
          {
            id: 1,
            merchantName: 'Bakery',
            totalAmount: -20000,
            type: 'expense',
            category: 'Food & Dining',
            date: new Date(2026, 10, 15).getTime(),
            note: '',
            lineItemsText: '',
            walletId: 1,
          },
        ],
      } as any);
    });

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    // Primary CSV export uses SAF and does not call shareAsync
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Export Transactions CSV' }).props.onPress();
    });
    expect(StorageAccessFramework.requestDirectoryPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(StorageAccessFramework.createFileAsync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringMatching(/^Silo_Transactions_\d{4}-\d{2}-\d{2}$/),
      'text/csv'
    );
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      'CSV exported',
      expect.stringContaining('Saved'),
      expect.arrayContaining([expect.objectContaining({ text: 'Share' })])
    );

    // Primary Backup saves binary via SAF using SDK 54 File raw bytes and cleans up temp .db file
    const { deleteAsync, readAsStringAsync } = require('expo-file-system/legacy');
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Back Up All Data' }).props.onPress();
    });
    expect(createBackupSpy).toHaveBeenCalledTimes(1);
    expect(StorageAccessFramework.createFileAsync).toHaveBeenCalledWith(
      expect.any(String),
      'silo-backup-2026-11-21.db',
      'application/octet-stream'
    );
    expect(File.prototype.bytes).toHaveBeenCalledTimes(1);
    expect(File.prototype.write).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(readAsStringAsync).not.toHaveBeenCalled();
    expect(deleteAsync).toHaveBeenCalledWith(
      'file:///data/user/0/com.silo.app/cache/silo-backup-2026-11-21.db',
      { idempotent: true }
    );
    expect(alertSpy).toHaveBeenCalledWith(
      'Backup saved',
      expect.stringContaining('silo-backup-2026-11-21.db'),
      expect.arrayContaining([expect.objectContaining({ text: 'Share' })])
    );

    // Secondary Share buttons are present and gracefully explain when sharing is unavailable
    const shareCsvBtn = renderer.root.findByProps({ accessibilityLabel: 'Share Transactions CSV' });
    const shareBackupBtn = renderer.root.findByProps({ accessibilityLabel: 'Share backup file' });
    expect(shareCsvBtn).toBeTruthy();
    expect(shareBackupBtn).toBeTruthy();

    await ReactTestRenderer.act(async () => {
      await shareBackupBtn.props.onPress();
    });
    expect(alertSpy).toHaveBeenCalledWith('Sharing unavailable', expect.stringContaining('Back Up All Data'));

    createBackupSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it('filters restore picker to backup MIME types, rejects image files, and confirms before overwriting (F-26)', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const restoreSpy = jest.spyOn(backupService, 'restoreBackupFile').mockResolvedValue({ transactions: 1 } as any);

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    // Picking a photo is rejected before showing overwrite confirmation
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///DCIM/photo.jpg', name: 'photo.jpg', mimeType: 'image/jpeg' }],
    });

    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Restore From Backup' }).props.onPress();
    });

    expect(DocumentPicker.getDocumentAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        type: backupService.BACKUP_PICKER_MIME_TYPES,
      })
    );
    expect(alertSpy).toHaveBeenCalledWith('Not a backup file', expect.stringContaining('.db'));
    expect(alertSpy.mock.calls.some((call) => call[0] === 'Replace all data?')).toBe(false);
    expect(restoreSpy).not.toHaveBeenCalled();

    restoreSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it('warns before changing display currency that existing amounts will not be converted (F-11)', async () => {
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ currencyCode: 'IDR' });
    });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const usdChip = renderer.root.findByProps({ accessibilityLabel: 'Select USD currency' });
    await ReactTestRenderer.act(async () => {
      usdChip.props.onPress();
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'Change display currency?',
      expect.stringContaining('will not be converted'),
      expect.any(Array)
    );
    // Currency has NOT changed yet until confirmed
    expect(useSettingsStore.getState().currencyCode).toBe('IDR');

    const buttons = alertSpy.mock.calls[0][2] as any[];
    const confirmBtn = buttons.find((b) => b.text === 'Use USD');
    expect(confirmBtn).toBeDefined();

    await ReactTestRenderer.act(async () => {
      confirmBtn.onPress();
      await Promise.resolve();
    });
    expect(useSettingsStore.getState().currencyCode).toBe('USD');

    alertSpy.mockRestore();
  });

  it('stacks model status pill below model name and renders indeterminate verifying progress (F-13)', async () => {
    ReactTestRenderer.act(() => {
      const verifyingProvisioning = createInitialProvisioningSnapshot();
      verifyingProvisioning.status = 'verifying';
      verifyingProvisioning.progress = 1;
      useAIStore.setState({
        provisioning: verifyingProvisioning,
        runtime: createInitialRuntimeSnapshot(),
      });
    });

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const header = renderer.root.findByProps({ testID: 'model-card-header' });
    const headerStyle = StyleSheet.flatten(header.props.style);
    // Vertical stack prevents status pill from overlapping long model names
    expect(headerStyle.flexDirection).not.toBe('row');

    const pill = renderer.root.findByProps({ testID: 'model-status-pill' });
    expect(pill).toBeTruthy();

    const verifyingRow = renderer.root.findByProps({ testID: 'model-verifying-progress' });
    expect(verifyingRow.props.accessibilityRole).toBe('progressbar');
    expect(verifyingRow.findByType(ActivityIndicator)).toBeTruthy();
    const verifyingTexts = verifyingRow
      .findAllByType(Text)
      .map((t: any) => String(t.props.children ?? ''))
      .join(' ');
    expect(verifyingTexts).toContain('Verifying model integrity');
  });

  it('checks OS notification permission via syncDailyReminder when reminder time changes and warns if revoked (R2B2-1)', async () => {
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ dailyReminderEnabled: true, dailyReminderTime: '20:00' });
    });
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'denied', granted: false });

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const timeRow = renderer.root.findByProps({ accessibilityLabel: 'Reminder time' });
    ReactTestRenderer.act(() => {
      timeRow.props.onPress();
    });

    const picker = renderer.root.findByType('DateTimePicker');
    await ReactTestRenderer.act(async () => {
      await picker.props.onChange({ type: 'set' }, new Date(2026, 10, 21, 7, 15));
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });

    expect(useSettingsStore.getState().dailyReminderTime).toBe('07:15');
    expect(Notifications.getPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();

    const texts = renderer.root.findAllByType(Text).map((t: any) => t.props.children).flat().join(' ');
    expect(texts).toContain('notifications are turned off in phone Settings');
  });

  it('cleans up temporary backup files on SAF cancellation and write failure (R3A-03)', async () => {
    const { StorageAccessFramework, deleteAsync } = require('expo-file-system/legacy');
    const tempPath = 'file:///data/user/0/com.silo.app/cache/backups/silo-backup-2026-11-21.db';
    const createBackupSpy = jest.spyOn(backupService, 'createBackupFile').mockResolvedValue(tempPath);
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    // 1. User cancels SAF folder picker -> temp .db file is deleted
    (StorageAccessFramework.requestDirectoryPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false });
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Back Up All Data' }).props.onPress();
    });
    expect(deleteAsync).toHaveBeenCalledWith(tempPath, { idempotent: true });

    // 2. Binary write throws -> both SAF orphan and temp .db file are cleaned up
    (deleteAsync as jest.Mock).mockClear();
    (File.prototype.write as jest.Mock).mockImplementationOnce(() => {
      throw new Error('Disk full');
    });
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Back Up All Data' }).props.onPress();
    });
    expect(File.prototype.delete).toHaveBeenCalledTimes(1);
    expect(deleteAsync).toHaveBeenCalledWith(tempPath, { idempotent: true });
    expect(alertSpy).toHaveBeenCalledWith('Backup failed', expect.stringContaining('Disk full'));

    createBackupSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it('catches DocumentPicker errors, fetches categories before budgets, and keeps onboarding completed after restoring an empty backup (R3A-06)', async () => {
    const callOrder: string[] = [];
    let resolveCategories!: () => void;
    const fetchTransactions = jest.fn(async () => {
      callOrder.push('fetchTransactions');
    });
    const fetchCategories = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          callOrder.push('fetchCategories:start');
          resolveCategories = () => {
            callOrder.push('fetchCategories:end');
            resolve();
          };
        })
    );
    const fetchBudgets = jest.fn(async () => {
      callOrder.push('fetchBudgets');
    });

    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ hasCompletedOnboarding: true });
      useTransactionStore.setState({
        fetchTransactions,
        fetchCategories,
        fetchBudgets,
      } as any);
    });

    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const restoreSpy = jest.spyOn(backupService, 'restoreBackupFile').mockResolvedValueOnce({ transactions: 0 } as any);
    const loadSettingsSpy = jest.spyOn(useSettingsStore.getState(), 'loadSettings').mockImplementationOnce(async () => {
      // Simulate restoring an older empty backup where hasCompletedOnboarding became false
      useSettingsStore.setState({ hasCompletedOnboarding: false, dailyReminderEnabled: false });
    });

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    // 1. DocumentPicker throws -> handled cleanly with alert (no unhandled rejection)
    (DocumentPicker.getDocumentAsync as jest.Mock).mockRejectedValueOnce(new Error('No document picker available'));
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Restore From Backup' }).props.onPress();
    });
    expect(alertSpy).toHaveBeenCalledWith('Could not open file picker', expect.stringContaining('No document picker'));

    // 2. Restore orders fetchCategories -> fetchBudgets and keeps hasCompletedOnboarding = true
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///empty-v12.db', name: 'empty-v12.db' }],
    });
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Restore From Backup' }).props.onPress();
    });
    const confirmCall = alertSpy.mock.calls.find((c) => c[0] === 'Replace all data?');
    const restoreAction = (confirmCall![2] as any[]).find((b) => b.text === 'Restore');

    let restorePromise!: Promise<void>;
    await ReactTestRenderer.act(async () => {
      restorePromise = Promise.resolve(restoreAction.onPress());
      await Promise.resolve();
      await Promise.resolve();
    });
    // fetchBudgets MUST NOT run until fetchCategories has resolved
    expect(fetchBudgets).not.toHaveBeenCalled();

    await ReactTestRenderer.act(async () => {
      resolveCategories();
      await restorePromise;
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });

    expect(callOrder.indexOf('fetchCategories:end')).toBeLessThan(callOrder.indexOf('fetchBudgets'));
    expect(useSettingsStore.getState().hasCompletedOnboarding).toBe(true);

    restoreSpy.mockRestore();
    loadSettingsSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it('scales External API, Vision, Categories, and About text with fontScale (R3A-08)', async () => {
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({
        aiInferenceMode: 'external',
        receiptReadingMode: 'vision',
        fontScale: 1.0,
      });
      useTransactionStore.setState({
        categories: [{ id: 1, name: 'Groceries', type: 'expense', isSystem: true, createdAt: 1000 }],
      } as any);
    });

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const getSize = (label: string) => {
      const node = renderer.root.findAllByType(Text).find((t: any) => {
        const text = Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '');
        return text === label;
      });
      return StyleSheet.flatten(node.props.style).fontSize;
    };

    const sizes100 = {
      externalApi: getSize('External API'),
      endpointLabel: getSize('Endpoint Base URL'),
      visionNote: getSize('External mode needs no download.'),
      categoryName: getSize('Groceries'),
      aboutName: getSize('Silo'),
    };

    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ fontScale: 1.2 });
    });

    expect(getSize('External API')).toBeGreaterThan(sizes100.externalApi);
    expect(getSize('Endpoint Base URL')).toBeGreaterThan(sizes100.endpointLabel);
    expect(getSize('External mode needs no download.')).toBeGreaterThan(sizes100.visionNote);
    expect(getSize('Groceries')).toBeGreaterThan(sizes100.categoryName);
    expect(getSize('Silo')).toBeGreaterThan(sizes100.aboutName);
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
