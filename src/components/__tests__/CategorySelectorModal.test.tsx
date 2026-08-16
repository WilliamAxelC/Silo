import React from 'react';
import { Text, TextInput, TouchableOpacity } from 'react-native';
import { CategorySelectorModal } from '../CategorySelectorModal';
import type { CategoryRecord } from '../../features/transactions/types';

const ReactTestRenderer = require('react-test-renderer');

describe('CategorySelectorModal Component', () => {
  const mockCategories: CategoryRecord[] = [
    { id: 1, name: 'Food & Dining', type: 'expense', isSystem: true, createdAt: 1000 },
    { id: 2, name: 'Groceries', type: 'expense', isSystem: true, createdAt: 1000 },
    { id: 3, name: 'Salary', type: 'income', isSystem: true, createdAt: 1000 },
    { id: 4, name: 'Transport', type: 'expense', isSystem: true, createdAt: 1000 },
  ];

  it('renders visible categories and handles selection', () => {
    const onSelectCategory = jest.fn();
    const onClose = jest.fn();

    let testRenderer: any;
    ReactTestRenderer.act(() => {
      testRenderer = ReactTestRenderer.create(
        <CategorySelectorModal
          visible={true}
          onClose={onClose}
          categories={mockCategories}
          onSelectCategory={onSelectCategory}
          customCategory=""
          onChangeCustomCategory={jest.fn()}
          onAddCustomCategory={jest.fn()}
          selectedCategory="Groceries"
        />
      );
    });

    const root = testRenderer.root;
    const texts = root.findAllByType(Text);
    expect(texts.some((t: any) => t.props.children === 'Select Category')).toBe(true);

    // Find touchable for "Food & Dining" and press
    const categoryRows = root.findAllByProps({ accessibilityRole: 'button' });
    const foodRow = categoryRows.find((r: any) => {
      const rowTexts = r.findAllByType(Text);
      return rowTexts.some((t: any) => t.props.children === 'Food & Dining');
    });

    expect(foodRow).toBeDefined();
    ReactTestRenderer.act(() => {
      foodRow.props.onPress();
    });

    expect(onSelectCategory).toHaveBeenCalledWith('Food & Dining');
  });

  it('filters categories when typing into the search box', () => {
    let testRenderer: any;
    ReactTestRenderer.act(() => {
      testRenderer = ReactTestRenderer.create(
        <CategorySelectorModal
          visible={true}
          onClose={jest.fn()}
          categories={mockCategories}
          onSelectCategory={jest.fn()}
          customCategory=""
          onChangeCustomCategory={jest.fn()}
          onAddCustomCategory={jest.fn()}
        />
      );
    });

    const root = testRenderer.root;
    const searchInputs = root.findAllByType(TextInput);
    const searchInput = searchInputs.find((i: any) => i.props.placeholder?.includes('Search or create'));

    expect(searchInput).toBeDefined();

    // Type "trans"
    ReactTestRenderer.act(() => {
      searchInput.props.onChangeText('trans');
    });

    // Should only match "Transport"
    const texts = root.findAllByType(Text);
    expect(texts.some((t: any) => t.props.children === 'Transport')).toBe(true);
    expect(texts.some((t: any) => t.props.children === 'Groceries')).toBe(false);
  });

  it('shows instant creation card when search query does not match any existing category', () => {
    const onAddCustomCategory = jest.fn();

    let testRenderer: any;
    ReactTestRenderer.act(() => {
      testRenderer = ReactTestRenderer.create(
        <CategorySelectorModal
          visible={true}
          onClose={jest.fn()}
          categories={mockCategories}
          onSelectCategory={jest.fn()}
          customCategory=""
          onChangeCustomCategory={jest.fn()}
          onAddCustomCategory={onAddCustomCategory}
        />
      );
    });

    const root = testRenderer.root;
    const searchInput = root.findAllByType(TextInput).find((i: any) => i.props.placeholder?.includes('Search or create'));

    ReactTestRenderer.act(() => {
      searchInput.props.onChangeText('Cryptocurrency');
    });

    // Should display instant create card
    const texts = root.findAllByType(Text);
    const instantCreateFound = texts.some((t: any) => {
      const children = t.props.children;
      if (typeof children === 'string') return children.includes('Cryptocurrency');
      if (Array.isArray(children)) return children.join('').includes('Cryptocurrency');
      return false;
    });
    expect(instantCreateFound).toBe(true);

    // Tap instant create
    const createCards = root.findAllByProps({ accessibilityRole: 'button' });
    const instantCard = createCards.find((c: any) => {
      const cardTexts = c.findAllByType(Text);
      return cardTexts.some((t: any) => {
        const ch = t.props.children;
        return typeof ch === 'string' ? ch.includes('Cryptocurrency') : Array.isArray(ch) && ch.join('').includes('Cryptocurrency');
      });
    });

    ReactTestRenderer.act(() => {
      instantCard.props.onPress();
    });

    expect(onAddCustomCategory).toHaveBeenCalledWith('Cryptocurrency');
  });

  it('submits new category from the bottom custom category input', () => {
    const onAddCustomCategory = jest.fn();
    const onChangeCustomCategory = jest.fn();

    let testRenderer: any;
    ReactTestRenderer.act(() => {
      testRenderer = ReactTestRenderer.create(
        <CategorySelectorModal
          visible={true}
          onClose={jest.fn()}
          categories={mockCategories}
          onSelectCategory={jest.fn()}
          customCategory="Pet Care"
          onChangeCustomCategory={onChangeCustomCategory}
          onAddCustomCategory={onAddCustomCategory}
        />
      );
    });

    const root = testRenderer.root;
    const addBtn = root.findAllByProps({ accessibilityLabel: 'Add category' })[0];
    expect(addBtn).toBeDefined();

    ReactTestRenderer.act(() => {
      addBtn.props.onPress();
    });

    expect(onAddCustomCategory).toHaveBeenCalled();
  });
});
