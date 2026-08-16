import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import ErrorBoundary from '../ErrorBoundary';

const ReactTestRenderer = require('react-test-renderer');

function ProblemChild({ shouldThrow }: { shouldThrow?: boolean }) {
  if (shouldThrow) {
    throw new Error('Test Component Explosion');
  }
  return <Text>Normal Child Render</Text>;
}

describe('ErrorBoundary Component', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders children normally when no error is thrown', () => {
    let testRenderer: any;
    ReactTestRenderer.act(() => {
      testRenderer = ReactTestRenderer.create(
        <ErrorBoundary>
          <ProblemChild shouldThrow={false} />
        </ErrorBoundary>
      );
    });

    const texts = testRenderer.root.findAllByType(Text);
    expect(texts.some((t: any) => t.props.children === 'Normal Child Render')).toBe(true);
  });

  it('catches render errors, reports to console.error, and displays error fallback UI', () => {
    let testRenderer: any;
    ReactTestRenderer.act(() => {
      testRenderer = ReactTestRenderer.create(
        <ErrorBoundary>
          <ProblemChild shouldThrow={true} />
        </ErrorBoundary>
      );
    });

    expect(consoleErrorSpy).toHaveBeenCalled();
    const texts = testRenderer.root.findAllByType(Text);
    expect(texts.some((t: any) => t.props.children === 'Something went wrong')).toBe(true);
    expect(texts.some((t: any) => t.props.children === 'Restart')).toBe(true);
  });

  it('resets error state when Restart button is clicked', () => {
    let testRenderer: any;
    let throwError = true;

    function DynamicChild() {
      if (throwError) {
        throw new Error('Temporary failure');
      }
      return <Text>Recovered</Text>;
    }

    ReactTestRenderer.act(() => {
      testRenderer = ReactTestRenderer.create(
        <ErrorBoundary>
          <DynamicChild />
        </ErrorBoundary>
      );
    });

    let texts = testRenderer.root.findAllByType(Text);
    expect(texts.some((t: any) => t.props.children === 'Something went wrong')).toBe(true);

    // Now fix the underlying cause and trigger restart
    throwError = false;
    const button = testRenderer.root.findByType(TouchableOpacity);
    ReactTestRenderer.act(() => {
      button.props.onPress();
    });

    texts = testRenderer.root.findAllByType(Text);
    expect(texts.some((t: any) => t.props.children === 'Recovered')).toBe(true);
  });
});
