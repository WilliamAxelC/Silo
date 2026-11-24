import React from 'react';
import { StyleSheet, Text, TextInput } from 'react-native';
import { ActiveFilterChips, IconToggle, ListToolbar } from '../ListToolbar';
import { EMPTY_FILTERS } from '../../features/transactions/filters';
import { useSettingsStore } from '../../store/useSettingsStore';

const ReactTestRenderer = require('react-test-renderer');

function Harness({ initialQuery = '', count = 0, placement }: { initialQuery?: string; count?: number; placement?: 'inline' | 'below' }) {
  const [query, setQuery] = React.useState(initialQuery);
  return (
    <ListToolbar
      leading={<Text>LEADING</Text>}
      searchQuery={query}
      onChangeSearch={setQuery}
      searchPlaceholder="Search"
      searchPlacement={placement}
      activeFilterCount={count}
      onOpenFilters={jest.fn()}
    />
  );
}

const bg = (node: any) => StyleSheet.flatten(node.props.style).backgroundColor;

describe('ListToolbar', () => {
  beforeEach(() => {
    useSettingsStore.setState({ fontScale: 1, themeMode: 'light' } as any);
  });

  it('keeps search collapsed to an icon until tapped, then opens a box; closing clears the text', () => {
    let r: any;
    ReactTestRenderer.act(() => {
      r = ReactTestRenderer.create(<Harness />);
    });
    expect(r.root.findAllByType(TextInput)).toHaveLength(0);

    ReactTestRenderer.act(() => {
      r.root.findByProps({ accessibilityLabel: 'Open search' }).props.onPress();
    });
    const input = r.root.findByType(TextInput);
    ReactTestRenderer.act(() => input.props.onChangeText('kopi'));
    expect(r.root.findByType(TextInput).props.value).toBe('kopi');

    ReactTestRenderer.act(() => {
      r.root.findAllByProps({ accessibilityLabel: 'Close search' })[0].props.onPress();
    });
    expect(r.root.findAllByType(TextInput)).toHaveLength(0);
    ReactTestRenderer.act(() => r.unmount());
  });

  it('stays open while a search is active, so a hidden query never filters silently', () => {
    let r: any;
    ReactTestRenderer.act(() => {
      r = ReactTestRenderer.create(<Harness initialQuery="#date" />);
    });
    expect(r.root.findByType(TextInput).props.value).toBe('#date');
    ReactTestRenderer.act(() => r.unmount());
  });

  it('shows the Filters button as switched on, in colour with a count, when filters are active', () => {
    let off: any;
    let on: any;
    ReactTestRenderer.act(() => {
      off = ReactTestRenderer.create(<Harness count={0} />);
      on = ReactTestRenderer.create(<Harness count={2} />);
    });
    const offBtn = off.root.findByProps({ testID: 'toolbar-filter-button' });
    const onBtn = on.root.findByProps({ testID: 'toolbar-filter-button' });
    expect(bg(onBtn)).not.toBe(bg(offBtn));
    expect(onBtn.props.accessibilityLabel).toBe('Filters, 2 on');
    expect(onBtn.props.accessibilityState).toEqual({ selected: true });
    expect(on.root.findAllByType(Text).some((t: any) => t.props.children === 2)).toBe(true);
    expect(offBtn.props.accessibilityLabel).toBe('Filters');
    ReactTestRenderer.act(() => {
      off.unmount();
      on.unmount();
    });
  });

  it("places the search box under the row with placement 'below', keeping the leading control", () => {
    let r: any;
    ReactTestRenderer.act(() => {
      r = ReactTestRenderer.create(<Harness placement="below" />);
    });
    ReactTestRenderer.act(() => {
      r.root.findByProps({ accessibilityLabel: 'Open search' }).props.onPress();
    });
    expect(r.root.findByType(TextInput)).toBeTruthy();
    expect(r.root.findAllByType(Text).some((t: any) => t.props.children === 'LEADING')).toBe(true);
    ReactTestRenderer.act(() => r.unmount());
  });

  it('lists active filters as chips that remove themselves on tap', () => {
    const onChange = jest.fn();
    let r: any;
    ReactTestRenderer.act(() => {
      r = ReactTestRenderer.create(
        <ActiveFilterChips
          filters={{ ...EMPTY_FILTERS, walletId: 2, tag: 'date' }}
          onChange={onChange}
          walletNames={new Map([[2, 'GoPay']])}
        />
      );
    });
    ReactTestRenderer.act(() => {
      r.root.findByProps({ accessibilityLabel: 'Remove filter GoPay' }).props.onPress();
    });
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS, walletId: null, tag: 'date' });
    expect(r.root.findByProps({ accessibilityLabel: 'Remove filter #date' })).toBeTruthy();
    ReactTestRenderer.act(() => r.unmount());
  });

  it('renders nothing when no filter is on', () => {
    let r: any;
    ReactTestRenderer.act(() => {
      r = ReactTestRenderer.create(<ActiveFilterChips filters={EMPTY_FILTERS} onChange={jest.fn()} walletNames={new Map()} />);
    });
    expect(r.toJSON()).toBeNull();
    ReactTestRenderer.act(() => r.unmount());
  });

  it('icon toggle marks the selected option', () => {
    const onChange = jest.fn();
    let r: any;
    ReactTestRenderer.act(() => {
      r = ReactTestRenderer.create(
        <IconToggle
          value="list"
          onChange={onChange}
          options={[
            { key: 'list', icon: 'list', label: 'List view' },
            { key: 'calendar', icon: 'calendar-outline', label: 'Calendar view' },
          ]}
        />
      );
    });
    expect(r.root.findByProps({ accessibilityLabel: 'List view' }).props.accessibilityState).toEqual({ selected: true });
    ReactTestRenderer.act(() => r.root.findByProps({ accessibilityLabel: 'Calendar view' }).props.onPress());
    expect(onChange).toHaveBeenCalledWith('calendar');
    ReactTestRenderer.act(() => r.unmount());
  });

  // Reported 2026-11-24: the Reports Expenses/Income toggle was squeezed ("Expense/s" wrapped) because a
  // spacer shared the row with it. leadingFills drops the spacer; iconOnlyFilters frees more width.
  it('regression: lets a wide leading control fill the row and shows Filters as an icon with its badge', () => {
    let r: any;
    ReactTestRenderer.act(() => {
      r = ReactTestRenderer.create(
        <ListToolbar
          leading={<Text>TOGGLE</Text>}
          leadingFills
          iconOnlyFilters
          searchQuery=""
          onChangeSearch={jest.fn()}
          searchPlaceholder="Search"
          searchPlacement="below"
          activeFilterCount={2}
          onOpenFilters={jest.fn()}
        />
      );
    });
    const row = r.root.findByProps({ testID: 'list-toolbar' }).children[0];
    const flexKids = row.children.filter((c: any) => StyleSheet.flatten(c.props?.style)?.flex === 1);
    expect(flexKids).toHaveLength(0); // no spacer competing with the leading control
    const words = r.root.findAllByType(Text).map((t: any) => t.props.children);
    expect(words).not.toContain('Filters');
    expect(r.root.findByProps({ testID: 'toolbar-filter-button' }).props.accessibilityLabel).toBe('Filters, 2 on');
    expect(words).toContain(2);
    ReactTestRenderer.act(() => r.unmount());
  });
});
