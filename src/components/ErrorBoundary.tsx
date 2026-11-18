import React, { Component, ErrorInfo, ReactNode } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Appearance } from 'react-native';
import { lightTheme, darkTheme } from '../theme/colors';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      const isDark = Appearance.getColorScheme() === 'dark';
      const palette = isDark ? darkTheme : lightTheme;

      return (
        <View style={[styles.container, { backgroundColor: palette.background }]}>
          <Text style={[styles.title, { color: palette.text }]}>Something went wrong</Text>
          {__DEV__ && this.state.error && (
            <Text style={[styles.errorText, { color: palette.expense }]}>{this.state.error.toString()}</Text>
          )}
          <TouchableOpacity
            style={[styles.button, { backgroundColor: palette.primary }]}
            onPress={() => this.setState({ hasError: false })}
            accessibilityRole="button"
            accessibilityLabel="Restart"
          >
            <Text style={[styles.buttonText, { color: palette.onPrimary }]}>Restart</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  errorText: {
    fontSize: 14,
    marginBottom: 20,
    textAlign: 'center',
  },
  button: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonText: {
    fontWeight: 'bold',
  },
});
