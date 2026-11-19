import React from 'react';
import { AppState, Text } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';

import { AppLockGate, RELOCK_AFTER_MS } from '../AppLockGate';
import { useSettingsStore } from '../../store/useSettingsStore';

jest.mock('../../db/index', () => ({ db: {} }));
// No type declarations for react-test-renderer in this project; other screen tests require it the same way.
const ReactTestRenderer = require('react-test-renderer');
type Renderer = { root: any; toJSON: () => unknown; unmount: () => void };

const isLocked = (r: Renderer) => JSON.stringify(r.toJSON()).includes('Silo is locked');

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
  });
});
