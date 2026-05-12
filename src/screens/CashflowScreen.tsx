import React, { useState } from 'react';
import { View, Text, StyleSheet, SectionList, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { addMonths } from 'date-fns'; // NEW: Safe date math

import { useTransactionStore } from '../store/useTransactionStore';
import { useMonthlySummary } from '../hooks/useMonthlySummary'; // NEW: Centralized Math
import { useAppTheme } from '../theme/useAppTheme'; // NEW: Dynamic Theme

import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { NavigationProps } from '../navigation/types';

export const CashflowScreen = () => {
  const navigation = useNavigation<NavigationProps>();  
  const fetchTransactions = useTransactionStore((state) => state.fetchTransactions);
  const theme = useAppTheme(); 

  const [currentDate, setCurrentDate] = useState(new Date());

  useFocusEffect(
    React.useCallback(() => { fetchTransactions(); }, [])
  );

  // NEW: Bulletproof date math
  const changeMonth = (offset: number) => {
    setCurrentDate(prev => addMonths(prev, offset));
  };

  // NEW: All math and filtering is now handled instantly by the hook!
  const { currentMonthData, totalIncome, totalExpense, balance } = useMonthlySummary(currentDate);

  const groupedData = currentMonthData.reduce((acc, curr) => {
    const dateString = new Date(curr.date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (!acc[dateString]) acc[dateString] = [];
    acc[dateString].push(curr);
    return acc;
  }, {} as Record<string, any[]>);

  const sectionListData = Object.keys(groupedData).map(key => ({ title: key, data: groupedData[key] }));

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
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <View style={[styles.monthSelector, { backgroundColor: theme.surface }]}>
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

      <SectionList
        sections={sectionListData}
        keyExtractor={(item) => item.id.toString()}
        ListHeaderComponent={renderHeader}
        ListEmptyComponent={<Text style={[styles.emptyText, { color: theme.textMuted }]}>No transactions this month.</Text>}
        contentContainerStyle={{ paddingBottom: 120 }} 
        renderSectionHeader={({ section: { title } }) => (
          <Text style={[styles.sectionHeader, { color: theme.text }]}>{title}</Text>
        )}
        renderItem={({ item }) => (
          <TouchableOpacity 
            style={[styles.transactionRow, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}
            // FIX: Update to the new Stack name
            onPress={() => navigation.navigate('AddTransactionStack', { transactionId: item.id })}
          >
            <View style={[styles.iconContainer, { backgroundColor: theme.background }]}>
              <Ionicons name="receipt-outline" size={20} color={theme.textMuted} />
            </View>
            <View style={styles.transactionDetails}>
              <Text style={[styles.transactionTitle, { color: theme.text }]}>{item.merchantName || 'Unknown'}</Text>
              <Text style={[styles.transactionSubtitle, { color: theme.textMuted }]}>{item.category || 'Uncategorized'}</Text>
            </View>
            {/* SAFE FALLBACK HERE */}
            <Text style={[styles.transactionAmount, { color: (item.totalAmount || 0) > 0 ? theme.income : theme.expense }]}>
              {(item.totalAmount || 0) > 0 ? '+' : ''}{(item.totalAmount || 0).toLocaleString()}
            </Text>
          </TouchableOpacity>
        )}
      />
    </SafeAreaView>
  );
};

// Stripped of hardcoded colors
const styles = StyleSheet.create({
  container: { flex: 1 },
  monthSelector: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  monthText: { fontSize: 18, fontWeight: '600' },
  arrowBtn: { padding: 8 },
  summaryCard: { flexDirection: 'row', margin: 16, padding: 16, borderRadius: 8, borderWidth: 1, justifyContent: 'space-between' },
  summaryCol: { alignItems: 'center' },
  summaryLabel: { fontSize: 12, marginBottom: 4 },
  summaryValue: { fontSize: 14, fontWeight: 'bold' },
  sectionHeader: { fontSize: 14, fontWeight: 'bold', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  transactionRow: { flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: 1 },
  iconContainer: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  transactionDetails: { flex: 1 },
  transactionTitle: { fontSize: 14, fontWeight: '600' },
  transactionSubtitle: { fontSize: 12, marginTop: 2 },
  transactionAmount: { fontSize: 14, fontWeight: 'bold' },
  emptyText: { textAlign: 'center', marginTop: 40 }
});