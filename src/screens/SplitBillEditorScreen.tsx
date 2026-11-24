import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';

import { ContactsPickerModal } from '../components/ContactsPickerModal';
import { expoDb } from '../db/index';
import {
  computeCustomSplit,
  computeEqualSplit,
  computeItemizedSplit,
  SELF_PARTICIPANT_ID,
  type SplitLineItemInput,
} from '../features/splits/math';
import {
  formatGroupSummaryMessage,
  formatPersonBillMessage,
  inferCountryCodeFromCurrency,
  openWhatsAppMessage,
  shareMessageWithIntent,
} from '../features/splits/messaging';
import { useSplitsStore } from '../features/splits/store';
import { useSplitPaidToggle } from '../features/splits/useSplitPaidToggle';
import type { SiloContact, SplitBreakdown, SplitMode } from '../features/splits/types';
import {
  formatAmountForInput,
  formatAmountInput,
  formatDisplayCurrency,
  getCurrencySymbol,
  parseSignedAmount,
} from '../features/transactions/amount';
import {
  createReceiptItemDraft,
  parseReceiptLineItemsText,
  serializeReceiptLineItems,
  type ReceiptLineItemDraft,
} from '../features/transactions/lineItems';
import { formatCachedLocaleDate } from '../features/transactions/periods';
import type { Transaction } from '../features/transactions/types';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import type { NavigationProps, RootStackParamList } from '../navigation/types';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTransactionStore } from '../store/useTransactionStore';
import { useAppTheme } from '../theme/useAppTheme';

interface Participant {
  key: string;
  contactId: number | null;
  name: string;
  phone: string | null;
}

function loadTransactionFallback(transactionId: number): Transaction | null {
  try {
    const row = expoDb.getFirstSync<{
      id: number;
      wallet_id: number;
      merchant_name: string;
      total_amount: number;
      type: Transaction['type'];
      date: number;
      note: string | null;
      line_items_text: string | null;
      original_amount: number | null;
      original_currency: string | null;
      fx_rate: number | null;
      category: string | null;
    }>(
      `SELECT t.id, t.wallet_id, t.merchant_name, t.total_amount, t.type, t.date, t.note,
              t.line_items_text, t.original_amount, t.original_currency, t.fx_rate, i.category
       FROM transactions t
       LEFT JOIN transaction_items i ON i.transaction_id = t.id
       WHERE t.id = ? LIMIT 1;`,
      [transactionId]
    );
    if (!row) return null;
    return {
      id: row.id,
      walletId: row.wallet_id,
      merchantName: row.merchant_name,
      totalAmount: row.total_amount,
      type: row.type,
      category: row.category ?? '',
      date: row.date,
      note: row.note ?? '',
      lineItemsText: row.line_items_text ?? '',
      originalAmount: row.original_amount ?? null,
      originalCurrency: row.original_currency ?? null,
      fxRate: row.fx_rate ?? null,
    };
  } catch {
    return null;
  }
}

