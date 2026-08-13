import React, { useState } from 'react';
import { View, Text, StyleSheet, SectionList, TouchableOpacity, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { addMonths } from 'date-fns';

import { useTransactionStore } from '../store/useTransactionStore';
import { useMonthlySummary } from '../hooks/useMonthlySummary';
import { useAppTheme } from '../theme/useAppTheme';

import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { NavigationProps } from '../navigation/types';

export const CashflowScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const fetchTransactions = useTransactionStore((state) => state.fetchTransactions);
  const theme = useAppTheme();

  const [currentDate, setCurrentDate] = useState(new Date());
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = React.useCallback(async () => {
    setRefreshing(true);
    await fetchTransactions();
    setRefreshing(false);
  }, [fetchTransactions]);

  useFocusEffect(
    React.useCallback(() => {
      fetchTransactions();
    }, [])
  );

  const changeMonth = (offset: number) => {
    setCurrentDate((prev) => addMonths(prev, offset));
  };

  const { currentMonthData, totalIncome, totalExpense, balance } = useMonthlySummary(currentDate);

  const groupedData = currentMonthData.reduce((acc, curr) => {
    const dateString = new Date(curr.date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (!acc[dateString]) acc[dateString] = [];
    acc[dateString].push(curr);
    return acc;
  }, {} as Record<string, any[]>);

  const sectionListData = Object.keys(groupedData).map((key) => ({ title: key, data: groupedData[key] }));

  const renderHeader = () => (
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
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      <View style={[styles.monthSelector, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <TouchableOpacity onPress={() => changeMonth(-1)} style={styles.arrowBtn} accessibilityRole="button" accessibilityLabel="Previous month">
          <Ionicons name="chevron-back" size={20} color={theme.textMuted} />
        </TouchableOpacity>
        <Text style={[styles.monthText, { color: theme.text }]}>{currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</Text>
        <TouchableOpacity onPress={() => changeMonth(1)} style={styles.arrowBtn} accessibilityRole="button" accessibilityLabel="Next month">
          <Ionicons name="chevron-forward" size={20} color={theme.textMuted} />
        </TouchableOpacity>
      </View>

      <SectionList
        sections={sectionListData}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} />}
        keyExtractor={(item) => item.id.toString()}
        ListHeaderComponent={renderHeader}
        ListEmptyComponent={<Text style={[styles.emptyText, { color: theme.textMuted }]}>No transactions this month.</Text>}
        contentContainerStyle={styles.listContent}
        renderSectionHeader={({ section: { title } }) => <Text style={[styles.sectionHeader, { color: theme.text }]}>{title}</Text>}
        renderItem={({ item }) => (
          <TouchableOpacity 
            style={[styles.transactionRow, { backgroundColor: theme.surface, borderBottomColor: theme.border }]} 
            onPress={() => navigation.navigate('AddTransactionStack', { transactionId: item.id })}
            accessibilityRole="button"
            accessibilityLabel={`${item.merchantName || 'Unknown'}, ${item.totalAmount}`}
          >
            <View style={[styles.iconContainer, { backgroundColor: theme.background }]}>
              <Ionicons name="receipt-outline" size={18} color={theme.textMuted} />
            </View>
            <View style={styles.transactionDetails}>
              <Text style={[styles.transactionTitle, { color: theme.text }]} numberOfLines={1}>{item.merchantName || 'Unknown'}</Text>
              <Text style={[styles.transactionSubtitle, { color: theme.textMuted }]} numberOfLines={1}>{item.category || 'Uncategorized'}</Text>
            </View>
            <Text style={[styles.transactionAmount, { color: (item.totalAmount || 0) > 0 ? theme.income : theme.expense }]}>
              {(item.totalAmount || 0) > 0 ? '+' : ''}{(item.totalAmount || 0).toLocaleString()}
            </Text>
          </TouchableOpacity>
        )}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  monthSelector: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  monthText: { fontSize: 16, fontWeight: '600' },
  arrowBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  summaryCard: { flexDirection: 'row', marginHorizontal: 14, marginTop: 12, marginBottom: 4, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, borderWidth: 1, justifyContent: 'space-between' },
  summaryCol: { alignItems: 'center', flex: 1 },
  summaryLabel: { fontSize: 11, marginBottom: 3 },
  summaryValue: { fontSize: 13, fontWeight: '700' },
  listContent: { paddingBottom: 120 },
  sectionHeader: { fontSize: 12, fontWeight: '700', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6 },
  transactionRow: { flexDirection: 'row', alignItems: 'center', minHeight: 62, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  iconContainer: { width: 34, height: 34, borderRadius: 17, justifyContent: 'center', alignItems: 'center', marginRight: 10 },
  transactionDetails: { flex: 1, marginRight: 10 },
  transactionTitle: { fontSize: 14, fontWeight: '600' },
  transactionSubtitle: { fontSize: 12, marginTop: 1 },
  transactionAmount: { fontSize: 13, fontWeight: '700' },
  emptyText: { textAlign: 'center', marginTop: 40 },
});
