import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  TextInput,
  ScrollView,
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';

import { useAppTheme } from '../theme/useAppTheme';
import { useTransactionStore } from '../store/useTransactionStore';
import { useMonthlySummary } from '../hooks/useMonthlySummary';
import { useSettingsStore } from '../store/useSettingsStore';
import { getModalOverlayInsetStyle, useSafeInsets } from '../hooks/useSafeInsets';
import {
  addAmounts,
  formatAmountForInput,
  formatAmountInput,
  formatDisplayCurrency,
  isAmountWithinRange,
  parseSignedAmount,
} from '../features/transactions/amount';
import { formatPeriodLabel, isSamePeriod, shiftPeriod } from '../features/transactions/periods';
import { AmountCalculatorKeypad } from '../components/AmountCalculatorKeypad';

const getProgressTone = (percentage: number, theme: ReturnType<typeof useAppTheme>) => {
  if (percentage > 100) {
    return theme.expense;
  }
  if (percentage >= 80) {
    return theme.warning;
  }
  return theme.income;
};

const ProgressBar = ({ spent, limit, theme }: { spent: number; limit: number; theme: ReturnType<typeof useAppTheme> }) => {
  const progressAnim = useRef(new Animated.Value(0)).current;
  const rawPercentage = limit > 0 ? (spent / limit) * 100 : 0;
  const percentage = Math.min(Math.max(rawPercentage, 0), 100);
  const barColor = getProgressTone(rawPercentage, theme);

  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: percentage,
      duration: 650,
      useNativeDriver: false,
    }).start();
  }, [percentage, progressAnim]);

  return (
    <View style={[styles.progressTrack, { backgroundColor: theme.background, borderColor: theme.border }]}>
      <Animated.View
        style={[
          styles.progressFill,
          {
            backgroundColor: barColor,
            width: progressAnim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
          },
        ]}
      />
    </View>
  );
};

