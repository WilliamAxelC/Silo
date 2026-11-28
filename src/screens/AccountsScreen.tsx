import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';

import { NavigationProps, type RootStackParamList } from '../navigation/types';
import { useTransactionStore } from '../store/useTransactionStore';
import { useSettingsStore } from '../store/useSettingsStore';
import {
  formatAmountForInput,
  formatAmountInput,
  formatDisplayCurrency,
  HIDDEN_TOTAL,
  isAmountWithinRange,
  parseSignedAmount,
} from '../features/transactions/amount';
import type { Wallet, WalletType } from '../features/transactions/types';
import { DEFAULT_WALLET_ID } from '../features/transactions/constants';
import { WALLET_TYPE_META } from '../components/AccountPickerModal';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import { quickCurrencyChoices, walletCurrencyOf } from '../features/currency/currencies';
import { CurrencyPickerModal } from '../components/CurrencyPickerModal';
import { refreshDailyRates, walletHomeRate } from '../services/fx/rates';
import { useAppTheme } from '../theme/useAppTheme';
import { KeyboardSheet } from '../components/KeyboardSheet';
import { SHEET_WIDTH } from '../theme/layout';

interface Draft {
  id: number | null;
  name: string;
  type: WalletType;
  openingBalance: string;
  openingNegative: boolean;
  /** Account currency; the home currency for ordinary accounts. */
  currency: string;
}

