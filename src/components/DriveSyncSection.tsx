import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Modal, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useAppTheme } from '../theme/useAppTheme';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import { connectDrive, disconnectDrive } from '../services/drive/googleAuth';
import {
  backupToDrive,
  downloadDriveBackup,
  listDriveBackups,
  offloadOldReceipts,
  setDriveAutoBackup,
  setOffloadMonths,
  useDriveStore,
} from '../services/drive/driveSync';
import type { DriveFile } from '../services/drive/driveApi';
import { getErrorMessage } from '../services/ai/localInferenceTypes';

const OFFLOAD_OPTIONS = [0, 3, 6, 12];

/** Settings > Data: optional Google Drive backups and moving old receipt photos off the phone. */
export function DriveSyncSection({ onRestoreFile, locale }: { onRestoreFile: (uri: string) => Promise<void>; locale: string }) {
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const { account, lastBackupAt, autoBackup, offloadMonths, refresh, lastError } = useDriveStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [backups, setBackups] = useState<DriveFile[] | null>(null);

  useEffect(() => refresh(), [refresh]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    useDriveStore.setState({ lastError: null });
    try {
      await fn();
    } catch (error) {
      Alert.alert('Google Drive', getErrorMessage(error, 'Something went wrong with Google Drive.'));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const text = { color: theme.text, fontSize: theme.scaleFont(14) };
  const sub = { color: theme.textMuted, fontSize: theme.scaleFont(12) };
  const when = lastBackupAt
    ? new Date(lastBackupAt).toLocaleString(locale, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    : 'not yet';

  if (!account) {
    return (
      <TouchableOpacity
        style={styles.row}
        onPress={() =>
          void run('connect', async () => {
            const email = await connectDrive();
            if (email) await backupToDrive();
          })
        }
        disabled={busy !== null}
        accessibilityRole="button"
        accessibilityLabel="Connect Google Drive"
        testID="drive-connect"
      >
        <View style={styles.left}>
          <Ionicons name="logo-google" size={18} color={theme.primary} />
          <View style={styles.textBlock}>
            <Text style={text}>Connect Google Drive</Text>
            <Text style={sub}>Daily backups to a Silo folder in your Drive, and optionally move old receipt photos there.</Text>
          </View>
        </View>
        {busy ? <ActivityIndicator color={theme.primary} /> : <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />}
      </TouchableOpacity>
    );
  }

  return (
    <View testID="drive-section">
      <View style={styles.row}>
        <View style={styles.left}>
          <Ionicons name="logo-google" size={18} color={theme.primary} />
          <View style={styles.textBlock}>
            <Text style={text}>Google Drive</Text>
            <Text style={sub}>{account}</Text>
          </View>
        </View>
        <TouchableOpacity
          style={styles.smallBtn}
          onPress={() =>
            Alert.alert('Disconnect Google Drive?', 'Silo stops syncing. Files already in your Drive stay there.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Disconnect', style: 'destructive', onPress: () => void run('disconnect', disconnectDrive) },
            ])
          }
          accessibilityRole="button"
          accessibilityLabel="Disconnect Google Drive"
        >
          <Text style={{ color: theme.expense, fontWeight: '700', fontSize: theme.scaleFont(13) }}>Disconnect</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.row}>
        <View style={styles.textBlock}>
          <Text style={text}>Daily backup to Drive</Text>
          <Text style={sub}>Last: {when}. The newest 30 are kept.</Text>
        </View>
        <Switch
          value={autoBackup}
          onValueChange={(v) => {
            setDriveAutoBackup(v);
            refresh();
          }}
          trackColor={{ true: theme.primary, false: theme.border }}
          accessibilityLabel="Daily backup to Drive"
        />
      </View>

      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.actionBtn, { borderColor: theme.primary }]}
          onPress={() => void run('backup', async () => void (await backupToDrive()))}
          disabled={busy !== null}
          accessibilityRole="button"
          accessibilityLabel="Back up to Drive now"
        >
          {busy === 'backup' ? (
            <ActivityIndicator color={theme.primary} />
          ) : (
            <Text style={{ color: theme.primary, fontWeight: '700', fontSize: theme.scaleFont(13) }}>Back up now</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, { borderColor: theme.border }]}
          onPress={() => void run('list', async () => setBackups(await listDriveBackups()))}
          disabled={busy !== null}
          accessibilityRole="button"
          accessibilityLabel="Restore from Drive"
        >
          {busy === 'list' ? (
            <ActivityIndicator color={theme.primary} />
          ) : (
            <Text style={{ color: theme.text, fontWeight: '700', fontSize: theme.scaleFont(13) }}>Restore from Drive</Text>
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.block}>
        <Text style={text}>Move receipt photos to Drive</Text>
        <Text style={sub}>Photos of older transactions move to Drive; a small preview stays and the full photo opens from Drive.</Text>
        <View style={styles.chips}>
          {OFFLOAD_OPTIONS.map((m) => {
            const selected = offloadMonths === m;
            return (
              <TouchableOpacity
                key={m}
                style={[styles.chip, { borderColor: selected ? theme.primary : theme.border, backgroundColor: selected ? theme.primary : theme.background }]}
                onPress={() => {
                  setOffloadMonths(m);
                  refresh();
                }}
                accessibilityRole="button"
                accessibilityLabel={m === 0 ? 'Keep all photos on the phone' : `Move photos older than ${m} months`}
                accessibilityState={{ selected }}
              >
                <Text style={{ color: selected ? theme.onPrimary : theme.text, fontWeight: '600', fontSize: theme.scaleFont(13) }}>
                  {m === 0 ? 'Off' : `Older than ${m} months`}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {offloadMonths > 0 ? (
          <TouchableOpacity
            style={[styles.actionBtn, { borderColor: theme.border, alignSelf: 'flex-start', marginTop: 8 }]}
            onPress={() =>
              void run('offload', async () => {
                const { moved, freedBytes } = await offloadOldReceipts(offloadMonths);
                Alert.alert(
                  'Receipt photos',
                  moved ? `${moved} photo${moved === 1 ? '' : 's'} moved to Drive, about ${Math.max(1, Math.round(freedBytes / 1048576))} MB freed.` : 'Nothing to move yet.'
                );
              })
            }
            disabled={busy !== null}
            accessibilityRole="button"
            accessibilityLabel="Move old receipt photos now"
          >
            {busy === 'offload' ? (
              <ActivityIndicator color={theme.primary} />
            ) : (
              <Text style={{ color: theme.text, fontWeight: '700', fontSize: theme.scaleFont(13) }}>Move now</Text>
            )}
          </TouchableOpacity>
        ) : null}
      </View>
      {lastError ? <Text style={[sub, styles.block, { color: theme.expense }]}>Last sync problem: {lastError}</Text> : null}

      <Modal visible={backups !== null} transparent animationType="slide" onRequestClose={() => setBackups(null)}>
        <View style={styles.overlay}>
          <View style={[styles.sheet, { backgroundColor: theme.surface, borderColor: theme.border, paddingBottom: getBottomInsetPadding(insets.bottom, 16) }]}>
            <Text style={{ color: theme.text, fontWeight: '800', fontSize: theme.scaleFont(17), marginBottom: 8 }}>Backups in Drive</Text>
            <ScrollView style={{ maxHeight: 360 }}>
              {(backups ?? []).length === 0 ? <Text style={sub}>No backups in Drive yet.</Text> : null}
              {(backups ?? []).map((b) => (
                <TouchableOpacity
                  key={b.id}
                  style={[styles.backupRow, { borderBottomColor: theme.border }]}
                  onPress={() =>
                    Alert.alert('Replace all data?', `Restore ${b.name}? Everything on this phone is replaced with it.`, [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Restore',
                        style: 'destructive',
                        onPress: () =>
                          void run('restore', async () => {
                            const uri = await downloadDriveBackup(b.id);
                            setBackups(null);
                            try {
                              await onRestoreFile(uri);
                            } finally {
                              await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
                            }
                          }),
                      },
                    ])
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`Restore ${b.name}`}
                >
                  <Text style={text}>{b.name.replace(/^silo-backup-|\.db$/g, '')}</Text>
                  <Text style={sub}>{b.size ? `${Math.max(1, Math.round(b.size / 1024))} KB` : ''}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity
              style={[styles.actionBtn, { borderColor: theme.border, marginTop: 12 }]}
              onPress={() => setBackups(null)}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Text style={{ color: theme.text, fontWeight: '700', fontSize: theme.scaleFont(14) }}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 56, paddingHorizontal: 14, paddingVertical: 10, gap: 10 },
  left: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  textBlock: { flex: 1, gap: 2 },
  smallBtn: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 8 },
  actions: { flexDirection: 'row', gap: 10, paddingHorizontal: 14, paddingBottom: 6 },
  actionBtn: { flex: 1, minHeight: 48, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  block: { paddingHorizontal: 14, paddingVertical: 8, gap: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  chip: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 12, minHeight: 44, justifyContent: 'center' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, padding: 18 },
  backupRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 52, borderBottomWidth: 1 },
});
