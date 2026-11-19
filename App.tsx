import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator } from './src/navigation/AppNavigator';
import { useAppTheme } from './src/theme/useAppTheme';
import ErrorBoundary from './src/components/ErrorBoundary';
import { AppLockGate } from './src/components/AppLockGate';

export default function App() {
  const { isDarkMode } = useAppTheme();

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <AppLockGate>
          <AppNavigator />
        </AppLockGate>
        <StatusBar style={isDarkMode ? 'light' : 'dark'} />
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
