import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';

import { NavigationProps } from '../navigation/types';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTransactionStore } from '../store/useTransactionStore';
import {
  formatAmountForInput,
  formatAmountInput,
  formatDisplayCurrency,
  getCurrencySymbol,
  isAmountWithinRange,
  parseSignedAmount,
} from '../features/transactions/amount';
import { DEFAULT_WALLET_ID, TRANSFER_CATEGORY_LABEL } from '../features/transactions/constants';
import type { TransactionType } from '../features/transactions/types';
import { formatCachedLocaleDate } from '../features/transactions/periods';
import {
  RECURRING_FREQUENCIES,
  createRecurringRule,
  deleteRecurringRule,
  listRecurringRules,
  setRecurringRuleActive,
  updateRecurringRule,
  type RecurringFrequency,
  type RecurringRule,
  type RecurringTemplate,
} from '../services/recurring';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import { useAppTheme } from '../theme/useAppTheme';
import { KeyboardSheet } from '../components/KeyboardSheet';
import { SHEET_WIDTH } from '../theme/layout';

interface RecurringDraft {
  id: number | null;
  merchantName: string;
  amount: string;
  type: TransactionType;
  category: string;
  frequency: RecurringFrequency;
  note: string;
  lineItemsText: string;
  walletId?: number;
  toWalletId?: number | null;
}

