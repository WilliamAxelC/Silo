import React, { useCallback, useEffect, useMemo } from 'react';
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';

import type { NavigationProps, RootStackParamList } from '../navigation/types';
import { useTransactionStore } from '../store/useTransactionStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { formatDisplayCurrency } from '../features/transactions/amount';
import { buildAccountLedger, type LedgerEntry } from '../features/transactions/accountLedger';
import { walletCurrencyOf } from '../features/currency/currencies';
import { walletHomeRate } from '../services/fx/rates';
import { WALLET_TYPE_META } from '../components/AccountPickerModal';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import { useAppTheme } from '../theme/useAppTheme';

/** Every transaction in or out of one account, newest first, with the balance after each. */
export const AccountDetailScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const route = useRoute<RouteProp<RootStackParamList, 'AccountDetail'>>();
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const homeCurrency = useSettingsStore((s) => s.currencyCode);
  const useThousands = useSettingsStore((s) => s.useThousandsSeparator);
  const dateFormat = useSettingsStore((s) => s.dateFormat);
  const wallets = useTransactionStore((s) => s.wallets);
  const transactionsList = useTransactionStore((s) => s.transactionsList);
  const walletId = route.params?.walletId;
  const wallet = wallets.find((w) => w.id === walletId) ?? null;

  useEffect(() => {
    const state = useTransactionStore.getState();
    if (!state.hasLoadedTransactions || state.transactionsDirty) void state.fetchTransactions();
  }, []);

  const ledger = useMemo(() => (wallet ? buildAccountLedger(transactionsList, wallet) : []), [transactionsList, wallet]);
  const currency = walletCurrencyOf(wallet, homeCurrency);
  const isForeign = currency !== homeCurrency;
  const money = useCallback(
    (amount: number, code: string = currency) => formatDisplayCurrency(amount, code, useThousands),
    [currency, useThousands]
  );
  const walletName = useCallback((id?: number | null) => wallets.find((w) => w.id === id)?.name ?? 'Account', [wallets]);
  const { moneyIn, moneyOut } = useMemo(
    () =>
      ledger.reduce(
        (acc, e) => (e.delta >= 0 ? { ...acc, moneyIn: acc.moneyIn + e.delta } : { ...acc, moneyOut: acc.moneyOut - e.delta }),
        { moneyIn: 0, moneyOut: 0 }
      ),
    [ledger]
  );

  if (!wallet) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
        <Text style={{ color: theme.textMuted, padding: 20 }}>This account no longer exists.</Text>
      </SafeAreaView>
    );
  }

  const homeRate = isForeign ? walletHomeRate(wallet, homeCurrency) : null;
  const describe = (e: LedgerEntry) => {
    const t = e.transaction;
    const day = new Date(t.date).toLocaleDateString(dateFormat || 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const tags = (t.tags ?? []).map((tag) => `#${tag}`).join(' ');
    const what =
      t.type === 'transfer'
        ? t.toWalletId === wallet.id
          ? `From ${walletName(t.walletId)}`
          : `To ${walletName(t.toWalletId)}`
        : t.category;
    return [day, what, tags].filter(Boolean).join(' · ');
  };

  const renderItem = ({ item: e }: { item: LedgerEntry }) => {
    const t = e.transaction;
    const tint = t.type === 'transfer' ? theme.primary : e.delta >= 0 ? theme.income : theme.expense;
    return (
      <TouchableOpacity
        style={[styles.row, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}
        onPress={() => navigation.navigate('AddTransactionStack', { transactionId: t.id })}
        accessibilityRole="button"
        accessibilityLabel={`${t.merchantName}, ${e.delta >= 0 ? 'in' : 'out'} ${money(Math.abs(e.delta))}, balance ${money(e.balanceAfter)}`}
      >
        <View style={styles.rowBody}>
          <Text style={[styles.rowTitle, { color: theme.text, fontSize: theme.scaleFont(14) }]} numberOfLines={1}>
            {t.merchantName || 'Unknown'}
          </Text>
          <Text style={[styles.rowSub, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]} numberOfLines={1}>
            {describe(e)}
          </Text>
        </View>
        <View style={styles.rowAmounts}>
          <Text style={[styles.rowAmount, { color: tint, fontSize: theme.scaleFont(14) }]}>
            {e.delta >= 0 ? '+' : ''}
            {money(e.delta)}
          </Text>
          <Text style={[styles.rowSub, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>{money(e.balanceAfter)}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="chevron-back" size={24} color={theme.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: theme.text, fontSize: theme.scaleFont(18) }]} numberOfLines={1}>
          {wallet.name}
        </Text>
        <TouchableOpacity
          onPress={() => navigation.navigate('Accounts', { editWalletId: wallet.id })}
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${wallet.name}`}
        >
          <Ionicons name="create-outline" size={22} color={theme.text} />
        </TouchableOpacity>
      </View>

      <FlatList
        data={ledger}
        keyExtractor={(e) => String(e.transaction.id)}
        renderItem={renderItem}
        contentContainerStyle={{ paddingBottom: getBottomInsetPadding(insets.bottom, 24) }}
        ListHeaderComponent={
          <View style={[styles.summary, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.summaryLabel, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
              {WALLET_TYPE_META[wallet.type].label}
              {isForeign ? ` · ${currency}` : ''} · Balance
            </Text>
            <Text style={[styles.balance, { color: wallet.balance < 0 ? theme.expense : theme.text, fontSize: theme.scaleFont(26) }]}>
              {money(wallet.balance)}
            </Text>
            {isForeign && homeRate ? (
              <Text style={[styles.summaryLabel, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
                ≈ {money(wallet.balance * homeRate, homeCurrency)}
              </Text>
            ) : null}
            <View style={styles.summaryRow}>
              <Text style={{ color: theme.income, fontSize: theme.scaleFont(12), fontWeight: '700' }}>In {money(moneyIn)}</Text>
              <Text style={{ color: theme.expense, fontSize: theme.scaleFont(12), fontWeight: '700' }}>Out {money(moneyOut)}</Text>
            </View>
          </View>
        }
        ListEmptyComponent={
          <Text style={[styles.empty, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>
            No transactions in this account yet.
          </Text>
        }
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1, gap: 4 },
  iconBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontWeight: '800' },
  summary: { margin: 16, borderWidth: 1, borderRadius: 20, padding: 16, gap: 4 },
  summaryLabel: { fontWeight: '600' },
  balance: { fontWeight: '800' },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 12 },
  rowBody: { flex: 1 },
  rowTitle: { fontWeight: '700' },
  rowSub: { fontWeight: '500', marginTop: 2 },
  rowAmounts: { alignItems: 'flex-end' },
  rowAmount: { fontWeight: '800' },
  empty: { textAlign: 'center', padding: 24 },
});
