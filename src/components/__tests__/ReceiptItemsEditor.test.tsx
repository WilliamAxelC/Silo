import React from 'react';
import { Text } from 'react-native';
import { ReceiptItemsEditor } from '../ReceiptItemsEditor';

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
  });
});
