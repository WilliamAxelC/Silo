import React from 'react';
import { Alert, StyleSheet, Text } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { AccountsScreen } from '../AccountsScreen';
import { useTransactionStore } from '../../store/useTransactionStore';
import { useSettingsStore } from '../../store/useSettingsStore';

const ReactTestRenderer = require('react-test-renderer');

const mockGoBack = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    goBack: mockGoBack,
    navigate: jest.fn(),
  }),
}));

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    SafeAreaInsetsContext: React.createContext({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

function withInsets(element: React.ReactElement) {
  return (
    <SafeAreaInsetsContext.Provider value={{ top: 24, bottom: 32, left: 0, right: 0 }}>
      {element}
    </SafeAreaInsetsContext.Provider>
  );
}

describe('AccountsScreen (F-18, F-25)', () => {
  const mockAddWallet = jest.fn();
  const mockUpdateWallet = jest.fn();
  const mockRemoveWallet = jest.fn(() => ({ ok: true }));

  beforeEach(() => {
    jest.clearAllMocks();
    useSettingsStore.setState({
      currencyCode: 'IDR',
      useThousandsSeparator: true,
      fontScale: 1,
    });
    useTransactionStore.setState({
      wallets: [
        { id: 1, name: 'Main Wallet', type: 'cash', isActive: true, initialBalance: 100000, balance: 150000 },
        { id: 2, name: 'BCA', type: 'bank', isActive: true, initialBalance: 0, balance: 500000 },
        { id: 3, name: 'Unused E-Wallet', type: 'ewallet', isActive: true, initialBalance: 0, balance: 0 },
        { id: 4, name: 'Old Credit Card', type: 'card', isActive: false, initialBalance: 0, balance: -250000 },
      ],
      transactionsList: [
        {
          id: 10,
          merchantName: 'Salary',
          totalAmount: 500000,
          type: 'income',
          category: 'Salary',
          date: Date.now(),
          walletId: 2,
        },
      ],
      addWallet: mockAddWallet,
      updateWallet: mockUpdateWallet,
      removeWallet: mockRemoveWallet,
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows Archive wording and explanation for active accounts with transaction history, and Remove for unused accounts (F-18)', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(withInsets(<AccountsScreen />));
    });

    // Net worth card explains archived accounts are excluded
    const note = renderer.root.findByProps({ testID: 'archived-networth-note' });
    const noteText = Array.isArray(note.props.children) ? note.props.children.join('') : String(note.props.children);
    expect(noteText).toContain('Active accounts only');
    expect(noteText).toContain('Archived:');
    expect(noteText).toContain('250.000');

    // Open account with history (BCA) -> button is "Archive"
    const bcaRow = renderer.root.findAll(
      (n: any) => typeof n.props?.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('BCA,')
    )[0];
    ReactTestRenderer.act(() => {
      bcaRow.props.onPress();
    });

    const archiveBtn = renderer.root.findByProps({ accessibilityLabel: 'Archive account' });
    const archiveBtnText = archiveBtn.findByType(Text).props.children;
    expect(archiveBtnText).toBe('Archive');

    ReactTestRenderer.act(() => {
      archiveBtn.props.onPress();
    });
    expect(alertSpy).toHaveBeenCalledWith(
      'Archive account?',
      expect.stringContaining('excluded from active Net worth'),
      expect.any(Array)
    );
    const confirmArchive = (alertSpy.mock.calls[0][2] as any[]).find((b) => b.text === 'Archive');
    expect(confirmArchive).toBeDefined();
    ReactTestRenderer.act(() => {
      confirmArchive.onPress();
    });
    expect(mockRemoveWallet).toHaveBeenCalledWith(2);

    alertSpy.mockClear();

    // Open unused account -> button is "Remove"
    const unusedRow = renderer.root.findAll(
      (n: any) => typeof n.props?.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Unused E-Wallet,')
    )[0];
    ReactTestRenderer.act(() => {
      unusedRow.props.onPress();
    });

    const removeBtn = renderer.root.findByProps({ accessibilityLabel: 'Remove account' });
    expect(removeBtn.findByType(Text).props.children).toBe('Remove');
    ReactTestRenderer.act(() => {
      removeBtn.props.onPress();
    });
    expect(alertSpy).toHaveBeenCalledWith(
      'Remove account?',
      expect.stringContaining('deleted permanently'),
      expect.any(Array)
    );

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('meets >=44pt touch target minimums on header controls (F-25)', () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(withInsets(<AccountsScreen />));
    });

    const backStyle = StyleSheet.flatten(renderer.root.findByProps({ accessibilityLabel: 'Go back' }).props.style);
    expect(backStyle.width).toBeGreaterThanOrEqual(44);
    expect(backStyle.height).toBeGreaterThanOrEqual(44);

    const addStyle = StyleSheet.flatten(renderer.root.findByProps({ accessibilityLabel: 'Add account' }).props.style);
    expect(addStyle.minHeight).toBeGreaterThanOrEqual(44);

    ReactTestRenderer.act(() => renderer.unmount());
  });
});
