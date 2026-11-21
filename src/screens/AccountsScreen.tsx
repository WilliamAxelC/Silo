import React, { useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
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
import { useNavigation } from '@react-navigation/native';

import { NavigationProps } from '../navigation/types';
import { useTransactionStore } from '../store/useTransactionStore';
import { useSettingsStore } from '../store/useSettingsStore';
import {
  formatAmountForInput,
  formatAmountInput,
  formatDisplayCurrency,
  isAmountWithinRange,
  parseSignedAmount,
} from '../features/transactions/amount';
import type { Wallet, WalletType } from '../features/transactions/types';
import { WALLET_TYPE_META } from '../components/AccountPickerModal';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import { useAppTheme } from '../theme/useAppTheme';

interface Draft {
  id: number | null;
  name: string;
  type: WalletType;
  openingBalance: string;
  openingNegative: boolean;
}

const EMPTY_DRAFT: Draft = { id: null, name: '', type: 'bank', openingBalance: '', openingNegative: false };

export const AccountsScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const currencyCode = useSettingsStore((s) => s.currencyCode);
  const useThousands = useSettingsStore((s) => s.useThousandsSeparator);
  const wallets = useTransactionStore((s) => s.wallets);
  const { addWallet, updateWallet, removeWallet } = useTransactionStore.getState();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const active = wallets.filter((w) => w.isActive);
  const archived = wallets.filter((w) => !w.isActive);
  const { netWorth, assets, debts } = useMemo(() => {
    const totals = { netWorth: 0, assets: 0, debts: 0 };
    for (const w of active) {
      totals.netWorth += w.balance;
      if (w.balance >= 0) totals.assets += w.balance;
      else totals.debts += -w.balance;
    }
    return totals;
  }, [active]);
  const money = (n: number) => formatDisplayCurrency(n, currencyCode, useThousands);

  const openEditor = (wallet?: Wallet) =>
    setDraft(
      wallet
        ? {
            id: wallet.id,
            name: wallet.name,
            type: wallet.type,
            openingBalance: wallet.initialBalance ? formatAmountForInput(wallet.initialBalance, currencyCode) : '',
            openingNegative: wallet.initialBalance < 0,
          }
        : EMPTY_DRAFT,
    );

  const save = () => {
    if (!draft) return;
    const magnitude = Math.abs(parseSignedAmount(draft.openingBalance || '0', undefined, currencyCode));
    if (!isAmountWithinRange(magnitude)) {
      Alert.alert('Amount too large', 'Enter an opening balance within the supported range.');
      return;
    }
    const initialBalance = draft.openingNegative ? -magnitude : magnitude;
    try {
      if (draft.id === null) addWallet({ name: draft.name, type: draft.type, initialBalance });
      else updateWallet(draft.id, { name: draft.name, type: draft.type, initialBalance });
      setDraft(null);
    } catch (error) {
      Alert.alert('Could not save account', error instanceof Error ? error.message : String(error));
    }
  };

  const remove = () => {
    if (draft?.id == null) return;
    const id = draft.id;
    Alert.alert('Remove account?', 'Accounts with transactions are archived so your history stays intact.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          const result = removeWallet(id);
          if (!result.ok) Alert.alert('Not removed', result.message ?? '');
          else setDraft(null);
        },
      },
    ]);
  };

  const renderWallet = (wallet: Wallet) => (
    <TouchableOpacity
      key={wallet.id}
      style={[styles.row, { backgroundColor: theme.surface, borderColor: theme.border, opacity: wallet.isActive ? 1 : 0.6 }]}
      onPress={() => openEditor(wallet)}
      accessibilityRole="button"
      accessibilityLabel={`${wallet.name}, ${WALLET_TYPE_META[wallet.type].label}, balance ${money(wallet.balance)}`}
    >
      <View style={[styles.iconWrap, { backgroundColor: theme.primaryMuted }]}>
        <Ionicons name={WALLET_TYPE_META[wallet.type].icon} size={20} color={theme.primary} />
      </View>
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, { color: theme.text, fontSize: theme.scaleFont(15) }]} numberOfLines={1}>
          {wallet.name}
        </Text>
        <Text style={[styles.rowSub, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
          {WALLET_TYPE_META[wallet.type].label}
        </Text>
      </View>
      <Text
        style={[
          styles.rowAmount,
          { color: wallet.balance < 0 ? theme.expense : theme.text, fontSize: theme.scaleFont(15) },
        ]}
      >
        {money(wallet.balance)}
      </Text>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={22} color={theme.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: theme.text, fontSize: theme.scaleFont(20) }]}>Accounts</Text>
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
        <View style={[styles.summary, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Text style={[styles.summaryLabel, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
            Net worth
          </Text>
          <Text
            style={[
              styles.netWorth,
              { color: netWorth < 0 ? theme.expense : theme.text, fontSize: theme.scaleFont(26) },
            ]}
          >
            {money(netWorth)}
          </Text>
          <View style={styles.summaryRow}>
            <Text style={[styles.summarySub, { color: theme.income, fontSize: theme.scaleFont(12) }]}>
              Assets {money(assets)}
            </Text>
            <Text style={[styles.summarySub, { color: theme.expense, fontSize: theme.scaleFont(12) }]}>
              Debts {money(debts)}
            </Text>
          </View>
        </View>

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

      <Modal visible={draft !== null} transparent animationType="slide" onRequestClose={() => setDraft(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.overlay}>
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
                  onChangeText={(v) => setDraft((d) => (d ? { ...d, openingBalance: formatAmountInput(v, currencyCode) } : d))}
                  keyboardType={Platform.OS === 'ios' ? 'decimal-pad' : 'numeric'}
                  placeholder="0"
                  placeholderTextColor={theme.textMuted}
                  accessibilityLabel="Opening balance"
                />
              </View>

              <View style={styles.actions}>
                {draft?.id != null ? (
                  <TouchableOpacity onPress={remove} style={styles.secondaryBtn} accessibilityRole="button">
                    <Text style={[styles.secondaryText, { color: theme.expense, fontSize: theme.scaleFont(14) }]}>
                      Remove
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
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  title: { flex: 1, fontSize: 20, fontWeight: '700' },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  addText: { fontSize: 13, fontWeight: '700' },
  content: { paddingHorizontal: 16, paddingBottom: 120, gap: 10 },
  summary: { borderWidth: 1, borderRadius: 16, padding: 16, marginBottom: 4 },
  summaryLabel: { fontSize: 12, fontWeight: '600' },
  netWorth: { fontSize: 26, fontWeight: '800', marginTop: 4 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  summarySub: { fontSize: 12, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 14, padding: 12, gap: 12 },
  iconWrap: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 15, fontWeight: '700' },
  rowSub: { fontSize: 12, marginTop: 2 },
  rowAmount: { fontSize: 15, fontWeight: '700' },
  archivedToggle: { alignItems: 'center', paddingVertical: 8 },
  archivedText: { fontSize: 13, fontWeight: '600' },
  hint: { fontSize: 12, lineHeight: 18, marginTop: 8 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, paddingBottom: 28, maxHeight: '88%' },
  sheetTitle: { fontSize: 17, fontWeight: '700', marginBottom: 8 },
  label: { fontSize: 12, fontWeight: '700', marginTop: 12, marginBottom: 6 },
  input: { minHeight: 46, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  chipText: { fontSize: 13, fontWeight: '600' },
  balanceRow: { flexDirection: 'row', gap: 8 },
  signBtn: { minWidth: 64, minHeight: 46, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  signText: { fontSize: 13, fontWeight: '700' },
  flex: { flex: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', marginTop: 18, gap: 8 },
  secondaryBtn: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' },
  secondaryText: { fontSize: 14, fontWeight: '700' },
  primaryBtn: { minHeight: 44, borderRadius: 12, paddingHorizontal: 20, justifyContent: 'center' },
  primaryText: { fontSize: 14, fontWeight: '700' },
  restore: { alignItems: 'center', minHeight: 44, justifyContent: 'center' },
});
