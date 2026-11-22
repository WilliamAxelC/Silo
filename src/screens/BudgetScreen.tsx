import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from '@react-navigation/native';

import { expoDb } from '../db/index';
import { useAppTheme } from '../theme/useAppTheme';
import { useTransactionStore } from '../store/useTransactionStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { formatDisplayCurrency } from '../features/transactions/amount';
import { getPeriodBounds } from '../features/transactions/periods';
import { computeBudgetStatus, type BudgetPlan, type BudgetStatus } from '../features/budgets/engine';
import type { BudgetPlanInput } from '../features/budgets/plans';
import { getCachedRate, refreshDailyRates } from '../services/fx/rates';
import { BudgetPlanEditor } from '../components/BudgetPlanEditor';

const getProgressTone = (percentage: number, theme: ReturnType<typeof useAppTheme>) => {
  if (percentage > 100) return theme.expense;
  if (percentage >= 80) return theme.warning;
  return theme.income;
};

const ProgressBar = ({ spent, limit, theme }: { spent: number; limit: number; theme: ReturnType<typeof useAppTheme> }) => {
  const progressAnim = useRef(new Animated.Value(0)).current;
  const rawPercentage = limit > 0 ? (spent / limit) * 100 : spent > 0 ? 101 : 0;
  const percentage = Math.min(Math.max(rawPercentage, 0), 100);
  const barColor = getProgressTone(rawPercentage, theme);

  useEffect(() => {
    Animated.timing(progressAnim, { toValue: percentage, duration: 650, useNativeDriver: false }).start();
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

const UNIT_LABEL: Record<BudgetPlan['unit'], [string, string]> = {
  day: ['day', 'days'],
  week: ['week', 'weeks'],
  month: ['month', 'months'],
  year: ['year', 'years'],
};

export const BudgetScreen = () => {
  const theme = useAppTheme();
  const currencyCode = useSettingsStore((state) => state.currencyCode);
  const useThousandsSeparator = useSettingsStore((state) => state.useThousandsSeparator);
  const dateFormat = useSettingsStore((state) => state.dateFormat);
  const monthStartDay = useSettingsStore((state) => state.monthStartDay);
  const plans = useTransactionStore((state) => state.budgetPlans);
  const wallets = useTransactionStore((state) => state.wallets);
  const tags = useTransactionStore((state) => state.tags);
  const categories = useTransactionStore((state) => state.categories);
  const dataVersion = useTransactionStore((state) => state.dataVersion);
  const getCategoriesByType = useTransactionStore((state) => state.getCategoriesByType);
  const [refreshing, setRefreshing] = useState(false);
  const [ratesVersion, setRatesVersion] = useState(0);
  const [editing, setEditing] = useState<{ plan: BudgetPlan | null } | null>(null);

  const refresh = useCallback(async (force = false) => {
    const state = useTransactionStore.getState();
    const work: Promise<void>[] = [];
    if (force || !state.hasLoadedTransactions || state.transactionsDirty) work.push(state.fetchTransactions());
    const needCategories = force || !state.hasLoadedCategories || state.categoriesDirty;
    if (needCategories) work.push(state.fetchCategories());
    await Promise.all(work);
    // fetchBudgets also loads budget plans; skip the query when nothing changed since the last load.
    if (needCategories || !state.hasLoadedBudgets || state.budgetsDirty) await useTransactionStore.getState().fetchBudgets();
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh(false);
    }, [refresh])
  );

  const needsRates = plans.some((p) => p.currency && p.currency !== currencyCode);
  useEffect(() => {
    if (!needsRates) return;
    let alive = true;
    void refreshDailyRates(currencyCode).then(() => alive && setRatesVersion((v) => v + 1));
    return () => {
      alive = false;
    };
  }, [needsRates, currencyCode]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh(true);
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const statuses = useMemo(() => {
    const now = Date.now();
    const rateFor = (code: string) => getCachedRate(code, currencyCode)?.rate ?? null;
    const result: BudgetStatus[] = [];
    for (const plan of plans) {
      if (plan.archived) continue;
      try {
        result.push(computeBudgetStatus(expoDb, plan, currencyCode, now, rateFor));
      } catch (error) {
        console.warn(`Failed to compute budget ${plan.id}:`, error);
      }
    }
    return result;
    // dataVersion/ratesVersion: recompute when transactions or rates change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans, currencyCode, dataVersion, ratesVersion]);

  const active = statuses.filter((s) => !s.ended);
  const finished = statuses.filter((s) => s.ended);
  const overspent = active.filter((s) => s.isOver).length;

  const expenseCategories = useMemo(
    () => getCategoriesByType('expense').map((c) => c.name),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [categories, getCategoriesByType]
  );
  const activeWallets = useMemo(
    () => wallets.filter((w) => w.isActive).map((w) => ({ id: w.id, name: w.name, currency: w.currency })),
    [wallets]
  );
  const tagNames = useMemo(() => tags.map((t) => t.name), [tags]);
  const walletNames = useMemo(() => new Map(wallets.map((w) => [w.id, w.name])), [wallets]);

  const money = (amount: number, code: string) => formatDisplayCurrency(amount, code, useThousandsSeparator);
  const fmtDay = (time: number) =>
    new Date(time).toLocaleDateString(dateFormat || 'en-GB', { day: 'numeric', month: 'short' });

  const describePeriod = (s: BudgetStatus) => {
    const range = `${fmtDay(s.periodStart)} – ${fmtDay(s.periodEnd - 1)}`;
    if (s.plan.kind === 'once') {
      if (s.notStarted) {
        const days = Math.ceil((s.plan.startDate - Date.now()) / 86_400_000);
        return `${range} · starts in ${days} day${days === 1 ? '' : 's'}`;
      }
      return s.ended ? `${range} · ended` : `${range} · ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} left`;
    }
    const [one, many] = UNIT_LABEL[s.plan.unit];
    const cadence = s.plan.every === 1 ? `Every ${one}` : `Every ${s.plan.every} ${many}`;
    return `${cadence} · ${range}`;
  };

  const describeFilters = (plan: BudgetPlan) => {
    const parts = [
      ...plan.categories,
      ...plan.walletIds.map((id) => walletNames.get(id)).filter((n): n is string => Boolean(n)),
      ...plan.tags.map((t) => `#${t}`),
    ];
    return parts.length > 0 ? parts.join(' · ') : 'All spending';
  };

  const handleSave = (input: BudgetPlanInput) => {
    try {
      useTransactionStore.getState().saveBudgetPlan(editing?.plan?.id ?? null, input);
      setEditing(null);
    } catch (error) {
      Alert.alert('Could not save budget', error instanceof Error ? error.message : String(error));
    }
  };

  const handleDelete = (plan: BudgetPlan) => {
    Alert.alert('Delete budget?', `"${plan.name}" will be removed. Your transactions are not affected.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          useTransactionStore.getState().deleteBudgetPlan(plan.id);
          setEditing(null);
        },
      },
    ]);
  };

  const renderCard = (s: BudgetStatus) => {
    const percentage = s.available > 0 ? (s.spent / s.available) * 100 : s.spent > 0 ? 101 : 0;
    const tone = getProgressTone(percentage, theme);
    return (
      <TouchableOpacity
        key={s.plan.id}
        testID={`budget-card-${s.plan.id}`}
        style={[styles.budgetCard, { backgroundColor: theme.surface, borderColor: theme.border, opacity: s.ended ? 0.75 : 1 }]}
        onPress={() => setEditing({ plan: s.plan })}
        accessibilityRole="button"
        accessibilityLabel={`${s.plan.name}, spent ${money(s.spent, s.currency)} of ${money(s.available, s.currency)}`}
      >
        <View style={styles.cardHeaderRow}>
          <View style={styles.cardHeadingBlock}>
            <Text style={[styles.cardTitle, { color: theme.text, fontSize: theme.scaleFont(15) }]} numberOfLines={1}>
              {s.plan.name}
            </Text>
            <Text style={[styles.cardMeta, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]} numberOfLines={1}>
              {describePeriod(s)}
            </Text>
            <Text style={[styles.cardMeta, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]} numberOfLines={1}>
              {describeFilters(s.plan)}
            </Text>
          </View>
          <Ionicons name="create-outline" size={18} color={theme.textMuted} />
        </View>

        <View style={styles.amountLine}>
          <Text style={[styles.amountPrimary, { color: theme.text, fontSize: theme.scaleFont(17) }]}>
            {money(s.spent, s.currency)}
          </Text>
          <Text style={[styles.amountSecondary, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>
            of {money(s.available, s.currency)}
          </Text>
        </View>
        <ProgressBar spent={s.spent} limit={s.available} theme={theme} />
        <View style={styles.bottomMetaRow}>
          <Text style={[styles.remainingText, { color: tone, fontSize: theme.scaleFont(13) }]}>
            {s.isOver ? `Over by ${money(-s.remaining, s.currency)}` : `${money(s.remaining, s.currency)} left`}
          </Text>
          {s.perDayLeft != null && !s.ended ? (
            <Text style={[styles.cardMeta, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
              ≈ {money(s.perDayLeft, s.currency)}/day
            </Text>
          ) : null}
        </View>
        {s.carried !== 0 ? (
          <Text style={[styles.cardMeta, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
            {s.carried > 0
              ? `Includes ${money(s.carried, s.currency)} carried over`
              : `${money(-s.carried, s.currency)} overspending carried in`}
          </Text>
        ) : null}
        {s.unconvertedHome > 0 ? (
          <Text style={[styles.cardMeta, { color: theme.warning, fontSize: theme.scaleFont(12) }]}>
            {money(s.unconvertedHome, currencyCode)} not counted until an exchange rate for {s.currency} is available
          </Text>
        ) : null}
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <View style={styles.headerRow}>
          <Text style={[styles.headerTitle, { color: theme.text, fontSize: theme.scaleFont(24) }]}>Budgets</Text>
          {active.length > 0 ? (
            <View style={[styles.headerPill, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Text
                style={[styles.headerPillText, { color: overspent > 0 ? theme.expense : theme.income, fontSize: theme.scaleFont(11.5) }]}
              >
                {overspent > 0 ? `${overspent} overspent` : 'On track'}
              </Text>
            </View>
          ) : null}
          <TouchableOpacity
            style={[styles.addBtn, { backgroundColor: theme.primary }]}
            onPress={() => setEditing({ plan: null })}
            accessibilityRole="button"
            accessibilityLabel="New budget"
          >
            <Ionicons name="add" size={18} color={theme.onPrimary} />
            <Text style={{ color: theme.onPrimary, fontSize: theme.scaleFont(13), fontWeight: '700' }}>New</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} colors={[theme.primary]} />}
      >
        {active.length === 0 && finished.length === 0 ? (
          <View style={[styles.emptyStateCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <View style={[styles.emptyIconWrap, { backgroundColor: theme.background, borderColor: theme.border }]}>
              <Ionicons name="wallet-outline" size={24} color={theme.primary} />
            </View>
            <Text style={[styles.emptyTitle, { color: theme.text, fontSize: theme.scaleFont(15) }]}>No budgets yet</Text>
            <Text style={[styles.emptySubtitle, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>
              Set a monthly limit for groceries, a weekly allowance, or a one-time budget for a holiday in its own currency.
            </Text>
            <TouchableOpacity
              style={[styles.emptyCta, { backgroundColor: theme.primary }]}
              onPress={() => setEditing({ plan: null })}
              accessibilityRole="button"
              accessibilityLabel="Create a budget"
            >
              <Text style={{ color: theme.onPrimary, fontSize: theme.scaleFont(14), fontWeight: '700' }}>Create a budget</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {active.map(renderCard)}

        {finished.length > 0 ? (
          <>
            <Text style={[styles.sectionTitle, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>Finished</Text>
            {finished.map(renderCard)}
          </>
        ) : null}
      </ScrollView>

      {editing ? (
        <BudgetPlanEditor
          plan={editing.plan}
          homeCurrency={currencyCode}
          defaultStart={getPeriodBounds(new Date(), monthStartDay).startMs}
          categories={expenseCategories}
          wallets={activeWallets}
          tags={tagNames}
          dateFormat={dateFormat}
          onSave={handleSave}
          onDelete={editing.plan ? () => handleDelete(editing.plan as BudgetPlan) : undefined}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10, borderBottomWidth: 1 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerTitle: { fontWeight: '800', letterSpacing: -0.5, flex: 1 },
  headerPill: { minHeight: 32, borderRadius: 999, borderWidth: 1, paddingHorizontal: 12, justifyContent: 'center' },
  headerPillText: { fontWeight: '700' },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 999, paddingHorizontal: 14, minHeight: 36 },
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 28 },
  sectionTitle: { fontWeight: '700', marginTop: 8, marginBottom: 8 },
  emptyStateCard: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 24, alignItems: 'center' },
  emptyIconWrap: { width: 50, height: 50, borderRadius: 16, borderWidth: 1, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  emptyTitle: { fontWeight: '700', marginBottom: 4 },
  emptySubtitle: { textAlign: 'center', lineHeight: 18 },
  emptyCta: { marginTop: 14, borderRadius: 999, paddingHorizontal: 18, minHeight: 44, justifyContent: 'center' },
  budgetCard: { borderWidth: 1, borderRadius: 20, padding: 14, marginBottom: 10, gap: 2 },
  cardHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 },
  cardHeadingBlock: { flex: 1, marginRight: 10 },
  cardTitle: { fontWeight: '700', marginBottom: 2 },
  cardMeta: { fontWeight: '600' },
  amountLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 8 },
  amountPrimary: { fontWeight: '800', flexShrink: 1, marginRight: 8 },
  amountSecondary: { fontWeight: '600', flexShrink: 1 },
  progressTrack: { height: 10, borderRadius: 999, overflow: 'hidden', borderWidth: 1, marginBottom: 8 },
  progressFill: { height: '100%', borderRadius: 999 },
  bottomMetaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  remainingText: { fontWeight: '700', flexShrink: 1 },
});
