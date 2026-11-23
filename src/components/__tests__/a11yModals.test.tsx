import React from 'react';

import { AccountPickerModal } from '../AccountPickerModal';
import { CategorySelectorModal } from '../CategorySelectorModal';
import { SourceSelectorModal } from '../SourceSelectorModal';
import { AmountCalculatorModal } from '../AmountCalculatorKeypad';
import { FilterSheet } from '../FilterSheet';
import { EMPTY_FILTERS } from '../../features/transactions/filters';

const ReactTestRenderer = require('react-test-renderer');

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    SafeAreaInsetsContext: React.createContext({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

const wallets = [
  { id: 1, name: 'Main Wallet', type: 'cash', isActive: true, initialBalance: 0, balance: 0, currency: null, averageRate: null },
] as any;
const categories = [{ id: 1, name: 'Food & Dining', type: 'expense', isSystem: true, createdAt: 1 }] as any;
const noop = () => {};

const MODALS: Array<[string, React.ReactElement]> = [
  ['FilterSheet', <FilterSheet visible onClose={noop} sections={['type', 'account', 'category', 'date']} filters={EMPTY_FILTERS} onChange={noop} wallets={wallets} categories={categories} tags={[]} />],
  ['AccountPickerModal', <AccountPickerModal visible title="Account" wallets={wallets} selectedId={1} onSelect={noop} onClose={noop} onManage={noop} />],
  [
    'CategorySelectorModal',
    <CategorySelectorModal visible onClose={noop} categories={categories} onSelectCategory={noop} customCategory="" onChangeCustomCategory={noop} onAddCustomCategory={noop} />,
  ],
  ['SourceSelectorModal', <SourceSelectorModal visible onClose={noop} onPickImage={noop} />],
  ['AmountCalculatorModal', <AmountCalculatorModal visible onClose={noop} initialValue="" currencyCode="IDR" onDone={noop} />],
];

// Regression (accessibility pass 2026-11-23): a pressable is one element to TalkBack, so a tap-outside
// backdrop or a stopPropagation wrapper around a sheet hid every control inside it from screen readers.
describe('modal sheets are navigable with a screen reader', () => {
  it.each(MODALS)('regression: %s has no pressable wrapping other pressables unless accessible={false}', (_name, element) => {
    let r: any;
    ReactTestRenderer.act(() => {
      r = ReactTestRenderer.create(element);
    });
    const pressables = r.root.findAll((n: any) => typeof n.type !== 'string' && typeof n.props?.onPress === 'function');
    const offenders = pressables.filter((p: any) => {
      if (p.props.accessible === false) return false;
      // TouchableOpacity renders an inner instance of itself with the same onPress; that is not nesting.
      const inner = p.findAll(
        (n: any) => n !== p && typeof n.type !== 'string' && typeof n.props?.onPress === 'function' && n.props.onPress !== p.props.onPress,
      );
      return inner.length > 0;
    });
    expect(offenders.map((o: any) => o.props.testID ?? o.props.accessibilityLabel ?? o.props.style)).toEqual([]);
    ReactTestRenderer.act(() => r.unmount());
  });
});
