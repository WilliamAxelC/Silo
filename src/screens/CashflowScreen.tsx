import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  FlatList,
  ScrollView,
  Modal,
  TouchableOpacity,
  RefreshControl,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { addMonths, endOfDay, endOfMonth, isSameMonth, startOfDay, startOfMonth, subDays, subMonths } from 'date-fns';

import { useTransactionStore } from '../store/useTransactionStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useReceiptQueueStore } from '../store/useReceiptQueueStore';
import { useMonthlySummary } from '../hooks/useMonthlySummary';
import { useAppTheme } from '../theme/useAppTheme';
import { formatDisplayCurrency, summarizeTransactions, type TransactionFilterSummary } from '../features/transactions/amount';
import { UNCATEGORIZED_EXPENSE_LABEL } from '../features/transactions/constants';
import type { Transaction, TransactionType } from '../features/transactions/types';
import type { SearchTransactionsOptions } from '../db/index';

import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { NavigationProps } from '../navigation/types';

type DateRangePreset = 'today' | 'last7' | 'thisMonth' | 'lastMonth' | 'last30' | 'custom';
type FilterSheetKind = 'type' | 'account' | 'category' | 'date';

const TYPE_OPTIONS: Array<{ key: TransactionType | null; label: string }> = [
  { key: null, label: 'All types' },
  { key: 'expense', label: 'Expense' },
  { key: 'income', label: 'Income' },
  { key: 'transfer', label: 'Transfer' },
];

const DATE_PRESETS: Array<{ key: Exclude<DateRangePreset, 'custom'>; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'thisMonth', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
  { key: 'last30', label: 'Last 30 days' },
];