export const RecurringScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const currencyCode = useSettingsStore((s) => s.currencyCode);
  const currencySymbol = getCurrencySymbol(currencyCode);
  const useThousands = useSettingsStore((s) => s.useThousandsSeparator);
  const dateFormat = useSettingsStore((s) => s.dateFormat);
  const wallets = useTransactionStore((s) => s.wallets);
  const categories = useTransactionStore((s) => s.categories);
  const getCategoriesByType = useTransactionStore((s) => s.getCategoriesByType);
  const normalizeCategoryForType = useTransactionStore((s) => s.normalizeCategoryForType);

  const [rules, setRules] = useState<RecurringRule[]>([]);
  const [draft, setDraft] = useState<RecurringDraft | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);

  const refresh = useCallback(() => setRules(listRecurringRules()), []);
  useFocusEffect(refresh);

  const defaultWalletId = wallets.find((w) => w.isActive)?.id ?? DEFAULT_WALLET_ID;

  const availableCategories = useMemo(() => {
    if (!draft || draft.type === 'transfer') return [];
    const list = getCategoriesByType(draft.type === 'income' ? 'income' : 'expense');
    if (draft.category && !list.some((c) => c.name === draft.category)) {
      return [{ id: -1, name: draft.category, type: draft.type, isSystem: false, createdAt: 0 }, ...list];
    }
    return list;
  }, [draft, categories, getCategoriesByType]);

  const openEditor = (rule?: RecurringRule) => {
    setTitleError(null);
    setAmountError(null);
    if (rule) {
      setDraft({
        id: rule.id,
        merchantName: rule.template.merchantName ?? '',
        amount:
          rule.template.totalAmount !== 0
            ? formatAmountForInput(Math.abs(rule.template.totalAmount), currencyCode)
            : '',
        type: rule.template.type ?? 'expense',
        category: rule.template.category ?? '',
        frequency: rule.frequency,
        note: rule.template.note ?? '',
        lineItemsText: rule.template.lineItemsText ?? '',
        walletId: rule.template.walletId ?? defaultWalletId,
        toWalletId: rule.template.toWalletId ?? null,
      });
      return;
    }

    const defaultExpenseCat = getCategoriesByType('expense')[0]?.name ?? normalizeCategoryForType('', 'expense');
    setDraft({
      id: null,
      merchantName: '',
      amount: '',
      type: 'expense',
      category: defaultExpenseCat,
      frequency: 'monthly',
      note: '',
      lineItemsText: '',
      walletId: defaultWalletId,
      toWalletId: null,
    });
  };

  const closeEditor = () => {
    setDraft(null);
    setTitleError(null);
    setAmountError(null);
  };

  const handleDraftTypeChange = (nextType: 'expense' | 'income') => {
    setDraft((prev) => {
      if (!prev || prev.type === nextType) return prev;
      const nextCats = getCategoriesByType(nextType);
      return {
        ...prev,
        type: nextType,
        category: nextCats[0]?.name ?? normalizeCategoryForType('', nextType),
        toWalletId: null,
      };
    });
  };

  const handleSaveDraft = () => {
    if (!draft) return;
    let hasError = false;
    const trimmedTitle = draft.merchantName.trim();
    if (draft.type !== 'transfer' && !trimmedTitle) {
      setTitleError('Please enter a title');
      hasError = true;
    } else {
      setTitleError(null);
    }

    const parsedAmt = Math.abs(parseSignedAmount(draft.amount, undefined, currencyCode));
    if (!draft.amount.trim() || parsedAmt === 0 || Number.isNaN(parsedAmt)) {
      setAmountError('Amount must be greater than 0');
      hasError = true;
    } else if (!isAmountWithinRange(parsedAmt)) {
      setAmountError('Amount is too large');
      hasError = true;
    } else {
      setAmountError(null);
    }

    if (hasError) return;

    const signedAmount = draft.type === 'income' ? parsedAmt : -parsedAmt;
    const resolvedCategory =
      draft.type === 'transfer'
        ? TRANSFER_CATEGORY_LABEL
        : draft.category.trim() || normalizeCategoryForType('', draft.type);

    const template: RecurringTemplate = {
      merchantName: trimmedTitle || 'Transfer',
      totalAmount: signedAmount,
      type: draft.type,
      category: resolvedCategory,
      note: draft.note,
      lineItemsText: draft.lineItemsText,
      walletId: draft.walletId ?? defaultWalletId,
      toWalletId: draft.type === 'transfer' ? (draft.toWalletId ?? null) : null,
    };

    try {
      if (draft.id === null) {
        createRecurringRule(template, draft.frequency, Date.now());
      } else {
        updateRecurringRule(draft.id, template, draft.frequency);
      }
      closeEditor();
      refresh();
    } catch (error) {
      Alert.alert('Could not save', error instanceof Error ? error.message : String(error));
    }
  };

  const handleToggleRule = (item: RecurringRule, nextActive: boolean) => {
    setRecurringRuleActive(item.id, nextActive);
    // Keep row in place on toggle so adjacent controls never shift under the user's thumb.
    setRules((prev) => prev.map((rule) => (rule.id === item.id ? { ...rule, isActive: nextActive } : rule)));
  };

  const confirmDelete = (rule: RecurringRule) =>
    Alert.alert('Stop repeating?', `${rule.template.merchantName} won't be added again. Past transactions stay.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Stop',
        style: 'destructive',
        onPress: () => {
          deleteRecurringRule(rule.id);
          setRules((prev) => prev.filter((r) => r.id !== rule.id));
        },
      },
    ]);

  const switchTrackColor = {
    false: theme.isDarkMode ? '#3f3f46' : '#d1d5db',
    true: theme.primaryTrack,
  };

  const renderRule = ({ item }: { item: RecurringRule }) => {
    const label = RECURRING_FREQUENCIES.find((f) => f.key === item.frequency)?.label ?? item.frequency;
    const next = formatCachedLocaleDate(item.nextDate, dateFormat || 'en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    const isIncome = item.template.type === 'income';
    const amountText = formatDisplayCurrency(Math.abs(item.template.totalAmount), currencyCode, useThousands);
    return (
      <View
        style={[
          styles.row,
          { backgroundColor: theme.surface, borderColor: theme.border, opacity: item.isActive ? 1 : 0.65 },
        ]}
      >
        <TouchableOpacity
          style={styles.rowMainTouch}
          onPress={() => openEditor(item)}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel={`Edit recurring ${item.template.merchantName}, ${label}, ${amountText}`}
        >
          <View style={styles.rowBody}>
            <Text style={[styles.rowTitle, { color: theme.text, fontSize: theme.scaleFont(15) }]} numberOfLines={1}>
              {item.template.merchantName}
            </Text>
            <Text style={[styles.rowSub, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]} numberOfLines={1}>
              {label} · {item.isActive ? `next ${next}` : 'paused'}
            </Text>
          </View>
          <Text
            style={[
              styles.amount,
              {
                color: item.template.type === 'transfer' ? theme.primary : isIncome ? theme.income : theme.expense,
                fontSize: theme.scaleFont(14),
              },
            ]}
          >
            {amountText}
          </Text>
        </TouchableOpacity>
        <Switch
          value={item.isActive}
          onValueChange={(on) => handleToggleRule(item, on)}
          trackColor={switchTrackColor}
          thumbColor={item.isActive ? theme.primary : theme.isDarkMode ? '#e5e7eb' : '#ffffff'}
          accessibilityLabel={`${item.template.merchantName} repeating`}
        />
        <TouchableOpacity
          onPress={() => confirmDelete(item)}
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel={`Stop repeating ${item.template.merchantName}`}
        >
          <Ionicons name="trash-outline" size={20} color={theme.textMuted} />
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={24} color={theme.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: theme.text, fontSize: theme.scaleFont(18) }]}>Recurring</Text>
        <TouchableOpacity
          style={[styles.addBtn, { backgroundColor: theme.primary }]}
          onPress={() => openEditor()}
          accessibilityRole="button"
          accessibilityLabel="Add recurring transaction"
        >
          <Ionicons name="add" size={18} color={theme.onPrimary} />
          <Text style={[styles.addBtnText, { color: theme.onPrimary, fontSize: theme.scaleFont(13) }]}>Add</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={rules}
        keyExtractor={(r) => String(r.id)}
        renderItem={renderRule}
        contentContainerStyle={
          rules.length === 0
            ? styles.emptyContainer
            : [styles.list, { paddingBottom: getBottomInsetPadding(insets.bottom, 32) }]
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="repeat-outline" size={44} color={theme.textMuted} />
            <Text style={[styles.emptyTitle, { color: theme.text, fontSize: theme.scaleFont(16) }]}>
              Nothing repeats yet
            </Text>
            <Text style={[styles.emptyText, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>
              Tap Add above or set Repeat when adding a transaction such as rent, salary, or a subscription. Silo adds it
              on schedule when you open the app.
            </Text>
          </View>
        }
      />

      <Modal visible={draft !== null} transparent animationType="slide" onRequestClose={closeEditor}>
        <KeyboardSheet style={styles.overlay}>
          <View
            testID="recurring-editor-sheet"
            style={[
              styles.sheet,
              { backgroundColor: theme.surface, paddingBottom: getBottomInsetPadding(insets.bottom, 24) },
            ]}
          >
            <ScrollView bounces={false} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <Text style={[styles.sheetTitle, { color: theme.text, fontSize: theme.scaleFont(17) }]}>
                {draft?.id == null ? 'New recurring rule' : 'Edit recurring rule'}
              </Text>

              {draft?.type !== 'transfer' ? (
                <>
                  <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(12) }]}>Type</Text>
                  <View style={[styles.typeToggle, { borderColor: theme.border, backgroundColor: theme.background }]}>
                    {(['expense', 'income'] as const).map((t) => {
                      const active = draft?.type === t;
                      return (
                        <TouchableOpacity
                          key={t}
                          style={[
                            styles.typeBtn,
                            { backgroundColor: active ? (t === 'income' ? theme.income : theme.expense) : 'transparent' },
                          ]}
                          onPress={() => handleDraftTypeChange(t)}
                          accessibilityRole="button"
                          accessibilityLabel={`Recurring type ${t}`}
                          accessibilityState={{ selected: active }}
                        >
                          <Text
                            style={[
                              styles.typeBtnText,
                              { color: active ? theme.onPrimary : theme.textMuted, fontSize: theme.scaleFont(13) },
                            ]}
                          >
                            {t === 'income' ? 'Income' : 'Expense'}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </>
              ) : null}

              <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(12) }]}>Title</Text>
              <TextInput
                style={[
                  styles.input,
                  {
                    borderColor: titleError ? theme.expense : theme.border,
                    color: theme.text,
                    backgroundColor: theme.background,
                    fontSize: theme.scaleFont(15),
                  },
                ]}
                value={draft?.merchantName ?? ''}
                onChangeText={(merchantName) => {
                  setDraft((prev) => (prev ? { ...prev, merchantName } : prev));
                  if (titleError && merchantName.trim()) setTitleError(null);
                }}
                placeholder="e.g. Rent, Salary, Netflix"
                placeholderTextColor={theme.textMuted}
                accessibilityLabel="Recurring title"
              />
              {titleError ? (
                <Text accessibilityRole="alert" style={[styles.errorText, { color: theme.expense, fontSize: theme.scaleFont(12) }]}>
                  {titleError}
                </Text>
              ) : null}

              <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(12) }]}>Amount</Text>
              <View style={styles.amountRow}>
                <View style={[styles.currencyBadge, { borderColor: theme.border, backgroundColor: theme.background }]}>
                  <Text style={[styles.currencyText, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>
                    {currencySymbol}
                  </Text>
                </View>
                <TextInput
                  style={[
                    styles.input,
                    styles.flex,
                    {
                      borderColor: amountError ? theme.expense : theme.border,
                      color: theme.text,
                      backgroundColor: theme.background,
                      fontSize: theme.scaleFont(15),
                    },
                  ]}
                  value={draft?.amount ?? ''}
                  onChangeText={(v) => {
                    const formatted = formatAmountInput(v, currencyCode);
                    setDraft((prev) => (prev ? { ...prev, amount: formatted } : prev));
                    if (amountError) setAmountError(null);
                  }}
                  keyboardType={Platform.OS === 'ios' ? 'decimal-pad' : 'numeric'}
                  placeholder="0"
                  placeholderTextColor={theme.textMuted}
                  accessibilityLabel="Recurring amount"
                />
              </View>
              {amountError ? (
                <Text accessibilityRole="alert" style={[styles.errorText, { color: theme.expense, fontSize: theme.scaleFont(12) }]}>
                  {amountError}
                </Text>
              ) : null}

              <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(12) }]}>Repeat</Text>
              <View style={styles.chips}>
                {RECURRING_FREQUENCIES.map((option) => {
                  const selected = draft?.frequency === option.key;
                  return (
                    <TouchableOpacity
                      key={option.key}
                      style={[
                        styles.chip,
                        {
                          borderColor: selected ? theme.primary : theme.border,
                          backgroundColor: selected ? theme.primaryMuted : theme.background,
                        },
                      ]}
                      onPress={() => setDraft((prev) => (prev ? { ...prev, frequency: option.key } : prev))}
                      accessibilityRole="button"
                      accessibilityLabel={`Schedule ${option.label}`}
                      accessibilityState={{ selected }}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          { color: selected ? theme.primary : theme.text, fontSize: theme.scaleFont(13) },
                        ]}
                      >
                        {option.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {draft?.type !== 'transfer' && availableCategories.length > 0 ? (
                <>
                  <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(12) }]}>Category</Text>
                  <View style={styles.chips}>
                    {availableCategories.map((cat) => {
                      const selected = draft?.category === cat.name;
                      return (
                        <TouchableOpacity
                          key={`${cat.id}-${cat.name}`}
                          style={[
                            styles.chip,
                            {
                              borderColor: selected ? theme.primary : theme.border,
                              backgroundColor: selected ? theme.primaryMuted : theme.background,
                            },
                          ]}
                          onPress={() => setDraft((prev) => (prev ? { ...prev, category: cat.name } : prev))}
                          accessibilityRole="button"
                          accessibilityLabel={`Category ${cat.name}`}
                          accessibilityState={{ selected }}
                        >
                          <Text
                            style={[
                              styles.chipText,
                              { color: selected ? theme.primary : theme.text, fontSize: theme.scaleFont(13) },
                            ]}
                          >
                            {cat.name}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </>
              ) : null}

              <View style={styles.actions}>
                <TouchableOpacity
                  onPress={closeEditor}
                  style={styles.secondaryBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel recurring rule"
                >
                  <Text style={[styles.secondaryText, { color: theme.textMuted, fontSize: theme.scaleFont(14) }]}>
                    Cancel
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleSaveDraft}
                  style={[styles.primaryBtn, { backgroundColor: theme.primary }]}
                  accessibilityRole="button"
                  accessibilityLabel="Save recurring rule"
                >
                  <Text style={[styles.primaryText, { color: theme.onPrimary, fontSize: theme.scaleFont(14) }]}>
                    Save
                  </Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </KeyboardSheet>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 56,
    gap: 6,
  },
  backBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: 18, fontWeight: '700' },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    paddingHorizontal: 14,
    minHeight: 48,
    justifyContent: 'center',
  },
  addBtnText: { fontSize: 13, fontWeight: '700' },
  list: { paddingHorizontal: 16, paddingTop: 12, gap: 10 },
  emptyContainer: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 32 },
  empty: { alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '700' },
  emptyText: { fontSize: 13, textAlign: 'center', lineHeight: 19 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 14,
    paddingLeft: 12,
    paddingRight: 4,
    paddingVertical: 8,
    gap: 6,
  },
  rowMainTouch: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    gap: 8,
  },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 15, fontWeight: '700' },
  rowSub: { fontSize: 12, marginTop: 2 },
  amount: { fontSize: 14, fontWeight: '700' },
  iconBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { ...SHEET_WIDTH, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, maxHeight: '88%' },
  sheetTitle: { fontSize: 17, fontWeight: '700', marginBottom: 4 },
  label: { fontSize: 12, fontWeight: '700', marginTop: 12, marginBottom: 6 },
  typeToggle: { flexDirection: 'row', borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  typeBtn: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  typeBtnText: { fontWeight: '700' },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 15 },
  amountRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  currencyBadge: {
    minWidth: 48,
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  currencyText: { fontWeight: '700' },
  flex: { flex: 1 },
  errorText: { marginTop: 4, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    minHeight: 48,
    justifyContent: 'center',
  },
  chipText: { fontSize: 13, fontWeight: '600' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', marginTop: 20, gap: 10 },
  secondaryBtn: { minHeight: 48, paddingHorizontal: 14, justifyContent: 'center' },
  secondaryText: { fontSize: 14, fontWeight: '700' },
  primaryBtn: { minHeight: 48, borderRadius: 12, paddingHorizontal: 22, justifyContent: 'center' },
  primaryText: { fontSize: 14, fontWeight: '700' },
});
