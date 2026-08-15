import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, SectionList, FlatList, TouchableOpacity, RefreshControl, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { addMonths } from 'date-fns';

import { useTransactionStore } from '../store/useTransactionStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useMonthlySummary } from '../hooks/useMonthlySummary';
import { useAppTheme } from '../theme/useAppTheme';
import { formatDisplayCurrency } from '../features/transactions/amount';
import type { Transaction } from '../features/transactions/types';

import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { NavigationProps } from '../navigation/types';

export const CashflowScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const fetchTransactions = useTransactionStore((state) => state.fetchTransactions);
  const searchTransactions = useTransactionStore((state) => state.searchTransactions);
  const theme = useAppTheme();

  const [currentDate, setCurrentDate] = useState(new Date());
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Transaction[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);

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

  useEffect(() => {
    let active = true;
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setSearchResults(null);
      return;
    }

    setIsSearching(true);
    const handler = setTimeout(async () => {
      try {
        const results = await searchTransactions(trimmed);
        if (active) {
          setSearchResults(results);
        }
      } catch (err) {
        console.warn('Search failed:', err);
      } finally {
        if (active) setIsSearching(false);
      }
    }, 250);

    return () => {
      active = false;
      clearTimeout(handler);
    };
  }, [searchQuery, searchTransactions]);

  const changeMonth = (offset: number) => {
    setCurrentDate((prev) => addMonths(prev, offset));
  };

  const currencyCode = useSettingsStore((state) => state.currencyCode);
  const useThousandsSeparator = useSettingsStore((state) => state.useThousandsSeparator);

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
        <Text style={[styles.summaryValue, { color: theme.income }]}>{formatDisplayCurrency(totalIncome || 0, currencyCode, useThousandsSeparator)}</Text>
      </View>
      <View style={styles.summaryCol}>
        <Text style={[styles.summaryLabel, { color: theme.textMuted }]}>Expense</Text>
        <Text style={[styles.summaryValue, { color: theme.expense }]}>{formatDisplayCurrency(totalExpense || 0, currencyCode, useThousandsSeparator)}</Text>
      </View>
      <View style={styles.summaryCol}>
        <Text style={[styles.summaryLabel, { color: theme.textMuted }]}>Balance</Text>
        <Text style={[styles.summaryValue, { color: (balance || 0) >= 0 ? theme.income : theme.expense }]}>{formatDisplayCurrency(balance || 0, currencyCode, useThousandsSeparator)}</Text>
      </View>
    </View>
  );

  const renderTransactionItem = (item: Transaction) => {
    const isIncome = (item.totalAmount || 0) > 0;
    return (
      <TouchableOpacity 
        key={item.id}
        style={[styles.transactionRow, { backgroundColor: theme.surface, borderBottomColor: theme.border }]} 
        onPress={() => navigation.navigate('AddTransactionStack', { transactionId: item.id })}
        accessibilityRole="button"
        accessibilityLabel={`${item.merchantName || 'Unknown'}, ${item.totalAmount}`}
      >
        <View style={[styles.iconContainer, { backgroundColor: isIncome ? theme.income + '15' : theme.expense + '15' }]}>
          <Ionicons 
            name={isIncome ? "arrow-down" : "arrow-up"} 
            size={16} 
            color={isIncome ? theme.income : theme.expense} 
          />
        </View>
        <View style={styles.transactionDetails}>
          <Text style={[styles.transactionTitle, { color: theme.text }]} numberOfLines={1}>{item.merchantName || 'Unknown'}</Text>
          <Text style={[styles.transactionSubtitle, { color: theme.textMuted }]} numberOfLines={1}>
            {item.category || 'Uncategorized'}
            {item.note ? ` · ${item.note}` : ''}
          </Text>
        </View>
        <Text style={[styles.transactionAmount, { color: isIncome ? theme.income : theme.expense }]}>
          {isIncome ? '+' : ''}{formatDisplayCurrency(item.totalAmount || 0, currencyCode, useThousandsSeparator)}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      {/* Search Bar */}
      <View style={[styles.searchBarWrap, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <Ionicons name="search-outline" size={18} color={theme.textMuted} style={styles.searchIcon} />
        <TextInput
          style={[styles.searchInput, { color: theme.text }]}
          placeholder="Search merchant, note, or items..."
          placeholderTextColor={theme.textMuted}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {searchQuery.length > 0 ? (
          <TouchableOpacity onPress={() => setSearchQuery('')} style={styles.clearSearchBtn}>
            <Ionicons name="close-circle" size={18} color={theme.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>

      {searchResults !== null ? (
        /* Search Results List */
        <FlatList
          data={searchResults}
          keyExtractor={(item) => item.id.toString()}
          renderItem={({ item }) => renderTransactionItem(item)}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <Text style={[styles.emptyText, { color: theme.textMuted }]}>
              {isSearching ? 'Searching...' : `No transactions found for "${searchQuery}"`}
            </Text>
          }
        />
      ) : (
        <>
          {/* Month Selector */}
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
            renderItem={({ item }) => renderTransactionItem(item)}
          />
        </>
      )}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  searchBarWrap: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 14, marginTop: 8, marginBottom: 8, paddingHorizontal: 10, height: 40, borderRadius: 10, borderWidth: 1, borderColor: 'transparent' },
  searchIcon: { marginRight: 8 },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 0 },
  clearSearchBtn: { padding: 4 },
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
