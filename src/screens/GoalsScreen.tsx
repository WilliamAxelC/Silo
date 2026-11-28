import React, { useEffect, useState } from 'react';
import {
  Alert,
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
import DateTimePicker from '@react-native-community/datetimepicker';
import { useNavigation } from '@react-navigation/native';

import type { NavigationProps } from '../navigation/types';
import { useAppTheme } from '../theme/useAppTheme';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTransactionStore } from '../store/useTransactionStore';
import { formatAmountForInput, formatAmountInput, formatDisplayCurrency, parseSignedAmount } from '../features/transactions/amount';
import { goalProgress, useGoalsStore, validateGoal, type Goal, type GoalSource } from '../features/goals/goals';
import { KeyboardSheet } from '../components/KeyboardSheet';
import { DIALOG_WIDTH, SHEET_WIDTH } from '../theme/layout';

type Draft = {
  id?: number;
  name: string;
  target: string;
  saved: string;
  targetDate: number | null;
  source: GoalSource;
  walletId: number | null;
};

const EMPTY: Draft = { name: '', target: '', saved: '', targetDate: null, source: 'manual', walletId: null };

export const GoalsScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const currency = useSettingsStore((s) => s.currencyCode);
  const thousands = useSettingsStore((s) => s.useThousandsSeparator);
  const locale = useSettingsStore((s) => s.dateFormat) || 'en-GB';
  const wallets = useTransactionStore((s) => s.wallets);
  const goals = useGoalsStore((s) => s.goals);
  const { ensureLoaded, save, addSaved, setArchived, remove } = useGoalsStore.getState();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [pickDate, setPickDate] = useState(false);
  const [adding, setAdding] = useState<{ goal: Goal; text: string; withdraw: boolean } | null>(null);

  useEffect(() => ensureLoaded(), [ensureLoaded]);

  const money = (n: number) => formatDisplayCurrency(n, currency, thousands);
  const activeWallets = wallets.filter((w) => w.isActive);

  const openEditor = (goal?: Goal) => {
    setDraftError(null);
    setDraft(
      goal
        ? {
            id: goal.id,
            name: goal.name,
            target: formatAmountForInput(goal.targetAmount, currency),
            saved: goal.savedAmount ? formatAmountForInput(goal.savedAmount, currency) : '',
            targetDate: goal.targetDate,
            source: goal.source,
            walletId: goal.walletId,
          }
        : { ...EMPTY, walletId: activeWallets.find((w) => w.type === 'savings')?.id ?? null }
    );
  };

  const saveDraft = () => {
    if (!draft) return;
    const input = {
      name: draft.name,
      targetAmount: Math.abs(parseSignedAmount(draft.target, undefined, currency)),
      savedAmount: Math.abs(parseSignedAmount(draft.saved || '0', undefined, currency)),
      targetDate: draft.targetDate,
      source: draft.source,
      walletId: draft.walletId,
    };
    const problem = validateGoal(input);
    if (problem) {
      setDraftError(problem);
      return;
    }
    save(input, draft.id);
    setDraft(null);
  };

  const confirmAdd = () => {
    if (!adding) return;
    const amount = Math.abs(parseSignedAmount(adding.text, undefined, currency));
    if (amount > 0) addSaved(adding.goal.id, adding.withdraw ? -amount : amount);
    setAdding(null);
  };

  const goalMenu = (goal: Goal) => {
    Alert.alert(goal.name, undefined, [
      { text: 'Edit', onPress: () => openEditor(goal) },
      { text: goal.archived ? 'Restore' : 'Archive', onPress: () => setArchived(goal.id, !goal.archived) },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          Alert.alert('Delete goal?', `"${goal.name}" will be removed. Your money and transactions are not affected.`, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: () => remove(goal.id) },
          ]),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const field = [styles.input, { backgroundColor: theme.background, borderColor: theme.border, color: theme.text, fontSize: theme.scaleFont(15) }];
  const label = [styles.label, { color: theme.text, fontSize: theme.scaleFont(13) }];

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <TouchableOpacity style={styles.iconBtn} onPress={() => navigation.goBack()} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="arrow-back" size={22} color={theme.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.text, fontSize: theme.scaleFont(18) }]} accessibilityRole="header">
          Savings goals
        </Text>
        <TouchableOpacity
          style={[styles.newBtn, { backgroundColor: theme.primary }]}
          onPress={() => openEditor()}
          accessibilityRole="button"
          accessibilityLabel="New goal"
        >
          <Ionicons name="add" size={20} color={theme.onPrimary} />
          <Text style={{ color: theme.onPrimary, fontWeight: '700', fontSize: theme.scaleFont(14) }}>New</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: getBottomInsetPadding(insets.bottom, 24) }]}>
        {goals.length === 0 ? (
          <View style={[styles.empty, { borderColor: theme.border, backgroundColor: theme.surface }]}>
            <Ionicons name="flag-outline" size={32} color={theme.textMuted} />
            <Text style={{ color: theme.text, fontWeight: '700', fontSize: theme.scaleFont(15), marginTop: 8 }}>No goals yet</Text>
            <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(13), textAlign: 'center', marginTop: 4 }}>
              Save towards a trip, an emergency fund or anything else. Track it by hand or follow a savings account.
            </Text>
          </View>
        ) : null}

        {goals.map((goal) => {
          const p = goalProgress(goal, wallets, currency);
          const wallet = wallets.find((w) => w.id === goal.walletId);
          return (
            <View
              key={goal.id}
              style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border, opacity: goal.archived ? 0.6 : 1 }]}
              testID={`goal-${goal.id}`}
            >
              <TouchableOpacity
                onPress={() => goalMenu(goal)}
                accessibilityRole="button"
                accessibilityLabel={`${goal.name}: ${money(p.current)} of ${money(goal.targetAmount)}${p.done ? ', reached' : ''}`}
              >
                <View style={styles.cardHead}>
                  <Text style={{ color: theme.text, fontWeight: '800', fontSize: theme.scaleFont(16), flex: 1 }} numberOfLines={1}>
                    {goal.name}
                  </Text>
                  {p.done ? <Ionicons name="checkmark-circle" size={20} color={theme.income} /> : null}
                </View>
                <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(13), marginTop: 2 }}>
                  {money(p.current)} of {money(goal.targetAmount)}
                  {goal.source === 'account' ? ` · ${wallet?.name ?? 'account removed'}` : ''}
                </Text>
                <View
                  style={[styles.bar, { backgroundColor: theme.border }]}
                  accessibilityRole="progressbar"
                  accessibilityValue={{ min: 0, max: 100, now: Math.round(p.fraction * 100) }}
                >
                  <View style={[styles.barFill, { width: `${Math.round(p.fraction * 100)}%`, backgroundColor: p.done ? theme.income : theme.primary }]} />
                </View>
                <Text style={{ color: p.overdue ? theme.expense : theme.textMuted, fontSize: theme.scaleFont(12) }}>
                  {p.done
                    ? 'Goal reached'
                    : p.overdue
                      ? `Target date passed · ${money(p.remaining)} to go`
                      : p.perMonth != null && goal.targetDate
                        ? `${money(p.perMonth)} a month to reach it by ${new Date(goal.targetDate).toLocaleDateString(locale, { month: 'short', year: 'numeric' })}`
                        : `${money(p.remaining)} to go`}
                </Text>
              </TouchableOpacity>
              {goal.source === 'manual' && !goal.archived ? (
                <View style={styles.cardActions}>
                  <TouchableOpacity
                    style={[styles.actionBtn, { borderColor: theme.primary }]}
                    onPress={() => setAdding({ goal, text: '', withdraw: false })}
                    accessibilityRole="button"
                    accessibilityLabel={`Add money to ${goal.name}`}
                  >
                    <Text style={{ color: theme.primary, fontWeight: '700', fontSize: theme.scaleFont(13) }}>Add money</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.actionBtn, { borderColor: theme.border }]}
                    onPress={() => setAdding({ goal, text: '', withdraw: true })}
                    accessibilityRole="button"
                    accessibilityLabel={`Take money out of ${goal.name}`}
                  >
                    <Text style={{ color: theme.text, fontWeight: '700', fontSize: theme.scaleFont(13) }}>Take out</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>

      <Modal visible={draft !== null} transparent animationType="slide" onRequestClose={() => setDraft(null)}>
        <KeyboardSheet style={styles.overlay}>
          <View style={[styles.sheet, { backgroundColor: theme.surface, borderColor: theme.border, paddingBottom: getBottomInsetPadding(insets.bottom, 16) }]}>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={{ color: theme.text, fontWeight: '800', fontSize: theme.scaleFont(18), marginBottom: 12 }}>
                {draft?.id ? 'Edit goal' : 'New goal'}
              </Text>
              <Text style={label}>Name</Text>
              <TextInput
                style={field}
                value={draft?.name ?? ''}
                onChangeText={(name) => setDraft((d) => (d ? { ...d, name } : d))}
                placeholder="e.g. Japan trip"
                placeholderTextColor={theme.textMuted}
                maxLength={60}
                accessibilityLabel="Goal name"
              />
              <Text style={label}>Target amount</Text>
              <TextInput
                style={field}
                value={draft?.target ?? ''}
                onChangeText={(t) => setDraft((d) => (d ? { ...d, target: formatAmountInput(t, currency) } : d))}
                keyboardType="numeric"
                placeholder="0"
                placeholderTextColor={theme.textMuted}
                accessibilityLabel="Target amount"
              />
              <Text style={label}>Target date (optional)</Text>
              <View style={styles.row}>
                <TouchableOpacity
                  style={[styles.actionBtn, { borderColor: theme.border, flex: 1 }]}
                  onPress={() => setPickDate(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Pick target date"
                >
                  <Text style={{ color: theme.text, fontSize: theme.scaleFont(14) }}>
                    {draft?.targetDate ? new Date(draft.targetDate).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : 'No date'}
                  </Text>
                </TouchableOpacity>
                {draft?.targetDate ? (
                  <TouchableOpacity
                    style={[styles.actionBtn, { borderColor: theme.border }]}
                    onPress={() => setDraft((d) => (d ? { ...d, targetDate: null } : d))}
                    accessibilityRole="button"
                    accessibilityLabel="Clear target date"
                  >
                    <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(14) }}>Clear</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              <Text style={label}>Track progress</Text>
              <View style={[styles.segment, { borderColor: theme.border }]}>
                {(['manual', 'account'] as const).map((src) => {
                  const selected = draft?.source === src;
                  return (
                    <TouchableOpacity
                      key={src}
                      style={[styles.segmentBtn, selected && { backgroundColor: theme.primary }]}
                      onPress={() => setDraft((d) => (d ? { ...d, source: src } : d))}
                      accessibilityRole="button"
                      accessibilityLabel={src === 'manual' ? 'Track by hand' : 'Follow an account'}
                      accessibilityState={{ selected }}
                    >
                      <Text style={{ color: selected ? theme.onPrimary : theme.text, fontWeight: '700', fontSize: theme.scaleFont(13) }}>
                        {src === 'manual' ? 'By hand' : 'Follow an account'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {draft?.source === 'account' ? (
                <View style={styles.chips}>
                  {activeWallets.map((w) => {
                    const selected = draft.walletId === w.id;
                    return (
                      <TouchableOpacity
                        key={w.id}
                        style={[styles.chip, { borderColor: selected ? theme.primary : theme.border, backgroundColor: selected ? theme.primary : theme.background }]}
                        onPress={() => setDraft((d) => (d ? { ...d, walletId: w.id } : d))}
                        accessibilityRole="button"
                        accessibilityLabel={`Account ${w.name}`}
                        accessibilityState={{ selected }}
                      >
                        <Text style={{ color: selected ? theme.onPrimary : theme.text, fontWeight: '600', fontSize: theme.scaleFont(13) }}>{w.name}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ) : (
                <>
                  <Text style={label}>Saved so far</Text>
                  <TextInput
                    style={field}
                    value={draft?.saved ?? ''}
                    onChangeText={(t) => setDraft((d) => (d ? { ...d, saved: formatAmountInput(t, currency) } : d))}
                    keyboardType="numeric"
                    placeholder="0"
                    placeholderTextColor={theme.textMuted}
                    accessibilityLabel="Saved so far"
                  />
                </>
              )}
              {draftError ? (
                <Text accessibilityRole="alert" style={{ color: theme.expense, fontSize: theme.scaleFont(13), marginTop: 8 }}>
                  {draftError}
                </Text>
              ) : null}
              <View style={[styles.row, { marginTop: 16 }]}>
                <TouchableOpacity
                  style={[styles.actionBtn, { borderColor: theme.border, flex: 1 }]}
                  onPress={() => setDraft(null)}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel"
                >
                  <Text style={{ color: theme.text, fontWeight: '700', fontSize: theme.scaleFont(14) }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: theme.primary, borderColor: theme.primary, flex: 1 }]}
                  onPress={saveDraft}
                  accessibilityRole="button"
                  accessibilityLabel="Save goal"
                >
                  <Text style={{ color: theme.onPrimary, fontWeight: '800', fontSize: theme.scaleFont(14) }}>Save</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </KeyboardSheet>
        {pickDate ? (
          <DateTimePicker
            value={new Date(draft?.targetDate ?? Date.now() + 90 * 86400000)}
            mode="date"
            minimumDate={new Date()}
            onChange={(_e, picked) => {
              setPickDate(false);
              if (picked) setDraft((d) => (d ? { ...d, targetDate: picked.getTime() } : d));
            }}
          />
        ) : null}
      </Modal>

      <Modal visible={adding !== null} transparent animationType="fade" onRequestClose={() => setAdding(null)}>
        <KeyboardSheet style={[styles.overlay, styles.centered]}>
          <View style={[styles.dialog, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={{ color: theme.text, fontWeight: '800', fontSize: theme.scaleFont(16), marginBottom: 10 }}>
              {adding?.withdraw ? 'Take money out of' : 'Add money to'} {adding?.goal.name}
            </Text>
            <TextInput
              style={field}
              value={adding?.text ?? ''}
              onChangeText={(t) => setAdding((a) => (a ? { ...a, text: formatAmountInput(t, currency) } : a))}
              keyboardType="numeric"
              autoFocus
              placeholder="0"
              placeholderTextColor={theme.textMuted}
              accessibilityLabel="Amount"
            />
            <View style={styles.row}>
              <TouchableOpacity style={[styles.actionBtn, { borderColor: theme.border, flex: 1 }]} onPress={() => setAdding(null)} accessibilityRole="button" accessibilityLabel="Cancel">
                <Text style={{ color: theme.text, fontWeight: '700', fontSize: theme.scaleFont(14) }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionBtn, { backgroundColor: theme.primary, borderColor: theme.primary, flex: 1 }]}
                onPress={confirmAdd}
                accessibilityRole="button"
                accessibilityLabel="Confirm amount"
              >
                <Text style={{ color: theme.onPrimary, fontWeight: '800', fontSize: theme.scaleFont(14) }}>OK</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardSheet>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, paddingHorizontal: 8, paddingVertical: 8, gap: 4 },
  iconBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontWeight: '800', flex: 1 },
  newBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 48, paddingHorizontal: 14, borderRadius: 12 },
  content: { padding: 16, gap: 12 },
  empty: { borderWidth: 1, borderRadius: 16, padding: 24, alignItems: 'center' },
  card: { borderWidth: 1, borderRadius: 16, padding: 16 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bar: { height: 10, borderRadius: 5, overflow: 'hidden', marginVertical: 10 },
  barFill: { height: '100%', borderRadius: 5 },
  cardActions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  actionBtn: { minHeight: 48, borderRadius: 12, borderWidth: 1, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  centered: { justifyContent: 'center', padding: 20 },
  sheet: { ...SHEET_WIDTH, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, padding: 18, maxHeight: '90%' },
  dialog: { ...DIALOG_WIDTH, borderWidth: 1, borderRadius: 18, padding: 18 },
  label: { fontWeight: '700', marginBottom: 6, marginTop: 6 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 48, marginBottom: 6 },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  segment: { flexDirection: 'row', borderWidth: 1, borderRadius: 12, padding: 3, gap: 3 },
  segmentBtn: { flex: 1, minHeight: 48, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  chip: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 14, minHeight: 44, justifyContent: 'center' },
});
