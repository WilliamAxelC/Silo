import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';

import { useSettingsStore } from '../store/useSettingsStore';
import { useAppTheme } from '../theme/useAppTheme';

// Coming back within this window (share sheet, camera, scanning a stack of receipts) does not ask again.
export const RELOCK_AFTER_MS = 5 * 60_000;

export async function authenticateUser(promptMessage = 'Unlock Silo'): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({ promptMessage, disableDeviceFallback: false });
    return result.success;
  } catch {
    return false;
  }
}

/** True when the phone has a fingerprint/face or at least a screen lock PIN/pattern to verify with. */
export async function canUseAppLock(): Promise<boolean> {
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    return level !== LocalAuthentication.SecurityLevel.NONE;
  } catch {
    return false;
  }
}

/**
 * Covers the app until the user authenticates, when App Lock is on: at launch and after Silo has been
 * in the background for longer than RELOCK_AFTER_MS. The app underneath stays mounted.
 */
export const AppLockGate = ({ children }: { children: React.ReactNode }) => {
  const theme = useAppTheme();
  const isLoaded = useSettingsStore((s) => s.isLoaded);
  const enabled = useSettingsStore((s) => s.appLockEnabled);
  const [unlocked, setUnlocked] = useState(false);
  const backgroundedAt = useRef<number | null>(null);
  const prompting = useRef(false);

  const unlock = useCallback(async () => {
    if (prompting.current) return;
    prompting.current = true;
    const ok = await authenticateUser();
    prompting.current = false;
    if (ok) setUnlocked(true);
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        backgroundedAt.current = Date.now();
      } else if (state === 'active' && backgroundedAt.current !== null) {
        if (Date.now() - backgroundedAt.current > RELOCK_AFTER_MS) setUnlocked(false);
        backgroundedAt.current = null;
      }
    });
    return () => sub.remove();
  }, []);

  const locked = !isLoaded || (enabled && !unlocked);

  useEffect(() => {
    if (isLoaded && enabled && !unlocked) void unlock();
  }, [isLoaded, enabled, unlocked, unlock]);

  return (
    <View style={styles.fill}>
      {children}
      {locked ? (
        <View style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: theme.background }]}>
          {isLoaded ? (
            <>
              <Image source={require('../../assets/icon.png')} style={styles.logo} accessibilityIgnoresInvertColors />
              <Text style={[styles.title, { color: theme.text }]}>Silo is locked</Text>
              <TouchableOpacity
                style={[styles.button, { backgroundColor: theme.primary }]}
                onPress={unlock}
                accessibilityRole="button"
                accessibilityLabel="Unlock Silo"
              >
                <Text style={[styles.buttonText, { color: theme.onPrimary }]}>Unlock</Text>
              </TouchableOpacity>
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  fill: { flex: 1 },
  cover: { alignItems: 'center', justifyContent: 'center', gap: 16, zIndex: 100, elevation: 100 },
  logo: { width: 72, height: 72, borderRadius: 18 },
  title: { fontSize: 18, fontWeight: '700' },
  button: { borderRadius: 999, paddingHorizontal: 28, paddingVertical: 12 },
  buttonText: { fontSize: 15, fontWeight: '700' },
});
