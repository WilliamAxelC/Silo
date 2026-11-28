import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { formatDisplayCurrency } from '../features/transactions/amount';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import { useAppTheme } from '../theme/useAppTheme';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTransactionStore } from '../store/useTransactionStore';
import type { CurrencyTotal } from '../features/splits/types';
import { SHEET_WIDTH } from '../theme/layout';

interface Props {
  visible: boolean;
  personName: string;
  subtitle: string;
  totals: CurrencyTotal[];
  defaultWalletId: number | null;
  onConfirm: (options: { logRepayment: boolean; walletId?: number }) => Promise<void> | void;
  onClose: () => void;
}

export const SettleSplitModal = ({
  visible,
  personName,
  subtitle,
  totals,
  defaultWalletId,
  onConfirm,
  onClose,
}: Props) => {
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const wallets = useTransactionStore((s) => s.wallets);
  const useThousandsSeparator = useSettingsStore((s) => s.useThousandsSeparator);
  const activeWallets = wallets.filter((w) => w.isActive);

  const [logRepayment, setLogRepayment] = useState(true);
  const [selectedWalletId, setSelectedWalletId] = useState<number | null>(defaultWalletId);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setLogRepayment(true);
      const fallback =
        activeWallets.find((w) => w.id === defaultWalletId)?.id ?? activeWallets[0]?.id ?? null;
      setSelectedWalletId(fallback);
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, defaultWalletId]);

  const amountSummary = totals
    .map((t) => formatDisplayCurrency(t.amount, t.currency, useThousandsSeparator))
    .join(' + ');

  const handleConfirm = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onConfirm({
        logRepayment,
        walletId: logRepayment && selectedWalletId != null ? selectedWalletId : undefined,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal statusBarTranslucent navigationBarTranslucent visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          activeOpacity={1}
          accessible={false}
          onPress={onClose}
        />
        <View
          testID="settle-split-sheet"
          style={[
            styles.sheet,
            { backgroundColor: theme.surface, paddingBottom: getBottomInsetPadding(insets.bottom, 18) },
          ]}
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.text, fontSize: theme.scaleFont(16) }]}>
              Mark as Paid
            </Text>
            <TouchableOpacity
              style={styles.closeBtn}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close mark as paid"
            >
              <Ionicons name="close" size={22} color={theme.textMuted} />
            </TouchableOpacity>
          </View>

          <View style={[styles.summaryBox, { backgroundColor: theme.background, borderColor: theme.border }]}>
            <Text style={[styles.personText, { color: theme.text, fontSize: theme.scaleFont(15) }]}>
              {personName}
            </Text>
            <Text style={[styles.subText, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
              {subtitle}
            </Text>
            <Text style={[styles.amountText, { color: theme.income, fontSize: theme.scaleFont(18) }]}>
              {amountSummary}
            </Text>
          </View>

          <View style={styles.toggleRow}>
            <View style={styles.toggleInfo}>
              <Text style={[styles.toggleTitle, { color: theme.text, fontSize: theme.scaleFont(14) }]}>
                Log repayment into a wallet
              </Text>
              <Text style={[styles.toggleDesc, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
                Adds an income entry so your wallet balance reflects the money you got back.
              </Text>
            </View>
            <Switch
              value={logRepayment}
              onValueChange={setLogRepayment}
              accessibilityLabel="Log repayment into a wallet"
              trackColor={{ true: theme.primary, false: theme.border }}
            />
          </View>

          {logRepayment ? (
            <View style={styles.walletSection}>
              <Text style={[styles.walletLabel, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
                Receiving wallet
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.walletChips}>
                {activeWallets.map((wallet) => {
                  const selected = wallet.id === selectedWalletId;
                  return (
                    <TouchableOpacity
                      key={wallet.id}
                      style={[
                        styles.walletChip,
                        {
                          borderColor: selected ? theme.primary : theme.border,
                          backgroundColor: selected ? theme.primaryMuted : theme.background,
                        },
                      ]}
                      onPress={() => setSelectedWalletId(wallet.id)}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`Receive into ${wallet.name}`}
                    >
                      <Text
                        style={{
                          color: selected ? theme.primary : theme.text,
                          fontWeight: selected ? '700' : '500',
                          fontSize: theme.scaleFont(13),
                        }}
                      >
                        {wallet.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          ) : null}

          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.cancelBtn, { borderColor: theme.border }]}
              onPress={onClose}
              disabled={saving}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <Text style={{ color: theme.textMuted, fontWeight: '600', fontSize: theme.scaleFont(14) }}>
                Cancel
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.confirmBtn, { backgroundColor: theme.income }]}
              onPress={() => void handleConfirm()}
              disabled={saving}
              accessibilityRole="button"
              accessibilityLabel="Confirm mark as paid"
            >
              {saving ? (
                <ActivityIndicator size="small" color={theme.onPrimary} />
              ) : (
                <Text style={{ color: theme.onPrimary, fontWeight: '700', fontSize: theme.scaleFont(14) }}>
                  Mark Paid
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { ...SHEET_WIDTH, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, maxHeight: '85%' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { fontWeight: '700' },
  closeBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  summaryBox: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 4, marginBottom: 14 },
  personText: { fontWeight: '700' },
  subText: { lineHeight: 16 },
  amountText: { fontWeight: '800', marginTop: 4 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  toggleInfo: { flex: 1, gap: 2 },
  toggleTitle: { fontWeight: '600' },
  toggleDesc: { lineHeight: 17 },
  walletSection: { marginBottom: 14, gap: 8 },
  walletLabel: { fontWeight: '600' },
  walletChips: { gap: 8 },
  walletChip: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, minHeight: 44, justifyContent: 'center' },
  footer: { flexDirection: 'row', gap: 10, marginTop: 6 },
  cancelBtn: { flex: 1, minHeight: 48, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  confirmBtn: { flex: 2, minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