export const AccountsScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const currencyCode = useSettingsStore((s) => s.currencyCode);
  const useThousands = useSettingsStore((s) => s.useThousandsSeparator);
  const hideTotals = useSettingsStore((s) => s.hideTotals);
  const setHideTotals = useSettingsStore((s) => s.setHideTotals);
  const wallets = useTransactionStore((s) => s.wallets);
  const transactionsList = useTransactionStore((s) => s.transactionsList);
  const { addWallet, updateWallet, removeWallet } = useTransactionStore.getState();
  const [draft, setDraft] = useState<Draft | null>(null);
  const route = useRoute<RouteProp<RootStackParamList, 'Accounts'>>();
  const editWalletId = route.params?.editWalletId;
  const [showArchived, setShowArchived] = useState(false);
  const [currencyPickerVisible, setCurrencyPickerVisible] = useState(false);

  const active = wallets.filter((w) => w.isActive);
  const archived = wallets.filter((w) => !w.isActive);
  const hasForeign = wallets.some((w) => w.currency && w.currency !== currencyCode);
  const [ratesVersion, setRatesVersion] = useState(0);
  useEffect(() => {
    if (!hasForeign) return;
    let alive = true;
    void refreshDailyRates(currencyCode).then(() => alive && setRatesVersion((v) => v + 1));
    return () => {
      alive = false;
    };
  }, [hasForeign, currencyCode]);

  // Foreign accounts count toward net worth at their average exchange cost (or today's rate when unknown).
  const homeValue = (w: Wallet): number | null => {
    const rate = walletHomeRate(w, currencyCode);
    return rate == null ? null : w.balance * rate;
  };
  const { netWorth, assets, debts, unpriced } = useMemo(() => {
    const totals = { netWorth: 0, assets: 0, debts: 0, unpriced: 0 };
    for (const w of active) {
      const value = homeValue(w);
      if (value == null) {
        totals.unpriced += 1;
        continue;
      }
      totals.netWorth += value;
      if (value >= 0) totals.assets += value;
      else totals.debts += -value;
    }
    return totals;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, currencyCode, ratesVersion]);
  const archivedNet = useMemo(
    () => archived.reduce((sum, w) => sum + (homeValue(w) ?? 0), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [archived, currencyCode, ratesVersion]
  );
  const money = (n: number, code: string = currencyCode) => formatDisplayCurrency(n, code, useThousands);
  const total = (n: number) => (hideTotals ? HIDDEN_TOTAL : money(n));
  const emptyDraft: Draft = { id: null, name: '', type: 'bank', openingBalance: '', openingNegative: false, currency: currencyCode };
  const draftCurrency = draft?.currency ?? currencyCode;
  const pickDraftCurrency = (code: string) =>
    setDraft((d) => (d ? { ...d, currency: code, openingBalance: formatAmountInput(d.openingBalance, code) } : d));

  const editingWallet = draft?.id != null ? wallets.find((w) => w.id === draft.id) ?? null : null;
  const editingWalletHasHistory = Boolean(
    editingWallet &&
      transactionsList.some((tx) => tx.walletId === editingWallet.id || tx.toWalletId === editingWallet.id)
  );
  const willArchiveEditingWallet = Boolean(
    editingWallet && editingWallet.isActive && (editingWallet.id === DEFAULT_WALLET_ID || editingWalletHasHistory)
  );
  const canRemoveEditingWallet = Boolean(
    editingWallet &&
      (willArchiveEditingWallet ||
        editingWallet.isActive ||
        (editingWallet.id !== DEFAULT_WALLET_ID && !editingWalletHasHistory))
  );

  const openEditor = (wallet?: Wallet) =>
    setDraft(
      wallet
        ? {
            id: wallet.id,
            name: wallet.name,
            type: wallet.type,
            openingBalance: wallet.initialBalance
              ? formatAmountForInput(wallet.initialBalance, walletCurrencyOf(wallet, currencyCode))
              : '',
            openingNegative: wallet.initialBalance < 0,
            currency: walletCurrencyOf(wallet, currencyCode),
          }
        : emptyDraft,
    );

  useEffect(() => {
    if (editWalletId == null) return;
    const target = wallets.find((w) => w.id === editWalletId);
    if (target) openEditor(target);
    navigation.setParams?.({ editWalletId: undefined } as never);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editWalletId]);

  const save = () => {
    if (!draft) return;
    const magnitude = Math.abs(parseSignedAmount(draft.openingBalance || '0', undefined, draft.currency));
    if (!isAmountWithinRange(magnitude)) {
      Alert.alert('Amount too large', 'Enter an opening balance within the supported range.');
      return;
    }
    const initialBalance = draft.openingNegative ? -magnitude : magnitude;
    const currency = draft.currency === currencyCode ? null : draft.currency;
    try {
      if (draft.id === null) addWallet({ name: draft.name, type: draft.type, initialBalance, currency });
      else updateWallet(draft.id, { name: draft.name, type: draft.type, initialBalance, currency });
      setDraft(null);
    } catch (error) {
      Alert.alert('Could not save account', error instanceof Error ? error.message : String(error));
    }
  };

  const remove = () => {
    if (draft?.id == null) return;
    const id = draft.id;
    const actionTitle = willArchiveEditingWallet ? 'Archive account?' : 'Remove account?';
    const actionBody = willArchiveEditingWallet
      ? 'Its past transactions stay in Cashflow. Its balance is excluded from active Net worth while archived, and you can restore it anytime.'
      : 'This unused account will be deleted permanently.';
    const actionButton = willArchiveEditingWallet ? 'Archive' : 'Remove';
    Alert.alert(actionTitle, actionBody, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: actionButton,
        style: 'destructive',
        onPress: () => {
          const result = removeWallet(id);
          if (!result.ok) Alert.alert(willArchiveEditingWallet ? 'Not archived' : 'Not removed', result.message ?? '');
          else setDraft(null);
        },
      },
    ]);
  };

  const renderWallet = (wallet: Wallet) => {
    const code = walletCurrencyOf(wallet, currencyCode);
    const isForeign = code !== currencyCode;
    const value = isForeign ? homeValue(wallet) : null;
    const subtitle = isForeign
      ? `${WALLET_TYPE_META[wallet.type].label} · ${code}${value != null ? ` · ≈ ${money(value)}` : ''}`
      : WALLET_TYPE_META[wallet.type].label;
    return (
    <TouchableOpacity
      key={wallet.id}
      style={[styles.row, { backgroundColor: theme.surface, borderColor: theme.border, opacity: wallet.isActive ? 1 : 0.6 }]}
      onPress={() => navigation.navigate('AccountDetail', { walletId: wallet.id })}
      accessibilityRole="button"
      accessibilityLabel={`${wallet.name}, ${WALLET_TYPE_META[wallet.type].label}, balance ${money(wallet.balance, code)}`}
      accessibilityHint="Shows this account's transactions"
    >
      <View style={[styles.iconWrap, { backgroundColor: theme.primaryMuted }]}>
        <Ionicons name={WALLET_TYPE_META[wallet.type].icon} size={20} color={theme.primary} />
      </View>
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, { color: theme.text, fontSize: theme.scaleFont(15) }]} numberOfLines={1}>
          {wallet.name}
        </Text>
        <Text style={[styles.rowSub, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      <Text
        style={[
          styles.rowAmount,
          { color: wallet.balance < 0 ? theme.expense : theme.text, fontSize: theme.scaleFont(15) },
        ]}
      >
        {money(wallet.balance, code)}
      </Text>
      <TouchableOpacity
        onPress={() => openEditor(wallet)}
        style={styles.editBtn}
        accessibilityRole="button"
        accessibilityLabel={`Edit ${wallet.name}`}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Ionicons name="create-outline" size={18} color={theme.textMuted} />
      </TouchableOpacity>
    </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={24} color={theme.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: theme.text, fontSize: theme.scaleFont(18) }]}>Accounts</Text>
        <TouchableOpacity
          style={[styles.addBtn, { backgroundColor: theme.primary }]}
          onPress={() => openEditor()}
          accessibilityRole="button"
          accessibilityLabel="Add account"
        >
          <Ionicons name="add" size={18} color={theme.onPrimary} />
          <Text style={[styles.addText, { color: theme.onPrimary, fontSize: theme.scaleFont(13) }]}>Add</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: getBottomInsetPadding(insets.bottom, 40) }]}
      >
        <TouchableOpacity
          testID="networth-totals"
          activeOpacity={0.7}
          onPress={() => void setHideTotals(!hideTotals)}
          accessibilityRole="button"
          accessibilityLabel={hideTotals ? 'Net worth hidden. Tap to show.' : undefined}
          accessibilityHint={hideTotals ? undefined : 'Tap to hide the totals'}
          style={[styles.summary, { backgroundColor: theme.surface, borderColor: theme.border }]}
        >
          <Text style={[styles.summaryLabel, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
            Net worth
          </Text>
          <Text
            style={[
              styles.netWorth,
              { color: netWorth < 0 && !hideTotals ? theme.expense : theme.text, fontSize: theme.scaleFont(26) },
            ]}
          >
            {total(netWorth)}
          </Text>
          <View style={styles.summaryRow}>
            <Text style={[styles.summarySub, { color: theme.income, fontSize: theme.scaleFont(12) }]}>
              Assets {total(assets)}
            </Text>
            <Text style={[styles.summarySub, { color: theme.expense, fontSize: theme.scaleFont(12) }]}>
              Debts {total(debts)}
            </Text>
          </View>
          {archived.length > 0 ? (
            <Text
              testID="archived-networth-note"
              style={[styles.summaryFootnote, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}
            >
              Active accounts only{archivedNet !== 0 ? ` · Archived: ${total(archivedNet)}` : ''}
            </Text>
          ) : null}
          {unpriced > 0 ? (
            <Text style={[styles.summaryFootnote, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
              {unpriced} foreign account{unpriced === 1 ? '' : 's'} left out until an exchange rate is available
            </Text>
          ) : null}
        </TouchableOpacity>

        {active.map(renderWallet)}

        {archived.length > 0 ? (
          <TouchableOpacity onPress={() => setShowArchived((v) => !v)} style={styles.archivedToggle} accessibilityRole="button">
            <Text style={[styles.archivedText, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>
              {showArchived ? 'Hide' : 'Show'} archived ({archived.length})
            </Text>
          </TouchableOpacity>
        ) : null}
        {showArchived ? archived.map(renderWallet) : null}

        <Text style={[styles.hint, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
          Pick the account on each transaction. Use Transfer to move money between accounts, e.g. topping up GoPay from
          your bank; transfers don&apos;t count as income or spending.
        </Text>
      </ScrollView>

      <Modal statusBarTranslucent navigationBarTranslucent visible={draft !== null} transparent animationType="slide" onRequestClose={() => setDraft(null)}>
        <KeyboardSheet style={styles.overlay}>
          <View
            testID="account-editor-sheet"
            style={[
              styles.sheet,
              { backgroundColor: theme.surface, paddingBottom: getBottomInsetPadding(insets.bottom, 24) },
            ]}
          >
            <ScrollView
              testID="account-editor-scroll"
              bounces={false}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={[styles.sheetTitle, { color: theme.text, fontSize: theme.scaleFont(17) }]}>
                {draft?.id == null ? 'New account' : 'Edit account'}
              </Text>

              <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(12) }]}>Name</Text>
              <TextInput
                style={[styles.input, { borderColor: theme.border, color: theme.text, fontSize: theme.scaleFont(15) }]}
                value={draft?.name ?? ''}
                onChangeText={(name) => setDraft((d) => (d ? { ...d, name } : d))}
                placeholder="e.g. BCA, GoPay, Wallet"
                placeholderTextColor={theme.textMuted}
                accessibilityLabel="Account name"
              />

              <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(12) }]}>Type</Text>
              <View style={styles.chips}>
                {(Object.keys(WALLET_TYPE_META) as WalletType[]).map((t) => {
                  const selected = draft?.type === t;
                  return (
                    <TouchableOpacity
                      key={t}
                      style={[
                        styles.chip,
                        {
                          borderColor: selected ? theme.primary : theme.border,
                          backgroundColor: selected ? theme.primaryMuted : 'transparent',
                        },
                      ]}
                      onPress={() => setDraft((d) => (d ? { ...d, type: t } : d))}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                    >
                      <Ionicons name={WALLET_TYPE_META[t].icon} size={14} color={selected ? theme.primary : theme.textMuted} />
                      <Text
                        style={[
                          styles.chipText,
                          { color: selected ? theme.primary : theme.text, fontSize: theme.scaleFont(13) },
                        ]}
                      >
                        {WALLET_TYPE_META[t].label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(12) }]}>Currency</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                {quickCurrencyChoices([currencyCode, ...wallets.map((w) => w.currency)], draftCurrency).map((code) => {
                  const selected = draftCurrency === code;
                  const locked = editingWalletHasHistory && !selected;
                  return (
                    <TouchableOpacity
                      key={code}
                      disabled={locked}
                      style={[
                        styles.chip,
                        {
                          borderColor: selected ? theme.primary : theme.border,
                          backgroundColor: selected ? theme.primaryMuted : 'transparent',
                          opacity: locked ? 0.4 : 1,
                        },
                      ]}
                      onPress={() => pickDraftCurrency(code)}
                      accessibilityRole="button"
                      accessibilityLabel={`Account currency ${code}${code === currencyCode ? ' (home)' : ''}`}
                      accessibilityState={{ selected, disabled: locked }}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          { color: selected ? theme.primary : theme.text, fontSize: theme.scaleFont(13) },
                        ]}
                      >
                        {code}
                        {code === currencyCode ? ' · home' : ''}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
                {!editingWalletHasHistory ? (
                  <TouchableOpacity
                    style={[styles.chip, { borderColor: theme.border, backgroundColor: 'transparent' }]}
                    onPress={() => setCurrencyPickerVisible(true)}
                    accessibilityRole="button"
                    accessibilityLabel="More currencies"
                  >
                    <Text style={[styles.chipText, { color: theme.primary, fontSize: theme.scaleFont(13) }]}>More…</Text>
                  </TouchableOpacity>
                ) : null}
              </ScrollView>
              <CurrencyPickerModal
                visible={currencyPickerVisible}
                title="Account currency"
                selected={draftCurrency}
                preferred={[currencyCode, ...wallets.map((w) => w.currency)]}
                onSelect={pickDraftCurrency}
                onClose={() => setCurrencyPickerVisible(false)}
              />
              {editingWalletHasHistory ? (
                <Text style={[styles.summaryFootnote, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
                  Currency is fixed once an account has transactions.
                </Text>
              ) : draftCurrency !== currencyCode ? (
                <Text style={[styles.summaryFootnote, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
                  Balance is kept in {draftCurrency}. Fill it with a Transfer from one of your {currencyCode} accounts to
                  record the exchange rate.
                </Text>
              ) : null}

              <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(12) }]}>Opening balance</Text>
              <View style={styles.balanceRow}>
                <TouchableOpacity
                  style={[styles.signBtn, { borderColor: theme.border }]}
                  onPress={() => setDraft((d) => (d ? { ...d, openingNegative: !d.openingNegative } : d))}
                  accessibilityRole="button"
                  accessibilityLabel={
                    draft?.openingNegative
                      ? 'Balance is owed (negative). Tap to make positive'
                      : 'Balance is positive. Tap if you owe this amount'
                  }
                >
                  <Text
                    style={[
                      styles.signText,
                      { color: draft?.openingNegative ? theme.expense : theme.income, fontSize: theme.scaleFont(13) },
                    ]}
                  >
                    {draft?.openingNegative ? 'Owe' : 'Have'}
                  </Text>
                </TouchableOpacity>
                <TextInput
                  style={[styles.input, styles.flex, { borderColor: theme.border, color: theme.text, fontSize: theme.scaleFont(15) }]}
                  value={draft?.openingBalance ?? ''}
                  onChangeText={(v) => setDraft((d) => (d ? { ...d, openingBalance: formatAmountInput(v, d.currency) } : d))}
                  keyboardType={Platform.OS === 'ios' ? 'decimal-pad' : 'numeric'}
                  placeholder="0"
                  placeholderTextColor={theme.textMuted}
                  accessibilityLabel="Opening balance"
                />
              </View>

              <View style={styles.actions}>
                {canRemoveEditingWallet ? (
                  <TouchableOpacity
                    onPress={remove}
                    style={styles.secondaryBtn}
                    accessibilityRole="button"
                    accessibilityLabel={willArchiveEditingWallet ? 'Archive account' : 'Remove account'}
                  >
                    <Text style={[styles.secondaryText, { color: theme.expense, fontSize: theme.scaleFont(14) }]}>
                      {willArchiveEditingWallet ? 'Archive' : 'Remove'}
                    </Text>
                  </TouchableOpacity>
                ) : null}
                <View style={styles.flex} />
                <TouchableOpacity onPress={() => setDraft(null)} style={styles.secondaryBtn} accessibilityRole="button">
                  <Text style={[styles.secondaryText, { color: theme.textMuted, fontSize: theme.scaleFont(14) }]}>
                    Cancel
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={save}
                  style={[styles.primaryBtn, { backgroundColor: theme.primary }]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.primaryText, { color: theme.onPrimary, fontSize: theme.scaleFont(14) }]}>Save</Text>
                </TouchableOpacity>
              </View>
              {draft?.id != null && !wallets.find((w) => w.id === draft.id)?.isActive ? (
                <TouchableOpacity
                  onPress={() => {
                    updateWallet(draft.id!, { isActive: true });
                    setDraft(null);
                  }}
                  style={styles.restore}
                  accessibilityRole="button"
                >
                  <Text style={[styles.secondaryText, { color: theme.primary, fontSize: theme.scaleFont(14) }]}>
                    Restore from archive
                  </Text>
                </TouchableOpacity>
              ) : null}
            </ScrollView>
          </View>
        </KeyboardSheet>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  editBtn: { marginLeft: 8, width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 56,
    gap: 6,
  },
  backBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: 18, fontWeight: '700' },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 999, paddingHorizontal: 14, minHeight: 48, justifyContent: 'center' },
  addText: { fontSize: 13, fontWeight: '700' },
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 120, gap: 10 },
  summary: { borderWidth: 1, borderRadius: 16, padding: 16, marginBottom: 4 },
  summaryLabel: { fontSize: 12, fontWeight: '600' },
  netWorth: { fontSize: 26, fontWeight: '800', marginTop: 4 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  summarySub: { fontSize: 12, fontWeight: '600' },
  summaryFootnote: { fontSize: 11, fontWeight: '500', marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 14, padding: 12, gap: 12 },
  iconWrap: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 15, fontWeight: '700' },
  rowSub: { fontSize: 12, marginTop: 2 },
  rowAmount: { fontSize: 15, fontWeight: '700' },
  archivedToggle: { alignItems: 'center', justifyContent: 'center', minHeight: 48, paddingVertical: 8 },
  archivedText: { fontSize: 13, fontWeight: '600' },
  hint: { fontSize: 12, lineHeight: 18, marginTop: 8 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { ...SHEET_WIDTH, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, paddingBottom: 28, maxHeight: '88%' },
  sheetTitle: { fontSize: 17, fontWeight: '700', marginBottom: 8 },
  label: { fontSize: 12, fontWeight: '700', marginTop: 12, marginBottom: 6 },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, minHeight: 48 },
  chipText: { fontSize: 13, fontWeight: '600' },
  balanceRow: { flexDirection: 'row', gap: 8 },
  signBtn: { minWidth: 64, minHeight: 48, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  signText: { fontSize: 13, fontWeight: '700' },
  flex: { flex: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', marginTop: 18, gap: 8 },
  secondaryBtn: { minHeight: 48, paddingHorizontal: 12, justifyContent: 'center' },
  secondaryText: { fontSize: 14, fontWeight: '700' },
  primaryBtn: { minHeight: 48, borderRadius: 12, paddingHorizontal: 20, justifyContent: 'center' },
  primaryText: { fontSize: 14, fontWeight: '700' },
  restore: { alignItems: 'center', minHeight: 48, justifyContent: 'center' },
});
