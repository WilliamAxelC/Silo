import { useColorScheme } from 'react-native';
import { useSettingsStore } from '../store/useSettingsStore';
import { lightTheme, darkTheme } from './colors';
import { spacing } from './spacing';
import { typography } from './typography';

export const useAppTheme = () => {
  const themeMode = useSettingsStore((state) => state.themeMode);
  const systemColorScheme = useColorScheme();
  const isDarkMode = themeMode === 'system' ? systemColorScheme === 'dark' : themeMode === 'dark';
  const colors = isDarkMode ? darkTheme : lightTheme;
  return { ...colors, isDarkMode, spacing, typography };
};
