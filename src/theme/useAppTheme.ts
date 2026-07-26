import { useSettingsStore } from '../store/useSettingsStore';
import { lightTheme, darkTheme } from './colors';

export const useAppTheme = () => {
  const themeMode = useSettingsStore((state) => state.themeMode);
  const isDarkMode = themeMode === 'dark';
  return isDarkMode ? darkTheme : lightTheme;
};
