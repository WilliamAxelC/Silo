import { useSettingsStore } from '../store/useSettingsStore';
import { lightTheme, darkTheme } from './colors';

export const useAppTheme = () => {
  const isDarkMode = useSettingsStore((state) => state.isDarkMode);
  return isDarkMode ? darkTheme : lightTheme;
};