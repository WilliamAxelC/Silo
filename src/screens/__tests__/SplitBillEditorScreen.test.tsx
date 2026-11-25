import React from 'react';
import { Alert, Text } from 'react-native';

import { SplitBillEditorScreen } from '../SplitBillEditorScreen';
import { useSplitsStore } from '../../features/splits/store';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useTransactionStore } from '../../store/useTransactionStore';

const ReactTestRenderer = require('react-test-renderer');
const mockNavigate = jest.fn();
const mockGoBack = jest.fn();

jest.mock('@react-navigation/native', () => {
  const React = require('react');
  return {
    useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
    useRoute: () => ({ params: { transactionId: 100 } }),
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

const split = (over: Record<string, unknown>) => ({
  id: 11,
  transactionId: 100,
  contactId: 1,
  personName: 'Valen',
  phone: '+60147671545',
  amountOwed: 37_000,
  currency: 'IDR',
  splitMode: 'equal',
  breakdown: { includeSelf: true, totalParticipants: 2 },
  isSettled: false,
  settledAt: null,
  repaymentTransactionId: null,
  createdAt: 1,
  merchantName: 'Wingstop Central Park',
  transactionDate: new Date('2026-11-24T12:00:00Z').getTime(),
  transactionTotal: -74_000,
  transactionWalletId: 1,
  transactionOriginalAmount: null,
  transactionOriginalCurrency: null,
  transactionFxRate: null,
  transactionLineItemsText: null,
  ...over,
});

const texts = (r: any) =>
  r.root.findAllByType(Text).map((t: any) => {
    const c = t.props.children;
    return Array.isArray(c) ? c.join('') : String(c ?? '');
  });

function setup(splits: any[]) {
  const markSplitSettled = jest.fn(async () => {});
  const deleteBillSplits = jest.fn(async () => {});
  useSplitsStore.setState({
    contacts: [{ id: 1, name: 'Valen', phone: '+60147671545', deviceContactId: null, createdAt: 1, updatedAt: 1 }],
    splits,
    paymentDetails: '',
    defaultCountryCode: '62',
    loaded: true,
    load: jest.fn(),
    ensureLoaded: jest.fn(),
    markSplitSettled,
    deleteBillSplits,
  } as any);
  let r: any;
  ReactTestRenderer.act(() => {
    r = ReactTestRenderer.create(<SplitBillEditorScreen />);
  });
  return { r, markSplitSettled, deleteBillSplits };
}

// Reported 2026-11-24: the per-expense split page only had sharing and setup; to see the result or mark
// someone paid you had to go to All Splits. The result now sits at the top and the setup folds away.
describe('SplitBillEditorScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useSettingsStore.setState({ currencyCode: 'IDR', useThousandsSeparator: true, fontScale: 1, dateFormat: 'en-GB' });
    useTransactionStore.setState({
      transactionsList: [
        { id: 100, merchantName: 'Wingstop Central Park', totalAmount: -74_000, type: 'expense', category: 'Food', date: Date.now(), walletId: 1 },
      ],
      wallets: [{ id: 1, name: 'Main Wallet', type: 'cash', isActive: true, initialBalance: 0, balance: 0, currency: null, averageRate: null }],
      updateTransaction: jest.fn(),
    } as any);
  });

  it('regression: a saved split shows its result with Mark paid, and the setup is folded away', () => {
    const { r, markSplitSettled } = setup([split({})]);
    expect(r.root.findByProps({ testID: 'split-result' })).toBeTruthy();
    expect(texts(r).some((t: string) => /^0 of 1 paid · Rp\s37\.000 still owed$/.test(t))).toBe(true);
    expect(texts(r)).toContain('Me (my share)');
    expect(r.root.findAllByProps({ accessibilityLabel: 'Save split' })).toHaveLength(0);

    // Mark paid right here opens the confirmation, which marks the share paid.
    ReactTestRenderer.act(() => r.root.findByProps({ accessibilityLabel: 'Mark Valen as paid' }).props.onPress());
    const modal = r.root.findAll((n: any) => n.props && n.props.personName === 'Valen' && typeof n.props.onConfirm === 'function')[0];
    expect(modal.props.visible).toBe(true);
    ReactTestRenderer.act(() => {
      void modal.props.onConfirm({ logRepayment: false });
    });
    expect(markSplitSettled).toHaveBeenCalledWith(11, { logRepayment: false });

    // The setup is still one tap away for editing.
    ReactTestRenderer.act(() => r.root.findByProps({ testID: 'split-setup-toggle' }).props.onPress());
    expect(r.root.findAllByProps({ accessibilityLabel: 'Save split' }).length).toBeGreaterThan(0);
    ReactTestRenderer.act(() => r.unmount());
  });

  it('shows everyone paid when all shares are settled', () => {
    const { r } = setup([split({ isSettled: true })]);
    expect(texts(r)).toContain('Everyone has paid');
    expect(r.root.findByProps({ accessibilityLabel: 'Valen has paid. Mark unpaid' })).toBeTruthy();
    ReactTestRenderer.act(() => r.unmount());
  });

  it('starts with the setup open and no result for a bill that is not split yet', () => {
    const { r } = setup([]);
    expect(r.root.findAllByProps({ testID: 'split-result' })).toHaveLength(0);
    expect(r.root.findAllByProps({ testID: 'split-setup-toggle' })).toHaveLength(0);
    expect(r.root.findAllByProps({ accessibilityLabel: 'Save split' }).length).toBeGreaterThan(0);
    ReactTestRenderer.act(() => r.unmount());
  });
  // Requested 2026-11-25: a split could only be removed from the small trash icon in All Splits (More).
  it('regression: Remove split on the split page asks, removes the split and goes back', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { r, deleteBillSplits } = setup([split({})]);
    ReactTestRenderer.act(() => r.root.findByProps({ testID: 'split-remove' }).props.onPress());
    const [title, , buttons] = alert.mock.calls[0] as any;
    expect(title).toBe('Remove split?');
    expect(buttons.map((b: any) => b.text)).toEqual(['Cancel', 'Remove']);
    expect(deleteBillSplits).not.toHaveBeenCalled();
    ReactTestRenderer.act(() => buttons[1].onPress());
    expect(deleteBillSplits).toHaveBeenCalledWith(100, { deleteRepayments: false });
    expect(mockGoBack).toHaveBeenCalled();
    alert.mockRestore();
    ReactTestRenderer.act(() => r.unmount());
  });

  it('asks whether to delete logged repayment income too', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { r, deleteBillSplits } = setup([split({ isSettled: true, repaymentTransactionId: 900 })]);
    ReactTestRenderer.act(() => r.root.findByProps({ testID: 'split-remove' }).props.onPress());
    const [, message, buttons] = alert.mock.calls[0] as any;
    expect(message).toContain('1 repayment was logged as income');
    expect(buttons.map((b: any) => b.text)).toEqual(['Cancel', 'Keep income', 'Delete income too']);
    ReactTestRenderer.act(() => buttons[2].onPress());
    expect(deleteBillSplits).toHaveBeenCalledWith(100, { deleteRepayments: true });
    alert.mockRestore();
    ReactTestRenderer.act(() => r.unmount());
  });

  it('saving a split with everyone taken off offers to remove it', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { r } = setup([split({})]);
    ReactTestRenderer.act(() => r.root.findByProps({ testID: 'split-setup-toggle' }).props.onPress());
    ReactTestRenderer.act(() => r.root.findByProps({ accessibilityLabel: 'Remove Valen' }).props.onPress());
    ReactTestRenderer.act(() => {
      void r.root.findByProps({ accessibilityLabel: 'Save split' }).props.onPress();
    });
    expect(alert.mock.calls[0][0]).toBe('Remove split?');
    alert.mockRestore();
    ReactTestRenderer.act(() => r.unmount());
  });
});
