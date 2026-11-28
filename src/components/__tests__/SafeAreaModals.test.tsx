import React from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { AccountPickerModal } from '../AccountPickerModal';
import { AmountCalculatorModal } from '../AmountCalculatorKeypad';
import { CategorySelectorModal } from '../CategorySelectorModal';
import { SourceSelectorModal } from '../SourceSelectorModal';
import { WelcomeSheet } from '../WelcomeSheet';
import { AccountsScreen } from '../../screens/AccountsScreen';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useTransactionStore } from '../../store/useTransactionStore';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn(), navigate: jest.fn(), setParams: jest.fn() }),
  useRoute: () => ({ params: undefined }),
}));

const ReactTestRenderer = require('react-test-renderer');

const MOCK_INSETS = { top: 28, bottom: 48, left: 0, right: 0 };

function withInsets(element: React.ReactElement) {
  return <SafeAreaInsetsContext.Provider value={MOCK_INSETS}>{element}</SafeAreaInsetsContext.Provider>;
}

describe('Modal & bottom-sheet bottom safe-area insets (F-06)', () => {
  beforeEach(() => {
    useSettingsStore.setState({ currencyCode: 'IDR', useThousandsSeparator: true, fontScale: 1 });
    useTransactionStore.setState({
      wallets: [{ id: 1, name: 'Main Wallet', type: 'cash', isActive: true, initialBalance: 0, balance: 0 }],
    } as any);
  });

  it('applies bottom safe-area inset padding to AccountPickerModal sheet', () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        withInsets(
          <AccountPickerModal
            visible
            title="Account"
            wallets={[{ id: 1, name: 'Main Wallet', type: 'cash', isActive: true, initialBalance: 0, balance: 0, currency: null, averageRate: null }]}
            selectedId={1}
            onSelect={jest.fn()}
            onClose={jest.fn()}
            onManage={jest.fn()}
          />
        )
      );
    });

    const sheet = renderer.root.findByProps({ testID: 'account-picker-sheet' });
    const style = StyleSheet.flatten(sheet.props.style);
    expect(style.paddingBottom).toBeGreaterThanOrEqual(MOCK_INSETS.bottom + 18);
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('applies top and bottom safe-area insets to CategorySelectorModal and SourceSelectorModal overlays', () => {
    let catRenderer: any;
    ReactTestRenderer.act(() => {
      catRenderer = ReactTestRenderer.create(
        withInsets(
          <CategorySelectorModal
            visible
            onClose={jest.fn()}
            categories={[{ id: 1, name: 'Bills', type: 'expense', isSystem: true, createdAt: 1 }]}
            onSelectCategory={jest.fn()}
            customCategory=""
            onChangeCustomCategory={jest.fn()}
            onAddCustomCategory={jest.fn()}
          />
        )
      );
    });

    const catOverlay = catRenderer.root.findAll((n: any) => {
      const flat = StyleSheet.flatten(n.props?.style);
      return flat && flat.paddingBottom === MOCK_INSETS.bottom + 16 && flat.paddingTop === MOCK_INSETS.top + 16;
    });
    expect(catOverlay.length).toBeGreaterThan(0);
    ReactTestRenderer.act(() => catRenderer.unmount());

    let srcRenderer: any;
    ReactTestRenderer.act(() => {
      srcRenderer = ReactTestRenderer.create(
        withInsets(<SourceSelectorModal visible onClose={jest.fn()} onPickImage={jest.fn()} />)
      );
    });
    const srcOverlay = srcRenderer.root.findAll((n: any) => {
      const flat = StyleSheet.flatten(n.props?.style);
      return flat && flat.paddingBottom === MOCK_INSETS.bottom + 20 && flat.paddingTop === MOCK_INSETS.top + 20;
    });
    expect(srcOverlay.length).toBeGreaterThan(0);
    ReactTestRenderer.act(() => srcRenderer.unmount());
  });

  it('applies bottom safe-area inset padding to AmountCalculatorModal and WelcomeSheet', () => {
    let calcRenderer: any;
    ReactTestRenderer.act(() => {
      calcRenderer = ReactTestRenderer.create(
        withInsets(
          <AmountCalculatorModal
            visible
            initialValue="10000"
            currencyCode="IDR"
            onDone={jest.fn()}
            onClose={jest.fn()}
          />
        )
      );
    });
    const calcPanel = calcRenderer.root.findAll((n: any) => {
      const flat = StyleSheet.flatten(n.props?.style);
      return flat && flat.paddingBottom === MOCK_INSETS.bottom + 20;
    });
    expect(calcPanel.length).toBeGreaterThan(0);
    ReactTestRenderer.act(() => calcRenderer.unmount());

    let welcomeRenderer: any;
    ReactTestRenderer.act(() => {
      welcomeRenderer = ReactTestRenderer.create(withInsets(<WelcomeSheet visible />));
    });
    const welcomeSheet = welcomeRenderer.root.findByProps({ testID: 'welcome-sheet' });
    expect(StyleSheet.flatten(welcomeSheet.props.style).paddingBottom).toBe(MOCK_INSETS.bottom + 20);
    ReactTestRenderer.act(() => welcomeRenderer.unmount());
  });

  it('bounds AccountsScreen editor sheet with maxHeight and wraps form + archive actions in ScrollView (R3A-04)', () => {
    useSettingsStore.setState({ currencyCode: 'IDR', useThousandsSeparator: true, fontScale: 1.2 });
    useTransactionStore.setState({
      wallets: [
        { id: 1, name: 'Main Wallet', type: 'cash', isActive: true, initialBalance: 0, balance: 0 },
        { id: 2, name: 'Old Card', type: 'card', isActive: false, initialBalance: 0, balance: 0 },
      ],
    } as any);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(withInsets(<AccountsScreen />));
    });

    // Reveal and open the archived wallet in the editor sheet
    const showArchivedBtn = renderer.root.findAll(
      (n: any) => typeof n.props?.onPress === 'function' && n.findAllByType?.(Text).some((t: any) => String(t.props.children).includes('archived'))
    )[0];
    ReactTestRenderer.act(() => {
      showArchivedBtn.props.onPress();
    });
    const archivedRow = renderer.root.findAllByProps({ accessibilityLabel: 'Edit Old Card' })[0];
    ReactTestRenderer.act(() => {
      archivedRow.props.onPress();
    });

    const sheet = renderer.root.findByProps({ testID: 'account-editor-sheet' });
    const sheetStyle = StyleSheet.flatten(sheet.props.style);
    expect(sheetStyle.maxHeight).toBe('88%');
    // Tablets and unfolded foldables: the sheet stops stretching edge to edge.
    expect(sheetStyle.maxWidth).toBe(640);
    expect(sheetStyle.alignSelf).toBe('center');
    expect(sheetStyle.paddingBottom).toBe(MOCK_INSETS.bottom + 24);

    const scroll = renderer.root.findByProps({ testID: 'account-editor-scroll' });
    expect(scroll.type).toBe(ScrollView);
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');

    const scrollTexts = scroll.findAllByType(Text).map((t: any) => String(t.props.children ?? ''));
    expect(scrollTexts).toContain('Save');
    expect(scrollTexts).toContain('Cancel');
    expect(scrollTexts).toContain('Remove');
    expect(scrollTexts).toContain('Restore from archive');

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('keeps CategorySelectorModal and WelcomeSheet above the keyboard on Android with KeyboardSheet, not height (MIN-01)', () => {
    const originalOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    try {
      let catRenderer: any;
      ReactTestRenderer.act(() => {
        catRenderer = ReactTestRenderer.create(
          withInsets(
            <CategorySelectorModal
              visible
              onClose={jest.fn()}
              categories={[{ id: 1, name: 'Bills', type: 'expense', isSystem: true, createdAt: 1 }]}
              onSelectCategory={jest.fn()}
              customCategory=""
              onChangeCustomCategory={jest.fn()}
              onAddCustomCategory={jest.fn()}
            />
          )
        );
      });
      expect(catRenderer.root.findAllByProps({ testID: 'keyboard-sheet' }).length).toBeGreaterThan(0);
      expect(catRenderer.root.findAllByType(KeyboardAvoidingView)).toHaveLength(0);
      ReactTestRenderer.act(() => catRenderer.unmount());

      let welcomeRenderer: any;
      ReactTestRenderer.act(() => {
        welcomeRenderer = ReactTestRenderer.create(withInsets(<WelcomeSheet visible />));
      });
      expect(welcomeRenderer.root.findAllByProps({ testID: 'keyboard-sheet' }).length).toBeGreaterThan(0);
      expect(welcomeRenderer.root.findAllByType(KeyboardAvoidingView)).toHaveLength(0);
      ReactTestRenderer.act(() => welcomeRenderer.unmount());
    } finally {
      Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
    }
  });
});
