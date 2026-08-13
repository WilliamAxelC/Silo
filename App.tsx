import React from 'react';
import { LogBox } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator } from './src/navigation/AppNavigator';
import { useSettingsStore } from './src/store/useSettingsStore';
import ErrorBoundary from './src/components/ErrorBoundary';

if (__DEV__) {
  LogBox.ignoreAllLogs(true);
}

export default function App() {
  const isDarkMode = useSettingsStore((state) => state.isDarkMode);

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <AppNavigator />
        <StatusBar style={isDarkMode ? 'light' : 'dark'} />
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
