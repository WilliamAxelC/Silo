import React from 'react';
import { Text } from 'react-native';
import { AccountDetailScreen } from '../AccountDetailScreen';
import { useTransactionStore } from '../../store/useTransactionStore';
import { useSettingsStore } from '../../store/useSettingsStore';

const ReactTestRenderer = require('react-test-renderer');
const mockNavigate = jest.fn();
let mockParams: any = { walletId: 2 };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
  useRoute: () => ({ params: mockParams }),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
jest.mock('../../services/fx/rates', () => ({ walletHomeRate: () => 104.6 }));

describe('AccountDetailScreen', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    useSettingsStore.setState({ currencyCode: 'IDR', useThousandsSeparator: true, dateFormat: 'en-GB', fontScale: 1 });
    useTransactionStore.setState({
      hasLoadedTransactions: true,
      transactionsDirty: false,
      wallets: [
        { id: 1, name: 'BCA', type: 'bank', isActive: true, initialBalance: 0, balance: 4_000_000, currency: null, averageRate: null },
        { id: 2, name: 'Japan Cash', type: 'cash', isActive: true, initialBalance: 0, balance: 6_360, currency: 'JPY', averageRate: 104.6 },
      ],
      transactionsList: [
        { id: 1, merchantName: 'Money changer', totalAmount: -1_000_000, type: 'transfer', category: 'Transfer', date: 1, walletId: 1, toWalletId: 2, toAmount: 9_560, tags: [] },
        { id: 2, merchantName: 'Ramen', totalAmount: -334_720, type: 'expense', category: 'Food & Dining', date: 2, walletId: 2, originalAmount: -3_200, originalCurrency: 'JPY', fxRate: 104.6, tags: ['Japan 2026'] },
        { id: 3, merchantName: 'Lunch', totalAmount: -50_000, type: 'expense', category: 'Food & Dining', date: 3, walletId: 1, tags: [] },
      ],
    } as any);
  });

  it('lists only this account\'s transactions in its currency with running balances, and opens them for editing', () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AccountDetailScreen />);
    });
    const texts = renderer.root.findAllByType(Text).map((t: any) => [].concat(t.props.children).join(''));
    expect(texts).toContain('Ramen');
    expect(texts).toContain('Money changer');
    expect(texts).not.toContain('Lunch');
    expect(texts.some((t: string) => t.startsWith('-¥') && t.includes('3.200'))).toBe(true);
    expect(texts.some((t: string) => t.startsWith('+¥') && t.includes('9.560'))).toBe(true);
    expect(texts.some((t: string) => t.includes('From BCA'))).toBe(true);
    expect(texts.some((t: string) => t.includes('#Japan 2026'))).toBe(true);

    ReactTestRenderer.act(() => {
      renderer.root.findAll((n: any) => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Ramen,'))[0].props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('AddTransactionStack', { transactionId: 2 });
    ReactTestRenderer.act(() => renderer.root.findByProps({ accessibilityLabel: 'Edit Japan Cash' }).props.onPress());
    expect(mockNavigate).toHaveBeenCalledWith('Accounts', { editWalletId: 2 });
    ReactTestRenderer.act(() => renderer.unmount());
  });
});
