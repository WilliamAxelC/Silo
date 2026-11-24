import React, { useEffect, useState } from 'react';
import {
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

import { inferCountryCodeFromCurrency } from '../features/splits/messaging';
import { useSplitsStore } from '../features/splits/store';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import { useSettingsStore } from '../store/useSettingsStore';
import { useAppTheme } from '../theme/useAppTheme';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export const PaymentDetailsModal = ({ visible, onClose }: Props) => {
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const homeCurrency = useSettingsStore((s) => s.currencyCode);
  const paymentDetails = useSplitsStore((s) => s.paymentDetails);
  const defaultCountryCode = useSplitsStore((s) => s.defaultCountryCode);
  const setPaymentDetails = useSplitsStore((s) => s.setPaymentDetails);
  const setDefaultCountryCode = useSplitsStore((s) => s.setDefaultCountryCode);

  const [detailsText, setDetailsText] = useState('');
  const [countryText, setCountryText] = useState('');

  const inferredCode = inferCountryCodeFromCurrency(homeCurrency);

  useEffect(() => {
    if (visible) {
      useSplitsStore.getState().ensureLoaded();
      setDetailsText(paymentDetails);
      setCountryText(defaultCountryCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const handleSave = () => {
    setPaymentDetails(detailsText);
    setDefaultCountryCode(countryText);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          activeOpacity={1}
          accessible={false}
          onPress={onClose}
        />
        <View
          testID="payment-details-sheet"
          style={[
            styles.sheet,
            { backgroundColor: theme.surface, paddingBottom: getBottomInsetPadding(insets.bottom, 18) },
          ]}
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.text, fontSize: theme.scaleFont(16) }]}>
              Payment & Sharing Settings
            </Text>
            <TouchableOpacity
              style={styles.closeBtn}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close payment details"
            >
              <Ionicons name="close" size={22} color={theme.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(13) }]}>
              Saved payment details
            </Text>
            <Text style={[styles.hint, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
              Appended automatically to WhatsApp and Share Intent bill messages.
            </Text>
            <TextInput
              style={[
                styles.multilineInput,
                {
                  backgroundColor: theme.background,
                  borderColor: theme.border,
                  color: theme.text,
                  fontSize: theme.scaleFont(14),
                },
              ]}
              value={detailsText}
              onChangeText={setDetailsText}
              placeholder={'e.g. BCA 1234567890 a.n. Your Name\nGoPay / OVO 0812-3456-7890'}
              placeholderTextColor={theme.textMuted}
              multiline
              textAlignVertical="top"
              accessibilityLabel="Saved payment details"
            />

            <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(13), marginTop: 14 }]}>
              Default WhatsApp country code
            </Text>
            <Text style={[styles.hint, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
              Local numbers starting with 0 (e.g. 0812…) convert using +{countryText.trim() || inferredCode}. Leave blank to use +{inferredCode} (from {homeCurrency}).
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: theme.background,
                  borderColor: theme.border,
                  color: theme.text,
                  fontSize: theme.scaleFont(14),
                },
              ]}
              value={countryText}
              onChangeText={(t) => setCountryText(t.replace(/\D/g, '').slice(0, 4))}
              placeholder={inferredCode}
              placeholderTextColor={theme.textMuted}
              keyboardType="number-pad"
              accessibilityLabel="Default WhatsApp country code"
            />
          </ScrollView>

          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.cancelBtn, { borderColor: theme.border }]}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <Text style={{ color: theme.textMuted, fontWeight: '600', fontSize: theme.scaleFont(14) }}>
                Cancel
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.saveBtn, { backgroundColor: theme.primary }]}
              onPress={handleSave}
              accessibilityRole="button"
              accessibilityLabel="Save payment details"
            >
              <Text style={{ color: theme.onPrimary, fontWeight: '700', fontSize: theme.scaleFont(14) }}>
                Save
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, maxHeight: '88%' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  title: { fontWeight: '700' },
  closeBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  label: { fontWeight: '700', marginBottom: 4 },
  hint: { lineHeight: 17, marginBottom: 8 },
  multilineInput: { borderWidth: 1, borderRadius: 10, padding: 12, minHeight: 96 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 46 },
  footer: { flexDirection: 'row', gap: 10, marginTop: 16 },
  cancelBtn: { flex: 1, minHeight: 48, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  saveBtn: { flex: 2, minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
