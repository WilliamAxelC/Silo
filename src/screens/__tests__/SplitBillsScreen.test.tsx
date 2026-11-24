import React from 'react';
import { Linking, Share, Text } from 'react-native';

import { SplitBillsScreen } from '../SplitBillsScreen';
import { useSplitsStore } from '../../features/splits/store';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useTransactionStore } from '../../store/useTransactionStore';

const ReactTestRenderer = require('react-test-renderer');
const mockNavigate = jest.fn();

jest.mock('@react-navigation/native', () => {
  const React = require('react');
  return {
    useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
    useFocusEffect: (cb: any) => {
      React.useEffect(() => cb(), [cb]);
    },
  };
});

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    SafeAreaInsetsContext: React.createContext({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

describe('SplitBillsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useSettingsStore.setState({ currencyCode: 'IDR', useThousandsSeparator: true, fontScale: 1, dateFormat: 'en-GB' });
    useTransactionStore.setState({
      transactionsList: [],
      wallets: [{ id: 1, name: 'Main Wallet', type: 'cash', isActive: true, initialBalance: 0, balance: 0, currency: null, averageRate: null }],
      fetchTransactionsIfNeeded: jest.fn(async () => {}),
    } as any);
    useSplitsStore.setState({
      contacts: [{ id: 1, name: 'Budi', phone: '08123456789', deviceContactId: null, createdAt: 1, updatedAt: 1 }],
      splits: [
        {
          id: 11,
          transactionId: 100,
          contactId: 1,
          personName: 'Budi',
          phone: '08123456789',
          amountOwed: 50_000,
          currency: 'IDR',
          splitMode: 'equal',
          breakdown: { includeSelf: true, totalParticipants: 2 },
          isSettled: false,
          settledAt: null,
          repaymentTransactionId: null,
          createdAt: 1,
          merchantName: 'Ramen Ya',
          transactionDate: new Date('2026-11-20T12:00:00Z').getTime(),
          transactionTotal: -100_000,
          transactionWalletId: 1,
          transactionOriginalAmount: null,
          transactionOriginalCurrency: null,
          transactionFxRate: null,
          transactionLineItemsText: null,
        },
      ],
      paymentDetails: 'BCA 12345',
      defaultCountryCode: '62',
      loaded: true,
      load: jest.fn(),
      ensureLoaded: jest.fn(),
      markSplitSettled: jest.fn(async () => {}),
    } as any);
  });

  it('renders Bills and People views and triggers WhatsApp and Share actions', async () => {
    const openUrlSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as any);
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as any);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<SplitBillsScreen />);
    });

    const texts = renderer.root.findAllByType(Text).map((t: any) => {
      const c = t.props.children;
      return Array.isArray(c) ? c.join('') : String(c ?? '');
    });
    expect(texts).toContain('Ramen Ya');
    expect(texts).toContain('Budi');

    const waBtn = renderer.root.findByProps({ accessibilityLabel: 'Send WhatsApp to Budi for Ramen Ya' });
    await ReactTestRenderer.act(async () => {
      waBtn.props.onPress();
    });
    expect(openUrlSpy).toHaveBeenCalledWith(expect.stringContaining('https://wa.me/628123456789?text='));

    const shareBtn = renderer.root.findByProps({ accessibilityLabel: 'Share Ramen Ya split with Budi' });
    await ReactTestRenderer.act(async () => {
      shareBtn.props.onPress();
    });
    expect(shareSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('BCA 12345') })
    );

    const peopleTab = renderer.root.findByProps({ accessibilityLabel: 'People (1)' });
    ReactTestRenderer.act(() => {
      peopleTab.props.onPress();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Mark all bills paid for Budi' })).toBeTruthy();

    openUrlSpy.mockRestore();
    shareSpy.mockRestore();
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('opens Mark Paid modal and calls markSplitSettled on confirmation', async () => {
    const markSettledMock = jest.fn(async () => {});
    useSplitsStore.setState({ markSplitSettled: markSettledMock } as any);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<SplitBillsScreen />);
    });

    const markPaidBtn = renderer.root.findByProps({ accessibilityLabel: 'Mark Budi as paid' });
    ReactTestRenderer.act(() => {
      markPaidBtn.props.onPress();
    });

    const confirmBtn = renderer.root.findByProps({ accessibilityLabel: 'Confirm mark as paid' });
    await ReactTestRenderer.act(async () => {
      await confirmBtn.props.onPress();
    });

    expect(markSettledMock).toHaveBeenCalledWith(11, { logRepayment: true, walletId: 1 });
    ReactTestRenderer.act(() => renderer.unmount());
  });
});
