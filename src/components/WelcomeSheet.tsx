import React, { useState } from 'react';
import {
  ActivityIndicator,
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
import Ionicons from '@expo/vector-icons/Ionicons';
import * as DocumentPicker from 'expo-document-picker';

import {
  formatAmountForInput,
  formatAmountInput,
  isAmountWithinRange,
  parseSignedAmount,
} from '../features/transactions/amount';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import {
  BACKUP_PICKER_MIME_TYPES,
  isLikelyBackupFile,
  restoreBackupFile,
} from '../services/backup';
import { syncDailyReminder } from '../services/notifications';
import { getErrorMessage } from '../services/ai/localInferenceTypes';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTransactionStore } from '../store/useTransactionStore';
import { useAppTheme } from '../theme/useAppTheme';

const WELCOME_CURRENCY_OPTIONS = ['IDR', 'USD', 'EUR', 'GBP', 'SGD', 'JPY'] as const;

interface WelcomeSheetProps {
  visible: boolean;
}

export const WelcomeSheet: React.FC<WelcomeSheetProps> = ({ visible }) => {
  const theme = useAppTheme();
  const insets = useSafeInsets();

  const currentCurrency = useSettingsStore((s) => s.currencyCode);
  const setCurrencyCode = useSettingsStore((s) => s.setCurrencyCode);
  const setHasCompletedOnboarding = useSettingsStore((s) => s.setHasCompletedOnboarding);
  const wallets = useTransactionStore((s) => s.wallets);
  const updateWallet = useTransactionStore((s) => s.updateWallet);

  const [selectedCurrency, setSelectedCurrency] = useState(currentCurrency || 'IDR');
  const [startingBalance, setStartingBalance] = useState('');
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const defaultWallet = wallets.find((w) => w.isActive) ?? wallets[0] ?? null;

  const handleSelectCurrency = (code: string) => {
    setSelectedCurrency(code);
    if (startingBalance.trim()) {
      const parsed = Math.abs(parseSignedAmount(startingBalance, undefined, selectedCurrency));
      setStartingBalance(parsed > 0 ? formatAmountForInput(parsed, code) : '');
    }
    setBalanceError(null);
  };

  const handleBalanceChange = (text: string) => {
    const formatted = formatAmountInput(text, selectedCurrency);
    setStartingBalance(formatted);
    if (!text.trim()) {
      setBalanceError(null);
      return;
    }
    const parsed = Math.abs(parseSignedAmount(text, undefined, selectedCurrency));
    setBalanceError(!isAmountWithinRange(parsed) ? 'Amount is too large' : null);
  };

  const handleSkip = async () => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      await setHasCompletedOnboarding(true);
    } finally {
      setIsBusy(false);
    }
  };

  const handleComplete = async () => {
    if (isBusy) return;
    const trimmed = startingBalance.trim();
    const numericBalance = trimmed ? Math.abs(parseSignedAmount(trimmed, undefined, selectedCurrency)) : 0;
    if (trimmed && !isAmountWithinRange(numericBalance)) {
      setBalanceError('Amount is too large');
      return;
    }

    setIsBusy(true);
    try {
      await setCurrencyCode(selectedCurrency);
      if (defaultWallet && numericBalance > 0) {
        updateWallet(defaultWallet.id, { initialBalance: numericBalance });
      }
      await setHasCompletedOnboarding(true);
    } catch (error) {
      Alert.alert('Setup Failed', getErrorMessage(error, 'Could not save your setup choices.'));
    } finally {
      setIsBusy(false);
    }
  };

  const runRestoreFromWelcome = async (uri: string) => {
    setIsBusy(true);
    try {
      const { transactions } = await restoreBackupFile(uri);
      await useSettingsStore.getState().loadSettings();
      const txStore = useTransactionStore.getState();
      txStore.invalidateData?.();
      await Promise.all([txStore.fetchTransactions(), txStore.fetchCategories()]);
      await txStore.fetchBudgets();

      const restoredSettings = useSettingsStore.getState();
      try {
        await syncDailyReminder(restoredSettings.dailyReminderEnabled, restoredSettings.dailyReminderTime);
      } catch {
        // Non-blocking notification sync after restore
      }
      await useSettingsStore.getState().setHasCompletedOnboarding(true);
      Alert.alert('Backup restored', `${transactions} transaction${transactions === 1 ? '' : 's'} restored.`);
    } catch (error) {
      Alert.alert('Restore failed', getErrorMessage(error, 'Could not read the backup file.'));
    } finally {
      setIsBusy(false);
    }
  };

  const handleRestoreBackup = async () => {
    if (isBusy) return;
    let picked: DocumentPicker.DocumentPickerResult;
    try {
      picked = await DocumentPicker.getDocumentAsync({
        type: BACKUP_PICKER_MIME_TYPES,
        copyToCacheDirectory: true,
        multiple: false,
      });
    } catch (error) {
      Alert.alert('Could not open file picker', getErrorMessage(error, 'Unable to open your files to select a backup.'));
      return;
    }
    if (picked.canceled || !picked.assets?.[0]?.uri) return;
    const asset = picked.assets[0];
    if (!isLikelyBackupFile(asset.name)) {
      Alert.alert('Not a backup file', 'Please pick a Silo backup (.db) file.');
      return;
    }

    Alert.alert(
      'Replace all data?',
      `Restore from "${asset.name || 'selected backup'}"? Any data currently on this phone will be replaced.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Restore', style: 'destructive', onPress: () => void runRestoreFromWelcome(asset.uri) },
      ],
    );
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => void handleSkip()}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View
          testID="welcome-sheet"
          style={[
            styles.sheet,
            {
              backgroundColor: theme.surface,
              borderColor: theme.border,
              paddingBottom: getBottomInsetPadding(insets.bottom, 20),
            },
          ]}
        >
          <ScrollView bounces={false} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <View style={styles.headerRow}>
              <View style={[styles.badgeIcon, { backgroundColor: theme.primaryMuted }]}>
                <Ionicons name="wallet-outline" size={22} color={theme.primary} />
              </View>
              <View style={styles.headerCopy}>
                <Text style={[styles.title, { color: theme.text, fontSize: theme.scaleFont(20) }]}>
                  Welcome to Silo
                </Text>
                <Text style={[styles.subtitle, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>
                  Private, offline money tracking. Set your basics or skip for now.
                </Text>
              </View>
              <TouchableOpacity
                style={styles.skipBtn}
                onPress={() => void handleSkip()}
                disabled={isBusy}
                accessibilityRole="button"
                accessibilityLabel="Skip welcome setup"
              >
                <Text style={[styles.skipText, { color: theme.textMuted, fontSize: theme.scaleFont(14) }]}>
                  Skip
                </Text>
              </TouchableOpacity>
            </View>

            <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(13) }]}>Currency</Text>
            <View style={styles.chipRow}>
              {WELCOME_CURRENCY_OPTIONS.map((code) => {
                const selected = selectedCurrency === code;
                return (
                  <TouchableOpacity
                    key={code}
                    style={[
                      styles.chip,
                      {
                        backgroundColor: selected ? theme.primary : theme.background,
                        borderColor: selected ? theme.primary : theme.border,
                      },
                    ]}
                    onPress={() => handleSelectCurrency(code)}
                    accessibilityRole="button"
                    accessibilityLabel={`Welcome currency ${code}`}
                    accessibilityState={{ selected }}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        { color: selected ? theme.onPrimary : theme.text, fontSize: theme.scaleFont(13) },
                      ]}
                    >
                      {code}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(13) }]}>
              Starting balance ({defaultWallet?.name ?? 'Main Wallet'})
            </Text>
            <View
              style={[
                styles.inputWrap,
                {
                  backgroundColor: theme.background,
                  borderColor: balanceError ? theme.expense : theme.border,
                },
              ]}
            >
              <Text style={[styles.currencyPrefix, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>
                {selectedCurrency}
              </Text>
              <TextInput
                style={[styles.balanceInput, { color: theme.text, fontSize: theme.scaleFont(16) }]}
                value={startingBalance}
                onChangeText={handleBalanceChange}
                placeholder="0"
                placeholderTextColor={theme.textMuted}
                keyboardType={Platform.OS === 'ios' ? 'decimal-pad' : 'numeric'}
                accessibilityLabel="Starting balance"
              />
            </View>
            {balanceError ? (
              <Text style={[styles.errorText, { color: theme.expense, fontSize: theme.scaleFont(12) }]}>
                {balanceError}
              </Text>
            ) : (
              <Text style={[styles.helperText, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
                Optional — you can add or edit accounts anytime.
              </Text>
            )}

            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: theme.primary, opacity: isBusy ? 0.7 : 1 }]}
              onPress={() => void handleComplete()}
              disabled={isBusy}
              accessibilityRole="button"
              accessibilityLabel="Complete welcome setup"
            >
              {isBusy ? (
                <ActivityIndicator color={theme.onPrimary} />
              ) : (
                <Text style={[styles.primaryBtnText, { color: theme.onPrimary, fontSize: theme.scaleFont(15) }]}>
                  Get started
                </Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.restoreBtn, { borderColor: theme.border, backgroundColor: theme.background }]}
              onPress={() => void handleRestoreBackup()}
              disabled={isBusy}
              accessibilityRole="button"
              accessibilityLabel="Restore from a backup"
            >
              <Ionicons name="cloud-download-outline" size={18} color={theme.primary} />
              <Text style={[styles.restoreBtnText, { color: theme.primary, fontSize: theme.scaleFont(14) }]}>
                Restore from a backup
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.52)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingTop: 18,
    maxHeight: '88%',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 16,
  },
  badgeIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCopy: {
    flex: 1,
  },
  title: {
    fontWeight: '800',
  },
  subtitle: {
    marginTop: 2,
    lineHeight: 18,
  },
  skipBtn: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  skipText: {
    fontWeight: '700',
  },
  label: {
    fontWeight: '700',
    marginBottom: 8,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  chip: {
    minHeight: 44,
    minWidth: 64,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: {
    fontWeight: '700',
  },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 50,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
  },
  currencyPrefix: {
    fontWeight: '700',
    marginRight: 10,
  },
  balanceInput: {
    flex: 1,
    minHeight: 46,
    fontWeight: '700',
  },
  helperText: {
    marginTop: 6,
    marginBottom: 16,
  },
  errorText: {
    marginTop: 6,
    marginBottom: 16,
    fontWeight: '600',
  },
  primaryBtn: {
    minHeight: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: {
    fontWeight: '800',
  },
  restoreBtn: {
    marginTop: 10,
    minHeight: 46,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  restoreBtnText: {
    fontWeight: '700',
  },
});
