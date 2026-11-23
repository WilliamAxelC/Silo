import React, { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  FlatList,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTransactionStore } from '../store/useTransactionStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useReceiptQueueStore } from '../store/useReceiptQueueStore';
import { useMonthlySummary } from '../hooks/useMonthlySummary';
import { useAppTheme } from '../theme/useAppTheme';
import { BackToCurrentPeriodButton } from '../components/BackToCurrentPeriodButton';
import { FilterSheet } from '../components/FilterSheet';
import { selectShowUpdateBanner, useUpdateStore } from '../services/updates';
import { useAppUpdateStore } from '../services/appUpdate';
import { useTermsStore } from '../services/terms';
import { ActiveFilterChips, IconToggle, ListToolbar } from '../components/ListToolbar';
import { countActiveFilters, type DateRangePreset, type TransactionFilters } from '../features/transactions/filters';
import { addAmounts, formatDisplayCurrency, summarizeTransactions, type TransactionFilterSummary } from '../features/transactions/amount';
import {
  formatCachedLocaleDate,
  formatPeriodLabel,
  getCalendarMonthBounds,
  getLocalDayBounds,
  isSamePeriod,
  shiftPeriod,
  toLocalDayKey,
  type CalendarDayCell,
} from '../features/transactions/periods';
import { MonthlyCalendarView } from '../components/MonthlyCalendarView';
import { WelcomeSheet } from '../components/WelcomeSheet';
import { UNCATEGORIZED_EXPENSE_LABEL } from '../features/transactions/constants';
import type { Transaction, TransactionType } from '../features/transactions/types';
import type { DailyTotal, SearchTransactionsOptions } from '../db/index';

import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { NavigationProps } from '../navigation/types';

type CashflowViewMode = 'list' | 'calendar';
const SECTION_HEADER_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
};

const CALENDAR_MONTH_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'long',
  year: 'numeric',
};

const SHORT_DAY_OPTIONS: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
};

const FULL_SHORT_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
};

const transactionKeyExtractor = (item: Transaction) => String(item.id);

interface TransactionRowProps {
  item: Transaction;
  accountLabel?: string;
  dateLabel?: string;
  currencyCode: string;
  useThousandsSeparator: boolean;
  theme: ReturnType<typeof useAppTheme>;
  onPress: (transactionId: number) => void;
}

const TransactionRow = React.memo(function TransactionRow({
  item,
  accountLabel,
  dateLabel,
  currencyCode,
  useThousandsSeparator,
  theme,
  onPress,
}: TransactionRowProps) {
  const isTransfer = item.type === 'transfer';
  const isIncome = !isTransfer && (item.type === 'income' || (item.totalAmount || 0) > 0);
  const tint = isTransfer ? theme.primary : isIncome ? theme.income : theme.expense;
  const tagLabel = item.tags && item.tags.length > 0 ? item.tags.map((t) => `#${t}`).join(' ') : '';
  const subtitle = isTransfer
    ? [dateLabel, accountLabel, tagLabel, item.note].filter(Boolean).join(' · ')
    : [dateLabel, item.category || UNCATEGORIZED_EXPENSE_LABEL, accountLabel, tagLabel, item.note]
        .filter(Boolean)
        .join(' · ');
  const amountText = formatDisplayCurrency(
    isTransfer ? Math.abs(item.totalAmount || 0) : item.totalAmount || 0,
    currencyCode,
    useThousandsSeparator
  );
  // Foreign-currency entries show what was actually paid, with the home value underneath.
  const isForeign = Boolean(item.originalCurrency && item.originalCurrency !== currencyCode && item.originalAmount != null);
  const foreignText = isForeign
    ? formatDisplayCurrency(
        isTransfer ? Math.abs(item.originalAmount ?? 0) : item.originalAmount ?? 0,
        item.originalCurrency as string,
        useThousandsSeparator
      )
    : null;

  const handlePress = useCallback(() => {
    onPress(item.id);
  }, [onPress, item.id]);

  return (
    <TouchableOpacity
      style={[styles.transactionRow, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`${item.merchantName || 'Unknown'}, ${isTransfer ? 'transfer ' : ''}${foreignText ? `${foreignText} (${amountText})` : amountText}, ${subtitle}`}
    >
      <View style={[styles.iconContainer, { backgroundColor: tint + '18' }]}>
        <Ionicons name={isTransfer ? 'swap-horizontal' : isIncome ? 'arrow-down' : 'arrow-up'} size={16} color={tint} />
      </View>
      <View style={styles.transactionDetails}>
        <Text style={[styles.transactionTitle, { color: theme.text, fontSize: theme.scaleFont(14) }]} numberOfLines={1}>
          {item.merchantName || 'Unknown'}
        </Text>
        <Text
          style={[styles.transactionSubtitle, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}
          numberOfLines={1}
        >
          {subtitle}
        </Text>
      </View>
      {foreignText ? (
        <View style={styles.foreignAmountWrap}>
          <Text style={[styles.transactionAmount, { color: tint, fontSize: theme.scaleFont(13) }]}>
            {isIncome ? '+' : ''}
            {foreignText}
          </Text>
          <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(11) }}>≈ {amountText}</Text>
        </View>
      ) : (
        <Text style={[styles.transactionAmount, { color: tint, fontSize: theme.scaleFont(13) }]}>
          {isIncome ? '+' : ''}
          {amountText}
        </Text>
      )}
    </TouchableOpacity>
  );
});

