import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Switch,
  Alert,
  ActivityIndicator,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import DateTimePicker from '@react-native-community/datetimepicker';

import * as DocumentPicker from 'expo-document-picker';
import {
  BACKUP_PICKER_MIME_TYPES,
  createBackupFile,
  isLikelyBackupFile,
  restoreBackupFile,
} from '../services/backup';
import { buildTransactionsCsv } from '../services/csvExport';
import {
  deleteLocalFileQuietly,
  isAndroidSafSupported,
  saveBinaryFileToDevice,
  saveTextFileToDevice,
  shareLocalFile,
  writeLocalTextFile,
} from '../services/fileExport';
import { getModalOverlayInsetStyle, useSafeInsets } from '../hooks/useSafeInsets';
import {
  cancelDailyReminder,
  formatReminderTime,
  isNotificationsAvailable,
  reminderTimeToDate,
  requestDailyReminderPermissionStatus,
  scheduleDailyReminder,
  syncDailyReminder,
} from '../services/notifications';
import { authenticateUser, canUseAppLock } from '../components/AppLockGate';

import { NavigationProps } from '../navigation/types';
import { useSettingsStore } from '../store/useSettingsStore';
import { getAIRuntimeAvailability, getProvisioningStatusLabel, useAIStore } from '../store/useAIStore';
import { useTransactionStore } from '../store/useTransactionStore';
import { useAppTheme } from '../theme/useAppTheme';
import type { CategoryRecord, CategoryType, ThemeMode, ExternalAPIProvider, WeekStartDay } from '../features/transactions/types';
import { DEFAULT_APP_SETTINGS, EXTERNAL_API_PRESETS, MODEL_CATALOG } from '../features/transactions/constants';
import { MAX_MONTH_START_DAY, MIN_MONTH_START_DAY } from '../features/transactions/periods';
import {
  cancelVisionProjectorDownload,
  deleteVisionProjector,
  downloadVisionProjector,
  getModelLifecycleManager,
  isActiveModelInstalled,
  isVisionProjectorInstalled,
} from '../services/ai/modelLifecycle';
import { getErrorMessage } from '../services/ai/localInferenceTypes';
import appConfig from '../../app.json';

const THEME_OPTIONS: { key: ThemeMode; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'system', label: 'System', icon: 'phone-portrait-outline' },
  { key: 'light', label: 'Light', icon: 'sunny-outline' },
  { key: 'dark', label: 'Dark', icon: 'moon-outline' },
];

const CURRENCY_OPTIONS = ['IDR', 'USD', 'EUR', 'GBP', 'SGD', 'JPY'];
const DATE_FORMAT_OPTIONS = [
  { key: 'en-GB', label: 'DD/MM/YYYY (en-GB)' },
  { key: 'en-US', label: 'MM/DD/YYYY (en-US)' },
];
const FONT_SCALE_OPTIONS = [0.9, 1.0, 1.1, 1.2];
const WEEK_START_OPTIONS: Array<{ key: WeekStartDay; label: string }> = [
  { key: 'monday', label: 'Monday' },
  { key: 'sunday', label: 'Sunday' },
];
const MONTH_START_DAYS = Array.from(
  { length: MAX_MONTH_START_DAY - MIN_MONTH_START_DAY + 1 },
  (_, index) => MIN_MONTH_START_DAY + index
);