function computeDatePresetBounds(preset: Exclude<DateRangePreset, 'custom'>, now = new Date()): { from: number; to: number } {
  switch (preset) {
    case 'today':
      return { from: startOfDay(now).getTime(), to: endOfDay(now).getTime() };
    case 'last7':
      return { from: startOfDay(subDays(now, 6)).getTime(), to: endOfDay(now).getTime() };
    case 'thisMonth':
      return { from: startOfMonth(now).getTime(), to: endOfMonth(now).getTime() };
    case 'lastMonth': {
      const prev = subMonths(now, 1);
      return { from: startOfMonth(prev).getTime(), to: endOfMonth(prev).getTime() };
    }
    case 'last30':
      return { from: startOfDay(subDays(now, 29)).getTime(), to: endOfDay(now).getTime() };
  }
}

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
  const summarizeSearchTransactions = useTransactionStore((state) => state.summarizeSearchTransactions);
  const error = useTransactionStore((state) => state.error);
  const clearError = useTransactionStore((state) => state.clearError);
  const theme = useAppTheme();
  const queueItems = useReceiptQueueStore((s) => s.items);
  const wallets = useTransactionStore((s) => s.wallets);
  const categories = useTransactionStore((s) => s.categories);

  const [currentDate, setCurrentDate] = useState(new Date());
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TransactionType | null>(null);
  const [walletFilterId, setWalletFilterId] = useState<number | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [datePreset, setDatePreset] = useState<DateRangePreset | null>(null);
  const [dateFrom, setDateFrom] = useState<number | null>(null);
  const [dateTo, setDateTo] = useState<number | null>(null);
  const [activeFilterSheet, setActiveFilterSheet] = useState<FilterSheetKind | null>(null);
  const [datePickerTarget, setDatePickerTarget] = useState<'from' | 'to' | null>(null);
  const [filterRefreshTick, setFilterRefreshTick] = useState(0);
  const [searchResults, setSearchResults] = useState<Transaction[] | null>(null);
  const [searchSummaryState, setSearchSummaryState] = useState<TransactionFilterSummary | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  const hasActiveFilters = Boolean(
    typeFilter || walletFilterId != null || categoryFilter || dateFrom != null || dateTo != null
  );

  const onRefresh = React.useCallback(async () => {
    setRefreshing(true);
    await fetchTransactions();
    setFilterRefreshTick((tick) => tick + 1);
    setRefreshing(false);
  }, [fetchTransactions]);

  useFocusEffect(
    React.useCallback(() => {
      fetchTransactions();
      setFilterRefreshTick((tick) => tick + 1);
    }, [fetchTransactions])
  );

  useEffect(() => {
    let active = true;
    const trimmed = searchQuery.trim();
    if (!trimmed && !hasActiveFilters) {
      setSearchResults(null);
      setSearchSummaryState(null);
      setIsSearching(false);
      return;
    }

    const options: SearchTransactionsOptions = {};
    if (typeFilter) options.type = typeFilter;
    if (walletFilterId != null) options.walletId = walletFilterId;
    if (categoryFilter) options.category = categoryFilter;
    if (dateFrom != null) options.dateFrom = dateFrom;
    if (dateTo != null) options.dateTo = dateTo;

    const runSearch = async () => {
      try {
        const filterOptions = hasActiveFilters ? options : undefined;
        const [results, summary] = await Promise.all([
          searchTransactions(trimmed, filterOptions),
          summarizeSearchTransactions(trimmed, filterOptions),
        ]);
        if (active) {
          setSearchResults(results);
          setSearchSummaryState(summary);
        }
      } catch (err) {
        console.warn('Search failed:', err);
      } finally {
        if (active) setIsSearching(false);
      }
    };

    setIsSearching(true);
    if (!trimmed) {
      void runSearch();
      return () => {
        active = false;
      };
    }

    const handler = setTimeout(() => {
      void runSearch();
    }, 250);

    return () => {
      active = false;
      clearTimeout(handler);
    };
  }, [
    searchQuery,
    hasActiveFilters,
    typeFilter,
    walletFilterId,
    categoryFilter,
    dateFrom,
    dateTo,
    filterRefreshTick,
    searchTransactions,
    summarizeSearchTransactions,
  ]);

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

  const filterableCategories = useMemo(() => {
    const filtered =
      typeFilter === 'expense' || typeFilter === 'income'
        ? categories.filter((c) => c.type === typeFilter)
        : categories;
    const seen = new Set<string>();
    const names: string[] = [];
    for (const cat of filtered) {
      if (!seen.has(cat.name)) {
        seen.add(cat.name);
        names.push(cat.name);
      }
    }
    return names.sort((a, b) => a.localeCompare(b));
  }, [categories, typeFilter]);

  const searchSummary = useMemo(
    () => searchSummaryState ?? summarizeTransactions(searchResults ?? []),
    [searchSummaryState, searchResults]
  );

  const isListTruncated = searchResults !== null && searchSummary.count > searchResults.length;

  const dateRangeChipLabel = useMemo(() => {
    if (dateFrom == null && dateTo == null) return 'Date range';
    if (datePreset && datePreset !== 'custom') {
      return DATE_PRESETS.find((p) => p.key === datePreset)?.label ?? 'Date range';
    }
    const fmt = (ms: number) => formatLocaleDate(ms, locale, { day: 'numeric', month: 'short' });
    if (dateFrom != null && dateTo != null) return `${fmt(dateFrom)} – ${fmt(dateTo)}`;
    if (dateFrom != null) return `From ${fmt(dateFrom)}`;
    return `Until ${fmt(dateTo!)}`;
  }, [dateFrom, datePreset, dateTo, locale]);

  const typeChipLabel = useMemo(() => {
    if (!typeFilter) return 'Type';
    return TYPE_OPTIONS.find((opt) => opt.key === typeFilter)?.label ?? 'Type';
  }, [typeFilter]);

  const accountChipLabel = useMemo(() => {
    if (walletFilterId == null) return 'Account';
    return walletNames.get(walletFilterId) ?? 'Account';
  }, [walletFilterId, walletNames]);

  const clearAllFilters = () => {
    setTypeFilter(null);
    setWalletFilterId(null);
    setCategoryFilter(null);
    setDatePreset(null);
    setDateFrom(null);
    setDateTo(null);
  };

  const handleSelectTypeFilter = (nextType: TransactionType | null) => {
    setTypeFilter(nextType);
    if (nextType === 'transfer') {
      setCategoryFilter(null);
    } else if (nextType && categoryFilter) {
      const stillValid = categories.some((c) => c.type === nextType && c.name === categoryFilter);
      if (!stillValid) setCategoryFilter(null);
    }
    setActiveFilterSheet(null);
  };

  const handleSelectDatePreset = (preset: Exclude<DateRangePreset, 'custom'> | null) => {
    if (!preset) {
      setDatePreset(null);
      setDateFrom(null);
      setDateTo(null);
    } else {
      const bounds = computeDatePresetBounds(preset);
      setDatePreset(preset);
      setDateFrom(bounds.from);
      setDateTo(bounds.to);
    }
    setActiveFilterSheet(null);
  };

  const handleCustomDateChange = (_event: unknown, picked?: Date) => {
    const target = datePickerTarget;
    setDatePickerTarget(null);
    if (!picked || !target) return;
    setDatePreset('custom');
    if (target === 'from') {
      const nextFrom = startOfDay(picked).getTime();
      setDateFrom(nextFrom);
      if (dateTo != null && nextFrom > dateTo) {
        setDateTo(endOfDay(picked).getTime());
      }
    } else {
      const nextTo = endOfDay(picked).getTime();
      setDateTo(nextTo);
      if (dateFrom != null && nextTo < dateFrom) {
        setDateFrom(startOfDay(picked).getTime());
      }
    }
  };

  const renderSearchSummaryHeader = () => (
    <View style={[styles.filterSummaryCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <View style={styles.filterSummaryTop}>
        <Text style={[styles.filterSummaryCount, { color: theme.text }]}>
          {searchSummary.count} {searchSummary.count === 1 ? 'transaction' : 'transactions'}
        </Text>
        {isSearching ? (
          <Text style={[styles.filterSummaryUpdating, { color: theme.textMuted }]}>Updating…</Text>
        ) : null}
      </View>
      <View style={styles.filterSummaryRow}>
        <View style={styles.summaryCol}>
          <Text style={[styles.summaryLabel, { color: theme.textMuted }]}>In</Text>
          <Text style={[styles.summaryValue, { color: theme.income }]} numberOfLines={1} adjustsFontSizeToFit>
            {formatDisplayCurrency(searchSummary.totalIn, currencyCode, useThousandsSeparator)}
          </Text>
        </View>
        <View style={[styles.summaryDivider, { backgroundColor: theme.border }]} />
        <View style={styles.summaryCol}>
          <Text style={[styles.summaryLabel, { color: theme.textMuted }]}>Out</Text>
          <Text style={[styles.summaryValue, { color: theme.expense }]} numberOfLines={1} adjustsFontSizeToFit>
            {formatDisplayCurrency(searchSummary.totalOut, currencyCode, useThousandsSeparator)}
          </Text>
        </View>
        <View style={[styles.summaryDivider, { backgroundColor: theme.border }]} />
        <View style={styles.summaryCol}>
          <Text style={[styles.summaryLabel, { color: theme.textMuted }]}>Net</Text>
          <Text
            style={[styles.summaryValue, { color: searchSummary.net >= 0 ? theme.income : theme.expense }]}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {formatDisplayCurrency(searchSummary.net, currencyCode, useThousandsSeparator)}
          </Text>
        </View>
      </View>
      {isListTruncated && searchResults ? (
        <Text style={[styles.filterSummaryTruncation, { color: theme.textMuted }]}>
          Showing first {searchResults.length} of {searchSummary.count} matches · totals cover all {searchSummary.count}
        </Text>
      ) : null}
    </View>
  );

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

      {/* Filter Chips Row */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterBarScroll}
        contentContainerStyle={styles.filterBarContent}
        keyboardShouldPersistTaps="handled"
      >
        <TouchableOpacity
          style={[
            styles.filterChip,
            {
              backgroundColor: typeFilter ? theme.primaryMuted : theme.surface,
              borderColor: typeFilter ? theme.primary : theme.border,
            },
          ]}
          onPress={() => setActiveFilterSheet('type')}
          accessibilityRole="button"
          accessibilityLabel="Filter by type"
          accessibilityState={{ selected: Boolean(typeFilter) }}
        >
          <Text style={[styles.filterChipText, { color: typeFilter ? theme.primary : theme.text }]} numberOfLines={1}>
            {typeChipLabel}
          </Text>
          <Ionicons name="chevron-down" size={14} color={typeFilter ? theme.primary : theme.textMuted} />
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.filterChip,
            {
              backgroundColor: walletFilterId != null ? theme.primaryMuted : theme.surface,
              borderColor: walletFilterId != null ? theme.primary : theme.border,
            },
          ]}
          onPress={() => setActiveFilterSheet('account')}
          accessibilityRole="button"
          accessibilityLabel="Filter by account"
          accessibilityState={{ selected: walletFilterId != null }}
        >
          <Text
            style={[styles.filterChipText, { color: walletFilterId != null ? theme.primary : theme.text }]}
            numberOfLines={1}
          >
            {accountChipLabel}
          </Text>
          <Ionicons name="chevron-down" size={14} color={walletFilterId != null ? theme.primary : theme.textMuted} />
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.filterChip,
            {
              backgroundColor: categoryFilter ? theme.primaryMuted : theme.surface,
              borderColor: categoryFilter ? theme.primary : theme.border,
            },
          ]}
          onPress={() => setActiveFilterSheet('category')}
          accessibilityRole="button"
          accessibilityLabel="Filter by category"
          accessibilityState={{ selected: Boolean(categoryFilter) }}
        >
          <Text
            style={[styles.filterChipText, { color: categoryFilter ? theme.primary : theme.text }]}
            numberOfLines={1}
          >
            {categoryFilter ?? 'Category'}
          </Text>
          <Ionicons name="chevron-down" size={14} color={categoryFilter ? theme.primary : theme.textMuted} />
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.filterChip,
            {
              backgroundColor: dateFrom != null || dateTo != null ? theme.primaryMuted : theme.surface,
              borderColor: dateFrom != null || dateTo != null ? theme.primary : theme.border,
            },
          ]}
          onPress={() => setActiveFilterSheet('date')}
          accessibilityRole="button"
          accessibilityLabel="Filter by date range"
          accessibilityState={{ selected: dateFrom != null || dateTo != null }}
        >
          <Ionicons
            name="calendar-outline"
            size={14}
            color={dateFrom != null || dateTo != null ? theme.primary : theme.textMuted}
          />
          <Text
            style={[styles.filterChipText, { color: dateFrom != null || dateTo != null ? theme.primary : theme.text }]}
            numberOfLines={1}
          >
            {dateRangeChipLabel}
          </Text>
          <Ionicons
            name="chevron-down"
            size={14}
            color={dateFrom != null || dateTo != null ? theme.primary : theme.textMuted}
          />
        </TouchableOpacity>

        {hasActiveFilters ? (
          <TouchableOpacity
            style={[styles.filterChip, { backgroundColor: theme.surface, borderColor: theme.border }]}
            onPress={clearAllFilters}
            accessibilityRole="button"
            accessibilityLabel="Clear filters"
          >
            <Ionicons name="close-circle-outline" size={15} color={theme.textMuted} />
            <Text style={[styles.filterChipText, { color: theme.textMuted }]}>Clear</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>

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
        /* Search & Filtered Results List */
        <FlatList
          data={searchResults}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} />}
          keyExtractor={(item) => item.id.toString()}
          ListHeaderComponent={renderSearchSummaryHeader}
          ListFooterComponent={
            isListTruncated ? (
              <View style={[styles.truncationFooter, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <Text style={[styles.truncationFooterText, { color: theme.textMuted }]}>
                  List capped at {searchResults.length} of {searchSummary.count} matching transactions. Narrow filters to view older matches.
                </Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => renderTransactionItem(item)}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={[styles.emptyCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Ionicons name="search-outline" size={32} color={theme.textMuted} style={styles.emptyIcon} />
              <Text style={[styles.emptyTitle, { color: theme.text }]}>
                {isSearching ? 'Searching...' : 'No transactions found'}
              </Text>
              <Text style={[styles.emptySubtitle, { color: theme.textMuted }]}>
                {isSearching
                  ? 'Looking up matching records...'
                  : searchQuery.trim()
                    ? `No records matching "${searchQuery.trim()}"`
                    : 'No transactions match the selected filters'}
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

      {/* Filter Selection Bottom Sheet */}
      <Modal
        visible={activeFilterSheet !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setActiveFilterSheet(null)}
      >
        <TouchableOpacity
          style={styles.sheetOverlay}
          activeOpacity={1}
          onPress={() => setActiveFilterSheet(null)}
        >
          <TouchableOpacity
            activeOpacity={1}
            onPress={(e) => e.stopPropagation()}
            style={[styles.sheetCard, { backgroundColor: theme.surface, borderColor: theme.border }]}
          >
            <View style={styles.sheetHeader}>
              <Text style={[styles.sheetTitle, { color: theme.text }]}>
                {activeFilterSheet === 'type'
                  ? 'Filter by type'
                  : activeFilterSheet === 'account'
                    ? 'Filter by account'
                    : activeFilterSheet === 'category'
                      ? 'Filter by category'
                      : 'Filter by date range'}
              </Text>
              <TouchableOpacity
                onPress={() => setActiveFilterSheet(null)}
                style={styles.sheetCloseBtn}
                accessibilityRole="button"
                accessibilityLabel="Close filter"
              >
                <Ionicons name="close" size={20} color={theme.textMuted} />
              </TouchableOpacity>
            </View>

            {activeFilterSheet === 'type' ? (
              <View style={styles.sheetList}>
                {TYPE_OPTIONS.map((opt) => {
                  const selected = typeFilter === opt.key;
                  return (
                    <TouchableOpacity
                      key={opt.label}
                      style={[
                        styles.sheetRow,
                        {
                          borderColor: selected ? theme.primary : theme.border,
                          backgroundColor: selected ? theme.primaryMuted : theme.background,
                        },
                      ]}
                      onPress={() => handleSelectTypeFilter(opt.key)}
                      accessibilityRole="button"
                      accessibilityLabel={`Type option ${opt.label}`}
                      accessibilityState={{ selected }}
                    >
                      <Text style={[styles.sheetRowText, { color: selected ? theme.primary : theme.text }]}>
                        {opt.label}
                      </Text>
                      {selected ? <Ionicons name="checkmark" size={18} color={theme.primary} /> : null}
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : null}

            {activeFilterSheet === 'account' ? (
              <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetList}>
                <TouchableOpacity
                  style={[
                    styles.sheetRow,
                    {
                      borderColor: walletFilterId == null ? theme.primary : theme.border,
                      backgroundColor: walletFilterId == null ? theme.primaryMuted : theme.background,
                    },
                  ]}
                  onPress={() => {
                    setWalletFilterId(null);
                    setActiveFilterSheet(null);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Account option All accounts"
                  accessibilityState={{ selected: walletFilterId == null }}
                >
                  <Text style={[styles.sheetRowText, { color: walletFilterId == null ? theme.primary : theme.text }]}>
                    All accounts
                  </Text>
                  {walletFilterId == null ? <Ionicons name="checkmark" size={18} color={theme.primary} /> : null}
                </TouchableOpacity>
                {wallets.map((w) => {
                  const selected = walletFilterId === w.id;
                  return (
                    <TouchableOpacity
                      key={w.id}
                      style={[
                        styles.sheetRow,
                        {
                          borderColor: selected ? theme.primary : theme.border,
                          backgroundColor: selected ? theme.primaryMuted : theme.background,
                        },
                      ]}
                      onPress={() => {
                        setWalletFilterId(w.id);
                        setActiveFilterSheet(null);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`Account option ${w.name}`}
                      accessibilityState={{ selected }}
                    >
                      <Text style={[styles.sheetRowText, { color: selected ? theme.primary : theme.text }]}>
                        {w.name}
                        {!w.isActive ? ' (archived)' : ''}
                      </Text>
                      {selected ? <Ionicons name="checkmark" size={18} color={theme.primary} /> : null}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            ) : null}

            {activeFilterSheet === 'category' ? (
              <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetList}>
                <TouchableOpacity
                  style={[
                    styles.sheetRow,
                    {
                      borderColor: categoryFilter == null ? theme.primary : theme.border,
                      backgroundColor: categoryFilter == null ? theme.primaryMuted : theme.background,
                    },
                  ]}
                  onPress={() => {
                    setCategoryFilter(null);
                    setActiveFilterSheet(null);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Category option All categories"
                  accessibilityState={{ selected: categoryFilter == null }}
                >
                  <Text style={[styles.sheetRowText, { color: categoryFilter == null ? theme.primary : theme.text }]}>
                    All categories
                  </Text>
                  {categoryFilter == null ? <Ionicons name="checkmark" size={18} color={theme.primary} /> : null}
                </TouchableOpacity>
                {filterableCategories.map((name) => {
                  const selected = categoryFilter === name;
                  return (
                    <TouchableOpacity
                      key={name}
                      style={[
                        styles.sheetRow,
                        {
                          borderColor: selected ? theme.primary : theme.border,
                          backgroundColor: selected ? theme.primaryMuted : theme.background,
                        },
                      ]}
                      onPress={() => {
                        setCategoryFilter(name);
                        setActiveFilterSheet(null);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`Category option ${name}`}
                      accessibilityState={{ selected }}
                    >
                      <Text style={[styles.sheetRowText, { color: selected ? theme.primary : theme.text }]}>
                        {name}
                      </Text>
                      {selected ? <Ionicons name="checkmark" size={18} color={theme.primary} /> : null}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            ) : null}

            {activeFilterSheet === 'date' ? (
              <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetList}>
                <TouchableOpacity
                  style={[
                    styles.sheetRow,
                    {
                      borderColor: dateFrom == null && dateTo == null ? theme.primary : theme.border,
                      backgroundColor: dateFrom == null && dateTo == null ? theme.primaryMuted : theme.background,
                    },
                  ]}
                  onPress={() => handleSelectDatePreset(null)}
                  accessibilityRole="button"
                  accessibilityLabel="Date option Any time"
                  accessibilityState={{ selected: dateFrom == null && dateTo == null }}
                >
                  <Text
                    style={[
                      styles.sheetRowText,
                      { color: dateFrom == null && dateTo == null ? theme.primary : theme.text },
                    ]}
                  >
                    Any time
                  </Text>
                  {dateFrom == null && dateTo == null ? (
                    <Ionicons name="checkmark" size={18} color={theme.primary} />
                  ) : null}
                </TouchableOpacity>
                {DATE_PRESETS.map((preset) => {
                  const selected = datePreset === preset.key;
                  return (
                    <TouchableOpacity
                      key={preset.key}
                      style={[
                        styles.sheetRow,
                        {
                          borderColor: selected ? theme.primary : theme.border,
                          backgroundColor: selected ? theme.primaryMuted : theme.background,
                        },
                      ]}
                      onPress={() => handleSelectDatePreset(preset.key)}
                      accessibilityRole="button"
                      accessibilityLabel={`Date option ${preset.label}`}
                      accessibilityState={{ selected }}
                    >
                      <Text style={[styles.sheetRowText, { color: selected ? theme.primary : theme.text }]}>
                        {preset.label}
                      </Text>
                      {selected ? <Ionicons name="checkmark" size={18} color={theme.primary} /> : null}
                    </TouchableOpacity>
                  );
                })}

                <Text style={[styles.customDateLabel, { color: theme.textMuted }]}>Custom range</Text>
                <View style={styles.customDateRow}>
                  <TouchableOpacity
                    style={[styles.customDateBtn, { borderColor: theme.border, backgroundColor: theme.background }]}
                    onPress={() => setDatePickerTarget('from')}
                    accessibilityRole="button"
                    accessibilityLabel="Pick start date"
                  >
                    <Text style={[styles.customDateHint, { color: theme.textMuted }]}>From</Text>
                    <Text style={[styles.customDateValue, { color: theme.text }]}>
                      {dateFrom != null
                        ? formatLocaleDate(dateFrom, locale, { day: 'numeric', month: 'short', year: 'numeric' })
                        : 'Any'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.customDateBtn, { borderColor: theme.border, backgroundColor: theme.background }]}
                    onPress={() => setDatePickerTarget('to')}
                    accessibilityRole="button"
                    accessibilityLabel="Pick end date"
                  >
                    <Text style={[styles.customDateHint, { color: theme.textMuted }]}>To</Text>
                    <Text style={[styles.customDateValue, { color: theme.text }]}>
                      {dateTo != null
                        ? formatLocaleDate(dateTo, locale, { day: 'numeric', month: 'short', year: 'numeric' })
                        : 'Any'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>
            ) : null}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {datePickerTarget !== null ? (
        <DateTimePicker
          value={
            datePickerTarget === 'from'
              ? new Date(dateFrom ?? Date.now())
              : new Date(dateTo ?? Date.now())
          }
          mode="date"
          display="default"
          onChange={handleCustomDateChange}
        />
      ) : null}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  searchBarWrap: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 14, marginTop: 8, marginBottom: 6, paddingHorizontal: 10, height: 42, borderRadius: 12, borderWidth: 1 },
  searchIcon: { marginRight: 8 },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 0 },
  clearSearchBtn: { padding: 4 },
  filterBarScroll: { flexGrow: 0, marginBottom: 8 },
  filterBarContent: { paddingHorizontal: 14, gap: 8, alignItems: 'center' },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 22,
    borderWidth: 1,
    gap: 5,
    maxWidth: 190,
  },
  filterChipText: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  filterSummaryCard: {
    marginHorizontal: 14,
    marginTop: 6,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: 1,
  },
  filterSummaryTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  filterSummaryCount: { fontSize: 12, fontWeight: '700' },
  filterSummaryUpdating: { fontSize: 11, fontWeight: '600' },
  filterSummaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  filterSummaryTruncation: { fontSize: 11, fontWeight: '600', marginTop: 8, textAlign: 'center' },
  truncationFooter: {
    marginHorizontal: 14,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  truncationFooterText: { fontSize: 12, fontWeight: '500', textAlign: 'center', lineHeight: 17 },
  sheetOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheetCard: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, padding: 16, maxHeight: '72%' },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sheetTitle: { fontSize: 16, fontWeight: '700' },
  sheetCloseBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  sheetScroll: { maxHeight: 360 },
  sheetList: { gap: 8, paddingBottom: 12 },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 46,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
  },
  sheetRowText: { fontSize: 14, fontWeight: '600', flex: 1, marginRight: 8 },
  customDateLabel: { fontSize: 12, fontWeight: '700', marginTop: 8, marginBottom: 4 },
  customDateRow: { flexDirection: 'row', gap: 10 },
  customDateBtn: {
    flex: 1,
    minHeight: 52,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    justifyContent: 'center',
  },
  customDateHint: { fontSize: 11, fontWeight: '600' },
  customDateValue: { fontSize: 13, fontWeight: '700', marginTop: 2 },
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
