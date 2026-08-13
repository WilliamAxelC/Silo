import { useSettingsStore } from '../store/useSettingsStore';
import { lightTheme, darkTheme } from './colors';
import { spacing } from './spacing';
import { typography } from './typography';

export const useAppTheme = () => {
  const themeMode = useSettingsStore((state) => state.themeMode);
  const isDarkMode = themeMode === 'dark';
  const colors = isDarkMode ? darkTheme : lightTheme;
  return { ...colors, spacing, typography };
};
