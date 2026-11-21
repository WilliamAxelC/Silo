import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { ReceiptItemsEditor } from '../ReceiptItemsEditor';
import { useSettingsStore } from '../../store/useSettingsStore';

const ReactTestRenderer = require('react-test-renderer');

describe('ReceiptItemsEditor', () => {
  it('sums Rupiah line item prices using parseSignedAmount', () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <ReceiptItemsEditor
          lineItems={[
            { id: '1', name: 'Coffee', price: '45.000', note: '' },
            { id: '2', name: 'Cake', price: 'Rp 1.500.000,-', note: '' },
          ]}
          onAddRow={jest.fn()}
          onRemoveRow={jest.fn()}
          onUpdateRow={jest.fn()}
        />
      );
    });

    const texts = renderer.root.findAllByType(Text);
    const totalNode = texts.find((t: any) => {
      const content = Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '');
      return content.includes('1.545.000');
    });
    expect(totalNode).toBeDefined();
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('provides accessible labels for add and remove buttons', () => {
    const onRemoveRow = jest.fn();
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <ReceiptItemsEditor
          lineItems={[{ id: 'row-1', name: 'Milk', price: '35.000', note: '' }]}
          onAddRow={jest.fn()}
          onRemoveRow={onRemoveRow}
          onUpdateRow={jest.fn()}
        />
      );
    });

    const addBtn = renderer.root.findByProps({ accessibilityLabel: 'Add line item' });
    expect(addBtn.props.accessibilityRole).toBe('button');

    const removeBtn = renderer.root.findByProps({ accessibilityLabel: 'Remove item 1' });
    expect(removeBtn.props.accessibilityRole).toBe('button');
    ReactTestRenderer.act(() => {
      removeBtn.props.onPress();
    });
    expect(onRemoveRow).toHaveBeenCalledWith('row-1');
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('displays currency symbol prefix and enforces >=44pt touch targets on add and remove actions (F-15, F-25)', () => {
    const prevCurrency = useSettingsStore.getState().currencyCode;
    let renderer: any;
    try {
      ReactTestRenderer.act(() => {
        useSettingsStore.setState({ currencyCode: 'USD' });
        renderer = ReactTestRenderer.create(
          <ReceiptItemsEditor
            lineItems={[{ id: 'row-1', name: 'Espresso', price: '4.50', note: 'x1' }]}
            onAddRow={jest.fn()}
            onRemoveRow={jest.fn()}
            onUpdateRow={jest.fn()}
          />
        );
      });

      const texts = renderer.root.findAllByType(Text).map((t: any) =>
        Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '')
      );
      expect(texts).toContain('$');

      const addStyle = StyleSheet.flatten(renderer.root.findByProps({ accessibilityLabel: 'Add line item' }).props.style);
      const removeStyle = StyleSheet.flatten(renderer.root.findByProps({ accessibilityLabel: 'Remove item 1' }).props.style);
      expect(addStyle.minHeight).toBeGreaterThanOrEqual(44);
      expect(removeStyle.width).toBeGreaterThanOrEqual(44);
      expect(removeStyle.height).toBeGreaterThanOrEqual(44);

      ReactTestRenderer.act(() => renderer.unmount());
    } finally {
      ReactTestRenderer.act(() => {
        useSettingsStore.setState({ currencyCode: prevCurrency });
      });
    }
  });
});
