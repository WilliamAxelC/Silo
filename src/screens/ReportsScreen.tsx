import React, { useState, useMemo, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, LayoutAnimation } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PieChart } from 'react-native-gifted-charts';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTransactionStore } from '../store/useTransactionStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useMonthlySummary } from '../hooks/useMonthlySummary';
import { useAppTheme } from '../theme/useAppTheme';
import { formatCompactAmount, formatDisplayCurrency } from '../features/transactions/amount';
import {
  formatCachedLocaleDate,
  formatPeriodLabel,
  getPeriodBounds,
  isSamePeriod,
  shiftPeriod,
} from '../features/transactions/periods';
import { UNCATEGORIZED_EXPENSE_LABEL } from '../features/transactions/constants';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NavigationProps } from '../navigation/types';

const EXPENSE_PALETTE = [
  '#e11d48',
  '#ea580c',
  '#d97706',
  '#7c3aed',
  '#0284c7',
  '#059669',
  '#ec4899',
  '#0d9488',
  '#4f46e5',
  '#b45309',
  '#475569',
];
const INCOME_PALETTE = ['#10b981', '#0284c7', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4', '#6366f1', '#84cc16'];

function hashCategoryName(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export type ReportGroupBy = 'category' | 'account' | 'tag';

const REPORT_GROUPS: Array<{ key: ReportGroupBy; label: string; heading: string }> = [
  { key: 'category', label: 'Category', heading: 'CATEGORY' },
  { key: 'account', label: 'Account', heading: 'ACCOUNT' },
  { key: 'tag', label: 'Tag', heading: 'TAG' },
];

/** The breakdown group(s) a transaction belongs to; a transaction with several tags joins each tag. */
export function reportGroupKeys(
  tx: { category?: string; walletId?: number; tags?: string[] },
  groupBy: ReportGroupBy,
  walletNames: Map<number, string>
): string[] {
  if (groupBy === 'account') return [walletNames.get(tx.walletId ?? -1) ?? 'Unknown account'];
  if (groupBy === 'tag') return tx.tags && tx.tags.length > 0 ? tx.tags.map((t) => `#${t}`) : ['No tag'];
  return [tx.category || UNCATEGORIZED_EXPENSE_LABEL];
}

export const getCategoryColor = (categoryName: string, type: 'expense' | 'income'): string => {
  const palette = type === 'expense' ? EXPENSE_PALETTE : INCOME_PALETTE;
  const normalized = (categoryName || '').trim().toLowerCase();
  const index = hashCategoryName(normalized) % palette.length;
  return palette[index];
};

export const ReportsScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const fetchTransactions = useTransactionStore((state) => state.fetchTransactions);
  const transactionsList = useTransactionStore((state) => state.transactionsList);
  const wallets = useTransactionStore((state) => state.wallets);
  const theme = useAppTheme();
  const currencyCode = useSettingsStore((state) => state.currencyCode);
  const useThousandsSeparator = useSettingsStore((state) => state.useThousandsSeparator);
  const showIncomeInReportsFirst = useSettingsStore((state) => state.showIncomeInReportsFirst);
  const isLoaded = useSettingsStore((state) => state.isLoaded);
  const dateFormat = useSettingsStore((state) => state.dateFormat);
  const monthStartDay = useSettingsStore((state) => state.monthStartDay);
  const locale = dateFormat || 'en-GB';

  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [reportType, setReportType] = useState<'expense' | 'income'>(showIncomeInReportsFirst ? 'income' : 'expense');
  const hasUserToggledReportTypeRef = useRef(false);
  const hasSyncedInitialReportTypeRef = useRef(false);
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});
  const [selectedCategoryName, setSelectedCategoryName] = useState<string | null>(null);
  /** What the breakdown and chart split by. */
  const [groupBy, setGroupBy] = useState<ReportGroupBy>('category');

  useEffect(() => {
    if (isLoaded && !hasSyncedInitialReportTypeRef.current && !hasUserToggledReportTypeRef.current) {
      setReportType(showIncomeInReportsFirst ? 'income' : 'expense');
      hasSyncedInitialReportTypeRef.current = true;
    }
  }, [isLoaded, showIncomeInReportsFirst]);

  useFocusEffect(
    React.useCallback(() => {
      const state = useTransactionStore.getState();
      if (!state.hasLoadedTransactions || state.transactionsDirty) {
        void fetchTransactions();
      }
    }, [fetchTransactions])
  );

  const changeMonth = (offset: number) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCurrentDate((prev) => shiftPeriod(prev, offset, monthStartDay));
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

  const { currentMonthData, totalIncome, totalExpense, balance, periodBounds } = useMonthlySummary(currentDate);

  const filteredTransactions = useMemo(() => {
    return currentMonthData.filter(
      (tx) => tx.type !== 'transfer' && (reportType === 'expense' ? (tx.totalAmount || 0) < 0 : (tx.totalAmount || 0) > 0)
    );
  }, [currentMonthData, reportType]);

  const totalForType = reportType === 'expense' ? totalExpense : totalIncome;

  const walletNames = useMemo(() => new Map(wallets.map((w) => [w.id, w.name])), [wallets]);
  const categoryData = useMemo(() => {
    return filteredTransactions.reduce((acc, curr) => {
      for (const key of reportGroupKeys(curr, groupBy, walletNames)) {
        if (!acc[key]) {
          acc[key] = { total: 0, items: [] };
        }
        acc[key].total += Math.abs(curr.totalAmount);
        acc[key].items.push(curr);
      }
      return acc;
    }, {} as Record<string, { total: number; items: typeof filteredTransactions }>);
  }, [filteredTransactions, groupBy, walletNames]);

  const chartData = useMemo(() => {
    return Object.keys(categoryData)
      .map((key) => {
        const total = categoryData[key].total;
        const rawPercentage = totalForType > 0 ? (total / totalForType) * 100 : 0;
        const isFocused = selectedCategoryName === key;

        return {
          value: total,
          color: getCategoryColor(key, reportType),
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
  const isCurrentMonthNow = isSamePeriod(currentDate, new Date(), monthStartDay);
  const periodLabel = formatPeriodLabel(periodBounds, locale);
  const compactPeriodLabel = formatPeriodLabel(periodBounds, locale, { compact: true });

  const monthlyTrend = useMemo(() => {
    const periods: Array<{
      key: string;
      anchor: Date;
      label: string;
      startMs: number;
      endMs: number;
      income: number;
      expense: number;
      isSelected: boolean;
    }> = [];

    for (let offset = -5; offset <= 0; offset += 1) {
      const anchor = offset === 0 ? currentDate : shiftPeriod(currentDate, offset, monthStartDay);
      const bounds = getPeriodBounds(anchor, monthStartDay);
      const label = formatCachedLocaleDate(bounds.start, locale, { month: 'short' });
      periods.push({
        key: `${bounds.startMs}`,
        anchor,
        label,
        startMs: bounds.startMs,
        endMs: bounds.endMs,
        income: 0,
        expense: 0,
        isSelected: offset === 0,
      });
    }

    const windowStart = periods[0].startMs;
    const windowEnd = periods[periods.length - 1].endMs;

    for (let i = 0; i < transactionsList.length; i += 1) {
      const tx = transactionsList[i];
      if (!tx || tx.type === 'transfer' || typeof tx.date !== 'number') continue;
      if (tx.date < windowStart || tx.date > windowEnd) continue;
      for (let p = 0; p < periods.length; p += 1) {
        if (tx.date >= periods[p].startMs && tx.date <= periods[p].endMs) {
          const amt = tx.totalAmount || 0;
          if (amt > 0) periods[p].income += amt;
          else if (amt < 0) periods[p].expense += Math.abs(amt);
          break;
        }
      }
    }

    const maxVal = periods.reduce((m, item) => Math.max(m, item.income, item.expense), 0);
    return { periods, maxVal };
  }, [transactionsList, currentDate, monthStartDay, locale]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
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
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Jump to current month"
          >
            <Text style={[styles.monthText, { color: theme.text, fontSize: theme.scaleFont(17) }]} numberOfLines={1} adjustsFontSizeToFit>
              {periodLabel}
            </Text>
            {!isCurrentMonthNow && (
              <View style={[styles.todayBadge, { backgroundColor: theme.primaryMuted }]}>
                <Text style={[styles.todayBadgeText, { color: theme.primary, fontSize: theme.scaleFont(10) }]}>
                  Today
                </Text>
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
            hitSlop={{ top: 4, bottom: 4, left: 0, right: 0 }}
            onPress={() => {
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              hasUserToggledReportTypeRef.current = true;
              setReportType('expense');
              setExpandedCategories({});
              setSelectedCategoryName(null);
            }}
            accessibilityRole="button"
            accessibilityLabel="Show expense reports"
          >
            <Text
              style={[
                styles.toggleText,
                { color: reportType === 'expense' ? theme.onPrimary : theme.textMuted, fontSize: theme.scaleFont(13) },
              ]}
            >
              Expenses
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.toggleBtn,
              reportType === 'income' ? { backgroundColor: theme.income } : { backgroundColor: 'transparent' },
            ]}
            hitSlop={{ top: 4, bottom: 4, left: 0, right: 0 }}
            onPress={() => {
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              hasUserToggledReportTypeRef.current = true;
              setReportType('income');
              setExpandedCategories({});
              setSelectedCategoryName(null);
            }}
            accessibilityRole="button"
            accessibilityLabel="Show income reports"
          >
            <Text
              style={[
                styles.toggleText,
                { color: reportType === 'income' ? theme.onPrimary : theme.textMuted, fontSize: theme.scaleFont(13) },
              ]}
            >
              Income
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Main Scroll Content */}
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: 14, paddingBottom: 28 }}>
        {/* Group by: category / account / tag */}
        <View style={styles.groupByRow} testID="reports-group-by">
          <Text style={[styles.groupByLabel, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>Group by</Text>
          {REPORT_GROUPS.map((option) => {
            const selected = groupBy === option.key;
            return (
              <TouchableOpacity
                key={option.key}
                style={[
                  styles.groupByChip,
                  { borderColor: selected ? theme.primary : theme.border, backgroundColor: selected ? theme.primaryMuted : 'transparent' },
                ]}
                onPress={() => {
                  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                  setGroupBy(option.key);
                  setExpandedCategories({});
                  setSelectedCategoryName(null);
                }}
                accessibilityRole="button"
                accessibilityLabel={`Group by ${option.label}`}
                accessibilityState={{ selected }}
              >
                <Text style={{ color: selected ? theme.primary : theme.text, fontSize: theme.scaleFont(13), fontWeight: '700' }}>
                  {option.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Month Summary KPI Bar */}
        <View style={[styles.summaryCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.summaryCol}>
            <Text style={[styles.summaryLabel, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>Income</Text>
            <Text style={[styles.summaryValue, { color: theme.income, fontSize: theme.scaleFont(13) }]}>
              {formatDisplayCurrency(totalIncome || 0, currencyCode, useThousandsSeparator)}
            </Text>
          </View>
          <View style={[styles.summaryDivider, { backgroundColor: theme.border }]} />
          <View style={styles.summaryCol}>
            <Text style={[styles.summaryLabel, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>Expense</Text>
            <Text style={[styles.summaryValue, { color: theme.expense, fontSize: theme.scaleFont(13) }]}>
              {formatDisplayCurrency(totalExpense || 0, currencyCode, useThousandsSeparator)}
            </Text>
          </View>
          <View style={[styles.summaryDivider, { backgroundColor: theme.border }]} />
          <View style={styles.summaryCol}>
            <Text style={[styles.summaryLabel, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>Net Flow</Text>
            <Text style={[styles.summaryValue, { color: (balance || 0) >= 0 ? theme.income : theme.expense, fontSize: theme.scaleFont(13) }]}>
              {formatDisplayCurrency(balance || 0, currencyCode, useThousandsSeparator)}
            </Text>
          </View>
        </View>

        {/* Donut Pie Chart */}
        <View style={styles.chartContainer}>
          {totalForType > 0 ? (
            <>
              <PieChart
                donut
                showText
                radius={96}
                innerRadius={64}
                data={chartData}
                backgroundColor={theme.background}
                textColor="#ffffff"
                textSize={theme.scaleFont(10)}
                fontWeight="700"
                isAnimated
                animationDuration={600}
                centerLabelComponent={() => (
                  <View style={{ justifyContent: 'center', alignItems: 'center', paddingHorizontal: 6 }}>
                    <Text
                      style={{ fontSize: theme.scaleFont(16), color: theme.text, fontWeight: '800' }}
                      adjustsFontSizeToFit
                      numberOfLines={1}
                    >
                      {formatDisplayCurrency(totalForType || 0, currencyCode, useThousandsSeparator)}
                    </Text>
                    <Text
                      style={{ fontSize: theme.scaleFont(11), color: theme.textMuted, fontWeight: '600', marginTop: 2 }}
                    >
                      Total {reportType === 'expense' ? 'Expense' : 'Income'}
                    </Text>
                  </View>
                )}
              />
              <View style={styles.donutLegendWrap} testID="reports-donut-legend">
                {chartData.map((slice) => (
                  <TouchableOpacity
                    key={`legend-${slice.category}`}
                    style={[
                      styles.donutLegendPill,
                      {
                        backgroundColor: slice.focused ? theme.primaryMuted : theme.surface,
                        borderColor: slice.focused ? theme.primary : theme.border,
                      },
                    ]}
                    onPress={() => toggleCategory(slice.category)}
                    accessibilityRole="button"
                    accessibilityLabel={`${slice.category} ${slice.text}`}
                  >
                    <View style={[styles.donutLegendDot, { backgroundColor: slice.color }]} />
                    <Text
                      style={[styles.donutLegendText, { color: theme.text, fontSize: theme.scaleFont(11) }]}
                      numberOfLines={1}
                    >
                      {slice.category} · {slice.text}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          ) : (
            <View style={[styles.emptyChartCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Ionicons name="pie-chart-outline" size={36} color={theme.textMuted} style={{ marginBottom: 8 }} />
              <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(13), fontWeight: '600' }}>
                No {reportType} records for {compactPeriodLabel}.
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
              <Text
                style={{
                  color: theme.text,
                  fontSize: theme.scaleFont(13),
                  lineHeight: Math.round(theme.scaleFont(18)),
                }}
              >
                Top {reportType === 'expense' ? 'spending' : 'income'} was{' '}
                <Text style={{ fontWeight: '800' }}>{topCategory.category}</Text> —{' '}
                <Text style={{ fontWeight: '800' }}>
                  {formatDisplayCurrency(topCategory.value || 0, currencyCode, useThousandsSeparator)}
                </Text>{' '}
                ({topCategory.text} of total).
              </Text>
            </View>
          </View>
        )}

        {/* 6-Month Income vs Expense Trend */}
        {monthlyTrend.maxVal > 0 ? (
          <View
            testID="reports-trend-chart"
            style={[styles.trendCard, { backgroundColor: theme.surface, borderColor: theme.border }]}
          >
            <View style={styles.trendHeader}>
              <Text style={[styles.trendTitle, { color: theme.text, fontSize: theme.scaleFont(13) }]}>
                6-Month Trend
              </Text>
              <View style={styles.trendLegend}>
                <View style={styles.trendLegendItem}>
                  <View style={[styles.trendLegendDot, { backgroundColor: theme.income }]} />
                  <Text style={[styles.trendLegendLabel, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
                    Income
                  </Text>
                </View>
                <View style={styles.trendLegendItem}>
                  <View style={[styles.trendLegendDot, { backgroundColor: theme.expense }]} />
                  <Text style={[styles.trendLegendLabel, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
                    Expense
                  </Text>
                </View>
              </View>
            </View>
            <Text style={[styles.trendScaleHint, { color: theme.textMuted, fontSize: theme.scaleFont(10) }]}>
              Peak: {formatCompactAmount(monthlyTrend.maxVal, currencyCode)}
            </Text>
            <View style={styles.trendBarsRow}>
              {monthlyTrend.periods.map((col) => {
                const incomeHeight = col.income > 0 ? Math.max(4, Math.round((col.income / monthlyTrend.maxVal) * 76)) : 0;
                const expenseHeight = col.expense > 0 ? Math.max(4, Math.round((col.expense / monthlyTrend.maxVal) * 76)) : 0;
                return (
                  <TouchableOpacity
                    key={col.key}
                    style={[
                      styles.trendCol,
                      col.isSelected && { backgroundColor: theme.primaryMuted, borderRadius: 10 },
                    ]}
                    onPress={() => {
                      if (!col.isSelected) {
                        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                        setCurrentDate(col.anchor);
                        setExpandedCategories({});
                        setSelectedCategoryName(null);
                      }
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`${col.label}: income ${formatDisplayCurrency(col.income, currencyCode, useThousandsSeparator)}, expense ${formatDisplayCurrency(col.expense, currencyCode, useThousandsSeparator)}`}
                  >
                    <View style={styles.trendBarPair}>
                      <View
                        style={[
                          styles.trendBar,
                          { height: incomeHeight, backgroundColor: theme.income },
                        ]}
                      />
                      <View
                        style={[
                          styles.trendBar,
                          { height: expenseHeight, backgroundColor: theme.expense },
                        ]}
                      />
                    </View>
                    <Text
                      style={[
                        styles.trendColLabel,
                        {
                          color: col.isSelected ? theme.primary : theme.textMuted,
                          fontWeight: col.isSelected ? '800' : '600',
                          fontSize: theme.scaleFont(11),
                        },
                      ]}
                    >
                      {col.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        ) : null}

        {/* Collapsible Category Breakdown Drill-down */}
        {chartData.length > 0 ? (
          <View style={styles.legendContainer}>
            <Text style={[styles.breakdownHeaderTitle, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
              {REPORT_GROUPS.find((g) => g.key === groupBy)?.heading} BREAKDOWN ({chartData.length})
            </Text>
            {groupBy === 'tag' ? (
              <Text style={[styles.breakdownHeaderTitle, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
                A transaction with several tags counts under each of them.
              </Text>
            ) : null}

          {chartData.map((item) => {
            const isExpanded = expandedCategories[item.category];

            return (
              <View
                key={item.category}
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
                      <Text style={[styles.legendCategory, { color: theme.text, fontSize: theme.scaleFont(15) }]} numberOfLines={1}>
                        {item.category}
                      </Text>
                    </View>
                    <View style={styles.legendHeaderRight}>
                      <Text style={[styles.legendAmount, { color: theme.text, fontSize: theme.scaleFont(15) }]}>
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
                    <Text style={[styles.percentageText, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
                      {item.text}
                    </Text>
                  </View>
                </TouchableOpacity>

                {/* Nested Transaction List */}
                {isExpanded && (
                  <View style={[styles.transactionsList, { borderTopColor: theme.border }]}>
                    <Text
                      style={[styles.nestedTransactionsHeader, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}
                    >
                      {item.items.length} {item.items.length === 1 ? 'transaction' : 'transactions'}
                    </Text>
                    {item.items.map((tx, txIndex) => (
                      <TouchableOpacity
                        key={tx.id ?? txIndex}
                        activeOpacity={0.7}
                        onPress={() => navigation.navigate('AddTransactionStack', { transactionId: tx.id })}
                        accessibilityRole="button"
                        accessibilityLabel={`${tx.merchantName || 'Unnamed'}, ${tx.totalAmount}`}
                        style={[
                          styles.transactionItem,
                          txIndex < item.items.length - 1 && { borderBottomWidth: 1, borderBottomColor: theme.borderLight },
                        ]}
                      >
                        <View style={{ flex: 1, marginRight: 8 }}>
                          <Text style={[styles.txMerchant, { color: theme.text, fontSize: theme.scaleFont(13) }]} numberOfLines={1}>
                            {tx.merchantName || 'Unnamed'}
                          </Text>
                          <Text style={[styles.txDate, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
                            {formatCachedLocaleDate(tx.date, locale, {
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
                            {
                              color: reportType === 'income' ? theme.income : theme.text,
                              fontSize: theme.scaleFont(13),
                            },
                          ]}
                        >
                          {reportType === 'income' ? '+' : ''}
                          {formatDisplayCurrency(Math.abs(tx.totalAmount), currencyCode, useThousandsSeparator)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            );
          })}
          </View>
        ) : null}
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
  monthTextWrap: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginHorizontal: 4 },
  monthText: { fontSize: 17, fontWeight: '700', flexShrink: 1 },
  todayBadge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  todayBadgeText: { fontSize: 10, fontWeight: '700' },
  arrowBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  toggleContainer: {
    flexDirection: 'row',
    marginHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  toggleBtn: { flex: 1, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  groupByRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, marginBottom: 12 },
  groupByLabel: { fontWeight: '700', marginRight: 2 },
  groupByChip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 14, minHeight: 36, justifyContent: 'center' },
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
  donutLegendWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
    marginTop: 12,
    paddingHorizontal: 14,
  },
  donutLegendPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    maxWidth: '48%',
  },
  donutLegendDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  donutLegendText: { fontWeight: '600', flexShrink: 1 },
  trendCard: {
    marginHorizontal: 14,
    marginBottom: 16,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
  },
  trendHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  trendTitle: { fontWeight: '700' },
  trendLegend: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  trendLegendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  trendLegendDot: { width: 8, height: 8, borderRadius: 4 },
  trendLegendLabel: { fontWeight: '600' },
  trendScaleHint: { marginBottom: 8, fontWeight: '500' },
  trendBarsRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 4 },
  trendCol: { flex: 1, alignItems: 'center', paddingVertical: 6, minHeight: 108, justifyContent: 'flex-end' },
  trendBarPair: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 78 },
  trendBar: { width: 10, borderRadius: 4 },
  trendColLabel: { marginTop: 6 },
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
  percentageText: { fontSize: 12, fontWeight: '700', minWidth: 36, textAlign: 'right' },
  transactionsList: { borderTopWidth: 1, paddingHorizontal: 14, paddingBottom: 10, paddingTop: 8 },
  nestedTransactionsHeader: { fontSize: 11, fontWeight: '700', marginBottom: 6 },
  transactionItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 44,
    paddingVertical: 9,
  },
  txMerchant: { fontSize: 13, fontWeight: '600' },
  txDate: { fontSize: 11, marginTop: 1 },
  txAmount: { fontSize: 13, fontWeight: '700' },
});