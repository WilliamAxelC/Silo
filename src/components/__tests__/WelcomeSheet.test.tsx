import React from 'react';
import { Alert } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';

import { WelcomeSheet } from '../WelcomeSheet';
import { BACKUP_PICKER_MIME_TYPES } from '../../services/backup';
import * as backupService from '../../services/backup';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useTransactionStore } from '../../store/useTransactionStore';

const ReactTestRenderer = require('react-test-renderer');

describe('WelcomeSheet first-launch onboarding (F-14)', () => {
  const mockSetCurrencyCode = jest.fn(async (code: string) => {
    useSettingsStore.setState({ currencyCode: code });
  });
  const mockSetHasCompletedOnboarding = jest.fn(async (completed: boolean) => {
    useSettingsStore.setState({ hasCompletedOnboarding: completed });
  });
  const mockUpdateWallet = jest.fn();
  const mockFetchTransactions = jest.fn(async () => undefined);
  const mockFetchCategories = jest.fn(async () => undefined);
  const mockFetchBudgets = jest.fn(async () => undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    useSettingsStore.setState({
      currencyCode: 'IDR',
      hasCompletedOnboarding: false,
      isLoaded: true,
      setCurrencyCode: mockSetCurrencyCode,
      setHasCompletedOnboarding: mockSetHasCompletedOnboarding,
    } as any);
    useTransactionStore.setState({
      wallets: [{ id: 1, name: 'Main Wallet', type: 'cash', isActive: true, initialBalance: 0, balance: 0 }],
      updateWallet: mockUpdateWallet,
      fetchTransactions: mockFetchTransactions,
      fetchCategories: mockFetchCategories,
      fetchBudgets: mockFetchBudgets,
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('applies chosen currency and starting balance and marks onboarding complete', async () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<WelcomeSheet visible />);
    });

    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Welcome currency USD' }).props.onPress();
    });

    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Starting balance' }).props.onChangeText('1250.50');
    });

    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Complete welcome setup' }).props.onPress();
    });

    expect(mockSetCurrencyCode).toHaveBeenCalledWith('USD');
    expect(mockUpdateWallet).toHaveBeenCalledWith(1, { initialBalance: 1250.5 });
    expect(mockSetHasCompletedOnboarding).toHaveBeenCalledWith(true);

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('is skippable and sets hasCompletedOnboarding so it is never shown again', async () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<WelcomeSheet visible />);
    });

    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Skip welcome setup' }).props.onPress();
    });

    expect(mockSetCurrencyCode).not.toHaveBeenCalled();
    expect(mockUpdateWallet).not.toHaveBeenCalled();
    expect(mockSetHasCompletedOnboarding).toHaveBeenCalledWith(true);

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('supports restoring a backup directly from the welcome sheet with filtered picker and overwrite warning', async () => {
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///silo-backup-2026-11-21.db', name: 'silo-backup-2026-11-21.db' }],
    });
    const restoreSpy = jest.spyOn(backupService, 'restoreBackupFile').mockResolvedValueOnce({ transactions: 7 });
    const loadSettingsSpy = jest.spyOn(useSettingsStore.getState(), 'loadSettings').mockResolvedValueOnce(undefined);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<WelcomeSheet visible />);
    });

    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Restore from a backup' }).props.onPress();
    });

    expect(DocumentPicker.getDocumentAsync).toHaveBeenCalledWith(
      expect.objectContaining({ type: BACKUP_PICKER_MIME_TYPES })
    );

    const confirmCall = (Alert.alert as jest.Mock).mock.calls.find((c) => c[0] === 'Replace all data?');
    expect(confirmCall).toBeDefined();
    const restoreBtn = confirmCall[2].find((b: any) => b.text === 'Restore');

    await ReactTestRenderer.act(async () => {
      await restoreBtn.onPress();
    });

    expect(restoreSpy).toHaveBeenCalledWith('file:///silo-backup-2026-11-21.db');
    expect(mockSetHasCompletedOnboarding).toHaveBeenCalledWith(true);

    restoreSpy.mockRestore();
    loadSettingsSpy.mockRestore();
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('rounds decimal balance instead of inflating 100x when switching from USD to zero-decimal currencies (R3A-05)', () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<WelcomeSheet visible />);
    });

    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Welcome currency USD' }).props.onPress();
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Starting balance' }).props.onChangeText('12.05');
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Starting balance' }).props.value).toBe('12.05');

    // Switching to IDR must round 12.05 -> "12", NOT strip the dot into "1.205"
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Welcome currency IDR' }).props.onPress();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Starting balance' }).props.value).toBe('12');

    // Also verify rounding up from USD 12.75 -> JPY "13"
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Welcome currency USD' }).props.onPress();
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Starting balance' }).props.onChangeText('12.75');
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Welcome currency JPY' }).props.onPress();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Starting balance' }).props.value).toBe('13');

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('catches DocumentPicker errors and fetches categories before budgets during restore (R3A-06)', async () => {
    const callOrder: string[] = [];
    let resolveCategories!: () => void;
    useTransactionStore.setState({
      fetchTransactions: jest.fn(async () => {
        callOrder.push('fetchTransactions');
      }),
      fetchCategories: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            callOrder.push('fetchCategories:start');
            resolveCategories = () => {
              callOrder.push('fetchCategories:end');
              resolve();
            };
          })
      ),
      fetchBudgets: jest.fn(async () => {
        callOrder.push('fetchBudgets');
      }),
    } as any);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<WelcomeSheet visible />);
    });

    // 1. DocumentPicker rejects -> handled with alert
    (DocumentPicker.getDocumentAsync as jest.Mock).mockRejectedValueOnce(new Error('Picker unavailable'));
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Restore from a backup' }).props.onPress();
    });
    expect(Alert.alert).toHaveBeenCalledWith('Could not open file picker', expect.stringContaining('Picker unavailable'));

    // 2. Restore awaits fetchCategories before fetchBudgets
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///backup.db', name: 'backup.db' }],
    });
    const restoreSpy = jest.spyOn(backupService, 'restoreBackupFile').mockResolvedValueOnce({ transactions: 2 });
    const loadSettingsSpy = jest.spyOn(useSettingsStore.getState(), 'loadSettings').mockResolvedValueOnce(undefined);

    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Restore from a backup' }).props.onPress();
    });
    const confirmCall = (Alert.alert as jest.Mock).mock.calls.find((c) => c[0] === 'Replace all data?');
    const restoreBtn = confirmCall[2].find((b: any) => b.text === 'Restore');

    let restorePromise!: Promise<void>;
    await ReactTestRenderer.act(async () => {
      restorePromise = Promise.resolve(restoreBtn.onPress());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(callOrder).not.toContain('fetchBudgets');

    await ReactTestRenderer.act(async () => {
      resolveCategories();
      await restorePromise;
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });

    expect(callOrder.indexOf('fetchCategories:end')).toBeLessThan(callOrder.indexOf('fetchBudgets'));
    restoreSpy.mockRestore();
    loadSettingsSpy.mockRestore();
    ReactTestRenderer.act(() => renderer.unmount());
  });
});
