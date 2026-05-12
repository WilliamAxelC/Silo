import { create } from 'zustand';

interface SettingsState {
  isDarkMode: boolean;
  setIsDarkMode: (isDark: boolean) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  isDarkMode: false,
  setIsDarkMode: (isDark) => set({ isDarkMode: isDark }),
}));