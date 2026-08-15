import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Switch, Alert, ActivityIndicator, Modal, TextInput } from 'react-native';
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

const THEME_OPTIONS: ThemeMode[] = ['system', 'light', 'dark'];
const CURRENCY_OPTIONS = ['IDR', 'USD', 'EUR'];
const DATE_FORMAT_OPTIONS = ['en-GB', 'en-US'];
const FONT_SCALE_OPTIONS = [0.95, 1, 1.12, 1.24];

export const SettingsScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const theme = useAppTheme();

  const themeMode = useSettingsStore(s => s.themeMode);
  const currencyCode = useSettingsStore(s => s.currencyCode);
  const useThousandsSeparator = useSettingsStore(s => s.useThousandsSeparator);
  const dateFormat = useSettingsStore(s => s.dateFormat);
  const showIncomeInReportsFirst = useSettingsStore(s => s.showIncomeInReportsFirst);
  const fontScale = useSettingsStore(s => s.fontScale);
  const aiInferenceMode = useSettingsStore(s => s.aiInferenceMode);
  const externalApiProvider = useSettingsStore(s => s.externalApiProvider);
  const externalApiUrl = useSettingsStore(s => s.externalApiUrl);
  const externalApiModel = useSettingsStore(s => s.externalApiModel);
  const externalApiKey = useSettingsStore(s => s.externalApiKey);
  const activeModelId = useSettingsStore(s => s.activeModelId);
  const aiWifiOnlyDownload = useSettingsStore(s => s.aiWifiOnlyDownload);
  const ocrEngineId = useSettingsStore(s => s.ocrEngineId);

  const setThemeMode = useSettingsStore(s => s.setThemeMode);
  const setCurrencyCode = useSettingsStore(s => s.setCurrencyCode);
  const setUseThousandsSeparator = useSettingsStore(s => s.setUseThousandsSeparator);
  const setDateFormat = useSettingsStore(s => s.setDateFormat);
  const setShowIncomeInReportsFirst = useSettingsStore(s => s.setShowIncomeInReportsFirst);
  const setFontScale = useSettingsStore(s => s.setFontScale);
  const setAiInferenceMode = useSettingsStore(s => s.setAiInferenceMode);
  const setExternalApiProvider = useSettingsStore(s => s.setExternalApiProvider);
  const setExternalApiUrl = useSettingsStore(s => s.setExternalApiUrl);
  const setExternalApiModel = useSettingsStore(s => s.setExternalApiModel);
  const setExternalApiKey = useSettingsStore(s => s.setExternalApiKey);
  const setActiveModelId = useSettingsStore(s => s.setActiveModelId);
  const setOcrEngineId = useSettingsStore(s => s.setOcrEngineId);
  const setAiWifiOnlyDownload = useSettingsStore(s => s.setAiWifiOnlyDownload);

  const {
    provisioning,
    localModelDisplayName,
    runtime,
    runtimeReady,
    warmupPending,
    logs,
  } = useAIStore();
  const {
    transactionsList,
    categories,
    addCategory,
    renameCategory,
    deleteCategory,
    getCategoriesByType,
  } = useTransactionStore();

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
  }, []);

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
  const {
    runtimePhaseActive,
    canRunNativeChat,
    hasUsableLocalInferenceBackend,
    localInferenceStatusMessage,
  } = getAIRuntimeAvailability({ provisioning, runtimeReady, warmupPending, runtime });
  const canStartOrRetryProvisioning = hasUsableLocalInferenceBackend && ['failed', 'not-installed', 'update-available'].includes(provisioning.status);
  const showPrimaryProvisionAction = hasUsableLocalInferenceBackend && canStartOrRetryProvisioning;

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
    Alert.alert('Delete Category', `Delete ${category.name}?`, [
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
        const dateStr = new Date(tx.date).toLocaleDateString(dateFormat, { day: '2-digit', month: '2-digit', year: 'numeric' });
        const merchant = `"${(tx.merchantName || '').replace(/"/g, '""')}"`;
        const category = `"${(tx.category || '').replace(/"/g, '""')}"`;
        const lineItemsText = `"${(tx.lineItemsText || '').replace(/"/g, '""')}"`;
        const note = `"${(tx.note || '').replace(/"/g, '""')}"`;
        const type = (tx.totalAmount || 0) > 0 ? 'Income' : 'Expense';

        csvString += `${dateStr},${merchant},${category},${tx.totalAmount},${type},${note},${lineItemsText}\n`;
      });

      const fileName = `Silo_Export_${new Date().toISOString().split('T')[0]}.csv`;
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

  const handleAiPrimaryAction = async () => {
    setIsAiActionLoading(true);
    try {
      const manager = getModelLifecycleManager();
      if (canStartOrRetryProvisioning) {
        await manager.retryProvisioning();
      }
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

  const latestLogs = logs.slice(0, 3);
  const verboseLogs = logs.slice(0, 12);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      <View style={[styles.header, { backgroundColor: theme.background }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={24} color={theme.text} />
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={[styles.headerEyebrow, { color: theme.textMuted }, captionScale]}>Preferences</Text>
          <Text style={[styles.headerTitle, { color: theme.text }, headingScale]}>Settings</Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: 132 }]} showsVerticalScrollIndicator={false}>
        <View style={[styles.heroCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Text style={[styles.heroTitle, { color: theme.text }, headingScale]}>Make Silo feel right for you</Text>
          <Text style={[styles.heroSubtitle, { color: theme.textMuted }, captionScale]}>Tidy controls for appearance, readability, categories, exports, and offline AI setup.</Text>
        </View>

        <Text style={[styles.sectionTitle, { color: theme.textMuted }, captionScale]}>Preferences</Text>
        <View style={[styles.sectionCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.rowBlock}>
            <View style={styles.rowBlockHeader}>
              <View style={styles.rowLeft}>
                <Ionicons name="color-palette-outline" size={18} color={theme.text} />
                <Text style={[styles.rowText, { color: theme.text }, textScale]}>Theme</Text>
              </View>
            </View>
            <View style={styles.optionRowCompact}>
              {THEME_OPTIONS.map((option) => (
                <TouchableOpacity
                  key={option}
                  style={[styles.optionChip, { borderColor: theme.border, backgroundColor: themeMode === option ? theme.primary : theme.background }]}
                  onPress={() => setThemeMode(option)}
                >
                  <Text style={[styles.optionChipText, { color: themeMode === option ? '#fff' : theme.textMuted }]}>{option}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <View style={styles.rowBlock}>
            <View style={styles.rowBlockHeader}>
              <View style={styles.rowLeft}>
                <Ionicons name="text-outline" size={18} color={theme.text} />
                <Text style={[styles.rowText, { color: theme.text }, textScale]}>Text size</Text>
              </View>
              <Text style={[styles.inlineValue, { color: theme.textMuted }, captionScale]}>{Math.round(fontScale * 100)}%</Text>
            </View>
            <Text style={[styles.helperText, { color: theme.textMuted }, captionScale]}>Increase readability across budget and settings surfaces.</Text>
            <View style={styles.optionRowCompact}>
              {FONT_SCALE_OPTIONS.map((option) => (
                <TouchableOpacity
                  key={option}
                  style={[styles.optionChip, { borderColor: theme.border, backgroundColor: fontScale === option ? theme.primary : theme.background }]}
                  onPress={() => setFontScale(option)}
                >
                  <Text style={[styles.optionChipText, { color: fontScale === option ? '#fff' : theme.textMuted }]}>{option === 1 ? 'Default' : `${Math.round(option * 100)}%`}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <View style={styles.rowBlock}>
            <View style={styles.rowBlockHeader}>
              <View style={styles.rowLeft}>
                <Ionicons name="cash-outline" size={18} color={theme.text} />
                <Text style={[styles.rowText, { color: theme.text }, textScale]}>Currency</Text>
              </View>
            </View>
            <View style={styles.optionRowCompact}>
              {CURRENCY_OPTIONS.map((option) => (
                <TouchableOpacity
                  key={option}
                  style={[styles.optionChip, { borderColor: theme.border, backgroundColor: currencyCode === option ? theme.primary : theme.background }]}
                  onPress={() => setCurrencyCode(option)}
                >
                  <Text style={[styles.optionChipText, { color: currencyCode === option ? '#fff' : theme.textMuted }]}>{option}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <View style={styles.rowBlock}>
            <View style={styles.rowBlockHeader}>
              <View style={styles.rowLeft}>
                <Ionicons name="calendar-outline" size={18} color={theme.text} />
                <Text style={[styles.rowText, { color: theme.text }, textScale]}>Date format</Text>
              </View>
            </View>
            <View style={styles.optionRowCompact}>
              {DATE_FORMAT_OPTIONS.map((option) => (
                <TouchableOpacity
                  key={option}
                  style={[styles.optionChip, { borderColor: theme.border, backgroundColor: dateFormat === option ? theme.primary : theme.background }]}
                  onPress={() => setDateFormat(option)}
                >
                  <Text style={[styles.optionChipText, { color: dateFormat === option ? '#fff' : theme.textMuted }]}>{option}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <View style={styles.row}>
            <View style={styles.rowContent}>
              <View style={styles.rowLeft}>
                <Ionicons name="reorder-three-outline" size={18} color={theme.text} />
                <Text style={[styles.rowText, { color: theme.text }, textScale]}>Thousands separator</Text>
              </View>
            </View>
            <Switch value={useThousandsSeparator} onValueChange={setUseThousandsSeparator} trackColor={{ false: '#767577', true: theme.primary }} />
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <View style={styles.rowFeatureCardWrap}>
            <View style={[styles.rowFeatureCard, { backgroundColor: theme.background, borderColor: theme.border }]}> 
              <View style={styles.rowFeatureHeader}>
                <View style={[styles.featureIconWrap, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
                  <Ionicons name="swap-vertical-outline" size={16} color={theme.primary} />
                </View>
                <View style={styles.featureCopy}>
                  <Text style={[styles.featureTitle, { color: theme.text }, textScale]}>Income first in reports</Text>
                  <Text style={[styles.featureSubtitle, { color: theme.textMuted }, captionScale]}>Shows income-focused report views before expense-focused views when both are available.</Text>
                </View>
                <Switch value={showIncomeInReportsFirst} onValueChange={setShowIncomeInReportsFirst} trackColor={{ false: '#767577', true: theme.primary }} />
              </View>
            </View>
          </View>
        </View>

        <Text style={[styles.sectionTitle, { color: theme.textMuted }, captionScale]}>Categories</Text>
        <View style={styles.categorySplitWrap}>
          <View style={[styles.categoryColumnCard, styles.categoryColumnLeft, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
            <View style={styles.categoryColumnHeader}>
              <View>
                <Text style={[styles.categoryEyebrow, { color: theme.expense }, captionScale]}>Expense</Text>
                <Text style={[styles.categoryHeading, { color: theme.text }, textScale]}>Spending categories</Text>
              </View>
              <TouchableOpacity style={[styles.roundAddBtn, { backgroundColor: theme.background, borderColor: theme.border }]} onPress={() => openAddCategoryModal('expense')}>
                <Ionicons name="add" size={18} color={theme.expense} />
              </TouchableOpacity>
            </View>
            <Text style={[styles.categoryColumnHint, { color: theme.textMuted }, captionScale]}>Used for expenses and budget planning.</Text>
            {expenseCategories.map((category) => (
              <View key={category.id} style={[styles.categoryPillRow, { borderColor: theme.border }]}> 
                <View style={styles.categoryPillLeft}>
                  <Text style={[styles.categoryPillText, { color: theme.text }, textScale]}>{category.name}</Text>
                  {category.isSystem ? <Text style={[styles.badgeText, { color: theme.textMuted }, captionScale]}>System</Text> : null}
                </View>
                <View style={styles.categoryActions}>
                  <TouchableOpacity onPress={() => openEditCategoryModal(category)} style={styles.iconActionBtn}>
                    <Ionicons name="create-outline" size={18} color={theme.textMuted} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => handleDeleteCategory(category)} style={styles.iconActionBtn}>
                    <Ionicons name="trash-outline" size={18} color={theme.expense} />
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>

          <View style={[styles.categoryColumnCard, styles.categoryColumnRight, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
            <View style={styles.categoryColumnHeader}>
              <View>
                <Text style={[styles.categoryEyebrow, { color: theme.income }, captionScale]}>Income</Text>
                <Text style={[styles.categoryHeading, { color: theme.text }, textScale]}>Earnings categories</Text>
              </View>
              <TouchableOpacity style={[styles.roundAddBtn, { backgroundColor: theme.background, borderColor: theme.border }]} onPress={() => openAddCategoryModal('income')}>
                <Ionicons name="add" size={18} color={theme.income} />
              </TouchableOpacity>
            </View>
            <Text style={[styles.categoryColumnHint, { color: theme.textMuted }, captionScale]}>Used for salary, freelance, and other income sources.</Text>
            {incomeCategories.map((category) => (
              <View key={category.id} style={[styles.categoryPillRow, { borderColor: theme.border }]}> 
                <View style={styles.categoryPillLeft}>
                  <Text style={[styles.categoryPillText, { color: theme.text }, textScale]}>{category.name}</Text>
                  {category.isSystem ? <Text style={[styles.badgeText, { color: theme.textMuted }, captionScale]}>System</Text> : null}
                </View>
                <View style={styles.categoryActions}>
                  <TouchableOpacity onPress={() => openEditCategoryModal(category)} style={styles.iconActionBtn}>
                    <Ionicons name="create-outline" size={18} color={theme.textMuted} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => handleDeleteCategory(category)} style={styles.iconActionBtn}>
                    <Ionicons name="trash-outline" size={18} color={theme.expense} />
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        </View>

        <Text style={[styles.sectionTitle, { color: theme.textMuted }, captionScale]}>Data</Text>
        <View style={[styles.sectionCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <TouchableOpacity style={styles.row} onPress={handleExportCSV} disabled={isExporting}>
            <View style={styles.rowLeft}>
              <Ionicons name="download-outline" size={18} color={theme.text} />
              <Text style={[styles.rowText, { color: theme.text }, textScale]}>Export CSV</Text>
            </View>
            {isExporting ? <ActivityIndicator color={theme.primary} /> : <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />}
          </TouchableOpacity>
        </View>

        <Text style={[styles.sectionTitle, { color: theme.textMuted }, captionScale]}>Receipt Scanning</Text>
        <View style={[styles.sectionCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.rowBlock}>
            <Text style={[styles.featureTitle, { color: theme.text }, textScale]}>OCR Engine</Text>
            <View style={[styles.optionRowCompact, { marginTop: 8 }]}>
              {(['mlkit', 'paddleocr', 'external'] as const).map((engine) => (
                <TouchableOpacity
                  key={engine}
                  style={[
                    styles.optionChip,
                    { marginBottom: 0, marginRight: 8 },
                    ocrEngineId === engine
                      ? { backgroundColor: theme.primary, borderColor: theme.primary }
                      : { backgroundColor: theme.background, borderColor: theme.border },
                  ]}
                  onPress={() => setOcrEngineId(engine)}
                >
                  <Text
                    style={[
                      styles.optionChipText,
                      { color: ocrEngineId === engine ? '#fff' : theme.textMuted },
                    ]}
                  >
                    {engine === 'mlkit' ? 'ML Kit (Google)' : engine === 'paddleocr' ? 'PaddleOCR' : 'External'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          <View style={[styles.divider, { backgroundColor: theme.border }]} />
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Ionicons name="camera-outline" size={18} color={theme.text} />
              <Text style={[styles.rowText, { color: theme.text }, textScale]}>Pipeline Mode</Text>
            </View>
            <Text style={[styles.subText, { color: theme.textMuted }, captionScale]}>OCR + Text LLM</Text>
          </View>
          <View style={[styles.divider, { backgroundColor: theme.border }]} />
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Ionicons name="images-outline" size={18} color={theme.textMuted} />
              <Text style={[styles.rowText, { color: theme.textMuted }, textScale]}>Multimodal Vision</Text>
            </View>
            <Text style={[styles.subText, { color: theme.textMuted }, captionScale]}>Coming Soon</Text>
          </View>
        </View>

        <Text style={[styles.sectionTitle, { color: theme.textMuted }, captionScale]}>AI Assistant</Text>
        <View style={[styles.sectionCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Ionicons name="git-network-outline" size={18} color={theme.text} />
              <Text style={[styles.rowText, { color: theme.text }, textScale]}>Inference Mode</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {(['local', 'external'] as const).map((mode) => (
                <TouchableOpacity
                  key={mode}
                  style={[
                    styles.optionChip,
                    { marginBottom: 0, marginRight: 0 },
                    aiInferenceMode === mode
                      ? { backgroundColor: theme.primary, borderColor: theme.primary }
                      : { backgroundColor: theme.background, borderColor: theme.border },
                  ]}
                  onPress={() => setAiInferenceMode(mode)}
                >
                  <Text
                    style={[
                      styles.optionChipText,
                      { color: aiInferenceMode === mode ? '#fff' : theme.textMuted },
                    ]}
                  >
                    {mode === 'local' ? 'On-Device' : 'External API'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          {aiInferenceMode === 'external' ? (
            <>
              <View style={styles.rowBlock}>
                <Text style={[styles.featureTitle, { color: theme.text }, textScale]}>API Provider Preset</Text>
                <View style={[styles.optionRowCompact, { marginTop: 8 }]}>
                  {(Object.keys(EXTERNAL_API_PRESETS) as ExternalAPIProvider[]).map((providerKey) => {
                    const preset = EXTERNAL_API_PRESETS[providerKey];
                    const isSelected = externalApiProvider === providerKey;
                    return (
                      <TouchableOpacity
                        key={providerKey}
                        style={[
                          styles.optionChip,
                          isSelected
                            ? { backgroundColor: theme.primary, borderColor: theme.primary }
                            : { backgroundColor: theme.background, borderColor: theme.border },
                        ]}
                        onPress={() => setExternalApiProvider(providerKey)}
                      >
                        <Text
                          style={[
                            styles.optionChipText,
                            { color: isSelected ? '#fff' : theme.text },
                          ]}
                        >
                          {preset.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
              <View style={styles.rowBlock}>
                <Text style={[styles.featureTitle, { color: theme.text }, textScale]}>Endpoint URL</Text>
                <TextInput
                  style={[styles.modalInput, { backgroundColor: theme.background, borderColor: theme.border, color: theme.text, marginTop: 6 }, textScale]}
                  placeholder="https://api.openai.com/v1"
                  placeholderTextColor={theme.textMuted}
                  value={externalApiUrl}
                  onChangeText={setExternalApiUrl}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
              <View style={styles.rowBlock}>
                <Text style={[styles.featureTitle, { color: theme.text }, textScale]}>Model Name</Text>
                <TextInput
                  style={[styles.modalInput, { backgroundColor: theme.background, borderColor: theme.border, color: theme.text, marginTop: 6 }, textScale]}
                  placeholder="gpt-4o-mini"
                  placeholderTextColor={theme.textMuted}
                  value={externalApiModel}
                  onChangeText={setExternalApiModel}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
              <View style={styles.rowBlock}>
                <Text style={[styles.featureTitle, { color: theme.text }, textScale]}>API Key (Optional for Ollama/Custom)</Text>
                <TextInput
                  style={[styles.modalInput, { backgroundColor: theme.background, borderColor: theme.border, color: theme.text, marginTop: 6 }, textScale]}
                  placeholder="sk-..."
                  placeholderTextColor={theme.textMuted}
                  value={externalApiKey}
                  onChangeText={setExternalApiKey}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
              <View style={styles.row}>
                <View style={styles.rowLeft}>
                  <Ionicons name="flash-outline" size={18} color={theme.text} />
                  <Text style={[styles.rowText, { color: theme.text }, textScale]}>Status</Text>
                </View>
                <Text style={[styles.subText, { color: canRunNativeChat ? theme.primary : theme.expense }, captionScale]}>
                  {canRunNativeChat ? 'Ready (External API)' : 'Missing URL or Model Name'}
                </Text>
              </View>
            </>
          ) : (
            <>
              <View style={styles.row}>
                <View style={styles.rowLeft}>
                  <Ionicons name="hardware-chip-outline" size={18} color={theme.text} />
                  <Text style={[styles.rowText, { color: theme.text }, textScale]}>Model</Text>
                </View>
                <Text style={[styles.statusText, { color: hasUsableLocalInferenceBackend && canRunNativeChat ? theme.primary : theme.textMuted }, captionScale]}>{localModelDisplayName}</Text>
              </View>
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
              <View style={styles.rowBlock}>
                <Text style={[styles.featureTitle, { color: theme.text }, textScale]}>Active Model</Text>
                <View style={{ marginTop: 8, flexDirection: 'column', gap: 10 }}>
                  {Object.keys(MODEL_CATALOG).map((modelId) => {
                    const preset = MODEL_CATALOG[modelId];
                    const isSelected = activeModelId === modelId;
                    const isDownloaded = downloadedModels[modelId];
                    const reqRamGB = Math.round(preset.requiredRamBytes / (1024 * 1024 * 1024) * 10) / 10;
                    const recRamGB = Math.round(preset.recommendedRamBytes / (1024 * 1024 * 1024) * 10) / 10;
                    const sizeGB = Math.round((preset.fileSizeBytes / (1024 * 1024 * 1024)) * 10) / 10;
                    return (
                      <TouchableOpacity
                        key={modelId}
                        style={[
                          { borderWidth: 1, borderRadius: 12, padding: 12 },
                          isSelected
                            ? { backgroundColor: theme.primary + '11', borderColor: theme.primary }
                            : { backgroundColor: theme.background, borderColor: theme.border },
                        ]}
                        onPress={() => setActiveModelId(modelId)}
                      >
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                          <Text style={[{ fontWeight: '700' }, textScale, { color: isSelected ? theme.primary : theme.text }]}>
                            {preset.displayName} {isDownloaded && !isSelected ? '✓ (Downloaded)' : ''}
                          </Text>
                          <Text style={[{ fontWeight: '600' }, captionScale, { color: theme.textMuted }]}>
                            ~{sizeGB} GB
                          </Text>
                        </View>
                        <Text style={[{ color: theme.textMuted, marginBottom: 4 }, captionScale]}>
                          {preset.description}
                        </Text>
                        <Text style={[{ color: theme.text, fontWeight: '600' }, captionScale]}>
                          Capabilities: {preset.capabilities.join(', ')}
                        </Text>
                        <Text style={[{ color: theme.textMuted }, captionScale]}>
                          RAM: {reqRamGB} GB req / {recRamGB} GB rec
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
              <View style={styles.row}>
                <View style={styles.rowContent}>
                  <View style={styles.rowLeft}>
                    <Ionicons name="wifi-outline" size={18} color={theme.text} />
                    <Text style={[styles.rowText, { color: theme.text }, textScale]}>Wi-Fi Only Downloads</Text>
                  </View>
                </View>
                <Switch value={aiWifiOnlyDownload} onValueChange={setAiWifiOnlyDownload} trackColor={{ false: '#767577', true: theme.primary }} />
              </View>
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
              <View style={styles.row}>
                <View style={styles.rowLeft}>
                  <Ionicons name="cloud-download-outline" size={18} color={theme.text} />
                  <Text style={[styles.rowText, { color: theme.text }, textScale]}>Provisioning</Text>
                </View>
                <Text style={[styles.subText, { color: theme.textMuted }, captionScale]}>
                  {hasUsableLocalInferenceBackend ? getProvisioningStatusLabel(provisioning.status) : 'Disabled'}
                  {hasUsableLocalInferenceBackend && progressPercent > 0 && provisioning.status !== 'ready' ? ` · ${progressPercent}%` : ''}
                </Text>
              </View>
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
              <View style={styles.row}>
                <View style={styles.rowLeft}>
                  <Ionicons name="flash-outline" size={18} color={theme.text} />
                  <Text style={[styles.rowText, { color: theme.text }, textScale]}>Runtime</Text>
                </View>
                <Text style={[styles.subText, { color: hasUsableLocalInferenceBackend && canRunNativeChat ? theme.primary : theme.textMuted }, captionScale]}>
                  {hasUsableLocalInferenceBackend ? (runtimePhaseActive ? 'Initializing' : runtimeReady ? 'Ready' : 'Unavailable') : 'Unavailable'}
                </Text>
              </View>
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
              <View style={styles.row}>
                <View style={styles.rowLeft}>
                  <Ionicons name="speedometer-outline" size={18} color={theme.text} />
                  <Text style={[styles.rowText, { color: theme.text }, textScale]}>Transfer</Text>
                </View>
                <Text style={[styles.subText, { color: theme.textMuted }, captionScale]}>
                  {hasUsableLocalInferenceBackend ? throughputLabel ?? 'Waiting for transfer data' : 'Not applicable'}
                </Text>
              </View>
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
              <View style={styles.rowBlock}>
                <Text style={[styles.helperText, { color: hasUsableLocalInferenceBackend ? theme.textMuted : theme.expense }, captionScale]}>
                  {hasUsableLocalInferenceBackend
                    ? runtimePhaseActive
                      ? 'The model file is installed and the local runtime is finishing registration, warmup, and index initialization.'
                      : 'Progress is reconciled conservatively so incomplete downloads are cleared instead of being treated as installed.'
                    : localInferenceStatusMessage}
                </Text>
              </View>
              {hasUsableLocalInferenceBackend && provisioning.lastError ? (
                <>
                  <View style={[styles.divider, { backgroundColor: theme.border }]} />
                  <View style={styles.rowBlock}>
                    <Text style={[styles.helperText, { color: theme.expense }, captionScale]}>{provisioning.lastError}</Text>
                  </View>
                </>
              ) : null}
              {hasUsableLocalInferenceBackend && provisioning.pausedReason ? (
                <>
                  <View style={[styles.divider, { backgroundColor: theme.border }]} />
                  <View style={styles.rowBlock}>
                    <Text style={[styles.helperText, { color: theme.textMuted }, captionScale]}>{provisioning.pausedReason}</Text>
                  </View>
                </>
              ) : null}
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
              <View style={styles.aiActionRow}>
                {showPrimaryProvisionAction ? (
                  <TouchableOpacity
                    style={[styles.aiPrimaryAction, { backgroundColor: theme.primary, opacity: isAiActionLoading ? 0.7 : 1 }]}
                    onPress={handleAiPrimaryAction}
                    disabled={isAiActionLoading}
                  >
                    {isAiActionLoading ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.aiPrimaryActionText}>Retry setup</Text>
                    )}
                  </TouchableOpacity>
                ) : null}
                {hasUsableLocalInferenceBackend && (isAiActionLoading || provisioning.downloadedBytes > 0 || provisioning.status === 'downloading' || provisioning.status === 'queued') ? (
                  <TouchableOpacity style={[styles.aiSecondaryAction, { borderColor: theme.border, backgroundColor: theme.background }]} onPress={handleAiCancel} disabled={isAiActionLoading}>
                    <Text style={[styles.aiSecondaryActionText, { color: theme.expense }]}>Cancel</Text>
                  </TouchableOpacity>
                ) : null}
                {hasUsableLocalInferenceBackend && (provisioning.status === 'ready' || provisioning.downloadedBytes > 0) && !isAiActionLoading ? (
                  <TouchableOpacity
                    style={[styles.aiSecondaryAction, { borderColor: theme.border, backgroundColor: theme.background }]}
                    onPress={() => {
                      Alert.alert(
                        'Delete Downloaded Model',
                        'Are you sure you want to delete the offline model weights? You will need to re-download the model to use on-device AI.',
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Delete',
                            style: 'destructive',
                            onPress: async () => {
                              const manager = getModelLifecycleManager() as any;
                              if (typeof manager.deleteInstalledModel === 'function') {
                                await manager.deleteInstalledModel();
                              }
                            },
                          },
                        ]
                      );
                    }}
                  >
                    <Text style={[styles.aiSecondaryActionText, { color: theme.expense }]}>Delete Model</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </>
          )}
          <View style={[styles.divider, { backgroundColor: theme.border }]} />
          <TouchableOpacity style={styles.row} onPress={() => navigation.navigate('SystemLogs')}>
            <View style={styles.rowLeft}>
              <Ionicons name="terminal-outline" size={18} color={theme.text} />
              <Text style={[styles.rowText, { color: theme.text }, textScale]}>System logs</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
          </TouchableOpacity>
          {latestLogs.length > 0 ? (
            <>
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
              <View style={styles.rowBlock}>
                <Text style={[styles.featureTitle, { color: theme.text }, textScale]}>Recent AI events</Text>
                {latestLogs.map((entry) => (
                  <Text key={entry.id} style={[styles.logText, { color: entry.level === 'error' ? theme.expense : theme.textMuted }, captionScale]}>
                    {entry.event}: {entry.message}
                  </Text>
                ))}
              </View>
            </>
          ) : null}
          {verboseLogs.length > 0 ? (
            <>
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
              <View style={styles.rowBlock}>
                <Text style={[styles.featureTitle, { color: theme.text }, textScale]}>Verbose AI logs</Text>
                {verboseLogs.map((entry) => (
                  <Text key={`${entry.id}-verbose`} style={[styles.logText, { color: entry.level === 'error' ? theme.expense : theme.textMuted }, captionScale]}>
                    [{new Date(entry.timestamp).toLocaleTimeString()}] {entry.level.toUpperCase()} · {entry.event}: {entry.message}
                  </Text>
                ))}
              </View>
            </>
          ) : null}
        </View>
      </ScrollView>

      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={closeModal}>
        <TouchableOpacity style={[styles.modalOverlay, { backgroundColor: 'rgba(0,0,0,0.55)' }]} activeOpacity={1} onPress={closeModal}>
          <TouchableOpacity activeOpacity={1} onPress={(event) => event.stopPropagation()} style={[styles.modalCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.modalTitle, { color: theme.text }, headingScale]}>{editingCategory ? 'Edit Category' : 'Add Category'}</Text>
            <Text style={[styles.modalSubtitle, { color: categoryType === 'expense' ? theme.expense : theme.income }, captionScale]}>{categoryType === 'expense' ? 'Expense' : 'Income'} category</Text>

            <TextInput
              style={[styles.modalInput, { backgroundColor: theme.background, borderColor: theme.border, color: theme.text }, textScale]}
              placeholder="Category name"
              placeholderTextColor={theme.textMuted}
              value={categoryDraft}
              onChangeText={setCategoryDraft}
            />

            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.modalSecondaryBtn, { borderColor: theme.border, backgroundColor: theme.background }]} onPress={closeModal}>
                <Text style={[styles.modalSecondaryText, { color: theme.textMuted }, textScale]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalPrimaryBtn, { backgroundColor: theme.primary }]} onPress={handleSaveCategory}>
                <Text style={[styles.modalPrimaryText, textScale]}>{editingCategory ? 'Save' : 'Create'}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingTop: 8, paddingBottom: 10 },
  headerCopy: { flex: 1 },
  headerEyebrow: { fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 2 },
  headerTitle: { fontWeight: '700' },
  backButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  headerSpacer: { width: 32 },
  content: { paddingHorizontal: 14, paddingTop: 6, paddingBottom: 28 },
  heroCard: { borderRadius: 18, borderWidth: 1, padding: 16, marginBottom: 14 },
  heroTitle: { fontWeight: '800', marginBottom: 4 },
  heroSubtitle: { lineHeight: 18 },
  sectionTitle: { fontWeight: '700', textTransform: 'uppercase', marginBottom: 8, marginLeft: 4, marginTop: 10 },
  sectionCard: { borderRadius: 16, borderWidth: 1, overflow: 'hidden', marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 54, paddingHorizontal: 14, paddingVertical: 12 },
  rowContent: { flex: 1, paddingRight: 10 },
  rowLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  rowText: { marginLeft: 10, fontWeight: '600' },
  subText: { fontWeight: '500' },
  statusText: { fontWeight: '700' },
  divider: { height: 1, marginLeft: 44 },
  rowBlock: { paddingHorizontal: 14, paddingVertical: 12 },
  rowBlockHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  optionRowCompact: { flexDirection: 'row', flexWrap: 'wrap' },
  optionChip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 7, marginRight: 8, marginBottom: 8 },
  optionChipText: { fontWeight: '700', fontSize: 12 },
  helperText: { lineHeight: 18, marginBottom: 10 },
  inlineValue: { fontWeight: '700' },
  rowFeatureCardWrap: { padding: 12 },
  rowFeatureCard: { borderWidth: 1, borderRadius: 16, padding: 12 },
  rowFeatureHeader: { flexDirection: 'row', alignItems: 'center' },
  featureIconWrap: { width: 34, height: 34, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  featureCopy: { flex: 1, marginRight: 12 },
  featureTitle: { fontWeight: '700', marginBottom: 2 },
  featureSubtitle: { lineHeight: 17 },
  categorySplitWrap: { marginBottom: 8 },
  categoryColumnCard: { borderWidth: 1, borderRadius: 20, padding: 14 },
  categoryColumnLeft: { marginBottom: 12 },
  categoryColumnRight: { marginBottom: 6 },
  categoryColumnHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 },
  categoryEyebrow: { fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 2 },
  categoryHeading: { fontWeight: '700' },
  categoryColumnHint: { lineHeight: 17, marginBottom: 12 },
  roundAddBtn: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  categoryPillRow: { minHeight: 52, borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  categoryPillLeft: { flex: 1, paddingRight: 8 },
  categoryPillText: { fontWeight: '600' },
  badgeText: { marginTop: 2, fontWeight: '600' },
  categoryActions: { flexDirection: 'row', alignItems: 'center' },
  iconActionBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', marginLeft: 4 },
  aiActionRow: { flexDirection: 'row', padding: 14, alignItems: 'center' },
  aiPrimaryAction: { flex: 1, minHeight: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  aiPrimaryActionText: { color: '#fff', fontWeight: '800' },
  aiSecondaryAction: { minHeight: 44, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, marginLeft: 10 },
  aiSecondaryActionText: { fontWeight: '700' },
  logText: { lineHeight: 18, marginTop: 6 },
  modalOverlay: { flex: 1, justifyContent: 'center', padding: 20 },
  modalCard: { borderWidth: 1, borderRadius: 20, padding: 18 },
  modalTitle: { fontWeight: '700', marginBottom: 4 },
  modalSubtitle: { fontWeight: '700', marginBottom: 14 },
  modalInput: { minHeight: 46, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12 },
  modalActions: { flexDirection: 'row', marginTop: 16 },
  modalSecondaryBtn: { flex: 1, minHeight: 44, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  modalPrimaryBtn: { flex: 1, minHeight: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  modalSecondaryText: { fontWeight: '700' },
  modalPrimaryText: { fontWeight: '800', color: '#fff' },
});
