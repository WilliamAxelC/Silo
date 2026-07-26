import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PieChart } from 'react-native-gifted-charts';
import { Ionicons } from '@expo/vector-icons';
import { addMonths } from 'date-fns';

import { useTransactionStore } from '../store/useTransactionStore';
import { useMonthlySummary } from '../hooks/useMonthlySummary';
import { useAppTheme } from '../theme/useAppTheme';
import { useFocusEffect } from '@react-navigation/native';

const getCategoryColor = (index: number, type: 'expense' | 'income') => {
  const expenseColors = ['#e11d48', '#ea580c', '#d97706', '#7c3aed', '#0284c7', '#475569'];
  const incomeColors = ['#16a34a', '#059669', '#0d9488', '#0284c7', '#3b82f6', '#4f46e5'];
  const palette = type === 'expense' ? expenseColors : incomeColors;
  return palette[index % palette.length];
};

export const ReportsScreen = () => {
  const fetchTransactions = useTransactionStore((state) => state.fetchTransactions);
  const theme = useAppTheme();
  const [currentDate, setCurrentDate] = useState(new Date());
  
  const [reportType, setReportType] = useState<'expense' | 'income'>('expense');
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});

  useFocusEffect(
    React.useCallback(() => { fetchTransactions(); }, [])
  );

  const changeMonth = (offset: number) => {
    setCurrentDate(prev => addMonths(prev, offset));
    setExpandedCategories({}); 
  };

  const toggleCategory = (category: string) => {
    setExpandedCategories(prev => ({ ...prev, [category]: !prev[category] }));
  };

  const { currentMonthData, totalIncome, totalExpense, balance } = useMonthlySummary(currentDate);

  const filteredTransactions = currentMonthData.filter(tx => 
    reportType === 'expense' ? (tx.totalAmount || 0) < 0 : (tx.totalAmount || 0) > 0
  );

  const totalForType = reportType === 'expense' ? totalExpense : totalIncome;

  const categoryData = filteredTransactions.reduce((acc, curr) => {
    const cat = curr.category || 'General';
    if (!acc[cat]) { acc[cat] = { total: 0, items: [] }; }
    acc[cat].total += Math.abs(curr.totalAmount);
    acc[cat].items.push(curr);
    return acc;
  }, {} as Record<string, { total: number, items: typeof filteredTransactions }>);

  const chartData = Object.keys(categoryData).map((key, index) => {
    const total = categoryData[key].total;
    const rawPercentage = totalForType > 0 ? (total / totalForType) * 100 : 0;
    return {
      value: total,
      color: getCategoryColor(index, reportType),
      text: `${rawPercentage.toFixed(0)}%`,
      numericPercentage: rawPercentage,
      category: key,
      items: categoryData[key].items.sort((a, b) => b.date - a.date), 
    };
  }).sort((a, b) => b.value - a.value);

  const topCategory = chartData.length > 0 ? chartData[0] : null;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      
      {/* === 1. PINNED HEADER AREA === */}
      <View style={[styles.pinnedHeader, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        
        {/* Month Selector */}
        <View style={styles.monthSelector}>
          <TouchableOpacity onPress={() => changeMonth(-1)} style={styles.arrowBtn}>
            <Ionicons name="chevron-back" size={24} color={theme.textMuted} />
          </TouchableOpacity>
          <Text style={[styles.monthText, { color: theme.text }]}>
            {currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
          </Text>
          <TouchableOpacity onPress={() => changeMonth(1)} style={styles.arrowBtn}>
            <Ionicons name="chevron-forward" size={24} color={theme.textMuted} />
          </TouchableOpacity>
        </View>

        {/* The Income / Expense Toggle */}
        <View style={[styles.toggleContainer, { borderColor: theme.border }]}>
          <TouchableOpacity 
            style={[styles.toggleBtn, reportType === 'expense' ? { backgroundColor: theme.expense } : { backgroundColor: 'transparent' }]}
            onPress={() => { setReportType('expense'); setExpandedCategories({}); }}
          >
            <Text style={[styles.toggleText, { color: reportType === 'expense' ? '#fff' : theme.textMuted }]}>Expenses</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={[styles.toggleBtn, reportType === 'income' ? { backgroundColor: theme.income } : { backgroundColor: 'transparent' }]}
            onPress={() => { setReportType('income'); setExpandedCategories({}); }}
          >
            <Text style={[styles.toggleText, { color: reportType === 'income' ? '#fff' : theme.textMuted }]}>Income</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* === 2. SCROLLABLE DATA AREA === */}
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: 16, paddingBottom: 136 }}>
        
        {/* High-Level Summary Card (Now scrolls out of the way to save space) */}
        <View style={[styles.summaryCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.summaryCol}>
            <Text style={[styles.summaryLabel, { color: theme.textMuted }]}>Income</Text>
            <Text style={[styles.summaryValue, { color: theme.income }]}>{(totalIncome || 0).toLocaleString()}</Text>
          </View>
          <View style={styles.summaryCol}>
            <Text style={[styles.summaryLabel, { color: theme.textMuted }]}>Expense</Text>
            <Text style={[styles.summaryValue, { color: theme.expense }]}>{(totalExpense || 0).toLocaleString()}</Text>
          </View>
          <View style={styles.summaryCol}>
            <Text style={[styles.summaryLabel, { color: theme.textMuted }]}>Balance</Text>
            <Text style={[styles.summaryValue, { color: (balance || 0) >= 0 ? theme.income : theme.expense }]}>{(balance || 0).toLocaleString()}</Text>
          </View>
        </View>

        {/* Compacted Pie Chart */}
        <View style={styles.chartContainer}>
          {totalForType > 0 ? (
            <PieChart
              donut
              radius={95}      // Shrink radius slightly
              innerRadius={65} // Shrink inner radius to match
              data={chartData}
              backgroundColor={theme.background}
              centerLabelComponent={() => (
                <View style={{justifyContent: 'center', alignItems: 'center', paddingHorizontal: 8}}>
                    <Text style={{fontSize: 18, color: theme.text, fontWeight: 'bold'}} adjustsFontSizeToFit numberOfLines={1}>
                      {(totalForType || 0).toLocaleString()}
                    </Text>
                    <Text style={{fontSize: 12, color: theme.textMuted}}>
                      Total {reportType === 'expense' ? 'Expense' : 'Income'}
                    </Text>
                  </View>
              )}
            />
          ) : (
            <Text style={{color: theme.textMuted, marginTop: 40}}>No {reportType}s to chart this month.</Text>
          )}
        </View>

        {/* Key Insight Callout */}
        {topCategory && (
          <View style={[styles.insightCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Ionicons name="bulb-outline" size={24} color={theme.primary} style={{ marginRight: 12 }} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.text, fontSize: 14 }}>
                Your highest {reportType === 'expense' ? 'expense' : 'income source'} was <Text style={{ fontWeight: 'bold' }}>{topCategory.category}</Text>, making up <Text style={{ fontWeight: 'bold' }}>{topCategory.text}</Text> of the total.
              </Text>
            </View>
          </View>
        )}

        {/* Collapsible Category Breakdown */}
        <View style={styles.legendContainer}>
          {chartData.map((item, index) => {
            const isExpanded = expandedCategories[item.category];

            return (
              <View key={index} style={[styles.legendCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <TouchableOpacity activeOpacity={0.7} onPress={() => toggleCategory(item.category)}>
                  <View style={styles.legendHeader}>
                    <View style={styles.legendHeaderLeft}>
                      <View style={[styles.colorDot, { backgroundColor: item.color }]} />
                      <Text style={[styles.legendCategory, { color: theme.text }]}>{item.category}</Text>
                    </View>
                    <View style={styles.legendHeaderRight}>
                      <Text style={[styles.legendAmount, { color: theme.text }]}>Rp {(item.value || 0).toLocaleString()}</Text>
                      <Ionicons name={isExpanded ? "chevron-up" : "chevron-down"} size={20} color={theme.textMuted} style={styles.chevron} />
                    </View>
                  </View>

                  <View style={styles.progressRow}>
                    <View style={[styles.progressBarBackground, { backgroundColor: theme.border }]}>
                      <View 
                        style={[styles.progressBarFill, { backgroundColor: item.color, width: `${item.numericPercentage}%` }]} 
                      />
                    </View>
                    <Text style={[styles.percentageText, { color: theme.textMuted }]}>{item.text}</Text>
                  </View>
                </TouchableOpacity>

                {isExpanded && (
                  <View style={[styles.transactionsList, { borderTopColor: theme.border }]}>
                    {item.items.map((tx, txIndex) => (
                      <View key={txIndex} style={styles.transactionItem}>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.txMerchant, { color: theme.text }]} numberOfLines={1}>{tx.merchantName}</Text>
                          <Text style={[styles.txDate, { color: theme.textMuted }]}>
                            {new Date(tx.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                          </Text>
                        </View>
                        <Text style={[styles.txAmount, { color: reportType === 'income' ? theme.income : theme.text }]}>
                          {reportType === 'income' ? '+' : ''}Rp {Math.abs(tx.totalAmount).toLocaleString()}
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
  
  // PINNED HEADER STYLES
  pinnedHeader: { borderBottomWidth: 1, paddingBottom: 12 },
  monthSelector: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12 },
  monthText: { fontSize: 18, fontWeight: '600' },
  arrowBtn: { padding: 4 },
  
  // TOGGLE STYLES
  toggleContainer: { flexDirection: 'row', marginHorizontal: 16, borderRadius: 8, borderWidth: 1, overflow: 'hidden' },
  toggleBtn: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  toggleText: { fontWeight: 'bold', fontSize: 14 },
  
  // SCROLLABLE SUMMARY CARD
  summaryCard: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 24, padding: 16, borderRadius: 8, borderWidth: 1, justifyContent: 'space-between' },
  summaryCol: { alignItems: 'center' },
  summaryLabel: { fontSize: 12, marginBottom: 4 },
  summaryValue: { fontSize: 14, fontWeight: 'bold' },
  
  chartContainer: { alignItems: 'center', marginBottom: 24 },
  
  // INSIGHT CARD
  insightCard: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 24, padding: 16, borderRadius: 8, borderWidth: 1, alignItems: 'center' },

  legendContainer: { paddingHorizontal: 16 },
  legendCard: { padding: 16, borderRadius: 12, marginBottom: 12, borderWidth: 1 },
  legendHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  legendHeaderLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  legendHeaderRight: { flexDirection: 'row', alignItems: 'center' },
  colorDot: { width: 12, height: 12, borderRadius: 6, marginRight: 10 },
  legendCategory: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  legendAmount: { fontSize: 16, fontWeight: 'bold' },
  chevron: { marginLeft: 8 },
  
  progressRow: { flexDirection: 'row', alignItems: 'center' },
  progressBarBackground: { flex: 1, height: 6, borderRadius: 3, marginRight: 12, overflow: 'hidden' },
  progressBarFill: { height: '100%', borderRadius: 3 },
  percentageText: { fontSize: 13, fontWeight: '600', width: 36, textAlign: 'right' },

  transactionsList: { marginTop: 16, paddingTop: 8, borderTopWidth: 1 },
  transactionItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 },
  txMerchant: { fontSize: 14, fontWeight: '500', marginBottom: 2, paddingRight: 16 },
  txDate: { fontSize: 12 },
  txAmount: { fontSize: 14, fontWeight: '600' },
});