export const CashflowScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const fetchTransactions = useTransactionStore((state) => state.fetchTransactions);
  const searchTransactions = useTransactionStore((state) => state.searchTransactions);
  const summarizeSearchTransactions = useTransactionStore((state) => state.summarizeSearchTransactions);
  const getDailyTotals = useTransactionStore((state) => state.getDailyTotals);
  const transactionsList = useTransactionStore((state) => state.transactionsList);
  const dataVersion = useTransactionStore((state) => state.dataVersion);
  const error = useTransactionStore((state) => state.error);
  const clearError = useTransactionStore((state) => state.clearError);
  const theme = useAppTheme();
  const queueItems = useReceiptQueueStore((s) => s.items);
  const wallets = useTransactionStore((s) => s.wallets);
  const categories = useTransactionStore((s) => s.categories);
  const tags = useTransactionStore((s) => s.tags);
  const showUpdateBanner = useUpdateStore(selectShowUpdateBanner);
  const latestVersion = useUpdateStore((s) => s.latest);
  const dismissUpdate = useUpdateStore((s) => s.dismiss);
  const openUpdateSheet = useAppUpdateStore((s) => s.openSheet);
  // The welcome sheet waits until the Terms are accepted (TermsGate shows first).
  const termsAccepted = useTermsStore((s) => Boolean(s.accepted));
  const setStoredCashflowDateMs = useTransactionStore((s) => s.setSelectedCashflowDateMs);

  const [viewMode, setViewMode] = useState<CashflowViewMode>('list');
  const [currentDate, setCurrentDate] = useState(() => {
    const storedMs = useTransactionStore.getState().selectedCashflowDateMs;
    return typeof storedMs === 'number' && Number.isFinite(storedMs) ? new Date(storedMs) : new Date();
  });
  const currentDateRef = useRef<Date>(currentDate);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selectedCalendarDayKey, setSelectedCalendarDayKey] = useState<string | null>(() =>
    toLocalDayKey(new Date())
  );
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TransactionType | null>(null);
  const [walletFilterId, setWalletFilterId] = useState<number | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [datePreset, setDatePreset] = useState<DateRangePreset | null>(null);
  const [dateFrom, setDateFrom] = useState<number | null>(null);
  const [dateTo, setDateTo] = useState<number | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [filterRefreshTick, setFilterRefreshTick] = useState(0);
  const [searchResults, setSearchResults] = useState<Transaction[] | null>(null);
  const [searchSummaryState, setSearchSummaryState] = useState<TransactionFilterSummary | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  const hasActiveFilters = Boolean(
    typeFilter || walletFilterId != null || categoryFilter || tagFilter || dateFrom != null || dateTo != null
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchTransactions();
    setFilterRefreshTick((tick) => tick + 1);
    setRefreshing(false);
  }, [fetchTransactions]);

  useFocusEffect(
    useCallback(() => {
      const state = useTransactionStore.getState();
      if (!state.hasLoadedTransactions || state.transactionsDirty) {
        void fetchTransactions();
      }
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

    // "#date" in the search box filters by that tag (the whole text after # is the tag name).
    const tagQuery = trimmed.startsWith('#') ? trimmed.replace(/^#+/, '').trim() : '';
    const textQuery = tagQuery ? '' : trimmed;

    const options: SearchTransactionsOptions = {};
    if (tagQuery) options.tag = tagQuery;
    else if (tagFilter) options.tag = tagFilter;
    if (typeFilter) options.type = typeFilter;
    if (walletFilterId != null) options.walletId = walletFilterId;
    if (categoryFilter) options.category = categoryFilter;
    if (dateFrom != null) options.dateFrom = dateFrom;
    if (dateTo != null) options.dateTo = dateTo;

    const runSearch = async () => {
      try {
        const filterOptions = hasActiveFilters || tagQuery ? options : undefined;
        const [results, summary] = await Promise.all([
          searchTransactions(textQuery, filterOptions),
          summarizeSearchTransactions(textQuery, filterOptions),
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
    tagFilter,
    dateFrom,
    dateTo,
    dataVersion,
    filterRefreshTick,
    searchTransactions,
    summarizeSearchTransactions,
  ]);

  const currencyCode = useSettingsStore((state) => state.currencyCode);
  const useThousandsSeparator = useSettingsStore((state) => state.useThousandsSeparator);
  const dateFormat = useSettingsStore((state) => state.dateFormat);
  const monthStartDay = useSettingsStore((state) => state.monthStartDay);
  const weekStartDay = useSettingsStore((state) => state.weekStartDay);
  const isSettingsLoaded = useSettingsStore((state) => state.isLoaded);
  const hasCompletedOnboarding = useSettingsStore((state) => state.hasCompletedOnboarding);
  const locale = dateFormat || 'en-GB';

  const { currentMonthData, totalIncome, totalExpense, balance, periodBounds } = useMonthlySummary(currentDate);

  const updateCurrentDate = useCallback(
    (next: Date | ((prev: Date) => Date), persist = true) => {
      const resolved = typeof next === 'function' ? next(currentDateRef.current) : next;
      currentDateRef.current = resolved;
      setCurrentDate(resolved);
      setStoredCashflowDateMs?.(persist ? resolved.getTime() : null);
    },
    [setStoredCashflowDateMs]
  );

  const changeMonth = (offset: number) => {
    updateCurrentDate((prev) => shiftPeriod(prev, offset, monthStartDay), true);
  };

  const handleSwitchViewMode = (nextMode: CashflowViewMode) => {
    if (nextMode === viewMode) return;
    if (nextMode === 'calendar') {
      const now = new Date();
      const targetBase = isSamePeriod(currentDate, now, monthStartDay)
        ? now
        : monthStartDay === 1
          ? currentDate
          : periodBounds.end;
      const nextMonth = new Date(targetBase.getFullYear(), targetBase.getMonth(), 1);
      setCalendarMonth(nextMonth);
      setSelectedCalendarDayKey(
        nextMonth.getFullYear() === now.getFullYear() && nextMonth.getMonth() === now.getMonth()
          ? toLocalDayKey(now)
          : null
      );
    }
    setViewMode(nextMode);
  };

  const changeCalendarMonth = (offset: number) => {
    const next = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + offset, 1);
    const now = new Date();
    setCalendarMonth(next);
    if (monthStartDay === 1) {
      updateCurrentDate(next, true);
    }
    setSelectedCalendarDayKey(
      next.getFullYear() === now.getFullYear() && next.getMonth() === now.getMonth()
        ? toLocalDayKey(now)
        : null
    );
  };

  const resetCalendarToToday = () => {
    const now = new Date();
    setCalendarMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setSelectedCalendarDayKey(toLocalDayKey(now));
    if (monthStartDay === 1) {
      updateCurrentDate(now, false);
    }
  };

  const sectionListData = useMemo(() => {
    const groups = new Map<string, { timestamp: number; data: Transaction[] }>();
    for (let i = 0; i < currentMonthData.length; i += 1) {
      const curr = currentMonthData[i];
      const dayKey = toLocalDayKey(curr.date);
      const existing = groups.get(dayKey);
      if (existing) {
        existing.data.push(curr);
      } else {
        groups.set(dayKey, { timestamp: curr.date, data: [curr] });
      }
    }

    const sections: Array<{ key: string; title: string; data: Transaction[] }> = [];
    groups.forEach((group, dayKey) => {
      sections.push({
        key: dayKey,
        title: formatCachedLocaleDate(group.timestamp, locale, SECTION_HEADER_DATE_OPTIONS),
        data: group.data,
      });
    });
    return sections;
  }, [currentMonthData, locale]);

  const isCurrentMonthNow = isSamePeriod(currentDate, new Date(), monthStartDay);
  const periodLabel = useMemo(() => formatPeriodLabel(periodBounds, locale), [periodBounds, locale]);

  const nowForCalendar = new Date();
  const isCalendarCurrentMonth =
    calendarMonth.getFullYear() === nowForCalendar.getFullYear() &&
    calendarMonth.getMonth() === nowForCalendar.getMonth();
  const calendarMonthLabel = useMemo(
    () => formatCachedLocaleDate(calendarMonth, locale, CALENDAR_MONTH_OPTIONS),
    [calendarMonth, locale]
  );

  const calendarBounds = useMemo(
    () => getCalendarMonthBounds(calendarMonth.getFullYear(), calendarMonth.getMonth()),
    [calendarMonth]
  );

  const calendarDailyTotals = useMemo(() => {
    if (viewMode !== 'calendar') return [] as DailyTotal[];
    return getDailyTotals(calendarBounds.startMs, calendarBounds.endMs);
  }, [viewMode, calendarBounds.startMs, calendarBounds.endMs, getDailyTotals, dataVersion, filterRefreshTick, transactionsList]);

  const dailyTotalsMap = useMemo(() => {
    const map: Record<string, DailyTotal> = {};
    for (const row of calendarDailyTotals) {
      map[row.dayKey] = row;
    }
    return map;
  }, [calendarDailyTotals]);

  const calendarSummary = useMemo(() => {
    let income = 0;
    let expense = 0;
    for (const row of calendarDailyTotals) {
      income = addAmounts(income, row.income);
      expense = addAmounts(expense, row.expense);
    }
    return {
      income,
      expense,
      balance: addAmounts(income, -expense),
    };
  }, [calendarDailyTotals]);

  const selectedCalendarDate = useMemo(() => {
    if (!selectedCalendarDayKey) return null;
    const parts = selectedCalendarDayKey.split('-').map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
    return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
  }, [selectedCalendarDayKey]);

  const selectedDayTransactions = useMemo(() => {
    if (viewMode !== 'calendar' || !selectedCalendarDate) return [] as Transaction[];
    const { startMs, endMs } = getLocalDayBounds(selectedCalendarDate);
    return transactionsList
      .filter((tx) => typeof tx.date === 'number' && tx.date >= startMs && tx.date <= endMs)
      .sort((a, b) => b.date - a.date);
  }, [viewMode, selectedCalendarDate, transactionsList]);

  const handleSelectCalendarDay = (cell: CalendarDayCell) => {
    setSelectedCalendarDayKey(cell.dayKey);
  };

  const handleAddOnSelectedDay = () => {
    if (!selectedCalendarDate) return;
    const now = new Date();
    const prefillDate = new Date(
      selectedCalendarDate.getFullYear(),
      selectedCalendarDate.getMonth(),
      selectedCalendarDate.getDate(),
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
      0
    );
    navigation.navigate('AddTransactionStack', { initialDate: prefillDate.getTime() });
  };

  const resetToCurrentMonth = () => {
    updateCurrentDate(new Date(), false);
  };

  const renderSummaryCard = (incomeVal: number, expenseVal: number, balanceVal: number) => (
    <View style={[styles.summaryCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <View style={styles.summaryCol}>
        <Text style={[styles.summaryLabel, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>Income</Text>
        <Text
          style={[styles.summaryValue, { color: theme.income, fontSize: theme.scaleFont(13) }]}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {formatDisplayCurrency(incomeVal || 0, currencyCode, useThousandsSeparator)}
        </Text>
      </View>
      <View style={[styles.summaryDivider, { backgroundColor: theme.border }]} />
      <View style={styles.summaryCol}>
        <Text style={[styles.summaryLabel, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>Expense</Text>
        <Text
          style={[styles.summaryValue, { color: theme.expense, fontSize: theme.scaleFont(13) }]}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {formatDisplayCurrency(expenseVal || 0, currencyCode, useThousandsSeparator)}
        </Text>
      </View>
      <View style={[styles.summaryDivider, { backgroundColor: theme.border }]} />
      <View style={styles.summaryCol}>
        <Text style={[styles.summaryLabel, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>Balance</Text>
        <Text
          style={[
            styles.summaryValue,
            { color: (balanceVal || 0) >= 0 ? theme.income : theme.expense, fontSize: theme.scaleFont(13) },
          ]}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {formatDisplayCurrency(balanceVal || 0, currencyCode, useThousandsSeparator)}
        </Text>
      </View>
    </View>
  );

  const walletNames = useMemo(() => new Map(wallets.map((w) => [w.id, w.name])), [wallets]);
  const showAccountNames = useMemo(() => wallets.filter((w) => w.isActive).length > 1, [wallets]);

  const searchSummary = useMemo(
    () => searchSummaryState ?? summarizeTransactions(searchResults ?? []),
    [searchSummaryState, searchResults]
  );

  const isListTruncated = searchResults !== null && searchSummary.count > searchResults.length;

  const filters: TransactionFilters = {
    type: typeFilter,
    walletId: walletFilterId,
    category: categoryFilter,
    tag: tagFilter,
    datePreset,
    dateFrom,
    dateTo,
  };
  const activeFilterCount = countActiveFilters(filters);

  const applyFilters = (next: TransactionFilters) => {
    setTypeFilter(next.type);
    setWalletFilterId(next.walletId);
    setCategoryFilter(next.category);
    setTagFilter(next.tag);
    setDatePreset(next.datePreset);
    setDateFrom(next.dateFrom);
    setDateTo(next.dateTo);
  };

  const renderSearchSummaryHeader = () => (
    <View style={[styles.filterSummaryCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <View style={styles.filterSummaryTop}>
        <Text style={[styles.filterSummaryCount, { color: theme.text, fontSize: theme.scaleFont(12) }]}>
          {searchSummary.count} {searchSummary.count === 1 ? 'transaction' : 'transactions'}
        </Text>
        {isSearching ? (
          <Text style={[styles.filterSummaryUpdating, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
            Updating…
          </Text>
        ) : null}
      </View>
      <View style={styles.filterSummaryRow}>
        <View style={styles.summaryCol}>
          <Text style={[styles.summaryLabel, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>In</Text>
          <Text
            style={[styles.summaryValue, { color: theme.income, fontSize: theme.scaleFont(13) }]}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {formatDisplayCurrency(searchSummary.totalIn, currencyCode, useThousandsSeparator)}
          </Text>
        </View>
        <View style={[styles.summaryDivider, { backgroundColor: theme.border }]} />
        <View style={styles.summaryCol}>
          <Text style={[styles.summaryLabel, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>Out</Text>
          <Text
            style={[styles.summaryValue, { color: theme.expense, fontSize: theme.scaleFont(13) }]}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {formatDisplayCurrency(searchSummary.totalOut, currencyCode, useThousandsSeparator)}
          </Text>
        </View>
        <View style={[styles.summaryDivider, { backgroundColor: theme.border }]} />
        <View style={styles.summaryCol}>
          <Text style={[styles.summaryLabel, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>Net</Text>
          <Text
            style={[
              styles.summaryValue,
              { color: searchSummary.net >= 0 ? theme.income : theme.expense, fontSize: theme.scaleFont(13) },
            ]}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {formatDisplayCurrency(searchSummary.net, currencyCode, useThousandsSeparator)}
          </Text>
        </View>
      </View>
      {isListTruncated && searchResults ? (
        <Text style={[styles.filterSummaryTruncation, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
          Showing first {searchResults.length} of {searchSummary.count} matches · totals cover all {searchSummary.count}
        </Text>
      ) : null}
    </View>
  );

  const handleOpenTransaction = useCallback(
    (transactionId: number) => {
      navigation.navigate('AddTransactionStack', { transactionId });
    },
    [navigation]
  );

  const getAccountLabel = useCallback(
    (item: Transaction, alwaysShowAccount = false): string | undefined => {
      if (item.type === 'transfer') {
        return `${walletNames.get(item.walletId ?? -1) ?? 'Account'} → ${walletNames.get(item.toWalletId ?? -1) ?? 'Account'}`;
      }
      return (alwaysShowAccount || showAccountNames) && item.walletId ? walletNames.get(item.walletId) : undefined;
    },
    [walletNames, showAccountNames]
  );

  const renderTransactionRow = useCallback(
    ({ item }: { item: Transaction }) => (
      <TransactionRow
        item={item}
        accountLabel={getAccountLabel(item)}
        currencyCode={currencyCode}
        useThousandsSeparator={useThousandsSeparator}
        theme={theme}
        onPress={handleOpenTransaction}
      />
    ),
    [getAccountLabel, currencyCode, useThousandsSeparator, theme, handleOpenTransaction]
  );

  const currentYear = new Date().getFullYear();

  const renderSearchTransactionRow = useCallback(
    ({ item }: { item: Transaction }) => {
      const txYear = typeof item.date === 'number' && Number.isFinite(item.date) ? new Date(item.date).getFullYear() : currentYear;
      const dateLabel =
        typeof item.date === 'number' && Number.isFinite(item.date)
          ? formatCachedLocaleDate(item.date, locale, txYear === currentYear ? SHORT_DAY_OPTIONS : FULL_SHORT_DATE_OPTIONS)
          : undefined;
      return (
        <TransactionRow
          item={item}
          dateLabel={dateLabel}
          accountLabel={getAccountLabel(item, true)}
          currencyCode={currencyCode}
          useThousandsSeparator={useThousandsSeparator}
          theme={theme}
          onPress={handleOpenTransaction}
        />
      );
    },
    [currentYear, locale, getAccountLabel, currencyCode, useThousandsSeparator, theme, handleOpenTransaction]
  );

  const renderSectionHeader = useCallback(
    ({ section: { title } }: { section: { title: string } }) => (
      <Text style={[styles.sectionHeader, { color: theme.text, fontSize: theme.scaleFont(12) }]}>{title}</Text>
    ),
    [theme]
  );

  const monthlyHeaderElement = useMemo(
    () => renderSummaryCard(totalIncome, totalExpense, balance),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [totalIncome, totalExpense, balance, currencyCode, useThousandsSeparator, theme]
  );

  const searchSummaryHeaderElement = useMemo(
    () => renderSearchSummaryHeader(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchSummary, isSearching, isListTruncated, searchResults?.length, currencyCode, useThousandsSeparator, theme]
  );

  const queueReady = queueItems.filter((item) => item.status === 'done').length;
  const queueWaiting = queueItems.filter((item) => item.status === 'pending' || item.status === 'processing').length;

  const selectedDayShortLabel = selectedCalendarDate
    ? formatCachedLocaleDate(selectedCalendarDate, locale, SHORT_DAY_OPTIONS)
    : '';
  const selectedDayFullLabel = selectedCalendarDate
    ? formatCachedLocaleDate(selectedCalendarDate, locale, SECTION_HEADER_DATE_OPTIONS)
    : '';

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <View style={styles.toolbarWrap}>
        <ListToolbar
          leading={
            <IconToggle
              value={viewMode}
              onChange={handleSwitchViewMode}
              options={[
                { key: 'list', icon: 'list', label: 'List view' },
                { key: 'calendar', icon: 'calendar-outline', label: 'Calendar view' },
              ]}
            />
          }
          hideSearchAndFilters={viewMode !== 'list'}
          searchQuery={searchQuery}
          onChangeSearch={setSearchQuery}
          searchPlaceholder="Merchant, note, items or #tag"
          searchAccessibilityLabel="Search transactions"
          activeFilterCount={activeFilterCount}
          onOpenFilters={() => setFilterSheetOpen(true)}
        />
        {viewMode === 'list' ? (
          <ActiveFilterChips filters={filters} onChange={applyFilters} walletNames={walletNames} locale={locale} />
        ) : null}
      </View>

      {showUpdateBanner && latestVersion ? (
        <View
          testID="update-banner"
          style={[styles.errorBanner, { backgroundColor: theme.primaryMuted, borderColor: theme.primary }]}
        >
          <TouchableOpacity
            style={styles.updateBannerBody}
            onPress={() => openUpdateSheet(latestVersion)}
            accessibilityRole="button"
            accessibilityLabel={`Silo ${latestVersion.version} is available. Update`}
          >
            <Ionicons name="arrow-up-circle-outline" size={18} color={theme.primary} style={styles.errorBannerIcon} />
            <Text style={[styles.errorBannerText, { color: theme.primary, fontSize: theme.scaleFont(12) }]} numberOfLines={1}>
              Silo {latestVersion.version} is available · Update
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={dismissUpdate}
            style={styles.errorDismissBtn}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            accessibilityRole="button"
            accessibilityLabel="Dismiss update notice"
          >
            <Ionicons name="close" size={18} color={theme.primary} />
          </TouchableOpacity>
        </View>
      ) : null}

      {queueReady + queueWaiting > 0 && searchResults === null ? (
        <TouchableOpacity
          style={[styles.errorBanner, { backgroundColor: theme.primaryMuted, borderColor: theme.primary }]}
          onPress={() => navigation.navigate('ReceiptInbox')}
          accessibilityRole="button"
          accessibilityLabel="Open Receipt Inbox"
        >
          <Ionicons name="receipt-outline" size={18} color={theme.primary} style={styles.errorBannerIcon} />
          <Text style={[styles.errorBannerText, { color: theme.primary, fontSize: theme.scaleFont(12) }]} numberOfLines={1}>
            {queueReady > 0 ? `${queueReady} receipt${queueReady === 1 ? '' : 's'} ready to review` : 'Reading receipts…'}
            {queueReady > 0 && queueWaiting > 0 ? ` · ${queueWaiting} reading` : ''}
          </Text>
          <Ionicons name="chevron-forward" size={16} color={theme.primary} />
        </TouchableOpacity>
      ) : null}

      {error ? (
        <View style={[styles.errorBanner, { backgroundColor: theme.expenseMuted, borderColor: theme.expense }]}>
          <Ionicons name="alert-circle-outline" size={18} color={theme.expense} style={styles.errorBannerIcon} />
          <Text style={[styles.errorBannerText, { color: theme.expense, fontSize: theme.scaleFont(12) }]} numberOfLines={2}>
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

      {viewMode === 'calendar' ? (
        <>
          {/* Calendar Month Selector */}
          <View style={[styles.monthSelector, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
            <TouchableOpacity
              onPress={() => changeCalendarMonth(-1)}
              style={styles.arrowBtn}
              accessibilityRole="button"
              accessibilityLabel="Previous month"
            >
              <Ionicons name="chevron-back" size={20} color={theme.text} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={resetCalendarToToday}
              style={styles.monthTextWrap}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Jump to current month"
            >
              <Text
                style={[styles.monthText, { color: theme.text, fontSize: theme.scaleFont(16) }]}
                numberOfLines={1}
                adjustsFontSizeToFit
              >
                {calendarMonthLabel}
              </Text>
              {!isCalendarCurrentMonth && (
                <BackToCurrentPeriodButton onPress={resetCalendarToToday} locale={locale} />
              )}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => changeCalendarMonth(1)}
              style={styles.arrowBtn}
              accessibilityRole="button"
              accessibilityLabel="Next month"
            >
              <Ionicons name="chevron-forward" size={20} color={theme.text} />
            </TouchableOpacity>
          </View>

          <ScrollView
            contentContainerStyle={styles.listContent}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} />}
            showsVerticalScrollIndicator={false}
          >
            {renderSummaryCard(calendarSummary.income, calendarSummary.expense, calendarSummary.balance)}

            <MonthlyCalendarView
              year={calendarMonth.getFullYear()}
              month={calendarMonth.getMonth()}
              weekStartDay={weekStartDay}
              dailyTotalsMap={dailyTotalsMap}
              selectedDayKey={selectedCalendarDayKey}
              currencyCode={currencyCode}
              locale={locale}
              onSelectDay={handleSelectCalendarDay}
            />

            {selectedCalendarDate ? (
              <View style={styles.selectedDaySection}>
                <View style={styles.selectedDayHeader}>
                  <Text
                    style={[styles.selectedDayTitle, { color: theme.text, fontSize: theme.scaleFont(13) }]}
                    numberOfLines={1}
                  >
                    {selectedDayFullLabel}
                  </Text>
                  <TouchableOpacity
                    style={[styles.addOnDayBtn, { backgroundColor: theme.primaryMuted, borderColor: theme.primary }]}
                    onPress={handleAddOnSelectedDay}
                    accessibilityRole="button"
                    accessibilityLabel={`Add on ${selectedDayShortLabel}`}
                  >
                    <Ionicons name="add" size={16} color={theme.primary} />
                    <Text
                      style={[styles.addOnDayBtnText, { color: theme.primary, fontSize: theme.scaleFont(12) }]}
                      numberOfLines={1}
                    >
                      Add on {selectedDayShortLabel}
                    </Text>
                  </TouchableOpacity>
                </View>

                {selectedDayTransactions.length > 0 ? (
                  <View style={[styles.selectedDayListCard, { borderColor: theme.border, backgroundColor: theme.surface }]}>
                    {selectedDayTransactions.map((tx) => (
                      <TransactionRow
                        key={tx.id}
                        item={tx}
                        accountLabel={getAccountLabel(tx)}
                        currencyCode={currencyCode}
                        useThousandsSeparator={useThousandsSeparator}
                        theme={theme}
                        onPress={handleOpenTransaction}
                      />
                    ))}
                  </View>
                ) : (
                  <View style={[styles.emptyDayCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                    <Text style={[styles.emptyDayText, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>
                      No transactions on {selectedDayShortLabel}.
                    </Text>
                  </View>
                )}
              </View>
            ) : (
              <View style={[styles.emptyDayCard, { marginHorizontal: 14, marginTop: 12, backgroundColor: theme.surface, borderColor: theme.border }]}>
                <Text style={[styles.emptyDayText, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>
                  Tap a day to view its transactions or add one.
                </Text>
              </View>
            )}
          </ScrollView>
        </>
      ) : searchResults !== null ? (
        /* Search & Filtered Results List */
        <FlatList
          data={searchResults}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} />}
          keyExtractor={transactionKeyExtractor}
          ListHeaderComponent={searchSummaryHeaderElement}
          ListFooterComponent={
            isListTruncated ? (
              <View style={[styles.truncationFooter, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <Text style={[styles.truncationFooterText, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
                  List capped at {searchResults.length} of {searchSummary.count} matching transactions. Narrow filters to view older matches.
                </Text>
              </View>
            ) : null
          }
          renderItem={renderSearchTransactionRow}
          initialNumToRender={12}
          maxToRenderPerBatch={10}
          updateCellsBatchingPeriod={50}
          windowSize={11}
          removeClippedSubviews={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={[styles.emptyCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Ionicons name="search-outline" size={32} color={theme.textMuted} style={styles.emptyIcon} />
              <Text style={[styles.emptyTitle, { color: theme.text, fontSize: theme.scaleFont(14) }]}>
                {isSearching ? 'Searching...' : 'No transactions found'}
              </Text>
              <Text style={[styles.emptySubtitle, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
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
          {/* Month / Period Selector */}
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
              <Text style={[styles.monthText, { color: theme.text, fontSize: theme.scaleFont(16) }]} numberOfLines={1} adjustsFontSizeToFit>
                {periodLabel}
              </Text>
              {!isCurrentMonthNow && (
                <BackToCurrentPeriodButton onPress={resetToCurrentMonth} locale={locale} />
              )}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => changeMonth(1)} style={styles.arrowBtn} accessibilityRole="button" accessibilityLabel="Next month">
              <Ionicons name="chevron-forward" size={20} color={theme.text} />
            </TouchableOpacity>
          </View>

          <SectionList
            sections={sectionListData}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} />}
            keyExtractor={transactionKeyExtractor}
            ListHeaderComponent={monthlyHeaderElement}
            ListEmptyComponent={
              <View style={[styles.emptyCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <Ionicons name="wallet-outline" size={32} color={theme.textMuted} style={styles.emptyIcon} />
                <Text style={[styles.emptyTitle, { color: theme.text, fontSize: theme.scaleFont(14) }]}>
                  {monthStartDay === 1 ? 'No transactions this month' : 'No transactions in this period'}
                </Text>
                <Text style={[styles.emptySubtitle, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
                  Tap + at the bottom to add your first transaction.
                </Text>
              </View>
            }
            contentContainerStyle={styles.listContent}
            renderSectionHeader={renderSectionHeader}
            renderItem={renderTransactionRow}
            stickySectionHeadersEnabled={false}
            initialNumToRender={12}
            maxToRenderPerBatch={10}
            updateCellsBatchingPeriod={50}
            windowSize={11}
            removeClippedSubviews={false}
          />
        </>
      )}

      <FilterSheet
        visible={filterSheetOpen}
        onClose={() => setFilterSheetOpen(false)}
        sections={['type', 'account', 'category', 'tag', 'date']}
        filters={filters}
        onChange={applyFilters}
        wallets={wallets}
        categories={categories}
        tags={tags}
        monthStartDay={monthStartDay}
        locale={locale}
      />

      <WelcomeSheet visible={isSettingsLoaded && !hasCompletedOnboarding && termsAccepted} />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  updateBannerBody: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  toolbarWrap: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 6 },
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
  errorBanner: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 14, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, borderWidth: 1 },
  errorBannerIcon: { marginRight: 8 },
  errorBannerText: { flex: 1, fontSize: 12, fontWeight: '600' },
  errorDismissBtn: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginRight: -8 },
  monthSelector: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1 },
  monthTextWrap: { flex: 1, minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginHorizontal: 4 },
  monthText: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  selectedDaySection: { marginTop: 12 },
  selectedDayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    marginBottom: 8,
    gap: 8,
  },
  selectedDayTitle: { fontSize: 13, fontWeight: '700', flex: 1 },
  addOnDayBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    gap: 4,
  },
  addOnDayBtnText: { fontSize: 12, fontWeight: '700' },
  selectedDayListCard: {
    marginHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  emptyDayCard: {
    marginHorizontal: 14,
    paddingVertical: 18,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
  },
  emptyDayText: { fontSize: 13, fontWeight: '500', textAlign: 'center' },
  arrowBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  summaryCard: { flexDirection: 'row', marginHorizontal: 14, marginTop: 12, marginBottom: 4, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 14, borderWidth: 1, justifyContent: 'space-between', alignItems: 'center' },
  summaryCol: { alignItems: 'center', flex: 1 },
  summaryDivider: { width: 1, height: 26 },
  summaryLabel: { fontSize: 11, marginBottom: 3, fontWeight: '600' },
  summaryValue: { fontSize: 13, fontWeight: '700' },
  listContent: { paddingBottom: 28 },
  sectionHeader: { fontSize: 12, fontWeight: '700', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6 },
  transactionRow: { flexDirection: 'row', alignItems: 'center', minHeight: 62, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  iconContainer: { width: 34, height: 34, borderRadius: 17, justifyContent: 'center', alignItems: 'center', marginRight: 10 },
  transactionDetails: { flex: 1, marginRight: 10 },
  transactionTitle: { fontSize: 14, fontWeight: '600' },
  transactionSubtitle: { fontSize: 12, marginTop: 1 },
  foreignAmountWrap: { alignItems: 'flex-end' },
  transactionAmount: { fontSize: 13, fontWeight: '700' },
  emptyCard: { marginHorizontal: 14, marginTop: 24, padding: 24, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  emptyIcon: { marginBottom: 10 },
  emptyTitle: { fontSize: 14, fontWeight: '700', marginBottom: 4 },
  emptySubtitle: { fontSize: 12, textAlign: 'center', lineHeight: 16 },
});
