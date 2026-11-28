import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import { useAppTheme } from '../theme/useAppTheme';
import { requestAndLoadDeviceContacts, type DeviceContactCandidate } from '../services/contactsImport';
import { useSplitsStore } from '../features/splits/store';
import type { SiloContact } from '../features/splits/types';
import { KeyboardSheet } from './KeyboardSheet';
import { SHEET_WIDTH } from '../theme/layout';

interface Props {
  visible: boolean;
  mode: 'pick' | 'manage';
  selectedContactIds?: number[];
  onConfirmSelection?: (contacts: SiloContact[]) => void;
  onClose: () => void;
}

function normalizePhoneDigits(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '');
}

export const ContactsPickerModal = ({
  visible,
  mode,
  selectedContactIds = [],
  onConfirmSelection,
  onClose,
}: Props) => {
  const theme = useAppTheme();
  const insets = useSafeInsets();

  const contacts = useSplitsStore((s) => s.contacts);
  const addContact = useSplitsStore((s) => s.addContact);
  const updateContact = useSplitsStore((s) => s.updateContact);
  const deleteContact = useSplitsStore((s) => s.deleteContact);
  const importDeviceContacts = useSplitsStore((s) => s.importDeviceContacts);

  const [step, setStep] = useState<'silo' | 'device'>('silo');
  const [search, setSearch] = useState('');
  const [pickedIds, setPickedIds] = useState<number[]>(selectedContactIds);

  const [manualFormOpen, setManualFormOpen] = useState(false);
  const [editingContactId, setEditingContactId] = useState<number | null>(null);
  const [manualName, setManualName] = useState('');
  const [manualPhone, setManualPhone] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);

  const [loadingDevice, setLoadingDevice] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [deviceContacts, setDeviceContacts] = useState<DeviceContactCandidate[]>([]);
  const [deviceSearch, setDeviceSearch] = useState('');
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);

  React.useEffect(() => {
    if (visible) {
      useSplitsStore.getState().ensureLoaded();
      setPickedIds(selectedContactIds);
      setStep('silo');
      setSearch('');
      setDeviceSearch('');
      setSelectedDeviceIds([]);
      setManualFormOpen(false);
      setEditingContactId(null);
      setManualName('');
      setManualPhone('');
      setManualError(null);
      setPermissionDenied(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const filteredContacts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.phone ?? '').toLowerCase().includes(q)
    );
  }, [contacts, search]);

  const knownDeviceKeys = useMemo(() => {
    const deviceIdSet = new Set(contacts.map((c) => c.deviceContactId).filter((v): v is string => Boolean(v)));
    const namePhoneSet = new Set(
      contacts.map((c) => `${c.name.trim().toLowerCase()}|${normalizePhoneDigits(c.phone)}`)
    );
    return { deviceIdSet, namePhoneSet };
  }, [contacts]);

  const filteredDeviceContacts = useMemo(() => {
    const q = deviceSearch.trim().toLowerCase();
    if (!q) return deviceContacts;
    return deviceContacts.filter(
      (c) => c.name.toLowerCase().includes(q) || c.phone.toLowerCase().includes(q)
    );
  }, [deviceContacts, deviceSearch]);

  const togglePickedContact = (id: number) => {
    setPickedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const toggleDeviceContact = (deviceId: string) => {
    setSelectedDeviceIds((prev) =>
      prev.includes(deviceId) ? prev.filter((item) => item !== deviceId) : [...prev, deviceId]
    );
  };

  const handleOpenManualForm = (contact?: SiloContact) => {
    setManualError(null);
    if (contact) {
      setEditingContactId(contact.id);
      setManualName(contact.name);
      setManualPhone(contact.phone ?? '');
    } else {
      setEditingContactId(null);
      setManualName('');
      setManualPhone('');
    }
    setManualFormOpen(true);
  };

  const handleSaveManual = () => {
    if (!manualName.trim()) {
      setManualError('Enter a name.');
      return;
    }
    if (editingContactId != null) {
      updateContact(editingContactId, { name: manualName, phone: manualPhone });
    } else {
      const created = addContact({ name: manualName, phone: manualPhone });
      if (created && mode === 'pick') {
        setPickedIds((prev) => (prev.includes(created.id) ? prev : [...prev, created.id]));
      }
    }
    setManualFormOpen(false);
    setEditingContactId(null);
    setManualName('');
    setManualPhone('');
    setManualError(null);
  };

  const handleDeleteContact = (contact: SiloContact) => {
    Alert.alert('Remove contact?', `Remove ${contact.name} from Silo contacts? Existing bills keep their name.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          deleteContact(contact.id);
          setPickedIds((prev) => prev.filter((id) => id !== contact.id));
        },
      },
    ]);
  };

  const handleStartImport = async () => {
    setLoadingDevice(true);
    setPermissionDenied(false);
    try {
      const res = await requestAndLoadDeviceContacts();
      if (res.status === 'denied') {
        setPermissionDenied(true);
        return;
      }
      setDeviceContacts(res.contacts);
      setSelectedDeviceIds([]);
      setDeviceSearch('');
      setStep('device');
    } catch {
      Alert.alert('Contacts unavailable', 'Could not read contacts from your phone.');
    } finally {
      setLoadingDevice(false);
    }
  };

  const handleImportSelected = () => {
    const selectedSet = new Set(selectedDeviceIds);
    const chosen = deviceContacts.filter((c) => selectedSet.has(c.deviceContactId));
    if (chosen.length === 0) return;

    const beforeIds = new Set(useSplitsStore.getState().contacts.map((c) => c.id));
    importDeviceContacts(chosen);
    const afterContacts = useSplitsStore.getState().contacts;
    if (mode === 'pick') {
      const newlyAddedIds = afterContacts.filter((c) => !beforeIds.has(c.id)).map((c) => c.id);
      const matchedIds = afterContacts
        .filter((c) => c.deviceContactId && selectedSet.has(c.deviceContactId))
        .map((c) => c.id);
      const merged = new Set([...pickedIds, ...newlyAddedIds, ...matchedIds]);
      setPickedIds(Array.from(merged));
    }
    setStep('silo');
  };

  const handleConfirmPick = () => {
    const selectedSet = new Set(pickedIds);
    const chosen = contacts.filter((c) => selectedSet.has(c.id));
    onConfirmSelection?.(chosen);
    onClose();
  };

  return (
    <Modal statusBarTranslucent navigationBarTranslucent visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardSheet style={styles.overlay}>
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          activeOpacity={1}
          accessible={false}
          onPress={onClose}
        />
        <View
          testID="contacts-picker-sheet"
          style={[
            styles.sheet,
            { backgroundColor: theme.surface, paddingBottom: getBottomInsetPadding(insets.bottom, 18) },
          ]}
        >
          <View style={styles.header}>
            {step === 'device' ? (
              <TouchableOpacity
                style={styles.headerIconBtn}
                onPress={() => setStep('silo')}
                accessibilityRole="button"
                accessibilityLabel="Back to Silo contacts"
              >
                <Ionicons name="chevron-back" size={22} color={theme.text} />
              </TouchableOpacity>
            ) : null}
            <Text style={[styles.title, { color: theme.text, fontSize: theme.scaleFont(16) }]}>
              {step === 'device'
                ? 'Import Phone Contacts'
                : mode === 'pick'
                  ? 'Select People'
                  : 'Silo Contacts'}
            </Text>
            <TouchableOpacity
              style={styles.headerIconBtn}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close contacts modal"
            >
              <Ionicons name="close" size={22} color={theme.textMuted} />
            </TouchableOpacity>
          </View>

          {step === 'silo' ? (
            <>
              <View style={styles.actionsRow}>
                <TouchableOpacity
                  style={[styles.actionBtn, { borderColor: theme.primary, backgroundColor: theme.primaryMuted }]}
                  onPress={() => void handleStartImport()}
                  disabled={loadingDevice}
                  accessibilityRole="button"
                  accessibilityLabel="Import from phone contacts"
                >
                  {loadingDevice ? (
                    <ActivityIndicator size="small" color={theme.primary} />
                  ) : (
                    <Ionicons name="person-add-outline" size={16} color={theme.primary} />
                  )}
                  <Text style={[styles.actionBtnText, { color: theme.primary, fontSize: theme.scaleFont(13) }]}>
                    Import contacts
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.actionBtn, { borderColor: theme.border, backgroundColor: theme.background }]}
                  onPress={() => handleOpenManualForm()}
                  accessibilityRole="button"
                  accessibilityLabel="Add contact manually"
                >
                  <Ionicons name="add" size={18} color={theme.text} />
                  <Text style={[styles.actionBtnText, { color: theme.text, fontSize: theme.scaleFont(13) }]}>
                    Add manually
                  </Text>
                </TouchableOpacity>
              </View>

              {permissionDenied ? (
                <View style={[styles.noticeCard, { backgroundColor: theme.primaryMuted, borderColor: theme.border }]}>
                  <Text style={[styles.noticeText, { color: theme.text, fontSize: theme.scaleFont(12) }]}>
                    Contacts permission was denied. You can still add people manually above, or enable Contacts in Settings.
                  </Text>
                  <TouchableOpacity
                    onPress={() => void Linking.openSettings()}
                    accessibilityRole="button"
                    accessibilityLabel="Open phone settings"
                  >
                    <Text style={{ color: theme.primary, fontWeight: '700', fontSize: theme.scaleFont(12) }}>
                      Open Settings
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : null}

              {manualFormOpen ? (
                <View style={[styles.manualCard, { backgroundColor: theme.background, borderColor: theme.border }]}>
                  <Text style={[styles.manualTitle, { color: theme.text, fontSize: theme.scaleFont(13) }]}>
                    {editingContactId != null ? 'Edit contact' : 'New contact'}
                  </Text>
                  <TextInput
                    style={[
                      styles.input,
                      {
                        backgroundColor: theme.surface,
                        borderColor: manualError ? theme.expense : theme.border,
                        color: theme.text,
                        fontSize: theme.scaleFont(14),
                      },
                    ]}
                    value={manualName}
                    onChangeText={(text) => {
                      setManualName(text);
                      if (manualError) setManualError(null);
                    }}
                    placeholder="Name *"
                    placeholderTextColor={theme.textMuted}
                    accessibilityLabel="Contact name"
                  />
                  <TextInput
                    style={[
                      styles.input,
                      {
                        backgroundColor: theme.surface,
                        borderColor: theme.border,
                        color: theme.text,
                        fontSize: theme.scaleFont(14),
                      },
                    ]}
                    value={manualPhone}
                    onChangeText={setManualPhone}
                    placeholder="Phone / WhatsApp (optional, e.g. 0812...)"
                    placeholderTextColor={theme.textMuted}
                    keyboardType="phone-pad"
                    accessibilityLabel="Contact phone"
                  />
                  {manualError ? (
                    <Text style={{ color: theme.expense, fontSize: theme.scaleFont(12) }}>{manualError}</Text>
                  ) : null}
                  <View style={styles.manualActions}>
                    <TouchableOpacity
                      style={[styles.smallBtn, { borderColor: theme.border }]}
                      onPress={() => setManualFormOpen(false)}
                      accessibilityRole="button"
                      accessibilityLabel="Cancel manual contact"
                    >
                      <Text style={{ color: theme.textMuted, fontWeight: '600', fontSize: theme.scaleFont(13) }}>
                        Cancel
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.smallBtn, { backgroundColor: theme.primary, borderColor: theme.primary }]}
                      onPress={handleSaveManual}
                      accessibilityRole="button"
                      accessibilityLabel="Save contact"
                    >
                      <Text style={{ color: theme.onPrimary, fontWeight: '700', fontSize: theme.scaleFont(13) }}>
                        Save
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : null}

              <TextInput
                style={[
                  styles.searchInput,
                  {
                    backgroundColor: theme.background,
                    borderColor: theme.border,
                    color: theme.text,
                    fontSize: theme.scaleFont(14),
                  },
                ]}
                value={search}
                onChangeText={setSearch}
                placeholder="Search Silo contacts"
                placeholderTextColor={theme.textMuted}
                accessibilityLabel="Search Silo contacts"
              />

              <FlatList
                data={filteredContacts}
                keyExtractor={(item) => String(item.id)}
                keyboardShouldPersistTaps="handled"
                style={styles.list}
                renderItem={({ item }) => {
                  const selected = pickedIds.includes(item.id);
                  return (
                    <View style={[styles.row, { borderColor: selected && mode === 'pick' ? theme.primary : theme.border }]}>
                      <TouchableOpacity
                        style={styles.rowMain}
                        onPress={() => (mode === 'pick' ? togglePickedContact(item.id) : handleOpenManualForm(item))}
                        accessibilityRole="button"
                        accessibilityState={mode === 'pick' ? { selected } : undefined}
                        accessibilityLabel={item.phone ? `${item.name}, ${item.phone}` : item.name}
                      >
                        {mode === 'pick' ? (
                          <Ionicons
                            name={selected ? 'checkbox' : 'square-outline'}
                            size={22}
                            color={selected ? theme.primary : theme.textMuted}
                          />
                        ) : (
                          <Ionicons name="person-circle-outline" size={24} color={theme.primary} />
                        )}
                        <View style={styles.rowInfo}>
                          <Text style={[styles.rowName, { color: theme.text, fontSize: theme.scaleFont(14) }]} numberOfLines={1}>
                            {item.name}
                          </Text>
                          <Text style={[styles.rowSub, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]} numberOfLines={1}>
                            {item.phone || 'No phone saved'}
                          </Text>
                        </View>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={styles.rowIconBtn}
                        onPress={() => handleOpenManualForm(item)}
                        accessibilityRole="button"
                        accessibilityLabel={`Edit ${item.name}`}
                      >
                        <Ionicons name="create-outline" size={18} color={theme.textMuted} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.rowIconBtn}
                        onPress={() => handleDeleteContact(item)}
                        accessibilityRole="button"
                        accessibilityLabel={`Delete ${item.name}`}
                      >
                        <Ionicons name="trash-outline" size={18} color={theme.expense} />
                      </TouchableOpacity>
                    </View>
                  );
                }}
                ListEmptyComponent={
                  <Text style={[styles.empty, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>
                    {contacts.length === 0
                      ? 'No contacts yet. Import from your phone or add someone manually.'
                      : 'No matching contacts.'}
                  </Text>
                }
              />

              {mode === 'pick' ? (
                <TouchableOpacity
                  style={[styles.primaryBtn, { backgroundColor: theme.primary }]}
                  onPress={handleConfirmPick}
                  accessibilityRole="button"
                  accessibilityLabel={`Confirm ${pickedIds.length} selected contacts`}
                >
                  <Text style={[styles.primaryBtnText, { color: theme.onPrimary, fontSize: theme.scaleFont(15) }]}>
                    Done ({pickedIds.length} selected)
                  </Text>
                </TouchableOpacity>
              ) : null}
            </>
          ) : (
            <>
              <Text style={[styles.deviceHint, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
                Pick contacts to copy into Silo. Only selected contacts are imported and they stay on your phone.
              </Text>
              <TextInput
                style={[
                  styles.searchInput,
                  {
                    backgroundColor: theme.background,
                    borderColor: theme.border,
                    color: theme.text,
                    fontSize: theme.scaleFont(14),
                  },
                ]}
                value={deviceSearch}
                onChangeText={setDeviceSearch}
                placeholder="Search phone contacts"
                placeholderTextColor={theme.textMuted}
                accessibilityLabel="Search phone contacts"
              />

              <FlatList
                data={filteredDeviceContacts}
                keyExtractor={(item) => item.deviceContactId}
                keyboardShouldPersistTaps="handled"
                style={styles.list}
                renderItem={({ item }) => {
                  const alreadyImported =
                    knownDeviceKeys.deviceIdSet.has(item.deviceContactId) ||
                    knownDeviceKeys.namePhoneSet.has(
                      `${item.name.trim().toLowerCase()}|${normalizePhoneDigits(item.phone)}`
                    );
                  const selected = selectedDeviceIds.includes(item.deviceContactId);
                  return (
                    <TouchableOpacity
                      style={[
                        styles.row,
                        {
                          borderColor: selected ? theme.primary : theme.border,
                          opacity: alreadyImported ? 0.6 : 1,
                        },
                      ]}
                      disabled={alreadyImported}
                      onPress={() => toggleDeviceContact(item.deviceContactId)}
                      accessibilityRole="button"
                      accessibilityState={{ selected, disabled: alreadyImported }}
                      accessibilityLabel={`${item.name}${alreadyImported ? ', already imported' : ''}`}
                    >
                      <Ionicons
                        name={alreadyImported || selected ? 'checkbox' : 'square-outline'}
                        size={22}
                        color={alreadyImported ? theme.textMuted : selected ? theme.primary : theme.textMuted}
                      />
                      <View style={styles.rowInfo}>
                        <Text style={[styles.rowName, { color: theme.text, fontSize: theme.scaleFont(14) }]} numberOfLines={1}>
                          {item.name}
                        </Text>
                        <Text style={[styles.rowSub, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]} numberOfLines={1}>
                          {item.phone || 'No phone number'}
                        </Text>
                      </View>
                      {alreadyImported ? (
                        <Text style={[styles.importedBadge, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
                          Imported
                        </Text>
                      ) : null}
                    </TouchableOpacity>
                  );
                }}
                ListEmptyComponent={
                  <Text style={[styles.empty, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>
                    No phone contacts found.
                  </Text>
                }
              />

              <TouchableOpacity
                style={[
                  styles.primaryBtn,
                  { backgroundColor: selectedDeviceIds.length > 0 ? theme.primary : theme.border },
                ]}
                disabled={selectedDeviceIds.length === 0}
                onPress={handleImportSelected}
                accessibilityRole="button"
                accessibilityLabel={`Import ${selectedDeviceIds.length} selected contacts`}
              >
                <Text
                  style={[
                    styles.primaryBtnText,
                    { color: selectedDeviceIds.length > 0 ? theme.onPrimary : theme.textMuted, fontSize: theme.scaleFont(15) },
                  ]}
                >
                  Import selected ({selectedDeviceIds.length})
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </KeyboardSheet>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { ...SHEET_WIDTH, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, maxHeight: '88%' },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 6 },
  headerIconBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontWeight: '700' },
  actionsRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
  },
  actionBtnText: { fontWeight: '700' },
  noticeCard: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
    gap: 6,
  },
  noticeText: { lineHeight: 17 },
  manualCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    gap: 8,
  },
  manualTitle: { fontWeight: '700' },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    minHeight: 44,
  },
  manualActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 2 },
  smallBtn: {
    minHeight: 40,
    minWidth: 78,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    minHeight: 44,
    marginBottom: 10,
  },
  list: { maxHeight: 340 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 8,
  },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 36 },
  rowInfo: { flex: 1 },
  rowName: { fontWeight: '600' },
  rowSub: { marginTop: 1 },
  rowIconBtn: { minWidth: 36, minHeight: 36, alignItems: 'center', justifyContent: 'center' },
  importedBadge: { fontWeight: '600' },
  deviceHint: { marginBottom: 10, lineHeight: 17 },
  empty: { textAlign: 'center', paddingVertical: 20 },
  primaryBtn: {
    minHeight: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
  },
  primaryBtnText: { fontWeight: '700' },
});
