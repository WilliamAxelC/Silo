import React, { useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';

import type { BudgetPlan, BudgetUnit } from '../features/budgets/engine';
import type { BudgetPlanInput } from '../features/budgets/plans';
import { validateBudgetPlan } from '../features/budgets/plans';
import { SUPPORTED_CURRENCIES } from '../features/currency/currencies';
import { formatAmountForInput, formatAmountInput, getCurrencySymbol, parseSignedAmount } from '../features/transactions/amount';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import { useAppTheme } from '../theme/useAppTheme';

const UNITS: Array<{ key: BudgetUnit; one: string; many: string }> = [
  { key: 'day', one: 'Day', many: 'Days' },
  { key: 'week', one: 'Week', many: 'Weeks' },
  { key: 'month', one: 'Month', many: 'Months' },
  { key: 'year', one: 'Year', many: 'Years' },
];

interface Props {
  plan: BudgetPlan | null;
  homeCurrency: string;
  /** Default start for a new repeating budget (the current billing period start). */
  defaultStart: number;
  categories: string[];
  wallets: Array<{ id: number; name: string; currency: string | null }>;
  tags: string[];
  dateFormat: string;
  onSave: (input: BudgetPlanInput) => void;
  onDelete?: () => void;
  onClose: () => void;
}

const startOfDay = (time: number) => {
  const d = new Date(time);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** Create or edit a budget: one-off date range or repeating period, currency, rollover and filters. */
export function BudgetPlanEditor({ plan, homeCurrency, defaultStart, categories, wallets, tags, dateFormat, onSave, onDelete, onClose }: Props) {
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const [name, setName] = useState(plan?.name ?? '');
  const [currency, setCurrency] = useState(plan?.currency ?? homeCurrency);
  const [amountText, setAmountText] = useState(plan ? formatAmountForInput(plan.amount, plan.currency ?? homeCurrency) : '');
  const [kind, setKind] = useState(plan?.kind ?? 'recurring');
  const [every, setEvery] = useState(String(plan?.every ?? 1));
  const [unit, setUnit] = useState<BudgetUnit>(plan?.unit ?? 'month');
  const [startDate, setStartDate] = useState(plan?.startDate ?? defaultStart);
  const [endDate, setEndDate] = useState<number | null>(plan?.endDate ?? null);
  const [rollover, setRollover] = useState(plan?.rollover ?? 'reset');
  const [carryOverspend, setCarryOverspend] = useState(plan?.carryOverspend ?? false);
  const [selectedCategories, setSelectedCategories] = useState<string[]>(plan?.categories ?? []);
  const [selectedWallets, setSelectedWallets] = useState<number[]>(plan?.walletIds ?? []);
  const [selectedTags, setSelectedTags] = useState<string[]>(plan?.tags ?? []);
  const [picker, setPicker] = useState<'start' | 'end' | null>(null);

  // Currencies people are likely to budget in come first: home, then foreign accounts, then the rest.
  const currencyOptions = useMemo(() => {
    const preferred = [homeCurrency, ...wallets.map((w) => w.currency).filter((c): c is string => Boolean(c))];
    const rest = SUPPORTED_CURRENCIES.map((c) => c.code);
    return Array.from(new Set([...preferred, ...rest]));
  }, [homeCurrency, wallets]);

  const toggle = <T,>(list: T[], value: T, set: (next: T[]) => void) =>
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const fmtDate = (time: number) =>
    new Date(time).toLocaleDateString(dateFormat || 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  const save = () => {
    const input: BudgetPlanInput = {
      name,
      amount: Math.abs(parseSignedAmount(amountText || '0', undefined, currency)),
      currency: currency === homeCurrency ? null : currency,
      kind,
      startDate: startOfDay(startDate),
      endDate: kind === 'once' ? (endDate != null ? startOfDay(endDate) : null) : null,
      every: Math.max(1, Number.parseInt(every, 10) || 1),
      unit,
      rollover,
      carryOverspend,
      categories: selectedCategories,
      walletIds: selectedWallets,
      tags: selectedTags,
      archived: plan?.archived ?? false,
    };
    const error = validateBudgetPlan(input);
    if (error) {
      Alert.alert('Check the budget', error);
      return;
    }
    onSave(input);
  };

  const chipStyle = (selected: boolean) => [
    styles.chip,
    { borderColor: selected ? theme.primary : theme.border, backgroundColor: selected ? theme.primaryMuted : 'transparent' },
  ];
  const chipText = (selected: boolean) => ({ color: selected ? theme.primary : theme.text, fontSize: theme.scaleFont(13), fontWeight: '600' as const });
  const label = (text: string) => <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(12) }]}>{text}</Text>;
  const segmented = <K extends string>(options: Array<{ key: K; label: string }>, value: K, onPick: (k: K) => void) => (
    <View style={[styles.segment, { borderColor: theme.border }]}>
      {options.map((o) => {
        const selected = value === o.key;
        return (
          <TouchableOpacity
            key={o.key}
            style={[styles.segmentBtn, { backgroundColor: selected ? theme.primary : 'transparent' }]}
            onPress={() => onPick(o.key)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={o.label}
          >
            <Text style={{ color: selected ? theme.onPrimary : theme.text, fontSize: theme.scaleFont(13), fontWeight: '700' }}>{o.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
  const dateButton = (which: 'start' | 'end', value: number | null, placeholder: string) => (
    <TouchableOpacity
      style={[styles.input, styles.dateBtn, { borderColor: theme.border }]}
      onPress={() => setPicker(which)}
      accessibilityRole="button"
      accessibilityLabel={which === 'start' ? 'Start date' : 'End date'}
    >
      <Text style={{ color: value != null ? theme.text : theme.textMuted, fontSize: theme.scaleFont(14) }}>
        {value != null ? fmtDate(value) : placeholder}
      </Text>
    </TouchableOpacity>
  );
  const everyCount = Math.max(1, Number.parseInt(every, 10) || 1);

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.overlay}>
        <View
          testID="budget-plan-editor"
          style={[styles.sheet, { backgroundColor: theme.surface, paddingBottom: getBottomInsetPadding(insets.bottom, 20) }]}
        >
          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
            <Text style={[styles.title, { color: theme.text, fontSize: theme.scaleFont(18) }]}>{plan ? 'Edit budget' : 'New budget'}</Text>

            {label('Name')}
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text, fontSize: theme.scaleFont(15) }]}
              value={name}
              onChangeText={setName}
              placeholder="e.g. Groceries, Japan trip, Date nights"
              placeholderTextColor={theme.textMuted}
              accessibilityLabel="Budget name"
            />

            {label('Amount')}
            <View style={styles.row}>
              <View style={[styles.badge, { borderColor: theme.border }]}>
                <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(13), fontWeight: '700' }}>{getCurrencySymbol(currency)}</Text>
              </View>
              <TextInput
                style={[styles.input, styles.flex, { borderColor: theme.border, color: theme.text, fontSize: theme.scaleFont(15) }]}
                value={amountText}
                onChangeText={(t) => setAmountText(formatAmountInput(t, currency))}
                keyboardType={Platform.OS === 'ios' ? 'decimal-pad' : 'numeric'}
                placeholder="0"
                placeholderTextColor={theme.textMuted}
                accessibilityLabel="Budget amount"
              />
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {currencyOptions.map((code) => (
                <TouchableOpacity
                  key={code}
                  style={chipStyle(currency === code)}
                  onPress={() => {
                    setAmountText((t) => (t ? formatAmountForInput(Math.abs(parseSignedAmount(t, undefined, currency)), code) : t));
                    setCurrency(code);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Budget currency ${code}`}
                  accessibilityState={{ selected: currency === code }}
                >
                  <Text style={chipText(currency === code)}>{code}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            {label('Period')}
            {segmented(
              [
                { key: 'recurring', label: 'Repeating' },
                { key: 'once', label: 'One-time' },
              ],
              kind,
              (k) => setKind(k)
            )}
            {kind === 'recurring' ? (
              <>
                <View style={styles.row}>
                  <Text style={{ color: theme.text, fontSize: theme.scaleFont(14) }}>Every</Text>
                  <TextInput
                    style={[styles.input, styles.everyInput, { borderColor: theme.border, color: theme.text, fontSize: theme.scaleFont(15) }]}
                    value={every}
                    onChangeText={(t) => setEvery(t.replace(/\D/g, '').slice(0, 3))}
                    keyboardType="number-pad"
                    accessibilityLabel="Repeat every"
                  />
                </View>
                <View style={styles.chipsWrap}>
                  {UNITS.map((u) => (
                    <TouchableOpacity
                      key={u.key}
                      style={chipStyle(unit === u.key)}
                      onPress={() => setUnit(u.key)}
                      accessibilityRole="button"
                      accessibilityLabel={`Repeat unit ${u.many}`}
                      accessibilityState={{ selected: unit === u.key }}
                    >
                      <Text style={chipText(unit === u.key)}>{everyCount === 1 ? u.one : u.many}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {label('Starting')}
                {dateButton('start', startDate, 'Start date')}
                {label('When a period ends')}
                {segmented(
                  [
                    { key: 'reset', label: 'Reset' },
                    { key: 'carry', label: 'Carry over' },
                  ],
                  rollover,
                  (k) => setRollover(k)
                )}
                <Text style={[styles.hint, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
                  {rollover === 'reset'
                    ? 'Each period starts again at the full amount.'
                    : 'Money left over is added to the next period.'}
                </Text>
                {rollover === 'carry' ? (
                  <View style={styles.switchRow}>
                    <Text style={{ color: theme.text, fontSize: theme.scaleFont(14), flex: 1 }}>Also carry overspending</Text>
                    <Switch value={carryOverspend} onValueChange={setCarryOverspend} accessibilityLabel="Also carry overspending" />
                  </View>
                ) : null}
              </>
            ) : (
              <View style={styles.row}>
                <View style={styles.flex}>
                  {label('From')}
                  {dateButton('start', startDate, 'Start date')}
                </View>
                <View style={styles.flex}>
                  {label('To')}
                  {dateButton('end', endDate, 'End date')}
                </View>
              </View>
            )}

            {label('Counts spending in')}
            <Text style={[styles.hint, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
              Leave a group empty to include everything. Picking in several groups counts spending that matches all of them.
            </Text>
            <Text style={[styles.groupLabel, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>Categories</Text>
            <View style={styles.chipsWrap}>
              {categories.map((c) => (
                <TouchableOpacity
                  key={c}
                  style={chipStyle(selectedCategories.includes(c))}
                  onPress={() => toggle(selectedCategories, c, setSelectedCategories)}
                  accessibilityRole="button"
                  accessibilityLabel={`Budget category ${c}`}
                  accessibilityState={{ selected: selectedCategories.includes(c) }}
                >
                  <Text style={chipText(selectedCategories.includes(c))}>{c}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {wallets.length > 1 ? (
              <>
                <Text style={[styles.groupLabel, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>Accounts</Text>
                <View style={styles.chipsWrap}>
                  {wallets.map((w) => (
                    <TouchableOpacity
                      key={w.id}
                      style={chipStyle(selectedWallets.includes(w.id))}
                      onPress={() => toggle(selectedWallets, w.id, setSelectedWallets)}
                      accessibilityRole="button"
                      accessibilityLabel={`Budget account ${w.name}`}
                      accessibilityState={{ selected: selectedWallets.includes(w.id) }}
                    >
                      <Text style={chipText(selectedWallets.includes(w.id))}>
                        {w.name}
                        {w.currency ? ` · ${w.currency}` : ''}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            ) : null}
            {tags.length > 0 ? (
              <>
                <Text style={[styles.groupLabel, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>Tags</Text>
                <View style={styles.chipsWrap}>
                  {tags.map((t) => (
                    <TouchableOpacity
                      key={t}
                      style={chipStyle(selectedTags.includes(t))}
                      onPress={() => toggle(selectedTags, t, setSelectedTags)}
                      accessibilityRole="button"
                      accessibilityLabel={`Budget tag ${t}`}
                      accessibilityState={{ selected: selectedTags.includes(t) }}
                    >
                      <Text style={chipText(selectedTags.includes(t))}>#{t}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            ) : null}

            <TouchableOpacity
              style={[styles.primary, { backgroundColor: theme.primary }]}
              onPress={save}
              accessibilityRole="button"
              accessibilityLabel="Save budget"
            >
              <Text style={{ color: theme.onPrimary, fontSize: theme.scaleFont(15), fontWeight: '700' }}>Save budget</Text>
            </TouchableOpacity>
            {onDelete ? (
              <TouchableOpacity style={styles.secondary} onPress={onDelete} accessibilityRole="button" accessibilityLabel="Delete budget">
                <Text style={{ color: theme.expense, fontSize: theme.scaleFont(14), fontWeight: '600' }}>Delete budget</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={styles.secondary} onPress={onClose} accessibilityRole="button" accessibilityLabel="Cancel">
              <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(14), fontWeight: '600' }}>Cancel</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
      {picker ? (
        <DateTimePicker
          value={new Date(picker === 'start' ? startDate : endDate ?? startDate)}
          mode="date"
          display="default"
          onChange={(_e: unknown, date?: Date) => {
            const which = picker;
            setPicker(null);
            if (!date) return;
            if (which === 'start') setStartDate(startOfDay(date.getTime()));
            else setEndDate(startOfDay(date.getTime()));
          }}
        />
      ) : null}
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: '92%' },
  content: { padding: 20, gap: 8 },
  title: { fontWeight: '800', marginBottom: 4 },
  label: { fontWeight: '700', marginTop: 10 },
  groupLabel: { fontWeight: '700', marginTop: 4 },
  hint: { lineHeight: 17 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 46 },
  dateBtn: { justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flex: { flex: 1 },
  badge: { borderWidth: 1, borderRadius: 12, minHeight: 46, minWidth: 54, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  chips: { gap: 6, paddingVertical: 2 },
  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, minHeight: 34, justifyContent: 'center' },
  segment: { flexDirection: 'row', borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  segmentBtn: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center' },
  everyInput: { width: 72, textAlign: 'center' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  primary: { borderRadius: 14, minHeight: 50, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  secondary: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