export const BudgetScreen = () => {
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const currencyCode = useSettingsStore((state) => state.currencyCode);
  const useThousandsSeparator = useSettingsStore((state) => state.useThousandsSeparator);
  const dateFormat = useSettingsStore((state) => state.dateFormat);
  const monthStartDay = useSettingsStore((state) => state.monthStartDay);
  const {
    budgets,
    setBudget,
    getCategoriesByType,
    fetchTransactions,
    fetchBudgets,
    fetchCategories,
  } = useTransactionStore();
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [refreshing, setRefreshing] = useState(false);
  const { currentMonthExpenses, periodBounds } = useMonthlySummary(currentDate);
  const periodLabel = useMemo(
    () => formatPeriodLabel(periodBounds, dateFormat || 'en-GB'),
    [periodBounds, dateFormat]
  );
  const isCurrentPeriodNow = isSamePeriod(currentDate, new Date(), monthStartDay);
  const expenseCategories = getCategoriesByType('expense');

  const changePeriod = useCallback(
    (offset: number) => {
      setCurrentDate((prev) => shiftPeriod(prev, offset, monthStartDay));
    },
    [monthStartDay]
  );

  const resetToCurrentPeriod = useCallback(() => {
    setCurrentDate(new Date());
  }, []);

  const refreshMonthData = useCallback(async () => {
    await Promise.all([fetchTransactions(), fetchCategories()]);
    await fetchBudgets();
  }, [fetchTransactions, fetchCategories, fetchBudgets]);

  useFocusEffect(
    useCallback(() => {
      void refreshMonthData();
    }, [refreshMonthData])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshMonthData();
    } finally {
      setRefreshing(false);
    }
  }, [refreshMonthData]);

  const titleScale = useMemo(() => ({ fontSize: theme.scaleFont(24) }), [theme]);
  const bodyScale = useMemo(() => ({ fontSize: theme.scaleFont(13) }), [theme]);
  const smallScale = useMemo(() => ({ fontSize: theme.scaleFont(11.5) }), [theme]);
  const metricScale = useMemo(() => ({ fontSize: theme.scaleFont(17) }), [theme]);

  const categorySpending = useMemo(
    () =>
      currentMonthExpenses.reduce((acc, curr) => {
        const cat = curr.category || 'General';
        acc[cat] = addAmounts(acc[cat] || 0, Math.abs(curr.totalAmount));
        return acc;
      }, {} as Record<string, number>),
    [currentMonthExpenses]
  );

  const [modalVisible, setModalVisible] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [budgetInput, setBudgetInput] = useState('');
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [calculatorOpen, setCalculatorOpen] = useState(false);

  const budgetCards = useMemo(
    () =>
      expenseCategories.map((category) => {
        const categoryName = category.name;
        const limit = budgets[categoryName] ?? 0;
        const spent = categorySpending[categoryName] || 0;
        const hasBudget = limit > 0;
        const percentage = hasBudget ? (spent / limit) * 100 : 0;
        const remaining = hasBudget ? addAmounts(limit, -spent) : 0;

        return {
          category: categoryName,
          limit,
          spent,
          hasBudget,
          percentage,
          remaining,
        };
      }),
    [budgets, expenseCategories, categorySpending]
  );

  const totalBudgeted = useMemo(
    () => budgetCards.reduce((sum, item) => addAmounts(sum, item.limit), 0),
    [budgetCards]
  );
  const budgetedSpent = useMemo(
    () => budgetCards.reduce((sum, item) => (item.hasBudget ? addAmounts(sum, item.spent) : sum), 0),
    [budgetCards]
  );
  const totalAllSpent = useMemo(
    () => currentMonthExpenses.reduce((sum, tx) => addAmounts(sum, Math.abs(tx.totalAmount)), 0),
    [currentMonthExpenses]
  );
  const unbudgetedSpent = Math.max(0, addAmounts(totalAllSpent, -budgetedSpent));
  const activeBudgetCount = budgetCards.filter((item) => item.hasBudget).length;
  const overspentCount = budgetCards.filter((item) => item.hasBudget && item.spent > item.limit).length;

  const handleOpenModal = (category: string) => {
    setSelectedCategory(category);
    const existingLimit = budgets[category];
    setBudgetInput(existingLimit && existingLimit > 0 ? formatAmountForInput(existingLimit, currencyCode) : '');
    setBudgetError(null);
    setCalculatorOpen(false);
    setModalVisible(true);
  };

  const handleSaveBudget = async () => {
    const numericValue = Math.abs(parseSignedAmount(budgetInput, undefined, currencyCode));
    if (!isAmountWithinRange(numericValue)) {
      setBudgetError('Amount is too large');
      return;
    }
    if (numericValue > 0) {
      await setBudget(selectedCategory, numericValue);
    } else {
      // 0 or empty clears budget
      await setBudget(selectedCategory, 0);
    }
    setBudgetError(null);
    setCalculatorOpen(false);
    setModalVisible(false);
  };

  const handleClearBudget = async () => {
    await setBudget(selectedCategory, 0);
    setBudgetError(null);
    setCalculatorOpen(false);
    setModalVisible(false);
  };

  const closeModal = () => {
    setBudgetError(null);
    setCalculatorOpen(false);
    setModalVisible(false);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: theme.background }]}>
        <Text style={[styles.eyebrow, { color: theme.textMuted }, smallScale]}>Budgets</Text>
        <View style={styles.headerRow}>
          <View style={styles.headerTitleBlock}>
            <Text style={[styles.headerTitle, { color: theme.text }, titleScale]}>Monthly Plan</Text>
          </View>
          <View style={[styles.headerPill, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text
              style={[
                styles.headerPillText,
                {
                  color:
                    activeBudgetCount === 0
                      ? theme.textMuted
                      : overspentCount > 0
                        ? theme.expense
                        : theme.income,
                },
                smallScale,
              ]}
            >
              {activeBudgetCount === 0
                ? 'No limits'
                : overspentCount > 0
                  ? `${overspentCount} overspent`
                  : 'Balanced'}
            </Text>
          </View>
        </View>

        {/* Month / Period Navigation */}
        <View style={[styles.periodBar, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <TouchableOpacity
            onPress={() => changePeriod(-1)}
            style={styles.periodArrowBtn}
            accessibilityRole="button"
            accessibilityLabel="Previous month"
          >
            <Ionicons name="chevron-back" size={20} color={theme.text} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={resetToCurrentPeriod}
            style={styles.periodCenterBtn}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel="Jump to current month"
          >
            <Text
              style={[styles.periodSubtitle, { color: theme.text, fontSize: theme.scaleFont(14) }]}
              numberOfLines={1}
              adjustsFontSizeToFit
            >
              {periodLabel}
            </Text>
            {!isCurrentPeriodNow ? (
              <View style={[styles.todayBadge, { backgroundColor: theme.primaryMuted }]}>
                <Text style={[styles.todayBadgeText, { color: theme.primary, fontSize: theme.scaleFont(10.5) }]}>
                  Today
                </Text>
              </View>
            ) : null}
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => changePeriod(1)}
            style={styles.periodArrowBtn}
            accessibilityRole="button"
            accessibilityLabel="Next month"
          >
            <Ionicons name="chevron-forward" size={20} color={theme.text} />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: 132 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.primary}
            colors={[theme.primary]}
          />
        }
      >
        {/* Metric Summary Panel */}
        <View style={[styles.heroPanel, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.heroMetricGrid}>
            <View style={styles.metricCell}>
              <Text style={[styles.metricLabel, { color: theme.textMuted }, smallScale]}>Total Budgeted</Text>
              <Text style={[styles.metricValue, { color: theme.text }, metricScale]}>
                {formatDisplayCurrency(totalBudgeted, currencyCode, useThousandsSeparator)}
              </Text>
            </View>
            <View style={[styles.metricDivider, { backgroundColor: theme.border }]} />
            <View style={styles.metricCell}>
              <Text style={[styles.metricLabel, { color: theme.textMuted }, smallScale]}>Budgeted Spent</Text>
              <Text
                style={[
                  styles.metricValue,
                  { color: totalBudgeted > 0 && budgetedSpent > totalBudgeted ? theme.expense : theme.text },
                  metricScale,
                ]}
              >
                {formatDisplayCurrency(budgetedSpent, currencyCode, useThousandsSeparator)}
              </Text>
            </View>
          </View>

          <View
            testID="budget-unbudgeted-row"
            style={[styles.unbudgetedRow, { backgroundColor: theme.background, borderColor: theme.border }]}
          >
            <View style={styles.unbudgetedCopy}>
              <Text style={[styles.unbudgetedLabel, { color: theme.textMuted }, smallScale]}>
                Unbudgeted spending
              </Text>
              <Text style={[styles.unbudgetedValue, { color: theme.text }, bodyScale]}>
                {formatDisplayCurrency(unbudgetedSpent, currencyCode, useThousandsSeparator)}
              </Text>
            </View>
            <View style={[styles.unbudgetedDivider, { backgroundColor: theme.border }]} />
            <View style={styles.unbudgetedCopy}>
              <Text style={[styles.unbudgetedLabel, { color: theme.textMuted }, smallScale]}>
                All spending
              </Text>
              <Text style={[styles.unbudgetedValue, { color: theme.text }, bodyScale]}>
                {formatDisplayCurrency(totalAllSpent, currencyCode, useThousandsSeparator)}
              </Text>
            </View>
          </View>

          <View style={styles.miniStatRow}>
            <View style={[styles.miniStatChip, { backgroundColor: theme.background, borderColor: theme.border }]}>
              <Text style={[styles.miniStatValue, { color: theme.text }, bodyScale]}>{activeBudgetCount}</Text>
              <Text style={[styles.miniStatLabel, { color: theme.textMuted }, smallScale]}>active limits</Text>
            </View>
            <View style={[styles.miniStatChip, { backgroundColor: theme.background, borderColor: theme.border }]}>
              <Text
                style={[
                  styles.miniStatValue,
                  { color: overspentCount > 0 ? theme.expense : theme.income },
                  bodyScale,
                ]}
              >
                {overspentCount}
              </Text>
              <Text style={[styles.miniStatLabel, { color: theme.textMuted }, smallScale]}>over limit</Text>
            </View>
          </View>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: theme.text }, bodyScale]}>Category Limits</Text>
          <Text style={[styles.sectionSubtitle, { color: theme.textMuted }, smallScale]}>
            Tap a card to set or clear monthly caps
          </Text>
        </View>

        {budgetCards.length === 0 ? (
          <View style={[styles.emptyStateCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <View style={[styles.emptyIconWrap, { backgroundColor: theme.background, borderColor: theme.border }]}>
              <Ionicons name="wallet-outline" size={24} color={theme.primary} />
            </View>
            <Text style={[styles.emptyTitle, { color: theme.text }, bodyScale]}>No expense categories yet</Text>
            <Text style={[styles.emptySubtitle, { color: theme.textMuted }, smallScale]}>
              Create expense categories in Settings or add transactions first.
            </Text>
          </View>
        ) : (
          budgetCards.map((item) => {
            const tone = getProgressTone(item.percentage, theme);
            const isOverspent = item.hasBudget && item.spent > item.limit;

            return (
              <TouchableOpacity
                key={item.category}
                style={[styles.budgetCard, { backgroundColor: theme.surface, borderColor: theme.border }]}
                onPress={() => handleOpenModal(item.category)}
                activeOpacity={0.84}
                accessibilityRole="button"
                accessibilityLabel={`${item.category} budget limit`}
              >
                <View style={styles.cardHeaderRow}>
                  <View style={styles.cardHeadingBlock}>
                    <Text style={[styles.categoryTitle, { color: theme.text }, bodyScale]} numberOfLines={1}>
                      {item.category}
                    </Text>
                    <Text style={[styles.categoryMeta, { color: theme.textMuted }, smallScale]}>
                      {item.hasBudget
                        ? `${Math.round(item.percentage)}% of cap used`
                        : item.spent > 0
                          ? `Spent ${formatDisplayCurrency(item.spent, currencyCode, useThousandsSeparator)} · No budget set`
                          : 'No budget set'}
                    </Text>
                  </View>
                  <View style={[styles.editDotWrap, { backgroundColor: theme.background, borderColor: theme.border }]}>
                    <Ionicons name="create-outline" size={16} color={theme.textMuted} />
                  </View>
                </View>

                {item.hasBudget ? (
                  <>
                    <View style={styles.amountLine}>
                      <Text style={[styles.amountPrimary, { color: theme.text }, metricScale]}>
                        {formatDisplayCurrency(item.spent, currencyCode, useThousandsSeparator)}
                      </Text>
                      <Text style={[styles.amountSecondary, { color: theme.textMuted }, smallScale]}>
                        of {formatDisplayCurrency(item.limit, currencyCode, useThousandsSeparator)}
                      </Text>
                    </View>

                    <ProgressBar spent={item.spent} limit={item.limit} theme={theme} />

                    <View style={styles.bottomMetaRow}>
                      <View style={[styles.statusChip, { backgroundColor: theme.background, borderColor: theme.border }]}>
                        <View style={[styles.statusDot, { backgroundColor: tone }]} />
                        <Text
                          style={[
                            styles.statusChipText,
                            { color: isOverspent ? theme.expense : item.percentage >= 80 ? theme.warning : theme.income },
                            smallScale,
                          ]}
                        >
                          {isOverspent ? 'Over Budget' : item.percentage >= 80 ? 'Near Limit' : 'On Pace'}
                        </Text>
                      </View>
                      <Text
                        style={[
                          styles.remainingText,
                          { color: isOverspent ? theme.expense : theme.textMuted },
                          smallScale,
                        ]}
                      >
                        {isOverspent ? 'Over by ' : 'Remaining: '}
                        {formatDisplayCurrency(Math.abs(item.remaining), currencyCode, useThousandsSeparator)}
                      </Text>
                    </View>
                  </>
                ) : (
                  <View style={[styles.emptyBudgetStrip, { backgroundColor: theme.background, borderColor: theme.border }]}>
                    <Ionicons name="add-circle-outline" size={18} color={theme.primary} />
                    <Text style={[styles.emptyBudgetStripText, { color: theme.primary }, smallScale]}>
                      Set monthly limit
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })
        )}

        <View style={styles.bottomSpacer} />
      </ScrollView>

      {/* Edit / Clear Budget Modal */}
      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={closeModal}>
        {modalVisible ? (
          <KeyboardAvoidingView
            style={styles.keyboardShell}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <View
              style={[
                styles.modalOverlay,
                { backgroundColor: 'rgba(0,0,0,0.58)' },
                getModalOverlayInsetStyle(insets, 16),
              ]}
            >
              <TouchableOpacity
                style={StyleSheet.absoluteFill}
                activeOpacity={1}
                onPress={closeModal}
                accessibilityRole="button"
                accessibilityLabel="Close budget modal backdrop"
              />
              <View
                testID="budget-modal-card"
                style={[styles.modalCard, { backgroundColor: theme.surface, borderColor: theme.border }]}
              >
                <ScrollView
                  testID="budget-modal-scroll"
                  bounces={false}
                  showsVerticalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={styles.modalScrollContent}
                >
                  <View style={styles.modalHeader}>
                    <View style={[styles.modalIconWrap, { backgroundColor: theme.background, borderColor: theme.border }]}>
                      <Ionicons name="calculator-outline" size={20} color={theme.primary} />
                    </View>
                    <View style={styles.modalHeaderCopy}>
                      <Text style={[styles.modalTitle, { color: theme.text }, bodyScale]}>Monthly Budget Cap</Text>
                      <Text style={[styles.modalSubtitle, { color: theme.textMuted }, smallScale]} numberOfLines={1}>
                        {selectedCategory}
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={styles.modalCloseBtn}
                      onPress={closeModal}
                      accessibilityRole="button"
                      accessibilityLabel="Close"
                    >
                      <Ionicons name="close" size={22} color={theme.textMuted} />
                    </TouchableOpacity>
                  </View>

                  <Text style={[styles.modalInputLabel, { color: theme.textMuted }, smallScale]}>
                    Enter monthly limit amount (0 to remove budget):
                  </Text>

                  <TouchableOpacity
                    style={[
                      styles.inputShell,
                      {
                        borderColor: budgetError
                          ? theme.expense
                          : calculatorOpen
                            ? theme.primary
                            : theme.border,
                        backgroundColor: theme.background,
                      },
                    ]}
                    onPress={() => {
                      Keyboard.dismiss();
                      setCalculatorOpen(true);
                    }}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                    accessibilityLabel="Edit budget amount"
                  >
                    <Text style={[styles.currencyPrefix, { color: theme.textMuted }, bodyScale]}>{currencyCode}</Text>
                    <TextInput
                      style={[styles.input, { color: theme.text }, metricScale]}
                      keyboardType={Platform.OS === 'ios' ? 'decimal-pad' : 'numeric'}
                      showSoftInputOnFocus={false}
                      pointerEvents="none"
                      value={budgetInput}
                      onChangeText={(text) => {
                        const formatted = formatAmountInput(text, currencyCode);
                        setBudgetInput(formatted);
                        const parsed = Math.abs(parseSignedAmount(text, undefined, currencyCode));
                        setBudgetError(!isAmountWithinRange(parsed) ? 'Amount is too large' : null);
                      }}
                      placeholder="0"
                      placeholderTextColor={theme.textMuted}
                    />
                    <Ionicons name="calculator-outline" size={18} color={theme.textMuted} />
                  </TouchableOpacity>

                  {budgetError ? (
                    <Text style={[styles.budgetErrorText, { color: theme.expense }, smallScale]} accessibilityRole="alert">
                      {budgetError}
                    </Text>
                  ) : null}

                  {calculatorOpen ? (
                    <View style={styles.calculatorWrap}>
                      <AmountCalculatorKeypad
                        initialValue={budgetInput}
                        currencyCode={currencyCode}
                        allowZero
                        embedded
                        onDone={(formatted) => {
                          setBudgetInput(formatted);
                          setBudgetError(null);
                          setCalculatorOpen(false);
                        }}
                        onCancel={() => setCalculatorOpen(false)}
                      />
                    </View>
                  ) : (
                    <View style={styles.modalActions}>
                      {budgets[selectedCategory] && budgets[selectedCategory] > 0 ? (
                        <TouchableOpacity
                          style={[styles.clearBtn, { borderColor: theme.expense, backgroundColor: theme.background }]}
                          onPress={handleClearBudget}
                          accessibilityRole="button"
                          accessibilityLabel="Clear budget limit"
                        >
                          <Ionicons name="trash-outline" size={16} color={theme.expense} style={{ marginRight: 4 }} />
                          <Text style={[styles.clearBtnText, { color: theme.expense }, bodyScale]}>Clear</Text>
                        </TouchableOpacity>
                      ) : null}

                      <TouchableOpacity
                        style={[styles.cancelBtn, { backgroundColor: theme.background, borderColor: theme.border }]}
                        onPress={closeModal}
                        accessibilityRole="button"
                        accessibilityLabel="Cancel"
                      >
                        <Text style={[styles.cancelText, { color: theme.textMuted }, bodyScale]}>Cancel</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[styles.saveBtn, { backgroundColor: theme.primary }]}
                        onPress={handleSaveBudget}
                        accessibilityRole="button"
                        accessibilityLabel="Save budget limit"
                      >
                        <Text style={[styles.saveText, bodyScale]}>Save Limit</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </ScrollView>
              </View>
            </View>
          </KeyboardAvoidingView>
        ) : null}
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  keyboardShell: { flex: 1 },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 },
  eyebrow: { fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 4 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  headerTitleBlock: { flex: 1 },
  headerTitle: { fontWeight: '800', letterSpacing: -0.5 },
  headerPill: { minHeight: 32, borderRadius: 999, borderWidth: 1, paddingHorizontal: 14, justifyContent: 'center' },
  headerPillText: { fontWeight: '700' },
  periodBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 4,
    minHeight: 46,
  },
  periodArrowBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  periodCenterBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 4,
  },
  periodSubtitle: { fontWeight: '700', flexShrink: 1 },
  todayBadge: { borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  todayBadgeText: { fontWeight: '700' },
  content: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 28 },
  heroPanel: { borderWidth: 1, borderRadius: 20, padding: 14, marginBottom: 14 },
  heroMetricGrid: { flexDirection: 'row', alignItems: 'stretch' },
  metricCell: { flex: 1 },
  metricDivider: { width: 1, marginHorizontal: 12 },
  metricLabel: { fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 },
  metricValue: { fontWeight: '800' },
  unbudgetedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  unbudgetedCopy: { flex: 1 },
  unbudgetedDivider: { width: 1, height: 28, marginHorizontal: 10 },
  unbudgetedLabel: { fontWeight: '600', marginBottom: 2 },
  unbudgetedValue: { fontWeight: '700' },
  miniStatRow: { flexDirection: 'row', marginTop: 12, gap: 8 },
  miniStatChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  miniStatValue: { fontWeight: '800', marginRight: 6 },
  miniStatLabel: { fontWeight: '700' },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 10 },
  sectionTitle: { fontWeight: '700' },
  sectionSubtitle: { fontWeight: '600' },
  emptyStateCard: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 24, alignItems: 'center' },
  emptyIconWrap: { width: 50, height: 50, borderRadius: 16, borderWidth: 1, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  emptyTitle: { fontWeight: '700', marginBottom: 4 },
  emptySubtitle: { textAlign: 'center', lineHeight: 18 },
  budgetCard: { borderWidth: 1, borderRadius: 20, padding: 14, marginBottom: 10 },
  cardHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  cardHeadingBlock: { flex: 1, marginRight: 10 },
  categoryTitle: { fontWeight: '700', marginBottom: 2 },
  categoryMeta: { fontWeight: '600' },
  editDotWrap: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  amountLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 10 },
  amountPrimary: { fontWeight: '800', flexShrink: 1, marginRight: 8 },
  amountSecondary: { fontWeight: '600', flexShrink: 1 },
  progressTrack: { height: 10, borderRadius: 999, overflow: 'hidden', borderWidth: 1, marginBottom: 10 },
  progressFill: { height: '100%', borderRadius: 999 },
  bottomMetaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statusChip: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, marginRight: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  statusChipText: { fontWeight: '700' },
  remainingText: { fontWeight: '700', textAlign: 'right', flexShrink: 1 },
  emptyBudgetStrip: { minHeight: 46, borderWidth: 1, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  emptyBudgetStripText: { marginLeft: 8, fontWeight: '700' },
  bottomSpacer: { height: 92 },
  modalOverlay: { flex: 1, justifyContent: 'center', padding: 16 },
  modalCard: { borderWidth: 1, borderRadius: 24, maxHeight: '90%', overflow: 'hidden' },
  modalScrollContent: { padding: 18 },
  budgetErrorText: { fontWeight: '600', marginTop: 6 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  modalIconWrap: { width: 44, height: 44, borderRadius: 14, borderWidth: 1, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  modalHeaderCopy: { flex: 1 },
  modalTitle: { fontWeight: '800', marginBottom: 2 },
  modalSubtitle: { lineHeight: 18 },
  modalCloseBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  modalInputLabel: { marginBottom: 8 },
  inputShell: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    minHeight: 52,
  },
  currencyPrefix: { fontWeight: '700', marginRight: 8 },
  input: { flex: 1, fontWeight: '700', minHeight: 44 },
  calculatorWrap: { marginTop: 12 },
  modalActions: { flexDirection: 'row', marginTop: 18, gap: 8 },
  clearBtn: {
    minHeight: 46,
    borderRadius: 14,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
    paddingHorizontal: 14,
  },
  clearBtnText: { fontWeight: '700' },
  cancelBtn: { flex: 1, minHeight: 46, borderRadius: 14, borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
  saveBtn: { flex: 1.3, minHeight: 46, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  cancelText: { fontWeight: '700' },
  saveText: { fontWeight: '800', color: '#fff' },
});
