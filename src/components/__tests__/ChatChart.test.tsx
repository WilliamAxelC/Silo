import React from 'react';
import { ChatChart } from '../ChatChart';

const ReactTestRenderer = require('react-test-renderer');

jest.mock('react-native-gifted-charts', () => {
  const React = require('react');
  return {
    BarChart: (props: any) => React.createElement('BarChart', props),
    LineChart: (props: any) => React.createElement('LineChart', props),
    PieChart: (props: any) => React.createElement('PieChart', props),
  };
});

describe('ChatChart Component', () => {
  it('returns null when chart data array is empty', () => {
    let testRenderer: any;
    ReactTestRenderer.act(() => {
      testRenderer = ReactTestRenderer.create(<ChatChart type="bar" data="[]" />);
    });

    expect(testRenderer.toJSON()).toBeNull();
  });

  it('renders error preview when JSON data is malformed or invalid', () => {
    let testRenderer: any;
    ReactTestRenderer.act(() => {
      testRenderer = ReactTestRenderer.create(<ChatChart type="bar" data="not a json string" />);
    });

    const root = testRenderer.root;
    const texts = root.findAllByType('Text');
    expect(texts.some((t: any) => t.props.children === 'Unable to display chart preview.')).toBe(true);
  });

  it('handles HTML entity encoded JSON string (&quot;)', () => {
    const rawData = '[{&quot;value&quot;: 50000, &quot;label&quot;: &quot;Groceries&quot;}]';
    let testRenderer: any;
    ReactTestRenderer.act(() => {
      testRenderer = ReactTestRenderer.create(<ChatChart type="bar" data={rawData} />);
    });

    const root = testRenderer.root;
    const barChart = root.findByType('BarChart');
    expect(barChart.props.data).toEqual([{ value: 50000, label: 'Groceries' }]);
  });

  it('handles single-entry budget/spending item for bar chart', () => {
    const singleData = JSON.stringify([{ value: 75000, label: 'Coffee' }]);
    let testRenderer: any;
    ReactTestRenderer.act(() => {
      testRenderer = ReactTestRenderer.create(<ChatChart type="bar" data={singleData} />);
    });

    const root = testRenderer.root;
    const barChart = root.findByType('BarChart');
    expect(barChart.props.data.length).toBe(1);
    expect(barChart.props.data[0].value).toBe(75000);
  });

  it('handles plain number array format by generating 1-based index labels', () => {
    const numberArrayData = JSON.stringify([10000, 25000, 45000]);
    let testRenderer: any;
    ReactTestRenderer.act(() => {
      testRenderer = ReactTestRenderer.create(<ChatChart type="line" data={numberArrayData} />);
    });

    const root = testRenderer.root;
    const lineChart = root.findByType('LineChart');
    expect(lineChart.props.data).toEqual([
      { value: 10000, label: '1' },
      { value: 25000, label: '2' },
      { value: 45000, label: '3' },
    ]);
  });

  it('parses string values inside data items safely into numbers', () => {
    const stringValData = JSON.stringify([
      { value: '150.50', label: 'Item 1' },
      { value: 'invalid', label: 'Item 2' },
    ]);
    let testRenderer: any;
    ReactTestRenderer.act(() => {
      testRenderer = ReactTestRenderer.create(<ChatChart type="bar" data={stringValData} />);
    });

    const root = testRenderer.root;
    const barChart = root.findByType('BarChart');
    expect(barChart.props.data[0].value).toBe(150.5);
    expect(barChart.props.data[1].value).toBe(0);
  });

  it('renders PieChart with palette colors and legend for pie type', () => {
    const pieData = JSON.stringify([
      { value: 50000, label: 'Food' },
      { value: 20000, label: 'Transport' },
    ]);
    let testRenderer: any;
    ReactTestRenderer.act(() => {
      testRenderer = ReactTestRenderer.create(<ChatChart type="pie" data={pieData} />);
    });

    const root = testRenderer.root;
    const pieChart = root.findByType('PieChart');
    expect(pieChart.props.data.length).toBe(2);
    expect(pieChart.props.data[0].color).toBeDefined();
    expect(pieChart.props.data[0].text).toBe('Food');
  });

  it('handles negative and zero values safely in charts', () => {
    const mixedData = JSON.stringify([
      { value: 0, label: 'Zero' },
      { value: -50000, label: 'Negative Expense' },
    ]);
    let testRenderer: any;
    ReactTestRenderer.act(() => {
      testRenderer = ReactTestRenderer.create(<ChatChart type="bar" data={mixedData} />);
    });

    const root = testRenderer.root;
    const barChart = root.findByType('BarChart');
    expect(barChart.props.data[0].value).toBe(0);
    expect(barChart.props.data[1].value).toBe(-50000);
  });
});
