import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, SectionList, FlatList, TouchableOpacity, RefreshControl, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { addMonths, isSameMonth } from 'date-fns';

import { useTransactionStore } from '../store/useTransactionStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useReceiptQueueStore } from '../store/useReceiptQueueStore';
import { useMonthlySummary } from '../hooks/useMonthlySummary';
import { useAppTheme } from '../theme/useAppTheme';
import { formatDisplayCurrency } from '../features/transactions/amount';
import { UNCATEGORIZED_EXPENSE_LABEL } from '../features/transactions/constants';
import type { Transaction } from '../features/transactions/types';

import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { NavigationProps } from '../navigation/types';

function formatLocaleDate(date: Date | number, locale: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Date(date).toLocaleDateString(locale || 'en-GB', options);
  } catch {
    return new Date(date).toLocaleDateString('en-GB', options);
  }
}

export const CashflowScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const fetchTransactions = useTransactionStore((state) => state.fetchTransactions);
  const searchTransactions = useTransactionStore((state) => state.searchTransactions);
  const error = useTransactionStore((state) => state.error);
  const clearError = useTransactionStore((state) => state.clearError);
  const theme = useAppTheme();
  const queueItems = useReceiptQueueStore((s) => s.items);
  const wallets = useTransactionStore((s) => s.wallets);

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
    }, [fetchTransactions])
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
  const dateFormat = useSettingsStore((state) => state.dateFormat);
  const locale = dateFormat || 'en-GB';

  const { currentMonthData, totalIncome, totalExpense, balance } = useMonthlySummary(currentDate);

  const sectionListData = useMemo(() => {
    const groupedData = currentMonthData.reduce((acc, curr) => {
      const dateString = formatLocaleDate(curr.date, locale, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
      if (!acc[dateString]) acc[dateString] = [];
      acc[dateString].push(curr);
      return acc;
    }, {} as Record<string, Transaction[]>);

    return Object.keys(groupedData).map((key) => ({ title: key, data: groupedData[key] }));
  }, [currentMonthData, locale]);

  const isCurrentMonthNow = isSameMonth(currentDate, new Date());

  const resetToCurrentMonth = () => {
    setCurrentDate(new Date());
  };

  const renderHeader = () => (
    <View style={[styles.summaryCard, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
      <View style={styles.summaryCol}>
        <Text style={[styles.summaryLabel, { color: theme.textMuted }]}>Income</Text>
        <Text style={[styles.summaryValue, { color: theme.income }]}>{formatDisplayCurrency(totalIncome || 0, currencyCode, useThousandsSeparator)}</Text>
      </View>
      <View style={[styles.summaryDivider, { backgroundColor: theme.border }]} />
      <View style={styles.summaryCol}>
        <Text style={[styles.summaryLabel, { color: theme.textMuted }]}>Expense</Text>
        <Text style={[styles.summaryValue, { color: theme.expense }]}>{formatDisplayCurrency(totalExpense || 0, currencyCode, useThousandsSeparator)}</Text>
      </View>
      <View style={[styles.summaryDivider, { backgroundColor: theme.border }]} />
      <View style={styles.summaryCol}>
        <Text style={[styles.summaryLabel, { color: theme.textMuted }]}>Balance</Text>
        <Text style={[styles.summaryValue, { color: (balance || 0) >= 0 ? theme.income : theme.expense }]}>{formatDisplayCurrency(balance || 0, currencyCode, useThousandsSeparator)}</Text>
      </View>
    </View>
  );

  const walletNames = useMemo(() => new Map(wallets.map((w) => [w.id, w.name])), [wallets]);
  const showAccountNames = wallets.filter((w) => w.isActive).length > 1;

  const renderTransactionItem = (item: Transaction) => {
    const isTransfer = item.type === 'transfer';
    const isIncome = !isTransfer && (item.type === 'income' || (item.totalAmount || 0) > 0);
    const tint = isTransfer ? theme.primary : isIncome ? theme.income : theme.expense;
    const accountLabel = isTransfer
      ? `${walletNames.get(item.walletId ?? -1) ?? 'Account'} → ${walletNames.get(item.toWalletId ?? -1) ?? 'Account'}`
      : showAccountNames && item.walletId
        ? walletNames.get(item.walletId)
        : undefined;
    const subtitle = isTransfer
      ? [accountLabel, item.note].filter(Boolean).join(' · ')
      : [item.category || UNCATEGORIZED_EXPENSE_LABEL, accountLabel, item.note].filter(Boolean).join(' · ');
    const amountText = formatDisplayCurrency(isTransfer ? Math.abs(item.totalAmount || 0) : item.totalAmount || 0, currencyCode, useThousandsSeparator);
    return (
      <TouchableOpacity
        key={item.id}
        style={[styles.transactionRow, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}
        onPress={() => navigation.navigate('AddTransactionStack', { transactionId: item.id })}
        accessibilityRole="button"
        accessibilityLabel={`${item.merchantName || 'Unknown'}, ${isTransfer ? 'transfer ' : ''}${amountText}, ${subtitle}`}
      >
        <View style={[styles.iconContainer, { backgroundColor: tint + '18' }]}>
          <Ionicons name={isTransfer ? 'swap-horizontal' : isIncome ? 'arrow-down' : 'arrow-up'} size={16} color={tint} />
        </View>
        <View style={styles.transactionDetails}>
          <Text style={[styles.transactionTitle, { color: theme.text }]} numberOfLines={1}>{item.merchantName || 'Unknown'}</Text>
          <Text style={[styles.transactionSubtitle, { color: theme.textMuted }]} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <Text style={[styles.transactionAmount, { color: tint }]}>
          {isIncome ? '+' : ''}{amountText}
        </Text>
      </TouchableOpacity>
    );
  };

  const queueReady = queueItems.filter((item) => item.status === 'done').length;
  const queueWaiting = queueItems.filter((item) => item.status === 'pending' || item.status === 'processing').length;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      {/* Search Bar */}
      <View style={[styles.searchBarWrap, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <Ionicons name="search-outline" size={18} color={theme.textMuted} style={styles.searchIcon} />
        <TextInput
          style={[styles.searchInput, { color: theme.text }]}
          placeholder="Search merchant, note, or items..."
          placeholderTextColor={theme.textMuted}
          selectionColor={theme.primary}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Search transactions"
        />
        {searchQuery.length > 0 ? (
          <TouchableOpacity
            onPress={() => setSearchQuery('')}
            style={styles.clearSearchBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
          >
            <Ionicons name="close-circle" size={18} color={theme.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>

      {queueReady + queueWaiting > 0 ? (
        <TouchableOpacity
          style={[styles.errorBanner, { backgroundColor: theme.primaryMuted, borderColor: theme.primary }]}
          onPress={() => navigation.navigate('ReceiptInbox')}
          accessibilityRole="button"
          accessibilityLabel="Open Receipt Inbox"
        >
          <Ionicons name="receipt-outline" size={18} color={theme.primary} style={styles.errorBannerIcon} />
          <Text style={[styles.errorBannerText, { color: theme.primary }]} numberOfLines={1}>
            {queueReady > 0 ? `${queueReady} receipt${queueReady === 1 ? '' : 's'} ready to review` : 'Reading receipts…'}
            {queueReady > 0 && queueWaiting > 0 ? ` · ${queueWaiting} reading` : ''}
          </Text>
          <Ionicons name="chevron-forward" size={16} color={theme.primary} />
        </TouchableOpacity>
      ) : null}

      {error ? (
        <View style={[styles.errorBanner, { backgroundColor: theme.expenseMuted, borderColor: theme.expense }]}>
          <Ionicons name="alert-circle-outline" size={18} color={theme.expense} style={styles.errorBannerIcon} />
          <Text style={[styles.errorBannerText, { color: theme.expense }]} numberOfLines={2}>
            {error}
          </Text>
          <TouchableOpacity
            onPress={clearError}
            style={styles.errorDismissBtn}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            accessibilityRole="button"
            accessibilityLabel="Dismiss error"
          >
            <Ionicons name="close" size={18} color={theme.expense} />
          </TouchableOpacity>
        </View>
      ) : null}

      {searchResults !== null ? (
        /* Search Results List */
        <FlatList
          data={searchResults}
          keyExtractor={(item) => item.id.toString()}
          renderItem={({ item }) => renderTransactionItem(item)}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={[styles.emptyCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Ionicons name="search-outline" size={32} color={theme.textMuted} style={styles.emptyIcon} />
              <Text style={[styles.emptyTitle, { color: theme.text }]}>
                {isSearching ? 'Searching...' : 'No transactions found'}
              </Text>
              <Text style={[styles.emptySubtitle, { color: theme.textMuted }]}>
                {isSearching ? 'Looking up matching records...' : `No records matching "${searchQuery}"`}
              </Text>
            </View>
          }
        />
      ) : (
        <>
          {/* Month Selector */}
          <View style={[styles.monthSelector, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
            <TouchableOpacity onPress={() => changeMonth(-1)} style={styles.arrowBtn} accessibilityRole="button" accessibilityLabel="Previous month">
              <Ionicons name="chevron-back" size={20} color={theme.text} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={resetToCurrentMonth}
              style={styles.monthTextWrap}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Jump to current month"
            >
              <Text style={[styles.monthText, { color: theme.text }]}>
                {formatLocaleDate(currentDate, locale, { month: 'long', year: 'numeric' })}
              </Text>
              {!isCurrentMonthNow && (
                <View style={[styles.todayBadge, { backgroundColor: theme.primaryMuted }]}>
                  <Text style={[styles.todayBadgeText, { color: theme.primary }]}>Today</Text>
                </View>
              )}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => changeMonth(1)} style={styles.arrowBtn} accessibilityRole="button" accessibilityLabel="Next month">
              <Ionicons name="chevron-forward" size={20} color={theme.text} />
            </TouchableOpacity>
          </View>

          <SectionList
            sections={sectionListData}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} />}
            keyExtractor={(item) => item.id.toString()}
            ListHeaderComponent={renderHeader}
            ListEmptyComponent={
              <View style={[styles.emptyCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <Ionicons name="wallet-outline" size={32} color={theme.textMuted} style={styles.emptyIcon} />
                <Text style={[styles.emptyTitle, { color: theme.text }]}>No transactions this month</Text>
                <Text style={[styles.emptySubtitle, { color: theme.textMuted }]}>
                  Tap + at the bottom to add your first transaction.
                </Text>
              </View>
            }
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
  searchBarWrap: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 14, marginTop: 8, marginBottom: 8, paddingHorizontal: 10, height: 42, borderRadius: 12, borderWidth: 1 },
  searchIcon: { marginRight: 8 },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 0 },
  clearSearchBtn: { padding: 4 },
  errorBanner: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 14, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, borderWidth: 1 },
  errorBannerIcon: { marginRight: 8 },
  errorBannerText: { flex: 1, fontSize: 12, fontWeight: '600' },
  errorDismissBtn: { minWidth: 32, minHeight: 32, alignItems: 'center', justifyContent: 'center' },
  monthSelector: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  monthTextWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  monthText: { fontSize: 16, fontWeight: '600' },
  todayBadge: { borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  todayBadgeText: { fontSize: 10, fontWeight: '700' },
  arrowBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  summaryCard: { flexDirection: 'row', marginHorizontal: 14, marginTop: 12, marginBottom: 4, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 14, borderWidth: 1, justifyContent: 'space-between', alignItems: 'center' },
  summaryCol: { alignItems: 'center', flex: 1 },
  summaryDivider: { width: 1, height: 26 },
  summaryLabel: { fontSize: 11, marginBottom: 3, fontWeight: '600' },
  summaryValue: { fontSize: 13, fontWeight: '700' },
  listContent: { paddingBottom: 120 },
  sectionHeader: { fontSize: 12, fontWeight: '700', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6 },
  transactionRow: { flexDirection: 'row', alignItems: 'center', minHeight: 62, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  iconContainer: { width: 34, height: 34, borderRadius: 17, justifyContent: 'center', alignItems: 'center', marginRight: 10 },
  transactionDetails: { flex: 1, marginRight: 10 },
  transactionTitle: { fontSize: 14, fontWeight: '600' },
  transactionSubtitle: { fontSize: 12, marginTop: 1 },
  transactionAmount: { fontSize: 13, fontWeight: '700' },
  emptyCard: { marginHorizontal: 14, marginTop: 24, padding: 24, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  emptyIcon: { marginBottom: 10 },
  emptyTitle: { fontSize: 14, fontWeight: '700', marginBottom: 4 },
  emptySubtitle: { fontSize: 12, textAlign: 'center', lineHeight: 16 },
});