export const SettingsScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const theme = useAppTheme();
  const insets = useSafeInsets();

  const themeMode = useSettingsStore((s) => s.themeMode);
  const currencyCode = useSettingsStore((s) => s.currencyCode);
  const useThousandsSeparator = useSettingsStore((s) => s.useThousandsSeparator);
  const dateFormat = useSettingsStore((s) => s.dateFormat);
  const showIncomeInReportsFirst = useSettingsStore((s) => s.showIncomeInReportsFirst);
  const fontScale = useSettingsStore((s) => s.fontScale);
  const aiInferenceMode = useSettingsStore((s) => s.aiInferenceMode);
  const externalApiProvider = useSettingsStore((s) => s.externalApiProvider);
  const externalApiUrl = useSettingsStore((s) => s.externalApiUrl);
  const externalApiModel = useSettingsStore((s) => s.externalApiModel);
  const externalApiKey = useSettingsStore((s) => s.externalApiKey);
  const aiWifiOnlyDownload = useSettingsStore((s) => s.aiWifiOnlyDownload);
  const receiptReadingMode = useSettingsStore((s) => s.receiptReadingMode);
  const dailyReminderEnabled = useSettingsStore((s) => s.dailyReminderEnabled);
  const dailyReminderTime = useSettingsStore((s) => s.dailyReminderTime);
  const monthStartDay = useSettingsStore((s) => s.monthStartDay);
  const weekStartDay = useSettingsStore((s) => s.weekStartDay);

  const setThemeMode = useSettingsStore((s) => s.setThemeMode);
  const setCurrencyCode = useSettingsStore((s) => s.setCurrencyCode);
  const setUseThousandsSeparator = useSettingsStore((s) => s.setUseThousandsSeparator);
  const setDateFormat = useSettingsStore((s) => s.setDateFormat);
  const setShowIncomeInReportsFirst = useSettingsStore((s) => s.setShowIncomeInReportsFirst);
  const setFontScale = useSettingsStore((s) => s.setFontScale);
  const setAiInferenceMode = useSettingsStore((s) => s.setAiInferenceMode);
  const setExternalApiProvider = useSettingsStore((s) => s.setExternalApiProvider);
  const setExternalApiUrl = useSettingsStore((s) => s.setExternalApiUrl);
  const setExternalApiModel = useSettingsStore((s) => s.setExternalApiModel);
  const setExternalApiKey = useSettingsStore((s) => s.setExternalApiKey);
  const setReceiptReadingMode = useSettingsStore((s) => s.setReceiptReadingMode);
  const setAiWifiOnlyDownload = useSettingsStore((s) => s.setAiWifiOnlyDownload);
  const setDailyReminderEnabled = useSettingsStore((s) => s.setDailyReminderEnabled);
  const setDailyReminderTime = useSettingsStore((s) => s.setDailyReminderTime);
  const setMonthStartDay = useSettingsStore((s) => s.setMonthStartDay);
  const setWeekStartDay = useSettingsStore((s) => s.setWeekStartDay);

  const provisioning = useAIStore((s) => s.provisioning);
  const provisioningHydrated = useAIStore((s) => s.provisioningHydrated);
  const localModelDisplayName = useAIStore((s) => s.localModelDisplayName);
  const runtime = useAIStore((s) => s.runtime);
  const runtimeReady = useAIStore((s) => s.runtimeReady);
  const warmupPending = useAIStore((s) => s.warmupPending);
  const logs = useAIStore((s) => s.logs);

  const transactionsList = useTransactionStore((s) => s.transactionsList);
  const wallets = useTransactionStore((s) => s.wallets);
  const categories = useTransactionStore((s) => s.categories);
  const addCategory = useTransactionStore((s) => s.addCategory);
  const renameCategory = useTransactionStore((s) => s.renameCategory);
  const deleteCategory = useTransactionStore((s) => s.deleteCategory);
  const getCategoriesByType = useTransactionStore((s) => s.getCategoriesByType);

  const [isExporting, setIsExporting] = useState(false);
  const activeModelId = useSettingsStore((s) => s.activeModelId);
  const activeModel = MODEL_CATALOG[activeModelId] ?? MODEL_CATALOG[DEFAULT_APP_SETTINGS.activeModelId];
  const formatGb = (bytes: number) => `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`;
  const formatMb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
  const modelSizeLabel = `about ${formatGb(activeModel.sizeBytes + (activeModel.visionProjector?.sizeBytes ?? 0))}`;
  const modelDownloadLabel = `${modelSizeLabel} download`;
  const visionAddOnSizeLabel = activeModel.visionProjector?.sizeBytes
    ? `about ${formatMb(activeModel.visionProjector.sizeBytes)}`
    : 'about 200 MB';
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [categoryDraft, setCategoryDraft] = useState('');
  const [categoryType, setCategoryType] = useState<CategoryType>('expense');
  const [editingCategory, setEditingCategory] = useState<CategoryRecord | null>(null);
  const [isAiActionLoading, setIsAiActionLoading] = useState(false);
  const [isModelInstalled, setIsModelInstalled] = useState(false);
  const [isProjectorInstalled, setIsProjectorInstalled] = useState(false);
  const [isProjectorDownloading, setIsProjectorDownloading] = useState(false);
  const [projectorProgress, setProjectorProgress] = useState(0);
  const [projectorError, setProjectorError] = useState<string | null>(null);
  const [visionSetupOpen, setVisionSetupOpen] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [connectionTestResult, setConnectionTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [showReminderTimePicker, setShowReminderTimePicker] = useState(false);
  const [isUpdatingReminder, setIsUpdatingReminder] = useState(false);
  const [reminderNotice, setReminderNotice] = useState<string | null>(null);
  const [monthStartModalVisible, setMonthStartModalVisible] = useState(false);

  React.useEffect(() => {
    let isMounted = true;
    const checkInstalled = async () => {
      const manager = getModelLifecycleManager();
      await manager.ensureInitialized?.();
      const installed = await isActiveModelInstalled();
      if (isMounted) {
        setIsModelInstalled(installed);
      }
    };
    void checkInstalled();
    return () => {
      isMounted = false;
    };
  }, [provisioning.status]);

  React.useEffect(() => {
    let isMounted = true;
    const checkProjectorInstalled = async () => {
      try {
        const installed = await isVisionProjectorInstalled();
        if (isMounted) {
          setIsProjectorInstalled(installed);
        }
      } catch {
        if (isMounted) {
          setIsProjectorInstalled(false);
        }
      }
    };
    checkProjectorInstalled();
    return () => {
      isMounted = false;
    };
  }, [provisioning.status, isModelInstalled]);

  const expenseCategories = useMemo(() => getCategoriesByType('expense'), [categories, getCategoriesByType]);
  const incomeCategories = useMemo(() => getCategoriesByType('income'), [categories, getCategoriesByType]);
  const textScale = useMemo(() => ({ fontSize: theme.scaleFont(14) }), [theme]);
  const captionScale = useMemo(() => ({ fontSize: theme.scaleFont(12) }), [theme]);
  const headingScale = useMemo(() => ({ fontSize: theme.scaleFont(17) }), [theme]);

  const progressPercent = useMemo(() => {
    if (provisioning.totalBytes && provisioning.totalBytes > 0) {
      return Math.round((provisioning.downloadedBytes / provisioning.totalBytes) * 100);
    }
    return Math.round(provisioning.progress * 100);
  }, [provisioning.downloadedBytes, provisioning.progress, provisioning.totalBytes]);

  const throughputLabel = useMemo(() => {
    if (!provisioning.transfer.bytesPerSecond || provisioning.transfer.bytesPerSecond <= 0) {
      return null;
    }
    const mbps = provisioning.transfer.bytesPerSecond / (1024 * 1024);
    return `${mbps.toFixed(2)} MB/s`;
  }, [provisioning.transfer.bytesPerSecond]);

  const { runtimePhaseActive, canRunNativeChat, hasUsableLocalInferenceBackend, localInferenceStatusMessage } =
    getAIRuntimeAvailability({ provisioning, runtimeReady, warmupPending, runtime, provisioningHydrated });
  const isCheckingModelStatus =
    aiInferenceMode === 'local' &&
    !provisioningHydrated &&
    provisioning.status === 'not-installed' &&
    !isModelInstalled;
  const canStartOrRetryProvisioning =
    hasUsableLocalInferenceBackend &&
    !isCheckingModelStatus &&
    ['failed', 'not-installed', 'update-available'].includes(provisioning.status);
  const isQwenDownloaded = isModelInstalled || provisioning.status === 'ready';
  const isDownloading = provisioning.status === 'downloading';
  const isInProgress = [
    'queued',
    'downloading',
    'verifying',
    'unpacking',
    'registering',
    'warming',
    'indexing',
  ].includes(provisioning.status);

  const modelStatusLabel = useMemo(() => {
    if (isCheckingModelStatus) {
      return 'Checking…';
    }
    if (isQwenDownloaded && provisioning.status !== 'failed' && !isInProgress) {
      return 'Ready';
    }
    if (provisioning.status === 'downloading') {
      return `Downloading (${progressPercent}%)`;
    }
    return getProvisioningStatusLabel(provisioning.status) || 'Not installed';
  }, [isCheckingModelStatus, isQwenDownloaded, provisioning.status, isInProgress, progressPercent]);

  const closeModal = () => {
    setModalVisible(false);
    setCategoryDraft('');
    setEditingCategory(null);
    setCategoryType('expense');
  };

  const openAddCategoryModal = (type: CategoryType) => {
    setCategoryType(type);
    setCategoryDraft('');
    setEditingCategory(null);
    setModalVisible(true);
  };

  const openEditCategoryModal = (category: CategoryRecord) => {
    setCategoryType(category.type);
    setCategoryDraft(category.name);
    setEditingCategory(category);
    setModalVisible(true);
  };

  const handleSaveCategory = async () => {
    try {
      if (editingCategory) {
        const result = await renameCategory(editingCategory.id, categoryDraft);
        if (!result.ok) {
          Alert.alert('Unable to Rename', result.message || 'Could not rename this category.');
          return;
        }
      } else {
        await addCategory(categoryDraft, categoryType);
      }
      closeModal();
    } catch (error) {
      Alert.alert('Category Error', getErrorMessage(error, 'Unable to save category.'));
    }
  };

  const handleDeleteCategory = (category: CategoryRecord) => {
    Alert.alert('Delete Category', `Are you sure you want to delete "${category.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const result = await deleteCategory(category.id);
          if (!result.ok) {
            Alert.alert('Cannot Delete', result.message || 'This category could not be deleted.');
          }
        },
      },
    ]);
  };

  const appLockEnabled = useSettingsStore((s) => s.appLockEnabled);
  const handleAppLockToggle = async (next: boolean) => {
    if (next && !(await canUseAppLock())) {
      Alert.alert(
        'Set up a screen lock first',
        'App Lock uses your fingerprint, face, or phone PIN. Add one in your phone security settings.',
        [
          { text: 'Not now', style: 'cancel' },
          {
            text: 'Open Security Settings',
            onPress: () => {
              if (Platform.OS === 'android' && typeof Linking.sendIntent === 'function') {
                void Linking.sendIntent('android.settings.SECURITY_SETTINGS').catch(() => Linking.openSettings());
              } else {
                void Linking.openSettings();
              }
            },
          },
        ]
      );
      return;
    }
    // Confirm it is the owner both when turning the lock on and off.
    if (await authenticateUser(next ? 'Turn on App Lock' : 'Turn off App Lock')) {
      await useSettingsStore.getState().setAppLockEnabled(next);
    }
  };

  const handleDailyReminderToggle = async (next: boolean) => {
    if (isUpdatingReminder) return;
    setIsUpdatingReminder(true);
    setReminderNotice(null);
    try {
      if (next) {
        if (!isNotificationsAvailable()) {
          await setDailyReminderEnabled(false);
          setReminderNotice('Daily reminders are not available on this device.');
          return;
        }
        const permission = await requestDailyReminderPermissionStatus();
        if (permission === 'unavailable') {
          await setDailyReminderEnabled(false);
          setReminderNotice('Daily reminders are not available on this device.');
          return;
        }
        if (permission !== 'granted') {
          try {
            await cancelDailyReminder();
          } catch {
            // Ignore cleanup errors when notifications are disabled.
          }
          await setDailyReminderEnabled(false);
          Alert.alert(
            'Notifications are turned off',
            'Allow notifications for Silo in your phone Settings (Apps > Silo > Notifications) to enable the daily reminder.',
            [
              { text: 'Not now', style: 'cancel' },
              {
                text: 'Open Settings',
                onPress: () => {
                  void Linking.openSettings();
                },
              },
            ]
          );
          return;
        }
        let scheduledId: string | null = null;
        try {
          scheduledId = await scheduleDailyReminder(dailyReminderTime);
        } catch {
          scheduledId = null;
        }
        if (!scheduledId) {
          await setDailyReminderEnabled(false);
          setReminderNotice('Could not schedule the daily reminder on this device.');
          return;
        }
        await setDailyReminderEnabled(true);
      } else {
        await setDailyReminderEnabled(false);
        try {
          await cancelDailyReminder();
        } catch {
          setReminderNotice('Daily reminder turned off, but the existing schedule could not be cleared.');
        }
      }
    } catch (error) {
      if (next) {
        try {
          await setDailyReminderEnabled(false);
        } catch {
          // Ignore secondary persistence errors when reverting toggle.
        }
      }
      setReminderNotice(getErrorMessage(error, 'Could not update the daily reminder.'));
    } finally {
      setIsUpdatingReminder(false);
    }
  };

  const handleCurrencySelect = (nextCurrency: string) => {
    if (nextCurrency === currencyCode) return;
    Alert.alert(
      'Change display currency?',
      `Switching from ${currencyCode} to ${nextCurrency} changes the currency label and formatting only. Existing amounts will not be converted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Use ${nextCurrency}`,
          onPress: () => {
            void setCurrencyCode(nextCurrency);
          },
        },
      ]
    );
  };

  const handleReminderTimeChange = async (event: { type?: string }, picked?: Date) => {
    setShowReminderTimePicker(false);
    if (event?.type === 'dismissed' || !picked) {
      return;
    }
    const nextTime = formatReminderTime(picked.getHours(), picked.getMinutes());
    setReminderNotice(null);
    try {
      await setDailyReminderTime(nextTime);
    } catch (error) {
      Alert.alert('Reminder Error', getErrorMessage(error, 'Could not save the reminder time.'));
      return;
    }

    if (dailyReminderEnabled) {
      try {
        const syncResult = await syncDailyReminder(true, nextTime);
        if (!syncResult.ok) {
          if (syncResult.reason === 'permission-denied') {
            setReminderNotice(
              'Reminder time saved, but notifications are turned off in phone Settings. Enable notifications to receive daily reminders.'
            );
          } else {
            setReminderNotice('Reminder time saved, but the notification could not be rescheduled on this device.');
          }
        }
      } catch {
        setReminderNotice('Reminder time saved, but the notification could not be rescheduled on this device.');
      }
    }
  };

  const handleShareBackupFile = async (existingFileUri?: string) => {
    setIsBackingUp(true);
    let createdTempUri: string | null = null;
    let shouldCleanupTemp = false;
    try {
      const fileUri = existingFileUri ?? (await createBackupFile());
      if (!existingFileUri) {
        createdTempUri = fileUri;
      }
      const shared = await shareLocalFile(fileUri, {
        mimeType: 'application/octet-stream',
        dialogTitle: 'Share your Silo backup',
      });
      if (!shared) {
        shouldCleanupTemp = true;
        Alert.alert('Sharing unavailable', 'No sharing apps are available on this device. Use Back Up All Data to save directly to a folder.');
      }
    } catch (error) {
      shouldCleanupTemp = true;
      Alert.alert('Share failed', getErrorMessage(error, 'Could not share the backup.'));
    } finally {
      if (shouldCleanupTemp && createdTempUri) {
        await deleteLocalFileQuietly(createdTempUri);
      }
      setIsBackingUp(false);
    }
  };

  const handleBackup = async () => {
    setIsBackingUp(true);
    let tempFileUri: string | null = null;
    let shouldCleanupTemp = false;
    try {
      const fileUri = await createBackupFile();
      tempFileUri = fileUri;
      const fileName = fileUri.split('/').pop() || `silo-backup-${new Date().toISOString().slice(0, 10)}.db`;

      if (isAndroidSafSupported()) {
        shouldCleanupTemp = true;
        const saved = await saveBinaryFileToDevice({
          sourceUri: fileUri,
          fileName,
          mimeType: 'application/octet-stream',
        });
        if (saved.status === 'cancelled') {
          return;
        }
        Alert.alert(
          'Backup saved',
          `Saved ${fileName} to the selected folder.`,
          [
            { text: 'Share', onPress: () => void handleShareBackupFile() },
            { text: 'OK', style: 'cancel' },
          ]
        );
        return;
      }

      const shared = await shareLocalFile(fileUri, {
        mimeType: 'application/octet-stream',
        dialogTitle: 'Save your Silo backup',
      });
      if (!shared) {
        shouldCleanupTemp = true;
        Alert.alert('Backup created', 'Sharing is not available on this device.');
      }
    } catch (error) {
      shouldCleanupTemp = true;
      Alert.alert('Backup failed', getErrorMessage(error, 'Could not create the backup.'));
    } finally {
      if (shouldCleanupTemp && tempFileUri) {
        await deleteLocalFileQuietly(tempFileUri);
      }
      setIsBackingUp(false);
    }
  };

  const runRestore = async (uri: string) => {
    setIsBackingUp(true);
    try {
      const { transactions } = await restoreBackupFile(uri);
      await useSettingsStore.getState().loadSettings();
      const store = useTransactionStore.getState();
      store.invalidateData?.();
      await Promise.all([store.fetchTransactions(), store.fetchCategories()]);
      await store.fetchBudgets();

      const restoredSettings = useSettingsStore.getState();
      let reminderWarning: string | null = null;
      try {
        const syncResult = await syncDailyReminder(
          restoredSettings.dailyReminderEnabled,
          restoredSettings.dailyReminderTime
        );
        if (!syncResult.ok && restoredSettings.dailyReminderEnabled) {
          reminderWarning =
            syncResult.reason === 'permission-denied'
              ? 'Daily reminder was not scheduled because notifications are turned off.'
              : 'Daily reminder could not be rescheduled on this device.';
        }
      } catch {
        reminderWarning = 'Daily reminder could not be rescheduled on this device.';
      }

      await useSettingsStore.getState().setHasCompletedOnboarding(true);
      setReminderNotice(reminderWarning);
      const restoredSummary = `${transactions} transaction${transactions === 1 ? '' : 's'} restored.`;
      Alert.alert(
        'Backup restored',
        reminderWarning ? `${restoredSummary}\n\n${reminderWarning}` : restoredSummary
      );
    } catch (error) {
      Alert.alert('Restore failed', `${getErrorMessage(error, 'Could not read the backup.')} Your current data was not changed.`);
    } finally {
      setIsBackingUp(false);
    }
  };

  const handleRestore = async () => {
    if (isBackingUp) return;
    let picked: DocumentPicker.DocumentPickerResult;
    try {
      picked = await DocumentPicker.getDocumentAsync({
        type: BACKUP_PICKER_MIME_TYPES,
        copyToCacheDirectory: true,
        multiple: false,
      });
    } catch (error) {
      Alert.alert('Could not open file picker', getErrorMessage(error, 'Unable to open your files to pick a backup.'));
      return;
    }
    if (picked.canceled || !picked.assets?.[0]?.uri) return;
    const asset = picked.assets[0];
    if (!isLikelyBackupFile(asset.name)) {
      Alert.alert('Not a backup file', 'Please select a Silo backup (.db) file.');
      return;
    }
    const uri = asset.uri;
    const fileLabel = asset.name ? ` "${asset.name}"` : '';
    Alert.alert(
      'Replace all data?',
      `Everything in Silo on this phone will be overwritten by backup${fileLabel}. Back up first if you might need the current data.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Restore', style: 'destructive', onPress: () => void runRestore(uri) },
      ],
    );
  };

  const handleShareCSV = async (prebuiltCsv?: string, prebuiltName?: string) => {
    let tempFileUri: string | null = null;
    let shouldCleanupTemp = false;
    try {
      setIsExporting(true);
      if (!prebuiltCsv && (!transactionsList || transactionsList.length === 0)) {
        Alert.alert('No Data', "You don't have any transactions to export yet.");
        return;
      }
      const csvString =
        prebuiltCsv ??
        buildTransactionsCsv(transactionsList, {
          wallets,
          dateFormat,
        });
      const fileName = prebuiltName ?? `Silo_Transactions_${new Date().toISOString().split('T')[0]}.csv`;
      const fileUri = await writeLocalTextFile(fileName, csvString);
      tempFileUri = fileUri;
      const shared = await shareLocalFile(fileUri, {
        mimeType: 'text/csv',
        dialogTitle: 'Share Silo Transactions CSV',
        UTI: 'public.comma-separated-values-text',
      });
      if (!shared) {
        shouldCleanupTemp = true;
        Alert.alert('Sharing unavailable', 'No sharing apps are available on this device. Use Export Transactions CSV to save directly to a folder.');
      }
    } catch (error) {
      shouldCleanupTemp = true;
      console.error('Share CSV failed:', error);
      Alert.alert('Share Failed', getErrorMessage(error, 'An error occurred while sharing your CSV file.'));
    } finally {
      if (shouldCleanupTemp && tempFileUri) {
        await deleteLocalFileQuietly(tempFileUri);
      }
      setIsExporting(false);
    }
  };

  const handleExportCSV = async () => {
    let tempFileUri: string | null = null;
    let shouldCleanupTemp = false;
    try {
      setIsExporting(true);

      if (!transactionsList || transactionsList.length === 0) {
        Alert.alert('No Data', "You don't have any transactions to export yet.");
        return;
      }

      const csvString = buildTransactionsCsv(transactionsList, {
        wallets,
        dateFormat,
      });

      const baseName = `Silo_Transactions_${new Date().toISOString().split('T')[0]}`;
      const fullFileName = `${baseName}.csv`;

      if (isAndroidSafSupported()) {
        const saved = await saveTextFileToDevice({
          fileName: baseName,
          mimeType: 'text/csv',
          content: csvString,
        });
        if (saved.status === 'cancelled') {
          return;
        }
        Alert.alert(
          'CSV exported',
          `Saved ${fullFileName} to the selected folder.`,
          [
            { text: 'Share', onPress: () => void handleShareCSV(csvString, fullFileName) },
            { text: 'OK', style: 'cancel' },
          ]
        );
        return;
      }

      const fileUri = await writeLocalTextFile(fullFileName, csvString);
      tempFileUri = fileUri;
      const shared = await shareLocalFile(fileUri, {
        mimeType: 'text/csv',
        dialogTitle: 'Export Silo Transactions',
        UTI: 'public.comma-separated-values-text',
      });
      if (!shared) {
        shouldCleanupTemp = true;
        Alert.alert('Error', 'Sharing is not supported on this device.');
      }
    } catch (error) {
      shouldCleanupTemp = true;
      console.error('Export failed:', error);
      Alert.alert('Export Failed', getErrorMessage(error, 'An error occurred while generating your CSV file.'));
    } finally {
      if (shouldCleanupTemp && tempFileUri) {
        await deleteLocalFileQuietly(tempFileUri);
      }
      setIsExporting(false);
    }
  };

  const handleAiInstallOrRetry = async () => {
    setIsAiActionLoading(true);
    try {
      const manager = getModelLifecycleManager();
      await manager.ensureInitialized?.();
      const latestProvisioning = useAIStore.getState().provisioning;
      if (latestProvisioning.status === 'paused' || latestProvisioning.canResume) {
        await manager.resumeDownload();
      } else if (latestProvisioning.status === 'ready' && !latestProvisioning.updateAvailable) {
        return;
      } else {
        await manager.retryProvisioning();
      }
    } catch (error) {
      Alert.alert('AI Setup', getErrorMessage(error, 'Unable to continue model setup.'));
    } finally {
      setIsAiActionLoading(false);
    }
  };

  const handleAiPause = async () => {
    setIsAiActionLoading(true);
    try {
      await getModelLifecycleManager().pauseDownload();
    } catch (error) {
      Alert.alert('AI Setup', getErrorMessage(error, 'Unable to pause download.'));
    } finally {
      setIsAiActionLoading(false);
    }
  };

  const handleAiResume = async () => {
    setIsAiActionLoading(true);
    try {
      await getModelLifecycleManager().resumeDownload();
    } catch (error) {
      Alert.alert('AI Setup', getErrorMessage(error, 'Unable to resume download.'));
    } finally {
      setIsAiActionLoading(false);
    }
  };

  const handleAiCancel = async () => {
    setIsAiActionLoading(true);
    try {
      await getModelLifecycleManager().cancelDownload();
    } catch (error) {
      Alert.alert('AI Setup', getErrorMessage(error, 'Unable to cancel setup.'));
    } finally {
      setIsAiActionLoading(false);
    }
  };

  const handleAiDelete = () => {
    Alert.alert(
      'Delete Offline Model',
      `Remove the offline AI model (${modelSizeLabel}) from this phone? You can download it again anytime to use offline AI.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Model',
          style: 'destructive',
          onPress: async () => {
            setIsAiActionLoading(true);
            try {
              const manager = getModelLifecycleManager() as any;
              if (typeof manager.deleteInstalledModel === 'function') {
                await manager.deleteInstalledModel();
              }
              setIsModelInstalled(false);
            } catch (err) {
              Alert.alert('Delete Error', getErrorMessage(err, 'Failed to delete model.'));
            } finally {
              setIsAiActionLoading(false);
            }
          },
        },
      ]
    );
  };

  const handleSelectReceiptReadingMode = (mode: 'ocr' | 'vision') => {
    if (mode === 'ocr') {
      setVisionSetupOpen(false);
      void setReceiptReadingMode('ocr');
      return;
    }
    if (aiInferenceMode === 'external' || isProjectorInstalled) {
      setVisionSetupOpen(false);
      void setReceiptReadingMode('vision');
      return;
    }
    // In local mode, require the vision add-on to be downloaded before activating Accurate (AI vision).
    setVisionSetupOpen(true);
  };

  const handleTestExternalConnection = async () => {
    const trimmedUrl = externalApiUrl.trim().replace(/\/+$/, '');
    const trimmedModel = externalApiModel.trim();
    const requiresKey = Boolean(EXTERNAL_API_PRESETS[externalApiProvider]?.requiresKey);
    const trimmedKey = externalApiKey.trim();

    if (!trimmedUrl || !/^https?:\/\//i.test(trimmedUrl)) {
      setConnectionTestResult({ ok: false, message: 'Enter a valid endpoint URL starting with http:// or https://.' });
      return;
    }
    if (!trimmedModel) {
      setConnectionTestResult({ ok: false, message: 'Enter a model name before testing.' });
      return;
    }
    if (requiresKey && !trimmedKey) {
      setConnectionTestResult({ ok: false, message: 'Enter an API key for this provider.' });
      return;
    }

    setIsTestingConnection(true);
    setConnectionTestResult(null);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 10_000) : null;
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (trimmedKey) {
        headers.Authorization = `Bearer ${trimmedKey}`;
      }
      const response = await fetch(`${trimmedUrl}/models`, {
        method: 'GET',
        headers,
        signal: controller?.signal,
      });
      if (response.ok) {
        setConnectionTestResult({ ok: true, message: 'Connection successful. Settings are saved.' });
      } else {
        setConnectionTestResult({
          ok: false,
          message: `Connection failed (HTTP ${response.status}). Check your URL and API key.`,
        });
      }
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      setConnectionTestResult({
        ok: false,
        message: isAbort
          ? 'Connection timed out. Check your internet or server address.'
          : getErrorMessage(error, 'Could not reach the API endpoint.'),
      });
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      setIsTestingConnection(false);
    }
  };

  const handleDownloadProjector = async () => {
    setProjectorError(null);
    setIsProjectorDownloading(true);
    setProjectorProgress(0);
    try {
      await downloadVisionProjector((fraction) => {
        setProjectorProgress(fraction);
      });
      setIsProjectorInstalled(true);
      setProjectorProgress(1);
      setVisionSetupOpen(false);
      void setReceiptReadingMode('vision');
    } catch (err) {
      setProjectorError(getErrorMessage(err, 'Failed to download vision add-on.'));
    } finally {
      setIsProjectorDownloading(false);
    }
  };

  const handleCancelProjectorDownload = async () => {
    try {
      await cancelVisionProjectorDownload();
    } catch {
      // ignore
    } finally {
      setIsProjectorDownloading(false);
      setProjectorProgress(0);
    }
  };

  const handleDeleteProjector = () => {
    Alert.alert(
      'Remove Vision Add-on',
      `Remove the AI vision add-on (${visionAddOnSizeLabel})? You will need to download it again to read receipts with AI vision.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteVisionProjector();
              setIsProjectorInstalled(false);
              if (aiInferenceMode === 'local' && receiptReadingMode === 'vision') {
                void setReceiptReadingMode('ocr');
              }
            } catch (err) {
              Alert.alert('Delete Error', getErrorMessage(err, 'Failed to remove vision add-on.'));
            }
          },
        },
      ]
    );
  };

  const switchTrackColor = {
    false: theme.isDarkMode ? '#3f3f46' : '#d1d5db',
    true: theme.isDarkMode ? '#0369a1' : '#7dd3fc',
  };
  const getSwitchThumbColor = (value: boolean) =>
    value ? theme.primary : theme.isDarkMode ? '#e5e7eb' : '#ffffff';

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={24} color={theme.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.text, fontSize: theme.scaleFont(18) }]}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: 132 }]} showsVerticalScrollIndicator={false}>
        {/* Appearance & Formatting Section */}
        <Text style={[styles.sectionTitle, { color: theme.textMuted }, captionScale]}>APPEARANCE & LOCALE</Text>
        <View style={[styles.sectionCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          {/* Theme Selector */}
          <View style={styles.rowBlock}>
            <View style={styles.rowBlockHeader}>
              <View style={styles.rowLeft}>
                <Ionicons name="color-palette-outline" size={18} color={theme.primary} />
                <Text style={[styles.rowText, { color: theme.text }, textScale]}>Theme</Text>
              </View>
            </View>
            <View style={styles.segmentedRow}>
              {THEME_OPTIONS.map((option) => {
                const isSelected = themeMode === option.key;
                return (
                  <TouchableOpacity
                    key={option.key}
                    style={[
                      styles.segmentBtn,
                      {
                        backgroundColor: isSelected ? theme.primary : theme.background,
                        borderColor: isSelected ? theme.primary : theme.border,
                      },
                    ]}
                    onPress={() => setThemeMode(option.key)}
                    accessibilityRole="button"
                    accessibilityLabel={`${option.label} theme`}
                  >
                    <Ionicons
                      name={option.icon}
                      size={16}
                      color={isSelected ? theme.onPrimary : theme.textMuted}
                      style={{ marginRight: 6 }}
                    />
                    <Text
                      style={[
                        styles.segmentBtnText,
                        { color: isSelected ? theme.onPrimary : theme.text, fontSize: theme.scaleFont(13) },
                      ]}
                    >
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          {/* Text Size / Font Scale */}
          <View style={styles.rowBlock}>
            <View style={styles.rowBlockHeader}>
              <View style={styles.rowLeft}>
                <Ionicons name="text-outline" size={18} color={theme.primary} />
                <Text style={[styles.rowText, { color: theme.text }, textScale]}>Text scaling</Text>
              </View>
              <Text style={[styles.inlineValue, { color: theme.primary }, captionScale]}>
                {Math.round(fontScale * 100)}%
              </Text>
            </View>
            <View style={styles.optionRowCompact}>
              {FONT_SCALE_OPTIONS.map((option) => {
                const isSelected = fontScale === option;
                return (
                  <TouchableOpacity
                    key={option}
                    style={[
                      styles.optionChip,
                      {
                        borderColor: isSelected ? theme.primary : theme.border,
                        backgroundColor: isSelected ? theme.primary : theme.background,
                      },
                    ]}
                    onPress={() => setFontScale(option)}
                    accessibilityRole="button"
                    accessibilityLabel={`Text scaling ${Math.round(option * 100)}%`}
                    accessibilityState={{ selected: isSelected }}
                  >
                    <Text
                      style={[
                        styles.optionChipText,
                        { color: isSelected ? theme.onPrimary : theme.text, fontSize: theme.scaleFont(12) },
                      ]}
                    >
                      {option === 1.0 ? '100% (Standard)' : `${Math.round(option * 100)}%`}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          {/* Currency Code Selector */}
          <View style={styles.rowBlock}>
            <View style={styles.rowBlockHeader}>
              <View style={styles.rowLeft}>
                <Ionicons name="cash-outline" size={18} color={theme.primary} />
                <Text style={[styles.rowText, { color: theme.text }, textScale]}>Currency</Text>
              </View>
              <Text style={[styles.inlineValue, { color: theme.textMuted }, captionScale]}>
                Selected: {currencyCode}
              </Text>
            </View>
            <View style={styles.optionRowCompact}>
              {CURRENCY_OPTIONS.map((option) => {
                const isSelected = currencyCode === option;
                return (
                  <TouchableOpacity
                    key={option}
                    style={[
                      styles.optionChip,
                      {
                        borderColor: isSelected ? theme.primary : theme.border,
                        backgroundColor: isSelected ? theme.primary : theme.background,
                      },
                    ]}
                    onPress={() => handleCurrencySelect(option)}
                    accessibilityRole="button"
                    accessibilityLabel={`Select ${option} currency`}
                    accessibilityState={{ selected: isSelected }}
                  >
                    <Text
                      style={[
                        styles.optionChipText,
                        { color: isSelected ? theme.onPrimary : theme.text, fontSize: theme.scaleFont(12) },
                      ]}
                    >
                      {option}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          {/* Date Format */}
          <View style={styles.rowBlock}>
            <View style={styles.rowBlockHeader}>
              <View style={styles.rowLeft}>
                <Ionicons name="calendar-outline" size={18} color={theme.primary} />
                <Text style={[styles.rowText, { color: theme.text }, textScale]}>Date format</Text>
              </View>
            </View>
            <View style={styles.optionRowCompact}>
              {DATE_FORMAT_OPTIONS.map((option) => {
                const isSelected = dateFormat === option.key;
                return (
                  <TouchableOpacity
                    key={option.key}
                    style={[
                      styles.optionChip,
                      {
                        borderColor: isSelected ? theme.primary : theme.border,
                        backgroundColor: isSelected ? theme.primary : theme.background,
                      },
                    ]}
                    onPress={() => setDateFormat(option.key)}
                    accessibilityRole="button"
                    accessibilityLabel={`Date format ${option.label}`}
                    accessibilityState={{ selected: isSelected }}
                  >
                    <Text
                      style={[
                        styles.optionChipText,
                        { color: isSelected ? theme.onPrimary : theme.text, fontSize: theme.scaleFont(12) },
                      ]}
                    >
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          {/* Month starts on day */}
          <TouchableOpacity
            style={styles.row}
            onPress={() => setMonthStartModalVisible(true)}
            accessibilityRole="button"
            accessibilityLabel="Month starts on day"
          >
            <View style={styles.rowLeft}>
              <Ionicons name="calendar-number-outline" size={18} color={theme.primary} />
              <View style={styles.rowTextBlock}>
                <Text style={[styles.rowText, { color: theme.text }, textScale]}>Month starts on day</Text>
                <Text style={[styles.rowSubText, { color: theme.textMuted }, captionScale]}>
                  {monthStartDay === 1 ? 'Calendar month (1st to end)' : `Custom cycle starting on day ${monthStartDay}`}
                </Text>
              </View>
            </View>
            <View style={styles.rowValueRight}>
              <Text style={[styles.inlineValue, { color: theme.primary }, captionScale]}>Day {monthStartDay}</Text>
              <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
            </View>
          </TouchableOpacity>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          {/* Week starts on */}
          <View style={styles.rowBlock}>
            <View style={styles.rowBlockHeader}>
              <View style={styles.rowLeft}>
                <Ionicons name="today-outline" size={18} color={theme.primary} />
                <Text style={[styles.rowText, { color: theme.text }, textScale]}>Week starts on</Text>
              </View>
            </View>
            <View style={styles.segmentedRow}>
              {WEEK_START_OPTIONS.map((option) => {
                const isSelected = weekStartDay === option.key;
                return (
                  <TouchableOpacity
                    key={option.key}
                    style={[
                      styles.segmentBtn,
                      {
                        backgroundColor: isSelected ? theme.primary : theme.background,
                        borderColor: isSelected ? theme.primary : theme.border,
                      },
                    ]}
                    onPress={() => setWeekStartDay(option.key)}
                    accessibilityRole="button"
                    accessibilityLabel={`Week starts on ${option.label}`}
                    accessibilityState={{ selected: isSelected }}
                  >
                    <Text
                      style={[
                        styles.segmentBtnText,
                        { color: isSelected ? theme.onPrimary : theme.text, fontSize: theme.scaleFont(13) },
                      ]}
                    >
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          {/* Thousands Separator Toggle */}
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Ionicons name="reorder-three-outline" size={18} color={theme.primary} />
              <Text style={[styles.rowText, { color: theme.text }, textScale]}>Use thousands separator</Text>
            </View>
            <Switch
              value={useThousandsSeparator}
              onValueChange={setUseThousandsSeparator}
              trackColor={switchTrackColor}
              thumbColor={getSwitchThumbColor(useThousandsSeparator)}
              accessibilityLabel="Use thousands separator"
            />
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          {/* Default Reports view: Income Toggle */}
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Ionicons name="swap-vertical-outline" size={18} color={theme.primary} />
              <View style={styles.rowTextBlock}>
                <Text style={[styles.rowText, { color: theme.text }, textScale]}>Default Reports view: Income</Text>
                <Text style={[styles.rowSubText, { color: theme.textMuted }, captionScale]}>
                  Open Reports on Income instead of Expenses
                </Text>
              </View>
            </View>
            <Switch
              value={showIncomeInReportsFirst}
              onValueChange={setShowIncomeInReportsFirst}
              trackColor={switchTrackColor}
              thumbColor={getSwitchThumbColor(showIncomeInReportsFirst)}
              accessibilityLabel="Default Reports view: Income"
            />
          </View>
        </View>

        {/* Reminders Section */}
        <Text style={[styles.sectionTitle, { color: theme.textMuted }, captionScale]}>REMINDERS</Text>
        <View style={[styles.sectionCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Ionicons name="notifications-outline" size={18} color={theme.primary} />
              <View style={styles.rowTextBlock}>
                <Text style={[styles.rowText, { color: theme.text }, textScale]}>Daily reminder</Text>
                <Text style={[styles.rowSubText, { color: theme.textMuted }, captionScale]}>
                  Remind me to log today&apos;s spending
                </Text>
              </View>
            </View>
            <Switch
              value={dailyReminderEnabled}
              onValueChange={(next) => void handleDailyReminderToggle(next)}
              disabled={isUpdatingReminder}
              trackColor={switchTrackColor}
              thumbColor={getSwitchThumbColor(dailyReminderEnabled)}
              accessibilityLabel="Daily reminder"
            />
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <TouchableOpacity
            style={styles.row}
            onPress={() => setShowReminderTimePicker(true)}
            accessibilityRole="button"
            accessibilityLabel="Reminder time"
          >
            <View style={styles.rowLeft}>
              <Ionicons name="time-outline" size={18} color={theme.primary} />
              <View style={styles.rowTextBlock}>
                <Text style={[styles.rowText, { color: theme.text }, textScale]}>Reminder time</Text>
                <Text style={[styles.rowSubText, { color: theme.textMuted }, captionScale]}>
                  {dailyReminderEnabled ? 'Repeats every day' : 'Used when daily reminder is on'}
                </Text>
              </View>
            </View>
            <View style={styles.rowValueRight}>
              <Text style={[styles.inlineValue, { color: theme.primary }, textScale]}>{dailyReminderTime}</Text>
              <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
            </View>
          </TouchableOpacity>

          {reminderNotice ? (
            <>
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
              <View style={styles.reminderNoticeRow} accessibilityRole="alert">
                <Ionicons name="information-circle-outline" size={16} color={theme.textMuted} style={styles.reminderNoticeIcon} />
                <Text style={[styles.reminderNoticeText, { color: theme.textMuted }, captionScale]}>
                  {reminderNotice}
                </Text>
              </View>
            </>
          ) : null}
        </View>

        {/* AI & Receipt Scanning Section */}
        <Text style={[styles.sectionTitle, { color: theme.textMuted }, captionScale]}>AI & RECEIPT SCANNING</Text>
        <View style={[styles.sectionCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          {/* Inference Mode Toggle (On-Device vs External API) */}
          <View style={styles.rowBlock}>
            <View style={styles.rowBlockHeader}>
              <View style={styles.rowLeft}>
                <Ionicons name="hardware-chip-outline" size={18} color={theme.primary} />
                <Text style={[styles.rowText, { color: theme.text }, textScale]}>AI Mode</Text>
              </View>
            </View>
            <View style={styles.segmentedRow}>
              <TouchableOpacity
                style={[
                  styles.segmentBtn,
                  {
                    backgroundColor: aiInferenceMode === 'local' ? theme.primary : theme.background,
                    borderColor: aiInferenceMode === 'local' ? theme.primary : theme.border,
                  },
                ]}
                onPress={() => setAiInferenceMode('local')}
                accessibilityRole="button"
                accessibilityLabel="On-Device (Offline)"
                accessibilityState={{ selected: aiInferenceMode === 'local' }}
              >
                <Ionicons
                  name="phone-portrait-outline"
                  size={16}
                  color={aiInferenceMode === 'local' ? theme.onPrimary : theme.textMuted}
                  style={{ marginRight: 6 }}
                />
                <Text
                  style={[
                    styles.segmentBtnText,
                    { color: aiInferenceMode === 'local' ? theme.onPrimary : theme.text, fontSize: theme.scaleFont(13) },
                  ]}
                >
                  On-Device (Offline)
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.segmentBtn,
                  {
                    backgroundColor: aiInferenceMode === 'external' ? theme.primary : theme.background,
                    borderColor: aiInferenceMode === 'external' ? theme.primary : theme.border,
                  },
                ]}
                onPress={() => setAiInferenceMode('external')}
                accessibilityRole="button"
                accessibilityLabel="External API"
                accessibilityState={{ selected: aiInferenceMode === 'external' }}
              >
                <Ionicons
                  name="cloud-outline"
                  size={16}
                  color={aiInferenceMode === 'external' ? theme.onPrimary : theme.textMuted}
                  style={{ marginRight: 6 }}
                />
                <Text
                  style={[
                    styles.segmentBtnText,
                    { color: aiInferenceMode === 'external' ? theme.onPrimary : theme.text, fontSize: theme.scaleFont(13) },
                  ]}
                >
                  External API
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          {aiInferenceMode === 'local' ? (
            /* Offline Model Card */
            <View style={styles.rowBlock}>
              <Text style={[styles.cardSectionHeading, { color: theme.text }, textScale]}>Offline AI Model</Text>
              <View
                style={[
                  styles.modelCard,
                  {
                    backgroundColor: theme.background,
                    borderColor: isQwenDownloaded ? theme.income : theme.border,
                  },
                ]}
              >
                <View style={styles.modelCardHeader} testID="model-card-header">
                  <View style={styles.modelCardTitleWrap}>
                    <View style={[styles.modelBadgeIcon, { backgroundColor: theme.primaryMuted }]}>
                      <Ionicons name="hardware-chip" size={18} color={theme.primary} />
                    </View>
                    <View style={styles.modelTitleCopy}>
                      <Text
                        style={[styles.modelName, { color: theme.text, fontSize: theme.scaleFont(15) }]}
                        testID="model-card-name"
                      >
                        {activeModel.displayName.replace(' (Offline)', '')}
                      </Text>
                      <Text style={[styles.modelSpec, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
                        {modelDownloadLabel} · Needs {formatGb(activeModel.requiredRamBytes)} RAM ({formatGb(activeModel.recommendedRamBytes)} recommended)
                      </Text>
                    </View>
                  </View>

                  <View style={styles.statusPillRow}>
                    <View
                      testID="model-status-pill"
                      style={[
                        styles.statusPill,
                        {
                          backgroundColor: isQwenDownloaded && provisioning.status !== 'failed' && !isInProgress
                            ? theme.incomeMuted
                            : provisioning.status === 'failed'
                            ? theme.expenseMuted
                            : isInProgress
                            ? theme.primaryMuted
                            : theme.surface,
                          borderColor: isQwenDownloaded && provisioning.status !== 'failed' && !isInProgress
                            ? theme.income
                            : provisioning.status === 'failed'
                            ? theme.expense
                            : isInProgress
                            ? theme.primary
                            : theme.border,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.statusPillText,
                          {
                            color: isQwenDownloaded && provisioning.status !== 'failed' && !isInProgress
                              ? theme.income
                              : provisioning.status === 'failed'
                              ? theme.expense
                              : isInProgress
                              ? theme.primary
                              : theme.textMuted,
                            fontSize: theme.scaleFont(11),
                          },
                        ]}
                      >
                        {modelStatusLabel}
                      </Text>
                    </View>
                  </View>
                </View>

                <Text style={[styles.modelDesc, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
                  Compact offline AI model. Runs completely on your phone with no internet connection.
                </Text>

                {/* Progress bar if downloading or paused */}
                {(isDownloading || provisioning.status === 'paused') && (
                  <View style={styles.downloadProgressWrap}>
                    <View style={[styles.downloadTrack, { backgroundColor: theme.border }]}>
                      <View
                        style={[
                          styles.downloadFill,
                          { backgroundColor: theme.primary, width: `${Math.min(progressPercent, 100)}%` },
                        ]}
                      />
                    </View>
                    <View style={styles.downloadMetaRow}>
                      <Text style={[styles.downloadMetaText, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
                        {progressPercent}% completed{provisioning.status === 'paused' ? ' (Paused)' : ''}
                      </Text>
                      {isDownloading && throughputLabel && (
                        <Text style={[styles.downloadMetaText, { color: theme.primary, fontSize: theme.scaleFont(11) }]}>
                          Speed: {throughputLabel}
                        </Text>
                      )}
                    </View>
                  </View>
                )}

                {/* Indeterminate progress indicator during verification / unpacking / registering */}
                {isInProgress && !isDownloading && (
                  <View
                    testID="model-verifying-progress"
                    style={[styles.verifyingProgressRow, { backgroundColor: theme.surface, borderColor: theme.border }]}
                    accessibilityRole="progressbar"
                  >
                    <ActivityIndicator size="small" color={theme.primary} />
                    <Text style={[styles.verifyingProgressText, { color: theme.text, fontSize: theme.scaleFont(12) }]}>
                      {provisioning.status === 'verifying'
                        ? 'Verifying model integrity…'
                        : `${modelStatusLabel}…`}
                    </Text>
                  </View>
                )}

                {/* Error message for failed */}
                {provisioning.status === 'failed' && provisioning.lastError && (
                  <Text style={[styles.modelErrorText, { color: theme.expense, fontSize: theme.scaleFont(12) }]}>
                    {provisioning.lastError}
                  </Text>
                )}

                {/* Model Action Buttons */}
                <View style={styles.modelActionsRow}>
                  {isDownloading && (
                    <TouchableOpacity
                      style={[styles.modelActionButton, { backgroundColor: theme.primaryMuted, borderColor: theme.primary, borderWidth: 1 }]}
                      onPress={handleAiPause}
                      disabled={isAiActionLoading}
                      accessibilityRole="button"
                    >
                      <Ionicons name="pause-outline" size={16} color={theme.primary} style={{ marginRight: 6 }} />
                      <Text style={[styles.modelActionText, { color: theme.primary, fontSize: theme.scaleFont(13) }]}>Pause</Text>
                    </TouchableOpacity>
                  )}

                  {(isInProgress || provisioning.status === 'paused') && (
                    <TouchableOpacity
                      style={[styles.modelActionButton, { backgroundColor: theme.expense }]}
                      onPress={handleAiCancel}
                      disabled={isAiActionLoading}
                      accessibilityRole="button"
                    >
                      <Ionicons name="close-circle-outline" size={16} color={theme.onPrimary} style={{ marginRight: 6 }} />
                      <Text style={[styles.modelActionText, { color: theme.onPrimary, fontSize: theme.scaleFont(13) }]}>Cancel</Text>
                    </TouchableOpacity>
                  )}

                  {!isInProgress && provisioning.status === 'failed' && (
                    <TouchableOpacity
                      style={[styles.modelActionButton, { backgroundColor: theme.primary }]}
                      onPress={handleAiInstallOrRetry}
                      disabled={isAiActionLoading}
                      accessibilityRole="button"
                    >
                      {isAiActionLoading ? (
                        <ActivityIndicator color={theme.onPrimary} size="small" />
                      ) : (
                        <>
                          <Ionicons name="refresh-outline" size={16} color={theme.onPrimary} style={{ marginRight: 6 }} />
                          <Text style={[styles.modelActionText, { color: theme.onPrimary, fontSize: theme.scaleFont(13) }]}>Retry</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  )}

                  {isCheckingModelStatus && (
                    <View
                      style={[
                        styles.modelActionButton,
                        { backgroundColor: theme.background, borderColor: theme.border, borderWidth: 1 },
                      ]}
                      accessibilityLabel="Checking local AI model status"
                    >
                      <ActivityIndicator color={theme.primary} size="small" style={{ marginRight: 8 }} />
                      <Text style={[styles.modelActionText, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>
                        Checking model status…
                      </Text>
                    </View>
                  )}

                  {!isCheckingModelStatus && !isInProgress && provisioning.status !== 'failed' && !isQwenDownloaded && (
                    <TouchableOpacity
                      style={[styles.modelActionButton, { backgroundColor: theme.primary }]}
                      onPress={provisioning.status === 'paused' ? handleAiResume : handleAiInstallOrRetry}
                      disabled={isAiActionLoading}
                      accessibilityRole="button"
                    >
                      {isAiActionLoading ? (
                        <ActivityIndicator color={theme.onPrimary} size="small" />
                      ) : (
                        <>
                          <Ionicons
                            name={provisioning.status === 'paused' ? 'play-outline' : 'download-outline'}
                            size={16}
                            color={theme.onPrimary}
                            style={{ marginRight: 6 }}
                          />
                          <Text style={[styles.modelActionText, { color: theme.onPrimary, fontSize: theme.scaleFont(13) }]}>
                            {provisioning.status === 'paused' ? 'Resume' : 'Download Model'}
                          </Text>
                        </>
                      )}
                    </TouchableOpacity>
                  )}

                  {isQwenDownloaded && !isInProgress && (
                    <TouchableOpacity
                      style={[styles.modelSecondaryActionButton, { borderColor: theme.expense }]}
                      onPress={handleAiDelete}
                      disabled={isAiActionLoading}
                      accessibilityRole="button"
                      accessibilityLabel="Delete offline model"
                    >
                      <Ionicons name="trash-outline" size={16} color={theme.expense} style={{ marginRight: 6 }} />
                      <Text style={[styles.modelSecondaryActionText, { color: theme.expense, fontSize: theme.scaleFont(13) }]}>
                        Delete Model
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>

              {/* Wi-Fi Only Switch */}
              <View style={[styles.row, { paddingHorizontal: 0, marginTop: 8 }]}>
                <View style={styles.rowLeft}>
                  <Ionicons name="wifi-outline" size={18} color={theme.primary} />
                  <Text style={[styles.rowText, { color: theme.text }, textScale]}>Wi-Fi only downloads</Text>
                </View>
                <Switch
                  value={aiWifiOnlyDownload}
                  onValueChange={setAiWifiOnlyDownload}
                  trackColor={switchTrackColor}
                  thumbColor={getSwitchThumbColor(aiWifiOnlyDownload)}
                  accessibilityLabel="Wi-Fi only downloads"
                />
              </View>
            </View>
          ) : (
            /* External API Configuration */
            <View style={styles.rowBlock}>
              <Text style={[styles.cardSectionHeading, { color: theme.text }, textScale]}>
                External Provider Presets
              </Text>
              <View style={[styles.optionRowCompact, { marginTop: 6 }]}>
                {(Object.keys(EXTERNAL_API_PRESETS) as ExternalAPIProvider[]).map((providerKey) => {
                  const preset = EXTERNAL_API_PRESETS[providerKey];
                  const isSelected = externalApiProvider === providerKey;
                  return (
                    <TouchableOpacity
                      key={providerKey}
                      style={[
                        styles.optionChip,
                        {
                          backgroundColor: isSelected ? theme.primary : theme.background,
                          borderColor: isSelected ? theme.primary : theme.border,
                        },
                      ]}
                      onPress={() => {
                        setExternalApiProvider(providerKey);
                        setConnectionTestResult(null);
                        const preset = EXTERNAL_API_PRESETS[providerKey];
                        if (preset) {
                          setExternalApiUrl(preset.url);
                          setExternalApiModel(preset.model);
                        }
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`External provider ${preset.label}`}
                      accessibilityState={{ selected: isSelected }}
                    >
                      <Text
                        style={[
                          styles.optionChipText,
                          { color: isSelected ? theme.onPrimary : theme.text, fontSize: theme.scaleFont(12) },
                        ]}
                      >
                        {preset.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={[styles.inputLabel, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
                Endpoint Base URL
              </Text>
              <TextInput
                style={[
                  styles.formInput,
                  {
                    backgroundColor: theme.background,
                    borderColor: theme.border,
                    color: theme.text,
                    fontSize: theme.scaleFont(14),
                  },
                ]}
                placeholder="https://api.openai.com/v1"
                placeholderTextColor={theme.textMuted}
                value={externalApiUrl}
                onChangeText={(value) => {
                  setExternalApiUrl(value);
                  setConnectionTestResult(null);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Endpoint Base URL"
              />

              <Text style={[styles.inputLabel, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
                Model Identifier
              </Text>
              <TextInput
                style={[
                  styles.formInput,
                  {
                    backgroundColor: theme.background,
                    borderColor: theme.border,
                    color: theme.text,
                    fontSize: theme.scaleFont(14),
                  },
                ]}
                placeholder="gpt-4o-mini"
                placeholderTextColor={theme.textMuted}
                value={externalApiModel}
                onChangeText={(value) => {
                  setExternalApiModel(value);
                  setConnectionTestResult(null);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Model Identifier"
              />

              <Text style={[styles.inputLabel, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
                {EXTERNAL_API_PRESETS[externalApiProvider]?.requiresKey
                  ? 'API Key (Required)'
                  : 'API Key (Optional)'}
              </Text>
              <View style={[styles.apiKeyRow, { backgroundColor: theme.background, borderColor: theme.border }]}>
                <TextInput
                  style={[styles.apiKeyInput, { color: theme.text, fontSize: theme.scaleFont(14) }]}
                  placeholder="sk-..."
                  placeholderTextColor={theme.textMuted}
                  value={externalApiKey}
                  onChangeText={(value) => {
                    setExternalApiKey(value);
                    setConnectionTestResult(null);
                  }}
                  secureTextEntry={!showApiKey}
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="External API Key"
                />
                <TouchableOpacity
                  style={styles.apiKeyEyeBtn}
                  onPress={() => setShowApiKey((prev) => !prev)}
                  accessibilityRole="button"
                  accessibilityLabel={showApiKey ? 'Hide API key' : 'Show API key'}
                >
                  <Ionicons name={showApiKey ? 'eye-off-outline' : 'eye-outline'} size={18} color={theme.textMuted} />
                </TouchableOpacity>
              </View>

              <View style={styles.externalApiFooter}>
                <Text style={[styles.autoSaveHint, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
                  Settings save automatically
                </Text>
                <TouchableOpacity
                  style={[
                    styles.testConnectionBtn,
                    { borderColor: theme.primary, backgroundColor: theme.primaryMuted, opacity: isTestingConnection ? 0.7 : 1 },
                  ]}
                  onPress={() => void handleTestExternalConnection()}
                  disabled={isTestingConnection}
                  accessibilityRole="button"
                  accessibilityLabel="Test Connection"
                >
                  {isTestingConnection ? (
                    <ActivityIndicator size="small" color={theme.primary} />
                  ) : (
                    <>
                      <Ionicons name="pulse-outline" size={16} color={theme.primary} />
                      <Text style={[styles.testConnectionText, { color: theme.primary, fontSize: theme.scaleFont(13) }]}>
                        Test Connection
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>

              {connectionTestResult ? (
                <Text
                  accessibilityRole="alert"
                  style={[
                    styles.connectionResultText,
                    { color: connectionTestResult.ok ? theme.income : theme.expense, fontSize: theme.scaleFont(12) },
                  ]}
                >
                  {connectionTestResult.message}
                </Text>
              ) : null}
            </View>
          )}

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          {/* Receipt Reading Mode Selector */}
          <View style={styles.rowBlock}>
            <Text style={[styles.cardSectionHeading, { color: theme.text }, textScale]}>Receipt reading</Text>
            <View style={[styles.optionRowCompact, { marginTop: 6 }]}>
              {([
                { id: 'ocr' as const, label: 'Fast (text OCR)' },
                { id: 'vision' as const, label: 'Accurate (AI vision)' },
              ]).map((mode) => {
                const isSelected = receiptReadingMode === mode.id;
                return (
                  <TouchableOpacity
                    key={mode.id}
                    style={[
                      styles.optionChip,
                      {
                        backgroundColor: isSelected ? theme.primary : theme.background,
                        borderColor: isSelected ? theme.primary : theme.border,
                      },
                    ]}
                    onPress={() => handleSelectReceiptReadingMode(mode.id)}
                    accessibilityRole="button"
                    accessibilityLabel={mode.label}
                    accessibilityState={{ selected: isSelected }}
                  >
                    <Text
                      style={[
                        styles.optionChipText,
                        { color: isSelected ? theme.onPrimary : theme.text, fontSize: theme.scaleFont(12) },
                      ]}
                    >
                      {mode.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={[styles.modelDesc, { color: theme.textMuted, marginTop: 6, marginBottom: 0, fontSize: theme.scaleFont(12) }]}>
              {aiInferenceMode === 'external'
                ? 'AI vision reads the photo directly: more accurate on complex receipts using your connected AI provider.'
                : `AI vision reads the photo directly: more accurate on complex receipts, but slower, and needs an extra ${visionAddOnSizeLabel} download.`}
            </Text>

            {(receiptReadingMode === 'vision' || visionSetupOpen) && (
              <View style={{ marginTop: 10 }}>
                {aiInferenceMode === 'external' ? (
                  <Text style={[styles.modelDesc, { color: theme.textMuted, marginBottom: 0, fontSize: theme.scaleFont(12) }]}>
                    External mode needs no download.
                  </Text>
                ) : !isQwenDownloaded ? (
                  <Text style={[styles.modelDesc, { color: theme.textMuted, marginBottom: 0, fontSize: theme.scaleFont(12) }]}>
                    AI model must be downloaded first (local mode).
                  </Text>
                ) : isProjectorDownloading ? (
                  <View>
                    <View style={styles.downloadProgressWrap}>
                      <View style={[styles.downloadTrack, { backgroundColor: theme.border }]}>
                        <View
                          style={[
                            styles.downloadFill,
                            {
                              width: `${Math.min(100, Math.max(0, Math.round(projectorProgress * 100)))}%`,
                              backgroundColor: theme.primary,
                            },
                          ]}
                        />
                      </View>
                      <View style={styles.downloadMetaRow}>
                        <Text style={[styles.downloadMetaText, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
                          {`${Math.round(projectorProgress * 100)}% completed`}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.modelActionsRow}>
                      <TouchableOpacity
                        style={[styles.modelActionButton, { backgroundColor: theme.expense }]}
                        onPress={handleCancelProjectorDownload}
                        accessibilityRole="button"
                        accessibilityLabel="Cancel vision download"
                      >
                        <Ionicons name="close-circle-outline" size={16} color={theme.onPrimary} style={{ marginRight: 6 }} />
                        <Text style={[styles.modelActionText, { color: theme.onPrimary, fontSize: theme.scaleFont(13) }]}>Cancel</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : isProjectorInstalled ? (
                  <View style={[styles.modelActionsRow, { alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Ionicons name="checkmark-circle" size={18} color={theme.income} />
                      <Text style={[{ color: theme.income, fontWeight: '600' }, textScale]}>
                        Vision add-on installed
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={[
                        styles.modelActionButton,
                        {
                          flex: 0,
                          paddingHorizontal: 16,
                          minHeight: 44,
                          backgroundColor: theme.expenseMuted,
                          borderWidth: 1,
                          borderColor: theme.expense,
                        },
                      ]}
                      onPress={handleDeleteProjector}
                      accessibilityRole="button"
                      accessibilityLabel="Remove vision add-on"
                    >
                      <Text style={[styles.modelActionText, { color: theme.expense, fontSize: theme.scaleFont(13) }]}>Remove</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <View>
                    {visionSetupOpen && receiptReadingMode !== 'vision' ? (
                      <Text style={[styles.modelDesc, { color: theme.textMuted, marginBottom: 8, fontSize: theme.scaleFont(12) }]}>
                        Download the vision add-on before enabling Accurate (AI vision).
                      </Text>
                    ) : null}
                    {projectorError && (
                      <Text style={[styles.modelErrorText, { color: theme.expense, marginBottom: 8, fontSize: theme.scaleFont(12) }]}>
                        {projectorError}
                      </Text>
                    )}
                    <View style={styles.modelActionsRow}>
                      <TouchableOpacity
                        style={[styles.modelActionButton, { backgroundColor: theme.primary }]}
                        onPress={handleDownloadProjector}
                        accessibilityRole="button"
                        accessibilityLabel={
                          projectorError ? 'Retry vision download' : `Download vision add-on (${visionAddOnSizeLabel})`
                        }
                      >
                        <Ionicons
                          name={projectorError ? 'refresh-outline' : 'download-outline'}
                          size={16}
                          color={theme.onPrimary}
                          style={{ marginRight: 6 }}
                        />
                        <Text style={[styles.modelActionText, { color: theme.onPrimary, fontSize: theme.scaleFont(13) }]}>
                          {projectorError ? 'Retry' : `Download vision add-on (${visionAddOnSizeLabel})`}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </View>
            )}
          </View>

        </View>

        {/* Categories Section */}
        <Text style={[styles.sectionTitle, { color: theme.textMuted }, captionScale]}>CATEGORIES</Text>
        <View style={styles.categorySplitWrap}>
          {/* Expense Categories */}
          <View style={[styles.categoryColumnCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <View style={styles.categoryColumnHeader}>
              <View>
                <Text style={[styles.categoryEyebrow, { color: theme.expense, fontSize: theme.scaleFont(11) }]}>
                  EXPENSE
                </Text>
                <Text style={[styles.categoryHeading, { color: theme.text, fontSize: theme.scaleFont(15) }]}>
                  Spending ({expenseCategories.length})
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.roundAddBtn, { backgroundColor: theme.background, borderColor: theme.border }]}
                onPress={() => openAddCategoryModal('expense')}
                accessibilityRole="button"
                accessibilityLabel="Add expense category"
              >
                <Ionicons name="add" size={20} color={theme.expense} />
              </TouchableOpacity>
            </View>

            {expenseCategories.map((category) => (
              <View key={category.id} style={[styles.categoryPillRow, { borderColor: theme.border }]}>
                <View style={styles.categoryPillLeft}>
                  <Text style={[styles.categoryPillText, { color: theme.text, fontSize: theme.scaleFont(14) }]}>
                    {category.name}
                  </Text>
                  {category.isSystem && (
                    <Text style={[styles.badgeText, { color: theme.textMuted, fontSize: theme.scaleFont(10) }]}>
                      Default
                    </Text>
                  )}
                </View>
                <View style={styles.categoryActions}>
                  <TouchableOpacity
                    onPress={() => openEditCategoryModal(category)}
                    style={styles.iconActionBtn}
                    hitSlop={4}
                    accessibilityRole="button"
                    accessibilityLabel={`Edit ${category.name}`}
                  >
                    <Ionicons name="create-outline" size={18} color={theme.textMuted} />
                  </TouchableOpacity>
                  {!category.isSystem ? (
                    <TouchableOpacity
                      onPress={() => handleDeleteCategory(category)}
                      style={styles.iconActionBtn}
                      hitSlop={4}
                      accessibilityRole="button"
                      accessibilityLabel={`Delete ${category.name}`}
                    >
                      <Ionicons name="trash-outline" size={18} color={theme.expense} />
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>
            ))}
          </View>

          {/* Income Categories */}
          <View style={[styles.categoryColumnCard, { backgroundColor: theme.surface, borderColor: theme.border, marginTop: 10 }]}>
            <View style={styles.categoryColumnHeader}>
              <View>
                <Text style={[styles.categoryEyebrow, { color: theme.income, fontSize: theme.scaleFont(11) }]}>
                  INCOME
                </Text>
                <Text style={[styles.categoryHeading, { color: theme.text, fontSize: theme.scaleFont(15) }]}>
                  Earnings ({incomeCategories.length})
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.roundAddBtn, { backgroundColor: theme.background, borderColor: theme.border }]}
                onPress={() => openAddCategoryModal('income')}
                accessibilityRole="button"
                accessibilityLabel="Add income category"
              >
                <Ionicons name="add" size={20} color={theme.income} />
              </TouchableOpacity>
            </View>

            {incomeCategories.map((category) => (
              <View key={category.id} style={[styles.categoryPillRow, { borderColor: theme.border }]}>
                <View style={styles.categoryPillLeft}>
                  <Text style={[styles.categoryPillText, { color: theme.text, fontSize: theme.scaleFont(14) }]}>
                    {category.name}
                  </Text>
                  {category.isSystem && (
                    <Text style={[styles.badgeText, { color: theme.textMuted, fontSize: theme.scaleFont(10) }]}>
                      Default
                    </Text>
                  )}
                </View>
                <View style={styles.categoryActions}>
                  <TouchableOpacity
                    onPress={() => openEditCategoryModal(category)}
                    style={styles.iconActionBtn}
                    hitSlop={4}
                    accessibilityRole="button"
                    accessibilityLabel={`Edit ${category.name}`}
                  >
                    <Ionicons name="create-outline" size={18} color={theme.textMuted} />
                  </TouchableOpacity>
                  {!category.isSystem ? (
                    <TouchableOpacity
                      onPress={() => handleDeleteCategory(category)}
                      style={styles.iconActionBtn}
                      hitSlop={4}
                      accessibilityRole="button"
                      accessibilityLabel={`Delete ${category.name}`}
                    >
                      <Ionicons name="trash-outline" size={18} color={theme.expense} />
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        </View>

        {/* Data & Logs Section */}
        <Text style={[styles.sectionTitle, { color: theme.textMuted }, captionScale]}>DATA & SYSTEM</Text>
        <View style={[styles.sectionCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Ionicons name="finger-print-outline" size={18} color={theme.primary} />
              <View>
                <Text style={[styles.rowText, { color: theme.text }, textScale]}>App Lock</Text>
                <Text style={[styles.rowSubText, { color: theme.textMuted }, captionScale]}>Fingerprint, face or phone PIN to open Silo</Text>
              </View>
            </View>
            <Switch
              value={appLockEnabled}
              onValueChange={(next) => void handleAppLockToggle(next)}
              trackColor={switchTrackColor}
              thumbColor={getSwitchThumbColor(appLockEnabled)}
              accessibilityLabel="App Lock"
            />
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <View style={styles.rowWithSecondary}>
            <TouchableOpacity
              style={styles.rowPrimaryArea}
              onPress={handleExportCSV}
              disabled={isExporting}
              accessibilityRole="button"
              accessibilityLabel="Export Transactions CSV"
            >
              <View style={styles.rowLeft}>
                <Ionicons name="download-outline" size={18} color={theme.primary} />
                <View style={styles.rowTextBlock}>
                  <Text style={[styles.rowText, { color: theme.text }, textScale]}>Export Transactions CSV</Text>
                  <Text style={[styles.rowSubText, { color: theme.textMuted }, captionScale]}>
                    Save a CSV file directly to a folder on this device
                  </Text>
                </View>
              </View>
              {isExporting ? <ActivityIndicator color={theme.primary} /> : <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.secondaryIconBtn, { borderLeftColor: theme.border }]}
              onPress={() => void handleShareCSV()}
              disabled={isExporting}
              accessibilityRole="button"
              accessibilityLabel="Share Transactions CSV"
            >
              <Ionicons name="share-outline" size={18} color={theme.primary} />
            </TouchableOpacity>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <View style={styles.rowWithSecondary}>
            <TouchableOpacity
              style={styles.rowPrimaryArea}
              onPress={handleBackup}
              disabled={isBackingUp}
              accessibilityRole="button"
              accessibilityLabel="Back Up All Data"
            >
              <View style={styles.rowLeft}>
                <Ionicons name="cloud-upload-outline" size={18} color={theme.primary} />
                <View style={styles.rowTextBlock}>
                  <Text style={[styles.rowText, { color: theme.text }, textScale]}>Back Up All Data</Text>
                  <Text style={[styles.rowSubText, { color: theme.textMuted }, captionScale]}>
                    Save a backup file directly to a folder on this device
                  </Text>
                </View>
              </View>
              {isBackingUp ? <ActivityIndicator color={theme.primary} /> : <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.secondaryIconBtn, { borderLeftColor: theme.border }]}
              onPress={() => void handleShareBackupFile()}
              disabled={isBackingUp}
              accessibilityRole="button"
              accessibilityLabel="Share backup file"
            >
              <Ionicons name="share-outline" size={18} color={theme.primary} />
            </TouchableOpacity>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <TouchableOpacity
            style={styles.row}
            onPress={handleRestore}
            disabled={isBackingUp}
            accessibilityRole="button"
            accessibilityLabel="Restore From Backup"
          >
            <View style={styles.rowLeft}>
              <Ionicons name="cloud-download-outline" size={18} color={theme.primary} />
              <View style={styles.rowTextBlock}>
                <Text style={[styles.rowText, { color: theme.text }, textScale]}>Restore From Backup</Text>
                <Text style={[styles.rowSubText, { color: theme.textMuted }, captionScale]}>
                  Pick a Silo backup (.db) file to replace local data
                </Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
          </TouchableOpacity>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <TouchableOpacity
            style={styles.row}
            onPress={() => navigation.navigate('SystemLogs')}
            accessibilityRole="button"
            accessibilityLabel="System Logs & Diagnostics"
          >
            <View style={styles.rowLeft}>
              <Ionicons name="terminal-outline" size={18} color={theme.primary} />
              <Text style={[styles.rowText, { color: theme.text }, textScale]}>System Logs & Diagnostics</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
          </TouchableOpacity>
        </View>

        {/* About Section */}
        <Text style={[styles.sectionTitle, { color: theme.textMuted }, captionScale]}>ABOUT</Text>
        <View style={[styles.sectionCard, styles.aboutCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Image
            source={require('../../assets/icon.png')}
            style={styles.aboutIcon}
            resizeMode="cover"
            accessibilityRole="image"
            accessibilityLabel="Silo app icon"
          />
          <Text style={[styles.aboutAppName, { color: theme.text, fontSize: theme.scaleFont(18) }]}>Silo</Text>
          <Text style={[styles.aboutVersion, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>
            Version {appConfig.expo.version}
          </Text>
          <Text style={[styles.aboutAuthor, { color: theme.primary, fontSize: theme.scaleFont(13) }]}>Made by CDev</Text>
        </View>
      </ScrollView>

      {/* Month Start Day Picker Modal */}
      <Modal
        visible={monthStartModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMonthStartModalVisible(false)}
      >
        <TouchableOpacity
          style={[styles.modalOverlay, { backgroundColor: 'rgba(0,0,0,0.55)' }, getModalOverlayInsetStyle(insets, 20)]}
          activeOpacity={1}
          onPress={() => setMonthStartModalVisible(false)}
        >
          <TouchableOpacity
            activeOpacity={1}
            onPress={(event) => event.stopPropagation()}
            style={[styles.modalCard, { backgroundColor: theme.surface, borderColor: theme.border }]}
          >
            <View style={styles.dayModalHeader}>
              <View style={styles.rowTextBlock}>
                <Text style={[styles.modalTitle, { color: theme.text }, headingScale]}>Month starts on day</Text>
                <Text style={[styles.dayModalHint, { color: theme.textMuted }, captionScale]}>
                  Choose day 1–28 (e.g. payday on day 25)
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setMonthStartModalVisible(false)}
                style={styles.modalCloseBtn}
                accessibilityRole="button"
                accessibilityLabel="Close month start day picker"
              >
                <Ionicons name="close" size={20} color={theme.textMuted} />
              </TouchableOpacity>
            </View>

            <View style={styles.dayGrid}>
              {MONTH_START_DAYS.map((day) => {
                const isSelected = monthStartDay === day;
                return (
                  <TouchableOpacity
                    key={day}
                    style={[
                      styles.dayGridBtn,
                      {
                        backgroundColor: isSelected ? theme.primary : theme.background,
                        borderColor: isSelected ? theme.primary : theme.border,
                      },
                    ]}
                    onPress={() => {
                      void setMonthStartDay(day);
                      setMonthStartModalVisible(false);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Month start day ${day}`}
                    accessibilityState={{ selected: isSelected }}
                  >
                    <Text
                      style={[
                        styles.dayGridBtnText,
                        { color: isSelected ? theme.onPrimary : theme.text, fontSize: theme.scaleFont(13) },
                      ]}
                    >
                      {day}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {showReminderTimePicker ? (
        <DateTimePicker
          value={reminderTimeToDate(dailyReminderTime)}
          mode="time"
          is24Hour
          display="default"
          accentColor={theme.primary}
          onChange={(event, picked) => {
            void handleReminderTimeChange(event, picked);
          }}
        />
      ) : null}

      {/* Add / Edit Category Modal */}
      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={closeModal}>
        <KeyboardAvoidingView
          style={styles.keyboardShell}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <TouchableOpacity
            style={[styles.modalOverlay, { backgroundColor: 'rgba(0,0,0,0.55)' }, getModalOverlayInsetStyle(insets, 20)]}
            activeOpacity={1}
            onPress={closeModal}
          >
            <TouchableOpacity
              activeOpacity={1}
              onPress={(event) => event.stopPropagation()}
              style={[styles.modalCard, { backgroundColor: theme.surface, borderColor: theme.border }]}
            >
              <Text style={[styles.modalTitle, { color: theme.text }, headingScale]}>
                {editingCategory ? 'Edit Category' : 'Add Category'}
              </Text>
              <Text
                style={[
                  styles.modalSubtitle,
                  { color: categoryType === 'expense' ? theme.expense : theme.income },
                  captionScale,
                ]}
              >
                {categoryType === 'expense' ? 'Expense' : 'Income'} category
              </Text>

              <TextInput
                style={[styles.modalInput, { backgroundColor: theme.background, borderColor: theme.border, color: theme.text }, textScale]}
                placeholder="Category name"
                placeholderTextColor={theme.textMuted}
                value={categoryDraft}
                onChangeText={setCategoryDraft}
                autoFocus
              />

              <View style={styles.modalActions}>
                <TouchableOpacity
                  style={[styles.modalSecondaryBtn, { borderColor: theme.border, backgroundColor: theme.background }]}
                  onPress={closeModal}
                  accessibilityRole="button"
                >
                  <Text style={[styles.modalSecondaryText, { color: theme.textMuted }, textScale]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalPrimaryBtn, { backgroundColor: theme.primary }]}
                  onPress={handleSaveCategory}
                  accessibilityRole="button"
                >
                  <Text style={[styles.modalPrimaryText, textScale]}>{editingCategory ? 'Save' : 'Create'}</Text>
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  keyboardShell: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 56,
    borderBottomWidth: 1,
    gap: 6,
  },
  headerTitle: { flex: 1, fontWeight: '700' },
  backButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 28 },
  sectionTitle: {
    fontWeight: '800',
    letterSpacing: 0.6,
    marginBottom: 8,
    marginLeft: 4,
    marginTop: 14,
  },
  sectionCard: { borderRadius: 18, borderWidth: 1, overflow: 'hidden', marginBottom: 6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 56,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowWithSecondary: {
    flexDirection: 'row',
    alignItems: 'stretch',
    minHeight: 56,
  },
  rowPrimaryArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 14,
    paddingRight: 10,
    paddingVertical: 12,
  },
  secondaryIconBtn: {
    width: 48,
    minHeight: 48,
    borderLeftWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  rowTextBlock: { flex: 1 },
  rowValueRight: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 8 },
  rowSubText: { marginTop: 2, marginLeft: 10 },
  rowText: { marginLeft: 10, fontWeight: '600' },
  reminderNoticeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  reminderNoticeIcon: { marginRight: 8, marginTop: 1 },
  reminderNoticeText: { flex: 1, lineHeight: 17 },
  divider: { height: 1, marginLeft: 44 },
  rowBlock: { paddingHorizontal: 14, paddingVertical: 12 },
  rowBlockHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  segmentedRow: { flexDirection: 'row', gap: 6 },
  segmentBtn: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  segmentBtnText: { fontSize: 13, fontWeight: '700' },
  optionRowCompact: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  optionChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minHeight: 44,
    justifyContent: 'center',
  },
  optionChipText: { fontWeight: '700', fontSize: 12 },
  inlineValue: { fontWeight: '700' },
  cardSectionHeading: { fontWeight: '700', marginBottom: 8 },
  modelCard: { borderWidth: 1, borderRadius: 16, padding: 14, marginTop: 4 },
  modelCardHeader: {
    flexDirection: 'column',
    gap: 8,
    marginBottom: 8,
  },
  modelCardTitleWrap: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  modelTitleCopy: { flex: 1, minWidth: 0 },
  modelBadgeIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modelName: { fontSize: 15, fontWeight: '800', flexShrink: 1 },
  modelSpec: { fontSize: 11, marginTop: 2, flexShrink: 1 },
  statusPillRow: { flexDirection: 'row', alignItems: 'center' },
  statusPill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start' },
  statusPillText: { fontSize: 11, fontWeight: '700' },
  modelDesc: { fontSize: 12, lineHeight: 18, marginBottom: 12 },
  downloadProgressWrap: { marginVertical: 8 },
  downloadTrack: { height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 6 },
  downloadFill: { height: '100%', borderRadius: 4 },
  downloadMetaRow: { flexDirection: 'row', justifyContent: 'space-between' },
  downloadMetaText: { fontSize: 11, fontWeight: '600' },
  verifyingProgressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginVertical: 8,
  },
  verifyingProgressText: { flex: 1, fontWeight: '600' },
  modelErrorText: { fontSize: 12, fontWeight: '600', marginBottom: 8 },
  modelActionsRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  modelActionButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  modelActionText: { fontSize: 13, fontWeight: '800' },
  modelSecondaryActionButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  modelSecondaryActionText: { fontSize: 13, fontWeight: '800' },
  inputLabel: { fontSize: 12, fontWeight: '700', marginTop: 10, marginBottom: 4 },
  formInput: { minHeight: 46, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 14 },
  apiKeyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 46,
    borderWidth: 1,
    borderRadius: 12,
    paddingLeft: 12,
    paddingRight: 4,
  },
  apiKeyInput: { flex: 1, minHeight: 44, fontSize: 14 },
  apiKeyEyeBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  externalApiFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
    gap: 10,
  },
  autoSaveHint: { flex: 1, fontWeight: '500' },
  testConnectionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 12,
    minHeight: 44,
    paddingHorizontal: 14,
  },
  testConnectionText: { fontWeight: '700' },
  connectionResultText: { marginTop: 8, fontWeight: '600', lineHeight: 17 },
  categorySplitWrap: { marginBottom: 6 },
  categoryColumnCard: { borderWidth: 1, borderRadius: 18, padding: 14 },
  categoryColumnHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 10,
  },
  categoryEyebrow: { fontWeight: '800', letterSpacing: 0.6, fontSize: 11, marginBottom: 2 },
  categoryHeading: { fontWeight: '700', fontSize: 15 },
  roundAddBtn: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  categoryPillRow: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  categoryPillLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  categoryPillText: { fontWeight: '600', fontSize: 14 },
  badgeText: { fontSize: 10, fontWeight: '700' },
  categoryActions: { flexDirection: 'row', alignItems: 'center' },
  iconActionBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  modalOverlay: { flex: 1, justifyContent: 'center', padding: 20 },
  modalCard: { borderWidth: 1, borderRadius: 20, padding: 18 },
  modalTitle: { fontWeight: '800', marginBottom: 2 },
  dayModalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  dayModalHint: { marginTop: 2 },
  modalCloseBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  dayGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-start' },
  dayGridBtn: {
    width: '17.5%',
    minWidth: 44,
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayGridBtnText: { fontSize: 13, fontWeight: '700' },
  modalSubtitle: { fontWeight: '700', marginBottom: 14 },
  modalInput: { minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14 },
  modalActions: { flexDirection: 'row', marginTop: 16, gap: 8 },
  modalSecondaryBtn: { flex: 1, minHeight: 46, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  modalPrimaryBtn: { flex: 1.2, minHeight: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  modalSecondaryText: { fontWeight: '700' },
  modalPrimaryText: { fontWeight: '800' },
  aboutCard: {
    alignItems: 'center',
    paddingVertical: 20,
    paddingHorizontal: 16,
  },
  aboutIcon: {
    width: 56,
    height: 56,
    borderRadius: 14,
    marginBottom: 10,
  },
  aboutAppName: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 2,
  },
  aboutVersion: {
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 6,
  },
  aboutAuthor: {
    fontSize: 13,
    fontWeight: '600',
  },
});
