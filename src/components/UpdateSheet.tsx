import React, { useEffect } from 'react';
import { ActivityIndicator, AppState, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useAppTheme } from '../theme/useAppTheme';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import { useAppUpdateStore } from '../services/appUpdate';
import { getInstalledVersion } from '../services/updates';

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(0)} MB`;

/** Download, verify and install a new Silo version without leaving the app. Mounted once, app-wide. */
export function UpdateSheet() {
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const { status, progress, error, start, install, openPermissionSettings, cancel, sheet: manifest, closeSheet } = useAppUpdateStore();
  const installed = getInstalledVersion();

  // Coming back from Android's "Install unknown apps" screen: try the installer again.
  useEffect(() => {
    if (status !== 'needs-permission') return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') install();
    });
    return () => sub.remove();
  }, [status, install]);

  if (!manifest) return null;
  const busy = status === 'downloading' || status === 'verifying';
  const close = closeSheet;
  const body = { color: theme.text, fontSize: theme.scaleFont(14) };
  const muted = { color: theme.textMuted, fontSize: theme.scaleFont(13) };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={close}>
      <View style={styles.overlay}>
        <View
          style={[styles.sheet, { backgroundColor: theme.surface, borderColor: theme.border, paddingBottom: getBottomInsetPadding(insets.bottom, 18) }]}
          testID="update-sheet"
        >
          <View style={styles.head}>
            <Ionicons name="arrow-up-circle" size={26} color={theme.primary} />
            <Text style={{ color: theme.text, fontWeight: '800', fontSize: theme.scaleFont(18), flex: 1 }} accessibilityRole="header">
              Silo {manifest.version}
            </Text>
          </View>
          <Text style={muted}>
            You have {installed.version}.{manifest.apk ? ` Download: ${mb(manifest.apk.sizeBytes)}.` : ''}
          </Text>
          {manifest.notes?.length ? (
            <View style={styles.notes}>
              {manifest.notes.map((n) => (
                <Text key={n} style={body}>
                  • {n}
                </Text>
              ))}
            </View>
          ) : null}

          {busy ? (
            <View style={styles.progressWrap}>
              <View
                style={[styles.bar, { backgroundColor: theme.border }]}
                accessibilityRole="progressbar"
                accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
              >
                <View style={[styles.fill, { width: `${Math.round(progress * 100)}%`, backgroundColor: theme.primary }]} />
              </View>
              <Text style={muted}>{status === 'verifying' ? 'Checking the download…' : `Downloading… ${Math.round(progress * 100)}%`}</Text>
            </View>
          ) : null}

          {status === 'needs-permission' ? (
            <Text style={[body, styles.message]}>
              Android needs your OK once: allow Silo to install apps, then come back here. Silo only installs its own
              updates, checked against the published checksum.
            </Text>
          ) : null}
          {status === 'installing' ? (
            <Text style={[body, styles.message]}>Android's installer is open. Tap Update there. Your data stays as it is.</Text>
          ) : null}
          {status === 'error' && error ? (
            <Text accessibilityRole="alert" style={[{ color: theme.expense, fontSize: theme.scaleFont(14) }, styles.message]}>
              {error}
            </Text>
          ) : null}

          <View style={styles.buttons}>
            <TouchableOpacity
              style={[styles.btn, { borderColor: theme.border }]}
              onPress={busy ? () => void cancel() : close}
              accessibilityRole="button"
              accessibilityLabel={busy ? 'Cancel download' : 'Later'}
            >
              <Text style={{ color: theme.text, fontWeight: '700', fontSize: theme.scaleFont(14) }}>{busy ? 'Cancel' : 'Later'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: theme.primary, borderColor: theme.primary, opacity: busy ? 0.6 : 1 }]}
              disabled={busy}
              onPress={() => {
                if (status === 'needs-permission') openPermissionSettings();
                else if (status === 'installing') install();
                else void start(manifest);
              }}
              accessibilityRole="button"
              accessibilityLabel={
                status === 'needs-permission' ? 'Allow installing' : status === 'installing' ? 'Open installer again' : 'Update now'
              }
            >
              {busy ? (
                <ActivityIndicator color={theme.onPrimary} />
              ) : (
                <Text style={{ color: theme.onPrimary, fontWeight: '800', fontSize: theme.scaleFont(14) }}>
                  {status === 'needs-permission' ? 'Allow' : status === 'installing' ? 'Open installer' : status === 'error' ? 'Try again' : 'Update now'}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, padding: 18, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  notes: { gap: 4, marginTop: 6 },
  progressWrap: { gap: 6, marginTop: 8 },
  bar: { height: 8, borderRadius: 4, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4 },
  message: { marginTop: 8, lineHeight: 20 },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 14 },
  btn: { flex: 1, minHeight: 48, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
