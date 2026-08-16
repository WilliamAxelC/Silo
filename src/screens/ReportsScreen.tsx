import React, { useState, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, LayoutAnimation, Platform, UIManager } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PieChart } from 'react-native-gifted-charts';
import { Ionicons } from '@expo/vector-icons';
import { addMonths, isSameMonth } from 'date-fns';

import { useTransactionStore } from '../store/useTransactionStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useMonthlySummary } from '../hooks/useMonthlySummary';
import { useAppTheme } from '../theme/useAppTheme';
import { formatDisplayCurrency } from '../features/transactions/amount';
import { useFocusEffect } from '@react-navigation/native';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const EXPENSE_PALETTE = ['#e11d48', '#ea580c', '#d97706', '#7c3aed', '#0284c7', '#059669', '#ec4899', '#475569'];
const INCOME_PALETTE = ['#10b981', '#059669', '#0d9488', '#0284c7', '#3b82f6', '#6366f1', '#8b5cf6', '#14b8a6'];

const getCategoryColor = (index: number, type: 'expense' | 'income') => {
  const palette = type === 'expense' ? EXPENSE_PALETTE : INCOME_PALETTE;
  return palette[index % palette.length];
};

export const ReportsScreen = () => {
  const fetchTransactions = useTransactionStore((state) => state.fetchTransactions);
  const theme = useAppTheme();
  const currencyCode = useSettingsStore((state) => state.currencyCode);
  const useThousandsSeparator = useSettingsStore((state) => state.useThousandsSeparator);
  const showIncomeInReportsFirst = useSettingsStore((state) => state.showIncomeInReportsFirst);
  const dateFormat = useSettingsStore((state) => state.dateFormat);

  const [currentDate, setCurrentDate] = useState(new Date());
  const [reportType, setReportType] = useState<'expense' | 'income'>(showIncomeInReportsFirst ? 'income' : 'expense');
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});
  const [selectedCategoryName, setSelectedCategoryName] = useState<string | null>(null);

  useFocusEffect(
    React.useCallback(() => {
      fetchTransactions();
    }, [fetchTransactions])
  );

  const changeMonth = (offset: number) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCurrentDate((prev) => addMonths(prev, offset));
    setExpandedCategories({});
    setSelectedCategoryName(null);
  };

  const resetToCurrentMonth = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCurrentDate(new Date());
    setExpandedCategories({});
    setSelectedCategoryName(null);
  };

  const toggleCategory = (category: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedCategories((prev) => ({ ...prev, [category]: !prev[category] }));
    setSelectedCategoryName((prev) => (prev === category ? null : category));
  };

  const { currentMonthData, totalIncome, totalExpense, balance } = useMonthlySummary(currentDate);

  const filteredTransactions = useMemo(() => {
    return currentMonthData.filter((tx) =>
      reportType === 'expense' ? (tx.totalAmount || 0) < 0 : (tx.totalAmount || 0) > 0
    );
  }, [currentMonthData, reportType]);

  const totalForType = reportType === 'expense' ? totalExpense : totalIncome;

  const categoryData = useMemo(() => {
    return filteredTransactions.reduce((acc, curr) => {
      const cat = curr.category || 'General';
      if (!acc[cat]) {
        acc[cat] = { total: 0, items: [] };
      }
      acc[cat].total += Math.abs(curr.totalAmount);
      acc[cat].items.push(curr);
      return acc;
    }, {} as Record<string, { total: number; items: typeof filteredTransactions }>);
  }, [filteredTransactions]);

  const chartData = useMemo(() => {
    return Object.keys(categoryData)
      .map((key, index) => {
        const total = categoryData[key].total;
        const rawPercentage = totalForType > 0 ? (total / totalForType) * 100 : 0;
        const isFocused = selectedCategoryName === key;

        return {
          value: total,
          color: getCategoryColor(index, reportType),
          text: `${rawPercentage.toFixed(0)}%`,
          numericPercentage: rawPercentage,
          category: key,
          items: categoryData[key].items.sort((a, b) => b.date - a.date),
          focused: isFocused,
          shiftTextX: 0,
        };
      })
      .sort((a, b) => b.value - a.value);
  }, [categoryData, totalForType, reportType, selectedCategoryName]);

  const topCategory = chartData.length > 0 ? chartData[0] : null;
  const isCurrentMonthNow = isSameMonth(currentDate, new Date());

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      {/* Pinned Month Header & Segmented Controls */}
      <View style={[styles.pinnedHeader, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <View style={styles.monthSelector}>
          <TouchableOpacity
            onPress={() => changeMonth(-1)}
            style={styles.arrowBtn}
            accessibilityRole="button"
            accessibilityLabel="Previous month"
          >
            <Ionicons name="chevron-back" size={22} color={theme.text} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.monthTextWrap}
            onPress={resetToCurrentMonth}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Jump to current month"
          >
            <Text style={[styles.monthText, { color: theme.text }]}>
              {currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </Text>
            {!isCurrentMonthNow && (
              <View style={[styles.todayBadge, { backgroundColor: theme.primaryMuted }]}>
                <Text style={[styles.todayBadgeText, { color: theme.primary }]}>Today</Text>
              </View>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => changeMonth(1)}
            style={styles.arrowBtn}
            accessibilityRole="button"
            accessibilityLabel="Next month"
          >
            <Ionicons name="chevron-forward" size={22} color={theme.text} />
          </TouchableOpacity>
        </View>

        {/* Income / Expense Toggle */}
        <View style={[styles.toggleContainer, { borderColor: theme.border, backgroundColor: theme.background }]}>
          <TouchableOpacity
            style={[
              styles.toggleBtn,
              reportType === 'expense' ? { backgroundColor: theme.expense } : { backgroundColor: 'transparent' },
            ]}
            onPress={() => {
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              setReportType('expense');
              setExpandedCategories({});
              setSelectedCategoryName(null);
            }}
            accessibilityRole="button"
            accessibilityLabel="Show expense reports"
          >
            <Text style={[styles.toggleText, { color: reportType === 'expense' ? '#fff' : theme.textMuted }]}>
              Expenses
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.toggleBtn,
              reportType === 'income' ? { backgroundColor: theme.income } : { backgroundColor: 'transparent' },
            ]}
            onPress={() => {
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              setReportType('income');
              setExpandedCategories({});
              setSelectedCategoryName(null);
            }}
            accessibilityRole="button"
            accessibilityLabel="Show income reports"
          >
            <Text style={[styles.toggleText, { color: reportType === 'income' ? '#fff' : theme.textMuted }]}>
              Income
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Main Scroll Content */}
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: 14, paddingBottom: 136 }}>
        {/* Month Summary KPI Bar */}
        <View style={[styles.summaryCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.summaryCol}>
            <Text style={[styles.summaryLabel, { color: theme.textMuted }]}>Income</Text>
            <Text style={[styles.summaryValue, { color: theme.income }]}>
              {formatDisplayCurrency(totalIncome || 0, currencyCode, useThousandsSeparator)}
            </Text>
          </View>
          <View style={[styles.summaryDivider, { backgroundColor: theme.border }]} />
          <View style={styles.summaryCol}>
            <Text style={[styles.summaryLabel, { color: theme.textMuted }]}>Expense</Text>
            <Text style={[styles.summaryValue, { color: theme.expense }]}>
              {formatDisplayCurrency(totalExpense || 0, currencyCode, useThousandsSeparator)}
            </Text>
          </View>
          <View style={[styles.summaryDivider, { backgroundColor: theme.border }]} />
          <View style={styles.summaryCol}>
            <Text style={[styles.summaryLabel, { color: theme.textMuted }]}>Net Flow</Text>
            <Text style={[styles.summaryValue, { color: (balance || 0) >= 0 ? theme.income : theme.expense }]}>
              {formatDisplayCurrency(balance || 0, currencyCode, useThousandsSeparator)}
            </Text>
          </View>
        </View>

        {/* Donut Pie Chart */}
        <View style={styles.chartContainer}>
          {totalForType > 0 ? (
            <PieChart
              donut
              radius={96}
              innerRadius={66}
              data={chartData}
              backgroundColor={theme.background}
              textColor="#ffffff"
              textSize={10}
              fontWeight="700"
              isAnimated
              animationDuration={600}
              centerLabelComponent={() => (
                <View style={{ justifyContent: 'center', alignItems: 'center', paddingHorizontal: 6 }}>
                  <Text
                    style={{ fontSize: 16, color: theme.text, fontWeight: '800' }}
                    adjustsFontSizeToFit
                    numberOfLines={1}
                  >
                    {formatDisplayCurrency(totalForType || 0, currencyCode, useThousandsSeparator)}
                  </Text>
                  <Text style={{ fontSize: 11, color: theme.textMuted, fontWeight: '600', marginTop: 2 }}>
                    Total {reportType === 'expense' ? 'Expense' : 'Income'}
                  </Text>
                </View>
              )}
            />
          ) : (
            <View style={[styles.emptyChartCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Ionicons name="pie-chart-outline" size={36} color={theme.textMuted} style={{ marginBottom: 8 }} />
              <Text style={{ color: theme.textMuted, fontSize: 13, fontWeight: '600' }}>
                No {reportType} records for {currentDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}.
              </Text>
            </View>
          )}
        </View>

        {/* Insight Callout */}
        {topCategory && (
          <View style={[styles.insightCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <View style={[styles.insightIconWrap, { backgroundColor: theme.primaryMuted }]}>
              <Ionicons name="sparkles" size={18} color={theme.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.text, fontSize: 13, lineHeight: 18 }}>
                Top {reportType === 'expense' ? 'spending' : 'income'} was{' '}
                <Text style={{ fontWeight: '800' }}>{topCategory.category}</Text> ({topCategory.text} of total).
              </Text>
            </View>
          </View>
        )}

        {/* Collapsible Category Breakdown Drill-down */}
        <View style={styles.legendContainer}>
          <Text style={[styles.breakdownHeaderTitle, { color: theme.textMuted }]}>
            CATEGORY BREAKDOWN ({chartData.length})
          </Text>

          {chartData.map((item, index) => {
            const isExpanded = expandedCategories[item.category];

            return (
              <View
                key={index}
                style={[
                  styles.legendCard,
                  { backgroundColor: theme.surface, borderColor: item.focused ? theme.primary : theme.border },
                ]}
              >
                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={() => toggleCategory(item.category)}
                  style={styles.legendTouchArea}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.category}, ${item.text}`}
                >
                  <View style={styles.legendHeader}>
                    <View style={styles.legendHeaderLeft}>
                      <View style={[styles.colorDot, { backgroundColor: item.color }]} />
                      <Text style={[styles.legendCategory, { color: theme.text }]} numberOfLines={1}>
                        {item.category}
                      </Text>
                    </View>
                    <View style={styles.legendHeaderRight}>
                      <Text style={[styles.legendAmount, { color: theme.text }]}>
                        {formatDisplayCurrency(item.value || 0, currencyCode, useThousandsSeparator)}
                      </Text>
                      <Ionicons
                        name={isExpanded ? 'chevron-up' : 'chevron-down'}
                        size={18}
                        color={theme.textMuted}
                        style={styles.chevron}
                      />
                    </View>
                  </View>

                  <View style={styles.progressRow}>
                    <View style={[styles.progressBarBackground, { backgroundColor: theme.border }]}>
                      <View
                        style={[
                          styles.progressBarFill,
                          { backgroundColor: item.color, width: `${Math.min(item.numericPercentage, 100)}%` },
                        ]}
                      />
                    </View>
                    <Text style={[styles.percentageText, { color: theme.textMuted }]}>{item.text}</Text>
                  </View>
                </TouchableOpacity>

                {/* Nested Transaction List */}
                {isExpanded && (
                  <View style={[styles.transactionsList, { borderTopColor: theme.border }]}>
                    <Text style={[styles.nestedTransactionsHeader, { color: theme.textMuted }]}>
                      {item.items.length} {item.items.length === 1 ? 'transaction' : 'transactions'}
                    </Text>
                    {item.items.map((tx, txIndex) => (
                      <View
                        key={tx.id ?? txIndex}
                        style={[
                          styles.transactionItem,
                          txIndex < item.items.length - 1 && { borderBottomWidth: 1, borderBottomColor: theme.borderLight },
                        ]}
                      >
                        <View style={{ flex: 1, marginRight: 8 }}>
                          <Text style={[styles.txMerchant, { color: theme.text }]} numberOfLines={1}>
                            {tx.merchantName || 'Unnamed'}
                          </Text>
                          <Text style={[styles.txDate, { color: theme.textMuted }]}>
                            {new Date(tx.date).toLocaleDateString(dateFormat || 'en-GB', {
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric',
                            })}
                            {tx.note ? ` · ${tx.note}` : ''}
                          </Text>
                        </View>
                        <Text
                          style={[
                            styles.txAmount,
                            { color: reportType === 'income' ? theme.income : theme.text },
                          ]}
                        >
                          {reportType === 'income' ? '+' : ''}
                          {formatDisplayCurrency(Math.abs(tx.totalAmount), currencyCode, useThousandsSeparator)}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            );
          })}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  pinnedHeader: { borderBottomWidth: 1, paddingBottom: 10 },
  monthSelector: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 8,
  },
  monthTextWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  monthText: { fontSize: 17, fontWeight: '700' },
  todayBadge: { borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  todayBadgeText: { fontSize: 10, fontWeight: '700' },
  arrowBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  toggleContainer: {
    flexDirection: 'row',
    marginHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  toggleBtn: { flex: 1, minHeight: 38, justifyContent: 'center', alignItems: 'center' },
  toggleText: { fontWeight: '700', fontSize: 13 },
  summaryCard: {
    flexDirection: 'row',
    marginHorizontal: 14,
    marginBottom: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
  },
  summaryCol: { alignItems: 'center', flex: 1 },
  summaryDivider: { width: 1, height: 28 },
  summaryLabel: { fontSize: 11, fontWeight: '600', marginBottom: 2 },
  summaryValue: { fontSize: 13, fontWeight: '800' },
  chartContainer: { alignItems: 'center', marginBottom: 16 },
  emptyChartCard: {
    width: '92%',
    paddingVertical: 32,
    borderWidth: 1,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  insightCard: {
    flexDirection: 'row',
    marginHorizontal: 14,
    marginBottom: 16,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    gap: 10,
  },
  insightIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  legendContainer: { paddingHorizontal: 14 },
  breakdownHeaderTitle: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginLeft: 4,
  },
  legendCard: { borderRadius: 16, marginBottom: 10, borderWidth: 1, overflow: 'hidden' },
  legendTouchArea: { padding: 14 },
  legendHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  legendHeaderLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 },
  legendHeaderRight: { flexDirection: 'row', alignItems: 'center' },
  colorDot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  legendCategory: { fontSize: 15, fontWeight: '700', flexShrink: 1 },
  legendAmount: { fontSize: 15, fontWeight: '800' },
  chevron: { marginLeft: 6 },
  progressRow: { flexDirection: 'row', alignItems: 'center' },
  progressBarBackground: { flex: 1, height: 6, borderRadius: 3, marginRight: 10, overflow: 'hidden' },
  progressBarFill: { height: '100%', borderRadius: 3 },
  percentageText: { fontSize: 12, fontWeight: '700', width: 36, textAlign: 'right' },
  transactionsList: { borderTopWidth: 1, paddingHorizontal: 14, paddingBottom: 10, paddingTop: 8 },
  nestedTransactionsHeader: { fontSize: 11, fontWeight: '700', marginBottom: 6 },
  transactionItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 9,
  },
  txMerchant: { fontSize: 13, fontWeight: '600' },
  txDate: { fontSize: 11, marginTop: 1 },
  txAmount: { fontSize: 13, fontWeight: '700' },
});