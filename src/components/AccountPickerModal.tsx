import React from 'react';
import { FlatList, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import type { Wallet, WalletType } from '../features/transactions/types';
import { formatDisplayCurrency } from '../features/transactions/amount';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import { useSettingsStore } from '../store/useSettingsStore';
import { useAppTheme } from '../theme/useAppTheme';

export const WALLET_TYPE_META: Record<WalletType, { label: string; icon: keyof typeof Ionicons.glyphMap }> = {
  cash: { label: 'Cash', icon: 'cash-outline' },
  bank: { label: 'Bank', icon: 'business-outline' },
  ewallet: { label: 'E-wallet', icon: 'phone-portrait-outline' },
  card: { label: 'Credit card', icon: 'card-outline' },
  savings: { label: 'Savings', icon: 'trending-up-outline' },
};

interface Props {
  visible: boolean;
  title: string;
  wallets: Wallet[];
  selectedId: number | null;
  /** Hidden from the list, e.g. the source account when picking a transfer's destination. */
  excludeId?: number | null;
  onSelect: (id: number) => void;
  onClose: () => void;
  onManage: () => void;
}

export const AccountPickerModal = ({ visible, title, wallets, selectedId, excludeId, onSelect, onClose, onManage }: Props) => {
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const currencyCode = useSettingsStore((s) => s.currencyCode);
  const useThousands = useSettingsStore((s) => s.useThousandsSeparator);
  const options = wallets.filter((w) => w.isActive && w.id !== excludeId);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity
          activeOpacity={1}
          testID="account-picker-sheet"
          style={[
            styles.sheet,
            { backgroundColor: theme.surface, paddingBottom: getBottomInsetPadding(insets.bottom, 18) },
          ]}
        >
          <Text style={[styles.title, { color: theme.text, fontSize: theme.scaleFont(16) }]}>{title}</Text>
          <FlatList
            data={options}
            keyExtractor={(w) => String(w.id)}
            renderItem={({ item }) => {
              const selected = item.id === selectedId;
              return (
                <TouchableOpacity
                  style={[styles.row, { borderColor: selected ? theme.primary : theme.border }]}
                  onPress={() => {
                    onSelect(item.id);
                    onClose();
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${item.name}, balance ${formatDisplayCurrency(item.balance, currencyCode, useThousands)}`}
                >
                  <Ionicons name={WALLET_TYPE_META[item.type].icon} size={20} color={theme.primary} />
                  <Text style={[styles.name, { color: theme.text, fontSize: theme.scaleFont(15) }]} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text
                    style={[
                      styles.balance,
                      { color: item.balance < 0 ? theme.expense : theme.textMuted, fontSize: theme.scaleFont(13) },
                    ]}
                  >
                    {formatDisplayCurrency(item.balance, currencyCode, useThousands)}
                  </Text>
                  {selected ? <Ionicons name="checkmark" size={18} color={theme.primary} /> : null}
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={
              <Text style={[styles.empty, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>
                No other account yet. Add one to move money between accounts.
              </Text>
            }
          />
          <TouchableOpacity
            style={styles.manage}
            onPress={() => {
              onClose();
              onManage();
            }}
            accessibilityRole="button"
          >
            <Ionicons name="add-circle-outline" size={18} color={theme.primary} />
            <Text style={[styles.manageText, { color: theme.primary, fontSize: theme.scaleFont(14) }]}>
              Add or edit accounts
            </Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, maxHeight: '70%' },
  title: { fontSize: 16, fontWeight: '700', marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 8 },
  name: { flex: 1, fontSize: 15, fontWeight: '600' },
  balance: { fontSize: 13, fontWeight: '600' },
  empty: { fontSize: 13, textAlign: 'center', paddingVertical: 12 },
  manage: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 44, marginTop: 4 },
  manageText: { fontSize: 14, fontWeight: '700' },
});
