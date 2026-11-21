import React from 'react';
import { AppState, Text } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

import { AppLockGate, RELOCK_AFTER_MS } from '../AppLockGate';
import { useSettingsStore } from '../../store/useSettingsStore';
import { db } from '../../db/index';

jest.mock('../../db/index', () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => Promise.resolve([])),
    })),
    delete: jest.fn(() => ({
      where: jest.fn(() => Promise.resolve()),
    })),
  },
}));
// No type declarations for react-test-renderer in this project; other screen tests require it the same way.
const ReactTestRenderer = require('react-test-renderer');
type Renderer = { root: any; toJSON: () => unknown; unmount: () => void };

const isLocked = (r: Renderer) => JSON.stringify(r.toJSON()).includes('Silo is locked');
const hasCoverOverlay = (r: Renderer) => {
  const json = r.toJSON() as { children?: any[] } | null;
  return Array.isArray(json?.children) && json.children.length > 1;
};

describe('AppLockGate', () => {
  let appStateListener: (state: string) => void;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_e, cb: any) => {
      appStateListener = cb;
      return { remove: jest.fn() } as any;
    });
  });

  it('shows the app without prompting when App Lock is off', async () => {
    useSettingsStore.setState({ isLoaded: true, appLockEnabled: false });
    let r!: Renderer;
    await ReactTestRenderer.act(async () => {
      r = ReactTestRenderer.create(<AppLockGate><Text>content</Text></AppLockGate>);
    });
    expect(isLocked(r)).toBe(false);
    expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();
    r.unmount();
  });

  it('stays locked until authentication succeeds, and relocks after a long time in the background', async () => {
    useSettingsStore.setState({ isLoaded: true, appLockEnabled: true });
    (LocalAuthentication.authenticateAsync as jest.Mock).mockResolvedValueOnce({ success: false });
    let r!: Renderer;
    await ReactTestRenderer.act(async () => {
      r = ReactTestRenderer.create(<AppLockGate><Text>content</Text></AppLockGate>);
    });
    expect(isLocked(r)).toBe(true);

    await ReactTestRenderer.act(async () => {
      await r.root.findByProps({ accessibilityLabel: 'Unlock Silo' }).props.onPress();
    });
    expect(isLocked(r)).toBe(false);

    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    await ReactTestRenderer.act(async () => appStateListener('background'));
    clock.mockReturnValue(now + 10_000);
    await ReactTestRenderer.act(async () => appStateListener('active'));
    expect(isLocked(r)).toBe(false);

    (LocalAuthentication.authenticateAsync as jest.Mock).mockResolvedValueOnce({ success: false });
    await ReactTestRenderer.act(async () => appStateListener('background'));
    clock.mockReturnValue(now + 10_000 + RELOCK_AFTER_MS + 1);
    await ReactTestRenderer.act(async () => appStateListener('active'));
    expect(isLocked(r)).toBe(true);
    clock.mockRestore();
    await ReactTestRenderer.act(async () => {
      r.unmount();
    });
  });

  it('unblocks immediately after SQLite settings load when App Lock is OFF even while SecureStore is pending', async () => {
    useSettingsStore.setState({ isLoaded: false, appLockEnabled: false });

    let resolveSecureA!: (v: string | null) => void;
    let resolveSecureB!: (v: string | null) => void;
    (SecureStore.getItemAsync as jest.Mock)
      .mockImplementationOnce(() => new Promise<string | null>((res) => { resolveSecureA = res; }))
      .mockImplementationOnce(() => new Promise<string | null>((res) => { resolveSecureB = res; }));
    (db.select as jest.Mock).mockReturnValueOnce({
      from: jest.fn(() => Promise.resolve([{ key: 'appLockEnabled', value: 'false' }])),
    });

    let r!: Renderer;
    await ReactTestRenderer.act(async () => {
      r = ReactTestRenderer.create(<AppLockGate><Text>secret data</Text></AppLockGate>);
    });
    // Still covered while SQLite has not loaded yet
    expect(hasCoverOverlay(r)).toBe(true);

    let loadPromise!: Promise<void>;
    await ReactTestRenderer.act(async () => {
      loadPromise = useSettingsStore.getState().loadSettings();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Unlocked immediately without waiting for SecureStore
    expect(hasCoverOverlay(r)).toBe(false);
    expect(isLocked(r)).toBe(false);
    expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();

    await ReactTestRenderer.act(async () => {
      resolveSecureA(null);
      resolveSecureB(null);
      await loadPromise;
      r.unmount();
    });
  });

  it('never reveals app content before authentication when App Lock is ON during background SecureStore hydration', async () => {
    useSettingsStore.setState({ isLoaded: false, appLockEnabled: false });

    let resolveSecureA!: (v: string | null) => void;
    let resolveSecureB!: (v: string | null) => void;
    let resolveAuth!: (v: { success: boolean }) => void;
    (SecureStore.getItemAsync as jest.Mock)
      .mockImplementationOnce(() => new Promise<string | null>((res) => { resolveSecureA = res; }))
      .mockImplementationOnce(() => new Promise<string | null>((res) => { resolveSecureB = res; }));
    (LocalAuthentication.authenticateAsync as jest.Mock).mockImplementationOnce(
      () => new Promise<{ success: boolean }>((res) => { resolveAuth = res; }),
    );
    (db.select as jest.Mock).mockReturnValueOnce({
      from: jest.fn(() => Promise.resolve([{ key: 'appLockEnabled', value: 'true' }])),
    });

    let r!: Renderer;
    await ReactTestRenderer.act(async () => {
      r = ReactTestRenderer.create(<AppLockGate><Text>secret data</Text></AppLockGate>);
    });
    // Covered before SQLite finishes
    expect(hasCoverOverlay(r)).toBe(true);

    let loadPromise!: Promise<void>;
    await ReactTestRenderer.act(async () => {
      loadPromise = useSettingsStore.getState().loadSettings();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Still covered (never flashed unlocked!) and prompt started while SecureStore is pending
    expect(hasCoverOverlay(r)).toBe(true);
    expect(isLocked(r)).toBe(true);
    expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);

    // Resolving SecureStore must NOT unlock the gate before biometric authentication succeeds
    await ReactTestRenderer.act(async () => {
      resolveSecureA('sk-secret');
      resolveSecureB('');
      await loadPromise;
    });
    expect(hasCoverOverlay(r)).toBe(true);
    expect(isLocked(r)).toBe(true);

    // Only authentication succeeding removes the lock cover
    await ReactTestRenderer.act(async () => {
      resolveAuth({ success: true });
      await Promise.resolve();
    });
    expect(hasCoverOverlay(r)).toBe(false);
    expect(isLocked(r)).toBe(false);

    await ReactTestRenderer.act(async () => {
      r.unmount();
    });
  });
});
