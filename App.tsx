import React, { useEffect } from 'react';
import { Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as NavigationBar from 'expo-navigation-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator } from './src/navigation/AppNavigator';
import { useAppTheme } from './src/theme/useAppTheme';
import ErrorBoundary from './src/components/ErrorBoundary';
import { AppLockGate } from './src/components/AppLockGate';

export default function App() {
  const { isDarkMode } = useAppTheme();

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    try {
      void NavigationBar.setButtonStyleAsync?.(isDarkMode ? 'light' : 'dark')?.catch?.(() => undefined);
    } catch {
      // Ignore if native navigation bar module is unavailable in the current environment.
    }
  }, [isDarkMode]);

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
