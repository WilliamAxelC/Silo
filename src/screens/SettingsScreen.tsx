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
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

import { documentDirectory, writeAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import { isAvailableAsync, shareAsync } from 'expo-sharing';

import { NavigationProps } from '../navigation/types';
import { useSettingsStore } from '../store/useSettingsStore';
import { getAIRuntimeAvailability, getProvisioningStatusLabel, useAIStore } from '../store/useAIStore';
import { useTransactionStore } from '../store/useTransactionStore';
import { useAppTheme } from '../theme/useAppTheme';
import type { CategoryRecord, CategoryType, ThemeMode, ExternalAPIProvider } from '../features/transactions/types';
import { EXTERNAL_API_PRESETS, MODEL_CATALOG } from '../features/transactions/constants';
import { getModelLifecycleManager, checkModelExists } from '../services/ai/modelLifecycle';
import { getErrorMessage } from '../services/ai/localInferenceTypes';

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

export const SettingsScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const theme = useAppTheme();

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
  const ocrEngineId = useSettingsStore((s) => s.ocrEngineId);

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
  const setOcrEngineId = useSettingsStore((s) => s.setOcrEngineId);
  const setAiWifiOnlyDownload = useSettingsStore((s) => s.setAiWifiOnlyDownload);

  const { provisioning, localModelDisplayName, runtime, runtimeReady, warmupPending, logs } = useAIStore();
  const { transactionsList, categories, addCategory, renameCategory, deleteCategory, getCategoriesByType } =
    useTransactionStore();

  const [isExporting, setIsExporting] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [categoryDraft, setCategoryDraft] = useState('');
  const [categoryType, setCategoryType] = useState<CategoryType>('expense');
  const [editingCategory, setEditingCategory] = useState<CategoryRecord | null>(null);
  const [isAiActionLoading, setIsAiActionLoading] = useState(false);
  const [downloadedModels, setDownloadedModels] = useState<Record<string, boolean>>({});

  React.useEffect(() => {
    const checkModels = async () => {
      const results: Record<string, boolean> = {};
      for (const modelId of Object.keys(MODEL_CATALOG)) {
        const preset = MODEL_CATALOG[modelId];
        results[modelId] = await checkModelExists(preset.fileName, 'v1');
      }
      setDownloadedModels(results);
    };
    checkModels();
  }, [provisioning.status]);

  const expenseCategories = useMemo(() => getCategoriesByType('expense'), [categories, getCategoriesByType]);
  const incomeCategories = useMemo(() => getCategoriesByType('income'), [categories, getCategoriesByType]);
  const textScale = useMemo(() => ({ fontSize: 14 * fontScale }), [fontScale]);
  const captionScale = useMemo(() => ({ fontSize: 12 * fontScale }), [fontScale]);
  const headingScale = useMemo(() => ({ fontSize: 17 * fontScale }), [fontScale]);

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
    getAIRuntimeAvailability({ provisioning, runtimeReady, warmupPending, runtime });
  const canStartOrRetryProvisioning =
    hasUsableLocalInferenceBackend && ['failed', 'not-installed', 'update-available'].includes(provisioning.status);
  const isDownloading = provisioning.status === 'downloading' || provisioning.status === 'queued';

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

  const handleExportCSV = async () => {
    try {
      setIsExporting(true);

      if (!transactionsList || transactionsList.length === 0) {
        Alert.alert('No Data', "You don't have any transactions to export yet.");
        setIsExporting(false);
        return;
      }

      const headers = ['Date', 'Merchant Name', 'Category', 'Amount', 'Type', 'Description', 'Receipt Items'];
      let csvString = headers.join(',') + '\n';

      transactionsList.forEach((tx) => {
        const dateStr = new Date(tx.date).toLocaleDateString(dateFormat || 'en-GB', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        });
        const merchant = `"${(tx.merchantName || '').replace(/"/g, '""')}"`;
        const category = `"${(tx.category || '').replace(/"/g, '""')}"`;
        const lineItemsText = `"${(tx.lineItemsText || '').replace(/"/g, '""')}"`;
        const note = `"${(tx.note || '').replace(/"/g, '""')}"`;
        const type = (tx.totalAmount || 0) > 0 ? 'Income' : 'Expense';

        csvString += `${dateStr},${merchant},${category},${tx.totalAmount},${type},${note},${lineItemsText}\n`;
      });

      const fileName = `Silo_Transactions_${new Date().toISOString().split('T')[0]}.csv`;
      const fileUri = `${documentDirectory}${fileName}`;

      await writeAsStringAsync(fileUri, csvString, {
        encoding: EncodingType.UTF8,
      });

      const isAvailable = await isAvailableAsync();
      if (isAvailable) {
        await shareAsync(fileUri, {
          mimeType: 'text/csv',
          dialogTitle: 'Export Silo Transactions',
          UTI: 'public.comma-separated-values-text',
        });
      } else {
        Alert.alert('Error', 'Sharing is not supported on this device.');
      }
    } catch (error) {
      console.error('Export failed:', error);
      Alert.alert('Export Failed', 'An error occurred while generating your CSV file.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleAiInstallOrRetry = async () => {
    setIsAiActionLoading(true);
    try {
      const manager = getModelLifecycleManager();
      await manager.retryProvisioning();
    } catch (error) {
      Alert.alert('AI Setup', getErrorMessage(error, 'Unable to continue model setup.'));
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
      'Are you sure you want to delete the offline Qwen model weights (~1.5GB)? You will need to download them again to use on-device AI.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Weights',
          style: 'destructive',
          onPress: async () => {
            setIsAiActionLoading(true);
            try {
              const manager = getModelLifecycleManager() as any;
              if (typeof manager.deleteInstalledModel === 'function') {
                await manager.deleteInstalledModel();
              }
              const results: Record<string, boolean> = {};
              for (const modelId of Object.keys(MODEL_CATALOG)) {
                results[modelId] = false;
              }
              setDownloadedModels(results);
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

  const isQwenDownloaded = downloadedModels['qwen3.5-2b'] || provisioning.status === 'ready';

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
        <View style={styles.headerCopy}>
          <Text style={[styles.headerEyebrow, { color: theme.textMuted }, captionScale]}>Preferences</Text>
          <Text style={[styles.headerTitle, { color: theme.text }, headingScale]}>Settings</Text>
        </View>
        <View style={styles.headerSpacer} />
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
                      color={isSelected ? '#fff' : theme.textMuted}
                      style={{ marginRight: 6 }}
                    />
                    <Text style={[styles.segmentBtnText, { color: isSelected ? '#fff' : theme.text }]}>
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
                  >
                    <Text style={[styles.optionChipText, { color: isSelected ? '#fff' : theme.text }]}>
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
                    onPress={() => setCurrencyCode(option)}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.optionChipText, { color: isSelected ? '#fff' : theme.text }]}>{option}</Text>
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
                  >
                    <Text style={[styles.optionChipText, { color: isSelected ? '#fff' : theme.text }]}>
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
              trackColor={{ false: '#767577', true: theme.primary }}
            />
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          {/* Income first in reports Toggle */}
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Ionicons name="swap-vertical-outline" size={18} color={theme.primary} />
              <Text style={[styles.rowText, { color: theme.text }, textScale]}>Show income first in reports</Text>
            </View>
            <Switch
              value={showIncomeInReportsFirst}
              onValueChange={setShowIncomeInReportsFirst}
              trackColor={{ false: '#767577', true: theme.primary }}
            />
          </View>
        </View>

        {/* AI & Receipt Scanning Section */}
        <Text style={[styles.sectionTitle, { color: theme.textMuted }, captionScale]}>AI & INFERENCE ENGINE</Text>
        <View style={[styles.sectionCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          {/* Inference Mode Toggle (On-Device vs External API) */}
          <View style={styles.rowBlock}>
            <View style={styles.rowBlockHeader}>
              <View style={styles.rowLeft}>
                <Ionicons name="hardware-chip-outline" size={18} color={theme.primary} />
                <Text style={[styles.rowText, { color: theme.text }, textScale]}>AI Inference Engine</Text>
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
              >
                <Ionicons
                  name="phone-portrait-outline"
                  size={16}
                  color={aiInferenceMode === 'local' ? '#fff' : theme.textMuted}
                  style={{ marginRight: 6 }}
                />
                <Text style={[styles.segmentBtnText, { color: aiInferenceMode === 'local' ? '#fff' : theme.text }]}>
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
              >
                <Ionicons
                  name="cloud-outline"
                  size={16}
                  color={aiInferenceMode === 'external' ? '#fff' : theme.textMuted}
                  style={{ marginRight: 6 }}
                />
                <Text style={[styles.segmentBtnText, { color: aiInferenceMode === 'external' ? '#fff' : theme.text }]}>
                  External API
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          {aiInferenceMode === 'local' ? (
            /* Offline Model Card */
            <View style={styles.rowBlock}>
              <Text style={[styles.cardSectionHeading, { color: theme.text }, textScale]}>Offline Model Package</Text>
              <View
                style={[
                  styles.modelCard,
                  {
                    backgroundColor: theme.background,
                    borderColor: isQwenDownloaded ? theme.income : theme.border,
                  },
                ]}
              >
                <View style={styles.modelCardHeader}>
                  <View style={styles.modelCardTitleWrap}>
                    <View style={[styles.modelBadgeIcon, { backgroundColor: theme.primaryMuted }]}>
                      <Ionicons name="hardware-chip" size={18} color={theme.primary} />
                    </View>
                    <View>
                      <Text style={[styles.modelName, { color: theme.text }]}>Qwen 3.5 2B (GGUF)</Text>
                      <Text style={[styles.modelSpec, { color: theme.textMuted }]}>
                        ~1.5 GB · 2GB RAM required · 3GB recommended
                      </Text>
                    </View>
                  </View>

                  <View
                    style={[
                      styles.statusPill,
                      {
                        backgroundColor: isQwenDownloaded
                          ? theme.incomeMuted
                          : isDownloading
                          ? theme.primaryMuted
                          : theme.surface,
                        borderColor: isQwenDownloaded ? theme.income : theme.border,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusPillText,
                        {
                          color: isQwenDownloaded ? theme.income : isDownloading ? theme.primary : theme.textMuted,
                        },
                      ]}
                    >
                      {isQwenDownloaded
                        ? 'Installed'
                        : isDownloading
                        ? `Downloading (${progressPercent}%)`
                        : 'Not Installed'}
                    </Text>
                  </View>
                </View>

                <Text style={[styles.modelDesc, { color: theme.textMuted }]}>
                  High-performance quantized edge language model. Runs 100% locally on Android without internet connection.
                </Text>

                {/* Progress bar if downloading */}
                {isDownloading && (
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
                      <Text style={[styles.downloadMetaText, { color: theme.textMuted }]}>
                        {progressPercent}% completed
                      </Text>
                      {throughputLabel && (
                        <Text style={[styles.downloadMetaText, { color: theme.primary }]}>
                          Speed: {throughputLabel}
                        </Text>
                      )}
                    </View>
                  </View>
                )}

                {/* Model Action Buttons */}
                <View style={styles.modelActionsRow}>
                  {!isQwenDownloaded && !isDownloading && (
                    <TouchableOpacity
                      style={[styles.modelActionButton, { backgroundColor: theme.primary }]}
                      onPress={handleAiInstallOrRetry}
                      disabled={isAiActionLoading}
                      accessibilityRole="button"
                    >
                      {isAiActionLoading ? (
                        <ActivityIndicator color="#fff" size="small" />
                      ) : (
                        <>
                          <Ionicons name="download-outline" size={16} color="#fff" style={{ marginRight: 6 }} />
                          <Text style={styles.modelActionText}>Download Model</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  )}

                  {isDownloading && (
                    <TouchableOpacity
                      style={[styles.modelActionButton, { backgroundColor: theme.expense }]}
                      onPress={handleAiCancel}
                      disabled={isAiActionLoading}
                      accessibilityRole="button"
                    >
                      <Ionicons name="close-circle-outline" size={16} color="#fff" style={{ marginRight: 6 }} />
                      <Text style={styles.modelActionText}>Cancel Download</Text>
                    </TouchableOpacity>
                  )}

                  {isQwenDownloaded && !isDownloading && (
                    <TouchableOpacity
                      style={[styles.modelSecondaryActionButton, { borderColor: theme.expense }]}
                      onPress={handleAiDelete}
                      disabled={isAiActionLoading}
                      accessibilityRole="button"
                    >
                      <Ionicons name="trash-outline" size={16} color={theme.expense} style={{ marginRight: 6 }} />
                      <Text style={[styles.modelSecondaryActionText, { color: theme.expense }]}>Delete Weights</Text>
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
                  trackColor={{ false: '#767577', true: theme.primary }}
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
                        const preset = EXTERNAL_API_PRESETS[providerKey];
                        if (preset) {
                          setExternalApiUrl(preset.url);
                          setExternalApiModel(preset.model);
                        }
                      }}
                      accessibilityRole="button"
                    >
                      <Text style={[styles.optionChipText, { color: isSelected ? '#fff' : theme.text }]}>
                        {preset.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={[styles.inputLabel, { color: theme.textMuted }]}>Endpoint Base URL</Text>
              <TextInput
                style={[
                  styles.formInput,
                  { backgroundColor: theme.background, borderColor: theme.border, color: theme.text },
                ]}
                placeholder="https://api.openai.com/v1"
                placeholderTextColor={theme.textMuted}
                value={externalApiUrl}
                onChangeText={setExternalApiUrl}
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={[styles.inputLabel, { color: theme.textMuted }]}>Model Identifier</Text>
              <TextInput
                style={[
                  styles.formInput,
                  { backgroundColor: theme.background, borderColor: theme.border, color: theme.text },
                ]}
                placeholder="gpt-4o-mini"
                placeholderTextColor={theme.textMuted}
                value={externalApiModel}
                onChangeText={setExternalApiModel}
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={[styles.inputLabel, { color: theme.textMuted }]}>
                API Key (Optional for local Ollama)
              </Text>
              <TextInput
                style={[
                  styles.formInput,
                  { backgroundColor: theme.background, borderColor: theme.border, color: theme.text },
                ]}
                placeholder="sk-..."
                placeholderTextColor={theme.textMuted}
                value={externalApiKey}
                onChangeText={setExternalApiKey}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          )}

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          {/* OCR Engine Selector */}
          <View style={styles.rowBlock}>
            <Text style={[styles.cardSectionHeading, { color: theme.text }, textScale]}>Receipt OCR Engine</Text>
            <View style={[styles.optionRowCompact, { marginTop: 6 }]}>
              {(['mlkit', 'paddleocr', 'external'] as const).map((engine) => {
                const isSelected = ocrEngineId === engine;
                const label = engine === 'mlkit' ? 'ML Kit (Google On-Device)' : engine === 'paddleocr' ? 'PaddleOCR' : 'External OCR';
                return (
                  <TouchableOpacity
                    key={engine}
                    style={[
                      styles.optionChip,
                      {
                        backgroundColor: isSelected ? theme.primary : theme.background,
                        borderColor: isSelected ? theme.primary : theme.border,
                      },
                    ]}
                    onPress={() => setOcrEngineId(engine)}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.optionChipText, { color: isSelected ? '#fff' : theme.text }]}>{label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </View>

        {/* Categories Section */}
        <Text style={[styles.sectionTitle, { color: theme.textMuted }, captionScale]}>CATEGORIES</Text>
        <View style={styles.categorySplitWrap}>
          {/* Expense Categories */}
          <View style={[styles.categoryColumnCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <View style={styles.categoryColumnHeader}>
              <View>
                <Text style={[styles.categoryEyebrow, { color: theme.expense }]}>EXPENSE</Text>
                <Text style={[styles.categoryHeading, { color: theme.text }]}>
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
                  <Text style={[styles.categoryPillText, { color: theme.text }]}>{category.name}</Text>
                  {category.isSystem && (
                    <Text style={[styles.badgeText, { color: theme.textMuted }]}>Default</Text>
                  )}
                </View>
                <View style={styles.categoryActions}>
                  <TouchableOpacity
                    onPress={() => openEditCategoryModal(category)}
                    style={styles.iconActionBtn}
                    accessibilityRole="button"
                    accessibilityLabel={`Edit ${category.name}`}
                  >
                    <Ionicons name="create-outline" size={18} color={theme.textMuted} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => handleDeleteCategory(category)}
                    style={styles.iconActionBtn}
                    accessibilityRole="button"
                    accessibilityLabel={`Delete ${category.name}`}
                  >
                    <Ionicons name="trash-outline" size={18} color={theme.expense} />
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>

          {/* Income Categories */}
          <View style={[styles.categoryColumnCard, { backgroundColor: theme.surface, borderColor: theme.border, marginTop: 10 }]}>
            <View style={styles.categoryColumnHeader}>
              <View>
                <Text style={[styles.categoryEyebrow, { color: theme.income }]}>INCOME</Text>
                <Text style={[styles.categoryHeading, { color: theme.text }]}>
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
                  <Text style={[styles.categoryPillText, { color: theme.text }]}>{category.name}</Text>
                  {category.isSystem && (
                    <Text style={[styles.badgeText, { color: theme.textMuted }]}>Default</Text>
                  )}
                </View>
                <View style={styles.categoryActions}>
                  <TouchableOpacity
                    onPress={() => openEditCategoryModal(category)}
                    style={styles.iconActionBtn}
                    accessibilityRole="button"
                    accessibilityLabel={`Edit ${category.name}`}
                  >
                    <Ionicons name="create-outline" size={18} color={theme.textMuted} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => handleDeleteCategory(category)}
                    style={styles.iconActionBtn}
                    accessibilityRole="button"
                    accessibilityLabel={`Delete ${category.name}`}
                  >
                    <Ionicons name="trash-outline" size={18} color={theme.expense} />
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        </View>

        {/* Data & Logs Section */}
        <Text style={[styles.sectionTitle, { color: theme.textMuted }, captionScale]}>DATA & SYSTEM</Text>
        <View style={[styles.sectionCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <TouchableOpacity
            style={styles.row}
            onPress={handleExportCSV}
            disabled={isExporting}
            accessibilityRole="button"
          >
            <View style={styles.rowLeft}>
              <Ionicons name="download-outline" size={18} color={theme.primary} />
              <Text style={[styles.rowText, { color: theme.text }, textScale]}>Export Transactions CSV</Text>
            </View>
            {isExporting ? <ActivityIndicator color={theme.primary} /> : <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />}
          </TouchableOpacity>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <TouchableOpacity
            style={styles.row}
            onPress={() => navigation.navigate('SystemLogs')}
            accessibilityRole="button"
          >
            <View style={styles.rowLeft}>
              <Ionicons name="terminal-outline" size={18} color={theme.primary} />
              <Text style={[styles.rowText, { color: theme.text }, textScale]}>System Logs & Diagnostics</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* Add / Edit Category Modal */}
      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={closeModal}>
        <KeyboardAvoidingView
          style={styles.keyboardShell}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <TouchableOpacity style={[styles.modalOverlay, { backgroundColor: 'rgba(0,0,0,0.55)' }]} activeOpacity={1} onPress={closeModal}>
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
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 10,
    borderBottomWidth: 1,
  },
  headerCopy: { flex: 1, marginHorizontal: 8 },
  headerEyebrow: { fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 2 },
  headerTitle: { fontWeight: '700' },
  backButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerSpacer: { width: 44 },
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
  rowLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  rowText: { marginLeft: 10, fontWeight: '600' },
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
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 38,
    justifyContent: 'center',
  },
  optionChipText: { fontWeight: '700', fontSize: 12 },
  inlineValue: { fontWeight: '700' },
  cardSectionHeading: { fontWeight: '700', marginBottom: 8 },
  modelCard: { borderWidth: 1, borderRadius: 16, padding: 14, marginTop: 4 },
  modelCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  modelCardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, marginRight: 8 },
  modelBadgeIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modelName: { fontSize: 15, fontWeight: '800' },
  modelSpec: { fontSize: 11, marginTop: 2 },
  statusPill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  statusPillText: { fontSize: 11, fontWeight: '700' },
  modelDesc: { fontSize: 12, lineHeight: 18, marginBottom: 12 },
  downloadProgressWrap: { marginVertical: 8 },
  downloadTrack: { height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 6 },
  downloadFill: { height: '100%', borderRadius: 4 },
  downloadMetaRow: { flexDirection: 'row', justifyContent: 'space-between' },
  downloadMetaText: { fontSize: 11, fontWeight: '600' },
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
  modelActionText: { color: '#fff', fontSize: 13, fontWeight: '800' },
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
  iconActionBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  modalOverlay: { flex: 1, justifyContent: 'center', padding: 20 },
  modalCard: { borderWidth: 1, borderRadius: 20, padding: 18 },
  modalTitle: { fontWeight: '800', marginBottom: 2 },
  modalSubtitle: { fontWeight: '700', marginBottom: 14 },
  modalInput: { minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14 },
  modalActions: { flexDirection: 'row', marginTop: 16, gap: 8 },
  modalSecondaryBtn: { flex: 1, minHeight: 46, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  modalPrimaryBtn: { flex: 1.2, minHeight: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  modalSecondaryText: { fontWeight: '700' },
  modalPrimaryText: { fontWeight: '800', color: '#fff' },
});
