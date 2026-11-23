import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Modal, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { expoDb } from '../db/index';
import { getCurrencySymbol } from '../features/transactions/amount';
import { hasForeignCurrencyData, rebaseHomeCurrency } from '../features/currency/rebaseHomeCurrency';
import { getDailyRate } from '../services/fx/rates';
import { formatRate, parseRateText } from '../features/currency/conversion';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTransactionStore } from '../store/useTransactionStore';
import { useAppTheme } from '../theme/useAppTheme';

interface Props {
  fromCurrency: string;
  toCurrency: string | null;
  onClose: () => void;
}

/**
 * Changing the main currency with existing history. Converting keeps every past transaction in the
 * currency it was paid in (accounts keep their real currency) and only converts report totals; a plain
 * relabel is offered for fixing a wrong currency picked at setup, when no foreign data exists.
 */
export function CurrencyChangeModal({ fromCurrency, toCurrency, onClose }: Props) {
  const theme = useAppTheme();
  const [rateText, setRateText] = useState('');
  const [loadingRate, setLoadingRate] = useState(false);
  const [busy, setBusy] = useState(false);
  // Show whichever direction reads as a number above 1 (1 USD = Rp 16.250 rather than 1 IDR = $0.0000615).
  const [inverted, setInverted] = useState(false);
  const canRelabel = toCurrency ? !hasForeignCurrencyData(expoDb) : false;

  useEffect(() => {
    if (!toCurrency) return;
    let alive = true;
    setRateText('');
    setLoadingRate(true);
    void getDailyRate(fromCurrency, toCurrency)
      .then((daily) => {
        if (!alive || !daily) return;
        const invert = daily.rate < 1;
        setInverted(invert);
        const shown = invert ? 1 / daily.rate : daily.rate;
        setRateText(formatRate(shown));
      })
      .finally(() => alive && setLoadingRate(false));
    return () => {
      alive = false;
    };
  }, [fromCurrency, toCurrency]);

  if (!toCurrency) return null;
  const [baseCode, quoteCode] = inverted ? [toCurrency, fromCurrency] : [fromCurrency, toCurrency];
  const shownRate = parseRateText(rateText);
  const rate = shownRate ? (inverted ? 1 / shownRate : shownRate) : null;

  const finish = async (mode: 'convert' | 'relabel') => {
    if (mode === 'convert' && !rate) {
      Alert.alert('Exchange rate needed', `Enter how much 1 ${baseCode} is worth in ${quoteCode}.`);
      return;
    }
    setBusy(true);
    try {
      if (mode === 'convert' && rate) rebaseHomeCurrency(expoDb, fromCurrency, toCurrency, rate);
      await useSettingsStore.getState().setCurrencyCode(toCurrency);
      const store = useTransactionStore.getState();
      await store.fetchTransactions();
      store.fetchWallets();
      await store.fetchBudgets();
      onClose();
    } catch (error) {
      Alert.alert('Could not change currency', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.card, { backgroundColor: theme.surface }]} testID="currency-change-modal">
          <Text style={[styles.title, { color: theme.text, fontSize: theme.scaleFont(17) }]}>
            Switch main currency to {toCurrency}?
          </Text>
          <Text style={[styles.body, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>
            Past transactions keep the {fromCurrency} amounts you paid, and your current accounts stay in{' '}
            {fromCurrency}. Totals, reports and budgets switch to {toCurrency} at this rate:
          </Text>
          <View style={styles.rateRow}>
            <Text style={[styles.rateLabel, { color: theme.text, fontSize: theme.scaleFont(14) }]}>
              1 {baseCode} = {getCurrencySymbol(quoteCode)}
            </Text>
            <TextInput
              style={[styles.rateInput, { borderColor: theme.border, color: theme.text, fontSize: theme.scaleFont(14) }]}
              value={rateText}
              onChangeText={(text) => setRateText(text.replace(/[^0-9.,]/g, ''))}
              keyboardType="decimal-pad"
              placeholder={loadingRate ? 'Fetching today’s rate…' : 'Exchange rate'}
              placeholderTextColor={theme.textMuted}
              accessibilityLabel={`Exchange rate, ${quoteCode} per ${baseCode}`}
            />
            {loadingRate ? <ActivityIndicator color={theme.primary} /> : null}
          </View>

          <TouchableOpacity
            style={[styles.primary, { backgroundColor: theme.primary, opacity: busy ? 0.6 : 1 }]}
            disabled={busy}
            onPress={() => void finish('convert')}
            accessibilityRole="button"
            accessibilityLabel={`Convert totals and switch to ${toCurrency}`}
          >
            <Text style={[styles.primaryText, { color: theme.onPrimary, fontSize: theme.scaleFont(15) }]}>
              Convert totals and switch
            </Text>
          </TouchableOpacity>
          {canRelabel ? (
            <TouchableOpacity
              style={styles.secondary}
              disabled={busy}
              onPress={() => void finish('relabel')}
              accessibilityRole="button"
              accessibilityLabel={`My amounts were already in ${toCurrency}, just relabel`}
            >
              <Text style={{ color: theme.primary, fontSize: theme.scaleFont(13), fontWeight: '600' }}>
                My amounts were already in {toCurrency} (just relabel)
              </Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.secondary} disabled={busy} onPress={onClose} accessibilityRole="button">
            <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(13), fontWeight: '600' }}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 20 },
  card: { borderRadius: 18, padding: 20, gap: 12 },
  title: { fontWeight: '700' },
  body: { lineHeight: 19 },
  rateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rateLabel: { fontWeight: '600' },
  rateInput: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, minHeight: 48 },
  primary: { borderRadius: 12, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  primaryText: { fontWeight: '700' },
  secondary: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
});
