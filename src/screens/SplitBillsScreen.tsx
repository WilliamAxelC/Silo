import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';

import { ContactsPickerModal } from '../components/ContactsPickerModal';
import { PaymentDetailsModal } from '../components/PaymentDetailsModal';
import { SettleSplitModal } from '../components/SettleSplitModal';
import {
  formatGroupSummaryMessage,
  formatPersonBillMessage,
  formatPersonCombinedMessage,
  inferCountryCodeFromCurrency,
  openWhatsAppMessage,
  shareMessageWithIntent,
} from '../features/splits/messaging';
import { confirmRemoveSplit } from '../features/splits/confirmRemoveSplit';
import {
  getTransactionSplitCounts,
  groupSplitsByBill,
  groupUnpaidByPerson,
  summarizePendingByCurrency,
  useSplitsStore,
} from '../features/splits/store';
import type { CurrencyTotal, SplitEntry } from '../features/splits/types';
import { formatDisplayCurrency } from '../features/transactions/amount';
import { formatCachedLocaleDate } from '../features/transactions/periods';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import type { NavigationProps } from '../navigation/types';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTransactionStore } from '../store/useTransactionStore';
import { useAppTheme } from '../theme/useAppTheme';
import { KeyboardSheet } from '../components/KeyboardSheet';
import { SHEET_WIDTH } from '../theme/layout';

type MainViewTab = 'bills' | 'people';
type BillFilterTab = 'pending' | 'settled' | 'all';

interface SettleTarget {
  personName: string;
  subtitle: string;
  totals: CurrencyTotal[];
  defaultWalletId: number | null;
  entries: SplitEntry[];
}