export const SplitBillEditorScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const route = useRoute<RouteProp<RootStackParamList, 'SplitBillEditor'>>();
  const transactionId = route.params.transactionId;
  const theme = useAppTheme();
  const insets = useSafeInsets();

  const homeCurrency = useSettingsStore((s) => s.currencyCode);
  const useThousandsSeparator = useSettingsStore((s) => s.useThousandsSeparator);
  const locale = useSettingsStore((s) => s.dateFormat) || 'en-GB';

  const transactionsList = useTransactionStore((s) => s.transactionsList);
  const updateTransaction = useTransactionStore((s) => s.updateTransaction);

  const splits = useSplitsStore((s) => s.splits);
  const contacts = useSplitsStore((s) => s.contacts);
  const paymentDetails = useSplitsStore((s) => s.paymentDetails);
  const defaultCountryCode = useSplitsStore((s) => s.defaultCountryCode);
  const ensureLoaded = useSplitsStore((s) => s.ensureLoaded);
  const saveBillSplits = useSplitsStore((s) => s.saveBillSplits);

  const tx = useMemo(
    () => transactionsList.find((t) => t.id === transactionId) ?? loadTransactionFallback(transactionId),
    [transactionsList, transactionId]
  );

  const existingSplits = useMemo(
    () => splits.filter((s) => s.transactionId === transactionId),
    [splits, transactionId]
  );
  // Setup is open for a new split and folds away once a split is saved (requested 2026-11-24).
  const [setupOverride, setSetupOverride] = useState<boolean | null>(null);
  const setupOpen = setupOverride ?? existingSplits.length === 0;
  const setSetupOpen = (open: boolean) => setSetupOverride(open);
  const { toggle: togglePaid, modal: settleModal } = useSplitPaidToggle(locale);
  const paidCount = existingSplits.filter((e) => e.isSettled).length;
  const allPaid = existingSplits.length > 0 && paidCount === existingSplits.length;

  const billCurrency = tx?.originalCurrency ?? homeCurrency;
  const billTotal = useMemo(() => {
    if (!tx) return 0;
    return Math.abs(
      tx.originalCurrency && tx.originalAmount != null ? tx.originalAmount : tx.totalAmount
    );
  }, [tx]);

  const effectiveCountryCode = defaultCountryCode || inferCountryCodeFromCurrency(homeCurrency);

  const [participants, setParticipants] = useState<Participant[]>([]);
  const [includeSelf, setIncludeSelf] = useState(true);
  const [splitMode, setSplitMode] = useState<SplitMode>('equal');
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({});
  const [itemDrafts, setItemDrafts] = useState<ReceiptLineItemDraft[]>([]);
  const [itemAssignments, setItemAssignments] = useState<Record<string, string[]>>({});
  const [contactsModalVisible, setContactsModalVisible] = useState(false);
  const [initializedForTx, setInitializedForTx] = useState<number | null>(null);

  useEffect(() => {
    ensureLoaded();
  }, [ensureLoaded]);

  useEffect(() => {
    if (!tx || initializedForTx === tx.id) return;
    const loadedSplits = useSplitsStore.getState().splits.filter((s) => s.transactionId === tx.id);
    const allContacts = useSplitsStore.getState().contacts;

    const initialParticipants: Participant[] = loadedSplits.map((split, idx) => {
      const matchedContact =
        split.contactId != null ? allContacts.find((c) => c.id === split.contactId) : undefined;
      return {
        key: split.contactId != null ? `contact:${split.contactId}` : `adHoc:${idx}:${split.personName}`,
        contactId: split.contactId,
        name: matchedContact?.name ?? split.personName,
        phone: matchedContact?.phone ?? split.phone,
      };
    });

    const initialMode: SplitMode = loadedSplits[0]?.splitMode ?? 'equal';
    const inferredIncludeSelf =
      loadedSplits[0]?.breakdown?.includeSelf ??
      (loadedSplits.length > 0
        ? loadedSplits.reduce((sum, s) => sum + s.amountOwed, 0) < billTotal - 0.01
        : true);

    const parsedItems = parseReceiptLineItemsText(tx.lineItemsText ?? '');
    const nextCustomTexts: Record<string, string> = {};
    if (initialMode === 'custom') {
      loadedSplits.forEach((split, idx) => {
        const key = initialParticipants[idx].key;
        nextCustomTexts[key] = split.amountOwed > 0 ? formatAmountForInput(split.amountOwed, billCurrency) : '';
      });
      const othersSum = loadedSplits.reduce((sum, s) => sum + s.amountOwed, 0);
      const selfRem = Math.max(0, billTotal - othersSum);
      nextCustomTexts[SELF_PARTICIPANT_ID] =
        inferredIncludeSelf && selfRem > 0 ? formatAmountForInput(selfRem, billCurrency) : '';
    }

    const nextAssignments: Record<string, string[]> = {};
    if (initialMode === 'items' && parsedItems.length > 0) {
      loadedSplits.forEach((split, idx) => {
        const key = initialParticipants[idx].key;
        for (const itemShare of split.breakdown?.items ?? []) {
          const targetItem = parsedItems.find(
            (draft) => draft.name.trim().toLowerCase() === itemShare.name.trim().toLowerCase()
          );
          if (targetItem) {
            nextAssignments[targetItem.id] = [...(nextAssignments[targetItem.id] ?? []), key];
          }
        }
      });
    }

    setParticipants(initialParticipants);
    setIncludeSelf(inferredIncludeSelf);
    setSplitMode(initialMode);
    setCustomTexts(nextCustomTexts);
    setItemDrafts(parsedItems);
    setItemAssignments(nextAssignments);
    setInitializedForTx(tx.id);
  }, [tx, initializedForTx, billCurrency, billTotal]);

  const participantKeys = useMemo(() => participants.map((p) => p.key), [participants]);

  const equalResult = useMemo(
    () => computeEqualSplit(billTotal, participantKeys, includeSelf, billCurrency),
    [billTotal, participantKeys, includeSelf, billCurrency]
  );

  const customNumericMap = useMemo(() => {
    const out: Record<string, number> = {};
    for (const p of participants) {
      out[p.key] = Math.abs(parseSignedAmount(customTexts[p.key] ?? '', undefined, billCurrency));
    }
    if (includeSelf) {
      out[SELF_PARTICIPANT_ID] = Math.abs(
        parseSignedAmount(customTexts[SELF_PARTICIPANT_ID] ?? '', undefined, billCurrency)
      );
    }
    return out;
  }, [participants, customTexts, includeSelf, billCurrency]);

  const customResult = useMemo(
    () => computeCustomSplit(billTotal, customNumericMap, includeSelf, billCurrency),
    [billTotal, customNumericMap, includeSelf, billCurrency]
  );

  const lineItemInputs = useMemo<SplitLineItemInput[]>(
    () =>
      itemDrafts.map((d) => ({
        id: d.id,
        name: d.name.trim() || 'Item',
        price: Math.abs(parseSignedAmount(d.price, undefined, billCurrency)),
      })),
    [itemDrafts, billCurrency]
  );

  const itemizedResult = useMemo(
    () =>
      computeItemizedSplit(
        billTotal,
        lineItemInputs,
        itemAssignments,
        participantKeys,
        includeSelf,
        billCurrency
      ),
    [billTotal, lineItemInputs, itemAssignments, participantKeys, includeSelf, billCurrency]
  );

  const resolvedShares = useMemo<Record<string, number>>(() => {
    if (splitMode === 'equal') return equalResult.shares;
    if (splitMode === 'custom') {
      const out: Record<string, number> = {};
      for (const p of participants) {
        out[p.key] = customNumericMap[p.key] ?? 0;
      }
      return out;
    }
    return itemizedResult.shares;
  }, [splitMode, equalResult.shares, participants, customNumericMap, itemizedResult.shares]);

  const resolvedSelfShare =
    splitMode === 'equal'
      ? equalResult.selfShare
      : splitMode === 'custom'
        ? customResult.selfShare
        : itemizedResult.selfShare;

  const handleConfirmContacts = useCallback((selectedContacts: SiloContact[]) => {
    setParticipants((prev) => {
      const adHocOnly = prev.filter((p) => p.contactId == null);
      const fromContacts: Participant[] = selectedContacts.map((c) => ({
        key: `contact:${c.id}`,
        contactId: c.id,
        name: c.name,
        phone: c.phone,
      }));
      return [...fromContacts, ...adHocOnly];
    });
  }, []);

  const handleRemoveParticipant = (key: string) => {
    setParticipants((prev) => prev.filter((p) => p.key !== key));
    setItemAssignments((prev) => {
      const next: Record<string, string[]> = {};
      for (const [itemId, assignees] of Object.entries(prev)) {
        next[itemId] = assignees.filter((id) => id !== key);
      }
      return next;
    });
  };

  const handleFillRemaining = (targetKey: string) => {
    const currentVal = customNumericMap[targetKey] ?? 0;
    const targetVal = Math.max(0, currentVal + customResult.remaining);
    setCustomTexts((prev) => ({
      ...prev,
      [targetKey]: targetVal > 0 ? formatAmountForInput(targetVal, billCurrency) : '',
    }));
  };

  const toggleItemAssignee = (itemId: string, participantKey: string) => {
    setItemAssignments((prev) => {
      const current = prev[itemId] ?? [];
      const exists = current.includes(participantKey);
      return {
        ...prev,
        [itemId]: exists ? current.filter((id) => id !== participantKey) : [...current, participantKey],
      };
    });
  };

  const assignItemToAll = (itemId: string) => {
    const allKeys = includeSelf ? [...participantKeys, SELF_PARTICIPANT_ID] : [...participantKeys];
    setItemAssignments((prev) => {
      const current = prev[itemId] ?? [];
      const alreadyAll = allKeys.length > 0 && allKeys.every((k) => current.includes(k));
      return {
        ...prev,
        [itemId]: alreadyAll ? [] : allKeys,
      };
    });
  };

  const addInlineItem = () => {
    setItemDrafts((prev) => [...prev, createReceiptItemDraft()]);
  };

  const updateInlineItem = (id: string, field: 'name' | 'price', value: string) => {
    setItemDrafts((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        if (field === 'price') {
          return { ...item, price: formatAmountInput(value, billCurrency) };
        }
        return { ...item, name: value };
      })
    );
  };

  const removeInlineItem = (id: string) => {
    setItemDrafts((prev) => prev.filter((item) => item.id !== id));
    setItemAssignments((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const handleSave = async () => {
    if (!tx) return;
    if (participants.length === 0) {
      Alert.alert('Add people first', 'Select at least one contact or person to split this bill with.');
      return;
    }

    if (splitMode === 'custom' && !customResult.isBalanced) {
      Alert.alert(
        'Amounts do not match total',
        `Assigned amounts differ from the bill total by ${formatDisplayCurrency(Math.abs(customResult.remaining), billCurrency, useThousandsSeparator)}.`
      );
      return;
    }

    if (splitMode === 'items') {
      if (lineItemInputs.filter((i) => i.price > 0).length === 0) {
        Alert.alert('Add receipt items', 'Add at least one priced item or switch to Equal / Custom split.');
        return;
      }
      if (itemizedResult.unassignedItemIds.length > 0) {
        Alert.alert(
          'Unassigned items',
          'Assign every priced item to at least one person before saving.'
        );
        return;
      }
    }

    const totalParticipants = participants.length + (includeSelf ? 1 : 0);
    const entries = participants
      .map((p) => {
        const amountOwed = resolvedShares[p.key] ?? 0;
        const breakdown: SplitBreakdown =
          splitMode === 'items'
            ? itemizedResult.breakdowns[p.key] ?? { includeSelf, totalParticipants }
            : { includeSelf, totalParticipants };
        return {
          contactId: p.contactId,
          personName: p.name,
          phone: p.phone,
          amountOwed,
          breakdown,
        };
      })
      .filter((e) => e.amountOwed > 0);

    if (entries.length === 0) {
      Alert.alert('Nothing owed', 'At least one participant must owe an amount greater than 0.');
      return;
    }

    if (splitMode === 'items') {
      const serialized = serializeReceiptLineItems(itemDrafts);
      if (serialized !== (tx.lineItemsText ?? '').trim()) {
        try {
          await updateTransaction(tx.id, { lineItemsText: serialized });
        } catch {
          // Non-blocking: split breakdown still preserves the item breakdown JSON.
        }
      }
    }

    saveBillSplits(tx.id, {
      mode: splitMode,
      currency: billCurrency,
      entries,
    });
    setSetupOpen(false);
  };

  const money = (amount: number) => formatDisplayCurrency(amount, billCurrency, useThousandsSeparator);
  const unpaidTotal = existingSplits.filter((e) => !e.isSettled).reduce((sum, e) => sum + e.amountOwed, 0);
  // My share of the saved split: the bill minus what the others owe (only when I was included).
  const savedSelfShare =
    existingSplits.length > 0 && existingSplits[0].breakdown?.includeSelf !== false
      ? Math.max(0, billTotal - existingSplits.reduce((sum, e) => sum + e.amountOwed, 0))
      : null;

  const selectedContactIds = participants
    .map((p) => p.contactId)
    .filter((id): id is number => id != null);

  if (!tx) {
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
            Split Bill
          </Text>
        </View>
        <View style={styles.emptyWrap}>
          <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(14) }}>
            Transaction not found.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

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
        <Text style={[styles.headerTitle, { color: theme.text, fontSize: theme.scaleFont(18) }]} numberOfLines={1}>
          Split Bill
        </Text>
        <TouchableOpacity
          style={styles.headerActionBtn}
          onPress={() => navigation.navigate('SplitBills')}
          accessibilityRole="button"
          accessibilityLabel="Open all split bills"
        >
          <Text style={{ color: theme.primary, fontWeight: '700', fontSize: theme.scaleFont(13) }}>
            All Splits
          </Text>
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: getBottomInsetPadding(insets.bottom, 28) },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Bill Header Card */}
          <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.billMerchant, { color: theme.text, fontSize: theme.scaleFont(16) }]}>
              {tx.merchantName || 'Expense'}
            </Text>
            <Text style={[styles.billMeta, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
              {formatCachedLocaleDate(tx.date, locale, { day: 'numeric', month: 'short', year: 'numeric' })}
            </Text>
            <Text style={[styles.billTotal, { color: theme.expense, fontSize: theme.scaleFont(22) }]}>
              {money(billTotal)}
            </Text>
          </View>

          {/* Split result: who owes what, paid status, share and mark paid in one place */}
          {existingSplits.length > 0 ? (
            <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]} testID="split-result">
              <View style={styles.sectionHeaderRow}>
                <View style={styles.flex}>
                  <Text style={[styles.sectionTitle, { color: theme.text, fontSize: theme.scaleFont(15) }]}>Split</Text>
                  <Text style={{ color: allPaid ? theme.income : theme.textMuted, fontSize: theme.scaleFont(12), fontWeight: '600' }}>
                    {allPaid
                      ? 'Everyone has paid'
                      : `${paidCount} of ${existingSplits.length} paid · ${money(unpaidTotal)} still owed`}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => {
                    const summaryMsg = formatGroupSummaryMessage({
                      merchantName: tx.merchantName,
                      date: tx.date,
                      billTotal,
                      currency: billCurrency,
                      entries: existingSplits,
                      paymentDetails,
                      locale,
                      useThousandsSeparator,
                    });
                    void shareMessageWithIntent(summaryMsg, `Split: ${tx.merchantName}`);
                  }}
                  style={styles.linkBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Share group summary"
                >
                  <Text style={{ color: theme.primary, fontWeight: '700', fontSize: theme.scaleFont(13) }}>Group summary</Text>
                </TouchableOpacity>
              </View>

              {savedSelfShare != null ? (
                <View style={[styles.resultRow, { borderTopColor: theme.border }]}>
                  <View style={styles.flex}>
                    <Text style={{ color: theme.textMuted, fontWeight: '600', fontSize: theme.scaleFont(14) }}>Me (my share)</Text>
                  </View>
                  <Text style={{ color: theme.textMuted, fontWeight: '700', fontSize: theme.scaleFont(14) }}>{money(savedSelfShare)}</Text>
                </View>
              ) : null}

              {existingSplits.map((entry) => {
                const msg = formatPersonBillMessage({
                  personName: entry.personName,
                  merchantName: entry.merchantName,
                  date: entry.transactionDate,
                  billTotal,
                  amountOwed: entry.amountOwed,
                  currency: entry.currency,
                  splitMode: entry.splitMode,
                  breakdown: entry.breakdown,
                  paymentDetails,
                  locale,
                  useThousandsSeparator,
                });
                return (
                  <View key={entry.id} style={[styles.resultRow, { borderTopColor: theme.border }]} testID={`split-person-${entry.id}`}>
                    <View style={styles.flex}>
                      <Text style={{ color: theme.text, fontWeight: '700', fontSize: theme.scaleFont(14) }} numberOfLines={1}>
                        {entry.personName}
                      </Text>
                      <Text
                        style={{
                          color: entry.isSettled ? theme.income : theme.text,
                          fontWeight: '700',
                          fontSize: theme.scaleFont(14),
                          textDecorationLine: entry.isSettled ? 'line-through' : 'none',
                        }}
                      >
                        {money(entry.amountOwed)}
                      </Text>
                    </View>
                    {!entry.isSettled ? (
                      <>
                        <TouchableOpacity
                          style={[styles.iconPill, { backgroundColor: '#25D36618', borderColor: '#25D366' }]}
                          onPress={() => void openWhatsAppMessage(msg, entry.phone, effectiveCountryCode)}
                          accessibilityRole="button"
                          accessibilityLabel={`Send WhatsApp to ${entry.personName}`}
                        >
                          <Ionicons name="logo-whatsapp" size={18} color="#25D366" />
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.iconPill, { backgroundColor: theme.primaryMuted, borderColor: theme.primary }]}
                          onPress={() => void shareMessageWithIntent(msg, `Split with ${entry.personName}`)}
                          accessibilityRole="button"
                          accessibilityLabel={`Share bill with ${entry.personName}`}
                        >
                          <Ionicons name="share-outline" size={18} color={theme.primary} />
                        </TouchableOpacity>
                      </>
                    ) : null}
                    <TouchableOpacity
                      style={[
                        styles.paidBtn,
                        entry.isSettled
                          ? { backgroundColor: theme.incomeMuted, borderColor: theme.income }
                          : { backgroundColor: theme.surface, borderColor: theme.border },
                      ]}
                      onPress={() => togglePaid(entry)}
                      accessibilityRole="button"
                      accessibilityState={{ checked: entry.isSettled }}
                      accessibilityLabel={entry.isSettled ? `${entry.personName} has paid. Mark unpaid` : `Mark ${entry.personName} as paid`}
                    >
                      <Ionicons
                        name={entry.isSettled ? 'checkmark-circle' : 'ellipse-outline'}
                        size={16}
                        color={entry.isSettled ? theme.income : theme.textMuted}
                      />
                      <Text style={{ color: entry.isSettled ? theme.income : theme.text, fontWeight: '700', fontSize: theme.scaleFont(12) }}>
                        {entry.isSettled ? 'Paid' : 'Mark paid'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                );
              })}
            </View>
          ) : null}

          {existingSplits.length > 0 ? (
            <TouchableOpacity
              style={[styles.setupToggle, { backgroundColor: theme.surface, borderColor: theme.border }]}
              onPress={() => setSetupOpen(!setupOpen)}
              accessibilityRole="button"
              accessibilityState={{ expanded: setupOpen }}
              accessibilityLabel={setupOpen ? 'Hide split setup' : 'Edit split'}
              testID="split-setup-toggle"
            >
              <Ionicons name="create-outline" size={18} color={theme.primary} />
              <Text style={{ color: theme.text, fontWeight: '700', fontSize: theme.scaleFont(14), flex: 1 }}>
                {setupOpen ? 'Hide split setup' : 'Edit split'}
              </Text>
              <Ionicons name={setupOpen ? 'chevron-up' : 'chevron-down'} size={18} color={theme.textMuted} />
            </TouchableOpacity>
          ) : null}

          {setupOpen ? (
            <>
            {/* Participants */}
            <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <View style={styles.sectionHeaderRow}>
                <Text style={[styles.sectionTitle, { color: theme.text, fontSize: theme.scaleFont(14) }]}>
                  People
                </Text>
                <TouchableOpacity
                  style={[styles.addPeopleBtn, { backgroundColor: theme.primaryMuted }]}
                  onPress={() => setContactsModalVisible(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Add or pick people"
                >
                  <Ionicons name="person-add-outline" size={16} color={theme.primary} />
                  <Text style={{ color: theme.primary, fontWeight: '700', fontSize: theme.scaleFont(13) }}>
                    {participants.length > 0 ? 'Edit people' : 'Add people'}
                  </Text>
                </TouchableOpacity>
              </View>

              <View style={styles.includeSelfRow}>
                <Text style={{ color: theme.text, fontSize: theme.scaleFont(14), flex: 1 }}>
                  Include my own share
                </Text>
                <Switch
                  value={includeSelf}
                  onValueChange={(val) => {
                    setIncludeSelf(val);
                  }}
                  accessibilityLabel="Include my own share"
                  trackColor={{ true: theme.primary, false: theme.border }}
                />
              </View>

              {participants.length > 0 ? (
                <View style={styles.chipsWrap}>
                  {participants.map((p) => (
                    <View
                      key={p.key}
                      style={[styles.personChip, { backgroundColor: theme.background, borderColor: theme.border }]}
                    >
                      <Text style={{ color: theme.text, fontWeight: '600', fontSize: theme.scaleFont(13) }}>
                        {p.name}
                      </Text>
                      <TouchableOpacity
                        onPress={() => handleRemoveParticipant(p.key)}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${p.name}`}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons name="close-circle" size={18} color={theme.textMuted} />
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(13) }}>
                  Tap &quot;Add people&quot; to import contacts or add someone manually.
                </Text>
              )}
            </View>

            {/* Split Mode Switcher */}
            <View style={[styles.modeBar, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              {(
                [
                  { key: 'equal', label: 'Equal' },
                  { key: 'custom', label: 'Custom' },
                  { key: 'items', label: 'By Items' },
                ] as Array<{ key: SplitMode; label: string }>
              ).map((opt) => {
                const active = splitMode === opt.key;
                return (
                  <TouchableOpacity
                    key={opt.key}
                    style={[styles.modeTab, active && { backgroundColor: theme.primary }]}
                    onPress={() => {
                      setSplitMode(opt.key);
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={`Split mode ${opt.label}`}
                  >
                    <Text
                      style={{
                        color: active ? theme.onPrimary : theme.textMuted,
                        fontWeight: '700',
                        fontSize: theme.scaleFont(13),
                      }}
                    >
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Mode Body */}
            {splitMode === 'equal' ? (
              <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <Text style={[styles.sectionTitle, { color: theme.text, fontSize: theme.scaleFont(14) }]}>
                  Equal breakdown
                </Text>
                {includeSelf ? (
                  <View style={[styles.splitRow, { borderBottomColor: theme.border }]}>
                    <Text style={{ color: theme.text, fontWeight: '600', fontSize: theme.scaleFont(14) }}>
                      Me (my share)
                    </Text>
                    <Text style={{ color: theme.textMuted, fontWeight: '700', fontSize: theme.scaleFont(14) }}>
                      {money(resolvedSelfShare)}
                    </Text>
                  </View>
                ) : null}
                {participants.map((p) => (
                  <View key={p.key} style={[styles.splitRow, { borderBottomColor: theme.border }]}>
                    <View style={styles.flex}>
                      <Text style={{ color: theme.text, fontWeight: '600', fontSize: theme.scaleFont(14) }}>
                        {p.name}
                      </Text>
                      {p.phone ? (
                        <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(12) }}>{p.phone}</Text>
                      ) : null}
                    </View>
                    <Text style={{ color: theme.primary, fontWeight: '700', fontSize: theme.scaleFont(14) }}>
                      {money(resolvedShares[p.key] ?? 0)}
                    </Text>
                  </View>
                ))}
                {participants.length === 0 ? (
                  <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(13) }}>
                    Add participants above to preview equal shares.
                  </Text>
                ) : null}
              </View>
            ) : null}

            {splitMode === 'custom' ? (
              <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <View style={styles.sectionHeaderRow}>
                  <Text style={[styles.sectionTitle, { color: theme.text, fontSize: theme.scaleFont(14) }]}>
                    Custom amounts
                  </Text>
                  <Text
                    style={{
                      color: customResult.isBalanced ? theme.income : theme.expense,
                      fontWeight: '700',
                      fontSize: theme.scaleFont(12),
                    }}
                  >
                    {customResult.isBalanced
                      ? 'Balanced ✓'
                      : customResult.remaining > 0
                        ? `Remaining: ${money(customResult.remaining)}`
                        : `Over by: ${money(Math.abs(customResult.remaining))}`}
                  </Text>
                </View>

                {includeSelf ? (
                  <View style={styles.customRow}>
                    <View style={styles.flex}>
                      <Text style={{ color: theme.text, fontWeight: '600', fontSize: theme.scaleFont(14) }}>
                        Me (my share)
                      </Text>
                      {!customResult.isBalanced ? (
                        <TouchableOpacity onPress={() => handleFillRemaining(SELF_PARTICIPANT_ID)}>
                          <Text style={{ color: theme.primary, fontSize: theme.scaleFont(12), fontWeight: '600' }}>
                            Fill remainder
                          </Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                    <View style={[styles.customInputWrap, { borderColor: theme.border, backgroundColor: theme.background }]}>
                      <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(13) }}>
                        {getCurrencySymbol(billCurrency)}
                      </Text>
                      <TextInput
                        style={[styles.customInput, { color: theme.text, fontSize: theme.scaleFont(14) }]}
                        value={customTexts[SELF_PARTICIPANT_ID] ?? ''}
                        onChangeText={(t) => {
                          setCustomTexts((prev) => ({
                            ...prev,
                            [SELF_PARTICIPANT_ID]: formatAmountInput(t, billCurrency),
                          }));
                        }}
                        keyboardType="decimal-pad"
                        placeholder="0"
                        placeholderTextColor={theme.textMuted}
                        accessibilityLabel="Custom amount for Me"
                      />
                    </View>
                  </View>
                ) : null}

                {participants.map((p) => (
                  <View key={p.key} style={styles.customRow}>
                    <View style={styles.flex}>
                      <Text style={{ color: theme.text, fontWeight: '600', fontSize: theme.scaleFont(14) }}>
                        {p.name}
                      </Text>
                      {!customResult.isBalanced ? (
                        <TouchableOpacity onPress={() => handleFillRemaining(p.key)}>
                          <Text style={{ color: theme.primary, fontSize: theme.scaleFont(12), fontWeight: '600' }}>
                            Fill remainder
                          </Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                    <View style={[styles.customInputWrap, { borderColor: theme.border, backgroundColor: theme.background }]}>
                      <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(13) }}>
                        {getCurrencySymbol(billCurrency)}
                      </Text>
                      <TextInput
                        style={[styles.customInput, { color: theme.text, fontSize: theme.scaleFont(14) }]}
                        value={customTexts[p.key] ?? ''}
                        onChangeText={(t) => {
                          setCustomTexts((prev) => ({
                            ...prev,
                            [p.key]: formatAmountInput(t, billCurrency),
                          }));
                        }}
                        keyboardType="decimal-pad"
                        placeholder="0"
                        placeholderTextColor={theme.textMuted}
                        accessibilityLabel={`Custom amount for ${p.name}`}
                      />
                    </View>
                  </View>
                ))}
              </View>
            ) : null}

            {splitMode === 'items' ? (
              <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <View style={styles.sectionHeaderRow}>
                  <Text style={[styles.sectionTitle, { color: theme.text, fontSize: theme.scaleFont(14) }]}>
                    Assign receipt items
                  </Text>
                  <TouchableOpacity
                    style={[styles.addPeopleBtn, { backgroundColor: theme.primaryMuted }]}
                    onPress={addInlineItem}
                    accessibilityRole="button"
                    accessibilityLabel="Add item"
                  >
                    <Ionicons name="add" size={16} color={theme.primary} />
                    <Text style={{ color: theme.primary, fontWeight: '700', fontSize: theme.scaleFont(13) }}>
                      Add item
                    </Text>
                  </TouchableOpacity>
                </View>

                {itemDrafts.map((item) => {
                  const parsedPrice = Math.abs(parseSignedAmount(item.price, undefined, billCurrency));
                  const assignees = itemAssignments[item.id] ?? [];
                  const unassigned = parsedPrice > 0 && assignees.length === 0;
                  return (
                    <View
                      key={item.id}
                      style={[
                        styles.itemCard,
                        {
                          backgroundColor: theme.background,
                          borderColor: unassigned ? theme.warning : theme.border,
                        },
                      ]}
                    >
                      <View style={styles.itemEditRow}>
                        <TextInput
                          style={[
                            styles.itemNameInput,
                            { borderColor: theme.border, backgroundColor: theme.surface, color: theme.text, fontSize: theme.scaleFont(13) },
                          ]}
                          value={item.name}
                          onChangeText={(t) => updateInlineItem(item.id, 'name', t)}
                          placeholder="Item name"
                          placeholderTextColor={theme.textMuted}
                          accessibilityLabel="Item name"
                        />
                        <TextInput
                          style={[
                            styles.itemPriceInput,
                            { borderColor: theme.border, backgroundColor: theme.surface, color: theme.text, fontSize: theme.scaleFont(13) },
                          ]}
                          value={item.price}
                          onChangeText={(t) => updateInlineItem(item.id, 'price', t)}
                          placeholder="Price"
                          placeholderTextColor={theme.textMuted}
                          keyboardType="decimal-pad"
                          accessibilityLabel="Item price"
                        />
                        <TouchableOpacity
                          style={styles.itemDeleteBtn}
                          onPress={() => removeInlineItem(item.id)}
                          accessibilityRole="button"
                          accessibilityLabel={`Remove ${item.name || 'item'}`}
                        >
                          <Ionicons name="trash-outline" size={16} color={theme.expense} />
                        </TouchableOpacity>
                      </View>

                      <View style={styles.assignChipsRow}>
                        {includeSelf ? (
                          <TouchableOpacity
                            style={[
                              styles.assignChip,
                              {
                                borderColor: assignees.includes(SELF_PARTICIPANT_ID) ? theme.primary : theme.border,
                                backgroundColor: assignees.includes(SELF_PARTICIPANT_ID) ? theme.primaryMuted : theme.surface,
                              },
                            ]}
                            onPress={() => toggleItemAssignee(item.id, SELF_PARTICIPANT_ID)}
                            accessibilityRole="button"
                            accessibilityState={{ selected: assignees.includes(SELF_PARTICIPANT_ID) }}
                          >
                            <Text
                              style={{
                                color: assignees.includes(SELF_PARTICIPANT_ID) ? theme.primary : theme.text,
                                fontWeight: '600',
                                fontSize: theme.scaleFont(12),
                              }}
                            >
                              Me
                            </Text>
                          </TouchableOpacity>
                        ) : null}

                        {participants.map((p) => {
                          const selected = assignees.includes(p.key);
                          return (
                            <TouchableOpacity
                              key={p.key}
                              style={[
                                styles.assignChip,
                                {
                                  borderColor: selected ? theme.primary : theme.border,
                                  backgroundColor: selected ? theme.primaryMuted : theme.surface,
                                },
                              ]}
                              onPress={() => toggleItemAssignee(item.id, p.key)}
                              accessibilityRole="button"
                              accessibilityState={{ selected }}
                            >
                              <Text
                                style={{
                                  color: selected ? theme.primary : theme.text,
                                  fontWeight: '600',
                                  fontSize: theme.scaleFont(12),
                                }}
                              >
                                {p.name}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}

                        {participants.length > 0 ? (
                          <TouchableOpacity
                            style={[styles.assignChip, { borderColor: theme.border, backgroundColor: theme.surface }]}
                            onPress={() => assignItemToAll(item.id)}
                            accessibilityRole="button"
                          >
                            <Text style={{ color: theme.textMuted, fontWeight: '600', fontSize: theme.scaleFont(12) }}>
                              All
                            </Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>
                    </View>
                  );
                })}

                {itemDrafts.length === 0 ? (
                  <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(13) }}>
                    No receipt items on this transaction yet. Tap &quot;Add item&quot; above to enter them.
                  </Text>
                ) : (
                  <View style={styles.itemTotalsBox}>
                    <View style={styles.itemTotalLine}>
                      <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(12) }}>Items subtotal</Text>
                      <Text style={{ color: theme.text, fontWeight: '600', fontSize: theme.scaleFont(12) }}>
                        {money(itemizedResult.itemsSubtotal)}
                      </Text>
                    </View>
                    {itemizedResult.adjustmentTotal !== 0 ? (
                      <View style={styles.itemTotalLine}>
                        <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(12) }}>
                          {itemizedResult.adjustmentTotal > 0 ? 'Tax & fees (prorated)' : 'Discount (prorated)'}
                        </Text>
                        <Text style={{ color: theme.text, fontWeight: '600', fontSize: theme.scaleFont(12) }}>
                          {itemizedResult.adjustmentTotal > 0 ? '+' : '-'}
                          {money(Math.abs(itemizedResult.adjustmentTotal))}
                        </Text>
                      </View>
                    ) : null}
                    {participants.map((p) => (
                      <View key={p.key} style={styles.itemTotalLine}>
                        <Text style={{ color: theme.text, fontWeight: '600', fontSize: theme.scaleFont(13) }}>
                          {p.name}
                        </Text>
                        <Text style={{ color: theme.primary, fontWeight: '700', fontSize: theme.scaleFont(13) }}>
                          {money(resolvedShares[p.key] ?? 0)}
                        </Text>
                      </View>
                    ))}
                    {includeSelf ? (
                      <View style={styles.itemTotalLine}>
                        <Text style={{ color: theme.textMuted, fontWeight: '600', fontSize: theme.scaleFont(13) }}>
                          Me (my share)
                        </Text>
                        <Text style={{ color: theme.textMuted, fontWeight: '700', fontSize: theme.scaleFont(13) }}>
                          {money(resolvedSelfShare)}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                )}
              </View>
            ) : null}

            <TouchableOpacity
              style={[styles.saveBtn, { backgroundColor: theme.primary }]}
              onPress={() => void handleSave()}
              accessibilityRole="button"
              accessibilityLabel="Save split"
            >
              <Text style={[styles.saveBtnText, { color: theme.onPrimary, fontSize: theme.scaleFont(15) }]}>
                Save Split
              </Text>
            </TouchableOpacity>
            </>
          ) : null}

        </ScrollView>
      </KeyboardAvoidingView>

      {settleModal}

      <ContactsPickerModal
        visible={contactsModalVisible}
        mode="pick"
        selectedContactIds={selectedContactIds}
        onConfirmSelection={handleConfirmContacts}
        onClose={() => setContactsModalVisible(false)}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: 1, paddingVertical: 10, minHeight: 56 },
  paidBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 48, borderRadius: 12, borderWidth: 1, paddingHorizontal: 10 },
  setupToggle: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 14, minHeight: 52, paddingHorizontal: 14, marginBottom: 12 },
  linkBtn: { minHeight: 48, justifyContent: 'center', paddingLeft: 8 },
  container: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    paddingHorizontal: 8,
    minHeight: 56,
  },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, fontWeight: '700', marginLeft: 4 },
  headerActionBtn: { minHeight: 44, paddingHorizontal: 10, justifyContent: 'center' },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scrollContent: { padding: 14, gap: 12 },
  card: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 10 },
  billMerchant: { fontWeight: '700' },
  billMeta: {},
  billTotal: { fontWeight: '800' },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  sectionTitle: { fontWeight: '700' },
  addPeopleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    minHeight: 38,
    borderRadius: 10,
  },
  includeSelfRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  personChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 12,
    minHeight: 36,
  },
  modeBar: {
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: 12,
    padding: 4,
    gap: 4,
  },
  modeTab: {
    flex: 1,
    minHeight: 40,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  splitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  customRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  customInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    minHeight: 44,
    minWidth: 130,
  },
  customInput: { flex: 1, fontWeight: '700', textAlign: 'right', paddingVertical: 6 },
  itemCard: { borderWidth: 1, borderRadius: 12, padding: 10, gap: 8 },
  itemEditRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  itemNameInput: { flex: 2, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, minHeight: 40 },
  itemPriceInput: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, minHeight: 40, textAlign: 'right' },
  itemDeleteBtn: { minWidth: 36, minHeight: 36, alignItems: 'center', justifyContent: 'center' },
  assignChipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  assignChip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 10, minHeight: 32, justifyContent: 'center' },
  itemTotalsBox: { marginTop: 4, gap: 6, paddingTop: 8 },
  itemTotalLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  saveBtn: { minHeight: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  saveBtnText: { fontWeight: '700' },
  shareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  iconPill: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