export const SplitBillsScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const theme = useAppTheme();
  const insets = useSafeInsets();

  const homeCurrency = useSettingsStore((s) => s.currencyCode);
  const useThousandsSeparator = useSettingsStore((s) => s.useThousandsSeparator);
  const locale = useSettingsStore((s) => s.dateFormat) || 'en-GB';

  const transactionsList = useTransactionStore((s) => s.transactionsList);
  const fetchTransactionsIfNeeded = useTransactionStore((s) => s.fetchTransactionsIfNeeded);

  const splits = useSplitsStore((s) => s.splits);
  const paymentDetails = useSplitsStore((s) => s.paymentDetails);
  const defaultCountryCode = useSplitsStore((s) => s.defaultCountryCode);
  const ensureLoaded = useSplitsStore((s) => s.ensureLoaded);
  const loadSplits = useSplitsStore((s) => s.load);
  const markSplitSettled = useSplitsStore((s) => s.markSplitSettled);
  const markSplitUnsettled = useSplitsStore((s) => s.markSplitUnsettled);
  const markAllForPersonSettled = useSplitsStore((s) => s.markAllForPersonSettled);
  const deleteBillSplits = useSplitsStore((s) => s.deleteBillSplits);

  const [mainTab, setMainTab] = useState<MainViewTab>('bills');
  const [billFilter, setBillFilter] = useState<BillFilterTab>('pending');
  const [contactsVisible, setContactsVisible] = useState(false);
  const [paymentVisible, setPaymentVisible] = useState(false);
  const [newPickerVisible, setNewPickerVisible] = useState(false);
  const [txSearch, setTxSearch] = useState('');
  const [settleTarget, setSettleTarget] = useState<SettleTarget | null>(null);

  useFocusEffect(
    useCallback(() => {
      ensureLoaded();
      loadSplits();
      void fetchTransactionsIfNeeded();
    }, [ensureLoaded, loadSplits, fetchTransactionsIfNeeded])
  );

  const effectiveCountryCode = defaultCountryCode || inferCountryCodeFromCurrency(homeCurrency);

  const billGroups = useMemo(() => groupSplitsByBill(splits), [splits]);
  const filteredBills = useMemo(() => {
    if (billFilter === 'pending') return billGroups.filter((b) => !b.allSettled);
    if (billFilter === 'settled') return billGroups.filter((b) => b.allSettled);
    return billGroups;
  }, [billGroups, billFilter]);

  const peopleGroups = useMemo(() => groupUnpaidByPerson(splits), [splits]);
  const pendingTotals = useMemo(() => summarizePendingByCurrency(splits), [splits]);
  const splitCounts = useMemo(() => getTransactionSplitCounts(splits), [splits]);

  const expenseTransactions = useMemo(() => {
    const q = txSearch.trim().toLowerCase();
    return transactionsList
      .filter((tx) => tx.type === 'expense')
      .filter(
        (tx) =>
          !q ||
          tx.merchantName.toLowerCase().includes(q) ||
          (tx.note ?? '').toLowerCase().includes(q) ||
          tx.category.toLowerCase().includes(q)
      )
      .slice(0, 60);
  }, [transactionsList, txSearch]);

  const totalSummaryText =
    pendingTotals.length > 0
      ? pendingTotals
          .map((t) => formatDisplayCurrency(t.amount, t.currency, useThousandsSeparator))
          .join(' + ')
      : formatDisplayCurrency(0, homeCurrency, useThousandsSeparator);

  const handleToggleEntryPaid = (entry: SplitEntry) => {
    if (!entry.isSettled) {
      setSettleTarget({
        personName: entry.personName,
        subtitle: `${entry.merchantName} · ${formatCachedLocaleDate(entry.transactionDate, locale, { day: 'numeric', month: 'short', year: 'numeric' })}`,
        totals: [{ currency: entry.currency, amount: entry.amountOwed }],
        defaultWalletId: entry.transactionWalletId,
        entries: [entry],
      });
      return;
    }

    if (entry.repaymentTransactionId != null) {
      Alert.alert(
        'Mark as unpaid?',
        `${entry.personName}'s share has a logged repayment transaction. Do you want to keep or remove that repayment?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Keep repayment',
            onPress: () => void markSplitUnsettled(entry.id, { deleteRepayment: false }),
          },
          {
            text: 'Delete repayment',
            style: 'destructive',
            onPress: () => void markSplitUnsettled(entry.id, { deleteRepayment: true }),
          },
        ]
      );
      return;
    }

    Alert.alert('Mark as unpaid?', `Reopen ${entry.personName}'s share on ${entry.merchantName}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Mark unpaid',
        onPress: () => void markSplitUnsettled(entry.id),
      },
    ]);
  };

  const handleDeleteBill = (transactionId: number, merchantName: string) => {
    const entries = splits.filter((e) => e.transactionId === transactionId);
    confirmRemoveSplit(merchantName, entries, (options) => void deleteBillSplits(transactionId, options));
  };

  const sendWhatsApp = async (message: string, phone?: string | null) => {
    const res = await openWhatsAppMessage(message, phone, effectiveCountryCode);
    if (!res.ok) {
      Alert.alert('Could not open WhatsApp', res.error || 'Make sure WhatsApp is installed, or use the Share button.');
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={24} color={theme.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.text, fontSize: theme.scaleFont(18) }]}>
          Split Bills
        </Text>
        <TouchableOpacity
          style={styles.iconBtn}
          onPress={() => setContactsVisible(true)}
          accessibilityRole="button"
          accessibilityLabel="Manage contacts"
        >
          <Ionicons name="people-outline" size={22} color={theme.primary} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.iconBtn}
          onPress={() => setPaymentVisible(true)}
          accessibilityRole="button"
          accessibilityLabel="Payment details settings"
        >
          <Ionicons name="card-outline" size={22} color={theme.primary} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.newBtn, { backgroundColor: theme.primary }]}
          onPress={() => {
            setTxSearch('');
            setNewPickerVisible(true);
          }}
          accessibilityRole="button"
          accessibilityLabel="New split bill"
        >
          <Ionicons name="add" size={18} color={theme.onPrimary} />
          <Text style={{ color: theme.onPrimary, fontWeight: '700', fontSize: theme.scaleFont(13) }}>
            New
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: getBottomInsetPadding(insets.bottom, 28) },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Summary Card */}
        <View style={[styles.summaryCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Text style={[styles.summaryLabel, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
            Total owed to you
          </Text>
          <Text style={[styles.summaryAmount, { color: theme.income, fontSize: theme.scaleFont(22) }]}>
            {totalSummaryText}
          </Text>
          <Text style={[styles.summaryMeta, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
            {peopleGroups.length} {peopleGroups.length === 1 ? 'person' : 'people'} ·{' '}
            {billGroups.filter((b) => !b.allSettled).length} pending{' '}
            {billGroups.filter((b) => !b.allSettled).length === 1 ? 'bill' : 'bills'}
          </Text>
        </View>

        {/* Bills / People Switcher */}
        <View style={[styles.segmentRow, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          {(
            [
              { key: 'bills', label: `Bills (${billGroups.length})` },
              { key: 'people', label: `People (${peopleGroups.length})` },
            ] as Array<{ key: MainViewTab; label: string }>
          ).map((tab) => {
            const active = mainTab === tab.key;
            return (
              <TouchableOpacity
                key={tab.key}
                style={[styles.segmentTab, active && { backgroundColor: theme.primary }]}
                onPress={() => setMainTab(tab.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={tab.label}
              >
                <Text
                  style={{
                    color: active ? theme.onPrimary : theme.textMuted,
                    fontWeight: '700',
                    fontSize: theme.scaleFont(13),
                  }}
                >
                  {tab.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {mainTab === 'bills' ? (
          <>
            <View style={styles.filterPillsRow}>
              {(
                [
                  { key: 'pending', label: 'Pending' },
                  { key: 'settled', label: 'Settled' },
                  { key: 'all', label: 'All' },
                ] as Array<{ key: BillFilterTab; label: string }>
              ).map((f) => {
                const active = billFilter === f.key;
                return (
                  <TouchableOpacity
                    key={f.key}
                    style={[
                      styles.filterPill,
                      {
                        backgroundColor: active ? theme.primaryMuted : theme.surface,
                        borderColor: active ? theme.primary : theme.border,
                      },
                    ]}
                    onPress={() => setBillFilter(f.key)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    <Text
                      style={{
                        color: active ? theme.primary : theme.textMuted,
                        fontWeight: '700',
                        fontSize: theme.scaleFont(12),
                      }}
                    >
                      {f.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {filteredBills.length === 0 ? (
              <View style={[styles.emptyCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <Ionicons name="receipt-outline" size={32} color={theme.textMuted} />
                <Text style={[styles.emptyTitle, { color: theme.text, fontSize: theme.scaleFont(15) }]}>
                  {billGroups.length === 0 ? 'No split bills yet' : `No ${billFilter} bills`}
                </Text>
                <Text style={[styles.emptyDesc, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>
                  Pick an expense or log a new one to split it with friends and share via WhatsApp.
                </Text>
                <TouchableOpacity
                  style={[styles.emptyBtn, { backgroundColor: theme.primary }]}
                  onPress={() => {
                    setTxSearch('');
                    setNewPickerVisible(true);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Start splitting a bill"
                >
                  <Text style={{ color: theme.onPrimary, fontWeight: '700', fontSize: theme.scaleFont(14) }}>
                    Split a Bill
                  </Text>
                </TouchableOpacity>
              </View>
            ) : (
              filteredBills.map((group) => {
                const money = (amount: number) =>
                  formatDisplayCurrency(amount, group.currency, useThousandsSeparator);
                const groupSummaryMsg = formatGroupSummaryMessage({
                  merchantName: group.merchantName,
                  date: group.date,
                  billTotal: group.billTotal,
                  currency: group.currency,
                  entries: group.entries,
                  paymentDetails,
                  locale,
                  useThousandsSeparator,
                });

                return (
                  <View
                    key={group.transactionId}
                    style={[styles.billCard, { backgroundColor: theme.surface, borderColor: theme.border }]}
                  >
                    <View style={styles.billHeader}>
                      <View style={styles.flex}>
                        <Text style={[styles.billTitle, { color: theme.text, fontSize: theme.scaleFont(15) }]}>
                          {group.merchantName}
                        </Text>
                        <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(12) }}>
                          {formatCachedLocaleDate(group.date, locale, { day: 'numeric', month: 'short', year: 'numeric' })} · Total {money(group.billTotal)}
                        </Text>
                      </View>
                      <View
                        style={[
                          styles.statusBadge,
                          { backgroundColor: group.allSettled ? theme.incomeMuted : theme.primaryMuted },
                        ]}
                      >
                        <Text
                          style={{
                            color: group.allSettled ? theme.income : theme.primary,
                            fontWeight: '700',
                            fontSize: theme.scaleFont(11),
                          }}
                        >
                          {group.allSettled ? 'Settled' : `${group.unpaidCount} unpaid`}
                        </Text>
                      </View>
                    </View>

                    {group.entries.map((entry) => {
                      const msg = formatPersonBillMessage({
                        personName: entry.personName,
                        merchantName: group.merchantName,
                        date: group.date,
                        billTotal: group.billTotal,
                        amountOwed: entry.amountOwed,
                        currency: group.currency,
                        splitMode: group.splitMode,
                        breakdown: entry.breakdown,
                        paymentDetails,
                        locale,
                        useThousandsSeparator,
                      });
                      const itemCount = entry.breakdown?.items?.length ?? 0;
                      return (
                        <View
                          key={entry.id}
                          style={[styles.entryRow, { borderTopColor: theme.border }]}
                        >
                          <View style={styles.flex}>
                            <Text
                              style={[
                                styles.entryName,
                                {
                                  color: entry.isSettled ? theme.textMuted : theme.text,
                                  textDecorationLine: entry.isSettled ? 'line-through' : 'none',
                                  fontSize: theme.scaleFont(14),
                                },
                              ]}
                            >
                              {entry.personName}
                            </Text>
                            <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(12) }}>
                              {money(entry.amountOwed)}
                              {itemCount > 0 ? ` · ${itemCount} ${itemCount === 1 ? 'item' : 'items'}` : ''}
                            </Text>
                          </View>

                          <TouchableOpacity
                            style={[styles.actionIconBtn, { borderColor: '#25D366', backgroundColor: '#25D36618' }]}
                            onPress={() => void sendWhatsApp(msg, entry.phone)}
                            accessibilityRole="button"
                            accessibilityLabel={`Send WhatsApp to ${entry.personName} for ${group.merchantName}`}
                          >
                            <Ionicons name="logo-whatsapp" size={17} color="#25D366" />
                          </TouchableOpacity>

                          <TouchableOpacity
                            style={[styles.actionIconBtn, { borderColor: theme.border, backgroundColor: theme.background }]}
                            onPress={() => void shareMessageWithIntent(msg, `${group.merchantName} split`)}
                            accessibilityRole="button"
                            accessibilityLabel={`Share ${group.merchantName} split with ${entry.personName}`}
                          >
                            <Ionicons name="share-outline" size={17} color={theme.primary} />
                          </TouchableOpacity>

                          <TouchableOpacity
                            style={[
                              styles.paidBtn,
                              {
                                backgroundColor: entry.isSettled ? theme.incomeMuted : theme.background,
                                borderColor: entry.isSettled ? theme.income : theme.border,
                              },
                            ]}
                            onPress={() => handleToggleEntryPaid(entry)}
                            accessibilityRole="button"
                            accessibilityLabel={
                              entry.isSettled
                                ? `Unmark ${entry.personName} as paid`
                                : `Mark ${entry.personName} as paid`
                            }
                          >
                            <Ionicons
                              name={entry.isSettled ? 'checkmark-circle' : 'ellipse-outline'}
                              size={16}
                              color={entry.isSettled ? theme.income : theme.textMuted}
                            />
                            <Text
                              style={{
                                color: entry.isSettled ? theme.income : theme.text,
                                fontWeight: '700',
                                fontSize: theme.scaleFont(12),
                              }}
                            >
                              {entry.isSettled ? 'Paid' : 'Mark paid'}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      );
                    })}

                    <View style={[styles.billFooter, { borderTopColor: theme.border }]}>
                      <TouchableOpacity
                        style={styles.footerBtn}
                        onPress={() => void sendWhatsApp(groupSummaryMsg)}
                        accessibilityRole="button"
                        accessibilityLabel={`Send WhatsApp summary for ${group.merchantName}`}
                      >
                        <Ionicons name="logo-whatsapp" size={16} color="#25D366" />
                        <Text style={{ color: theme.text, fontWeight: '600', fontSize: theme.scaleFont(12) }}>
                          WhatsApp summary
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.footerBtn}
                        onPress={() => void shareMessageWithIntent(groupSummaryMsg, `Split: ${group.merchantName}`)}
                        accessibilityRole="button"
                        accessibilityLabel={`Share summary for ${group.merchantName}`}
                      >
                        <Ionicons name="share-outline" size={16} color={theme.primary} />
                        <Text style={{ color: theme.primary, fontWeight: '600', fontSize: theme.scaleFont(12) }}>
                          Share
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.footerBtn}
                        onPress={() =>
                          navigation.navigate('SplitBillEditor', { transactionId: group.transactionId })
                        }
                        accessibilityRole="button"
                        accessibilityLabel={`Edit split for ${group.merchantName}`}
                      >
                        <Ionicons name="create-outline" size={16} color={theme.textMuted} />
                        <Text style={{ color: theme.textMuted, fontWeight: '600', fontSize: theme.scaleFont(12) }}>
                          Edit
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.footerBtn}
                        onPress={() => handleDeleteBill(group.transactionId, group.merchantName)}
                        accessibilityRole="button"
                        accessibilityLabel={`Delete split for ${group.merchantName}`}
                      >
                        <Ionicons name="trash-outline" size={16} color={theme.expense} />
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })
            )}
          </>
        ) : peopleGroups.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Ionicons name="checkmark-done-circle-outline" size={32} color={theme.income} />
            <Text style={[styles.emptyTitle, { color: theme.text, fontSize: theme.scaleFont(15) }]}>
              Everyone is settled up
            </Text>
            <Text style={[styles.emptyDesc, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>
              No one currently owes you money on split bills.
            </Text>
          </View>
        ) : (
          peopleGroups.map((person) => {
            const combinedText = person.totalsByCurrency
              .map((t) => formatDisplayCurrency(t.amount, t.currency, useThousandsSeparator))
              .join(' + ');
            const combinedMsg = formatPersonCombinedMessage({
              personName: person.personName,
              entries: person.entries,
              paymentDetails,
              locale,
              useThousandsSeparator,
            });
            return (
              <View
                key={person.key}
                style={[styles.billCard, { backgroundColor: theme.surface, borderColor: theme.border }]}
              >
                <View style={styles.billHeader}>
                  <View style={styles.flex}>
                    <Text style={[styles.billTitle, { color: theme.text, fontSize: theme.scaleFont(15) }]}>
                      {person.personName}
                    </Text>
                    <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(12) }}>
                      {person.phone || 'No phone saved'} · {person.entries.length}{' '}
                      {person.entries.length === 1 ? 'unpaid bill' : 'unpaid bills'}
                    </Text>
                  </View>
                  <Text style={{ color: theme.income, fontWeight: '800', fontSize: theme.scaleFont(15) }}>
                    {combinedText}
                  </Text>
                </View>

                {person.entries.map((entry) => (
                  <View key={entry.id} style={[styles.personBillLine, { borderTopColor: theme.border }]}>
                    <Text style={{ color: theme.text, fontSize: theme.scaleFont(13), flex: 1 }}>
                      {entry.merchantName} (
                      {formatCachedLocaleDate(entry.transactionDate, locale, { day: 'numeric', month: 'short' })})
                    </Text>
                    <Text style={{ color: theme.textMuted, fontWeight: '600', fontSize: theme.scaleFont(13) }}>
                      {formatDisplayCurrency(entry.amountOwed, entry.currency, useThousandsSeparator)}
                    </Text>
                  </View>
                ))}

                <View style={[styles.personActions, { borderTopColor: theme.border }]}>
                  <TouchableOpacity
                    style={[styles.personActionBtn, { borderColor: '#25D366', backgroundColor: '#25D36618' }]}
                    onPress={() => void sendWhatsApp(combinedMsg, person.phone)}
                    accessibilityRole="button"
                    accessibilityLabel={`Send WhatsApp reminder to ${person.personName}`}
                  >
                    <Ionicons name="logo-whatsapp" size={16} color="#25D366" />
                    <Text style={{ color: '#25D366', fontWeight: '700', fontSize: theme.scaleFont(12) }}>
                      WhatsApp
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.personActionBtn, { borderColor: theme.border, backgroundColor: theme.background }]}
                    onPress={() => void shareMessageWithIntent(combinedMsg, `Bills for ${person.personName}`)}
                    accessibilityRole="button"
                    accessibilityLabel={`Share reminder with ${person.personName}`}
                  >
                    <Ionicons name="share-outline" size={16} color={theme.primary} />
                    <Text style={{ color: theme.primary, fontWeight: '700', fontSize: theme.scaleFont(12) }}>
                      Share
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.personActionBtn, { borderColor: theme.income, backgroundColor: theme.incomeMuted }]}
                    onPress={() =>
                      setSettleTarget({
                        personName: person.personName,
                        subtitle: `${person.entries.length} unpaid ${person.entries.length === 1 ? 'bill' : 'bills'}`,
                        totals: person.totalsByCurrency,
                        defaultWalletId: person.entries[0]?.transactionWalletId ?? null,
                        entries: person.entries,
                      })
                    }
                    accessibilityRole="button"
                    accessibilityLabel={`Mark all bills paid for ${person.personName}`}
                  >
                    <Ionicons name="checkmark-done" size={16} color={theme.income} />
                    <Text style={{ color: theme.income, fontWeight: '700', fontSize: theme.scaleFont(12) }}>
                      Mark all paid
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

      {/* Pick Transaction Modal */}
      <Modal statusBarTranslucent navigationBarTranslucent
        visible={newPickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setNewPickerVisible(false)}
      >
        <KeyboardSheet style={styles.modalOverlay}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            accessible={false}
            onPress={() => setNewPickerVisible(false)}
          />
          <View
            testID="pick-expense-sheet"
            style={[
              styles.modalSheet,
              { backgroundColor: theme.surface, paddingBottom: getBottomInsetPadding(insets.bottom, 18) },
            ]}
          >
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.text, fontSize: theme.scaleFont(16) }]}>
                Pick an Expense to Split
              </Text>
              <TouchableOpacity
                style={styles.modalCloseBtn}
                onPress={() => setNewPickerVisible(false)}
                accessibilityRole="button"
                accessibilityLabel="Close expense picker"
              >
                <Ionicons name="close" size={22} color={theme.textMuted} />
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={[styles.createExpenseBtn, { backgroundColor: theme.primary }]}
              onPress={() => {
                setNewPickerVisible(false);
                navigation.navigate('AddTransactionStack', { openSplitAfterSave: true });
              }}
              accessibilityRole="button"
              accessibilityLabel="Create new expense to split"
            >
              <Ionicons name="add-circle-outline" size={18} color={theme.onPrimary} />
              <Text style={{ color: theme.onPrimary, fontWeight: '700', fontSize: theme.scaleFont(14) }}>
                Create new expense to split
              </Text>
            </TouchableOpacity>

            <TextInput
              style={[
                styles.txSearchInput,
                { backgroundColor: theme.background, borderColor: theme.border, color: theme.text, fontSize: theme.scaleFont(14) },
              ]}
              value={txSearch}
              onChangeText={setTxSearch}
              placeholder="Search recent expenses"
              placeholderTextColor={theme.textMuted}
              accessibilityLabel="Search recent expenses"
            />

            <FlatList
              data={expenseTransactions}
              keyExtractor={(item) => String(item.id)}
              style={styles.txList}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const count = splitCounts[item.id];
                const displayCurrency = item.originalCurrency ?? homeCurrency;
                const displayTotal = Math.abs(
                  item.originalCurrency && item.originalAmount != null ? item.originalAmount : item.totalAmount
                );
                return (
                  <TouchableOpacity
                    style={[styles.txRow, { borderColor: theme.border }]}
                    onPress={() => {
                      setNewPickerVisible(false);
                      navigation.navigate('SplitBillEditor', { transactionId: item.id });
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Split ${item.merchantName}`}
                  >
                    <View style={styles.flex}>
                      <Text style={{ color: theme.text, fontWeight: '600', fontSize: theme.scaleFont(14) }} numberOfLines={1}>
                        {item.merchantName || 'Expense'}
                      </Text>
                      <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(12) }} numberOfLines={1}>
                        {formatCachedLocaleDate(item.date, locale, { day: 'numeric', month: 'short', year: 'numeric' })}
                        {count ? ` · Already split (${count.unpaid} unpaid)` : ''}
                      </Text>
                    </View>
                    <Text style={{ color: theme.expense, fontWeight: '700', fontSize: theme.scaleFont(13) }}>
                      {formatDisplayCurrency(displayTotal, displayCurrency, useThousandsSeparator)}
                    </Text>
                  </TouchableOpacity>
                );
              }}
              ListEmptyComponent={
                <Text style={{ color: theme.textMuted, textAlign: 'center', paddingVertical: 18 }}>
                  No matching expense transactions.
                </Text>
              }
            />
          </View>
        </KeyboardSheet>
      </Modal>

      <ContactsPickerModal
        visible={contactsVisible}
        mode="manage"
        onClose={() => setContactsVisible(false)}
      />

      <PaymentDetailsModal
        visible={paymentVisible}
        onClose={() => setPaymentVisible(false)}
      />

      <SettleSplitModal
        visible={settleTarget !== null}
        personName={settleTarget?.personName ?? ''}
        subtitle={settleTarget?.subtitle ?? ''}
        totals={settleTarget?.totals ?? []}
        defaultWalletId={settleTarget?.defaultWalletId ?? null}
        onConfirm={async (options) => {
          if (!settleTarget) return;
          if (settleTarget.entries.length === 1) {
            await markSplitSettled(settleTarget.entries[0].id, options);
          } else {
            await markAllForPersonSettled(settleTarget.entries, options);
          }
        }}
        onClose={() => setSettleTarget(null)}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    paddingHorizontal: 8,
    minHeight: 56,
    gap: 2,
  },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, fontWeight: '700', marginLeft: 4 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  newBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    minHeight: 38,
    borderRadius: 10,
    marginRight: 4,
  },
  scrollContent: { padding: 14, gap: 12 },
  summaryCard: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 4 },
  summaryLabel: { fontWeight: '600' },
  summaryAmount: { fontWeight: '800' },
  summaryMeta: {},
  segmentRow: { flexDirection: 'row', borderWidth: 1, borderRadius: 12, padding: 4, gap: 4 },
  segmentTab: { flex: 1, minHeight: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  filterPillsRow: { flexDirection: 'row', gap: 8 },
  filterPill: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 14, minHeight: 36, justifyContent: 'center' },
  emptyCard: { borderWidth: 1, borderRadius: 14, padding: 24, alignItems: 'center', gap: 8 },
  emptyTitle: { fontWeight: '700' },
  emptyDesc: { textAlign: 'center', lineHeight: 18 },
  emptyBtn: { minHeight: 44, paddingHorizontal: 20, borderRadius: 12, justifyContent: 'center', marginTop: 6 },
  billCard: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 10 },
  billHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  billTitle: { fontWeight: '700', marginBottom: 2 },
  statusBadge: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  entryName: { fontWeight: '600' },
  actionIconBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  paidBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    minHeight: 38,
  },
  billFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footerBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 36, paddingHorizontal: 4 },
  personBillLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  personActions: {
    flexDirection: 'row',
    gap: 8,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  personActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: 10,
    minHeight: 40,
  },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  modalSheet: { ...SHEET_WIDTH, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, maxHeight: '88%' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  modalTitle: { fontWeight: '700' },
  modalCloseBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  createExpenseBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 46,
    borderRadius: 12,
    marginBottom: 10,
  },
  txSearchInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    minHeight: 44,
    marginBottom: 10,
  },
  txList: { maxHeight: 340 },
  txRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
});
