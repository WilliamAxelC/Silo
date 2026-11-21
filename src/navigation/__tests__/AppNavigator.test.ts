import { Linking } from 'react-native';

const mockModelHydrate = jest.fn(async () => {});
const mockModelInitialize = jest.fn(async () => {});
const mockModelDispose = jest.fn();

jest.mock('@react-navigation/native', () => ({
  NavigationContainer: ({ children }: any) => children,
  DefaultTheme: { dark: false, colors: {} },
  DarkTheme: { dark: true, colors: {} },
  useNavigation: () => ({ navigate: jest.fn() }),
}));

jest.mock('@react-navigation/bottom-tabs', () => ({
  createBottomTabNavigator: () => ({ Navigator: 'TabNavigator', Screen: 'TabScreen' }),
}));

jest.mock('@react-navigation/native-stack', () => ({
  createNativeStackNavigator: () => ({ Navigator: 'StackNavigator', Screen: 'StackScreen' }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('../../screens/CashflowScreen', () => ({ CashflowScreen: () => null }));
jest.mock('../../screens/AddTransactionScreen', () => ({ AddTransactionScreen: () => null }));
jest.mock('../../screens/ReportsScreen', () => ({ ReportsScreen: () => null }));
jest.mock('../../screens/BudgetScreen', () => ({ BudgetScreen: () => null }));
jest.mock('../../screens/MoreScreen', () => ({ MoreScreen: () => null }));
jest.mock('../../screens/ChatbotScreen', () => ({ ChatbotScreen: () => null }));
jest.mock('../../screens/SettingsScreen', () => ({ SettingsScreen: () => null }));
jest.mock('../../screens/SystemLogsScreen', () => ({ SystemLogsScreen: () => null }));
jest.mock('../../screens/ReceiptInboxScreen', () => ({ ReceiptInboxScreen: () => null }));
jest.mock('../../screens/AccountsScreen', () => ({ AccountsScreen: () => null }));
jest.mock('../../screens/RecurringScreen', () => ({ RecurringScreen: () => null }));
jest.mock('../../services/ai/generationService', () => ({
  getGenerationService: () => ({ dispose: jest.fn() }),
}));
jest.mock('../../services/ai/modelLifecycle', () => ({
  getModelLifecycleManager: () => ({
    hydratePersistedState: mockModelHydrate,
    initialize: mockModelInitialize,
    ensureInitialized: mockModelInitialize,
    dispose: mockModelDispose,
  }),
}));
jest.mock('../../services/recurring', () => ({
  materializeDueRecurring: jest.fn(async () => 0),
}));

describe('AppNavigator notification linking & startup safety (R2B-1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('imports AppNavigator and runs APP_LINKING safely when expo-notifications native module is missing', async () => {
    const originalNotificationsMock = require('expo-notifications');
    let linkingUrlHandler: ((event: { url: string }) => void) | undefined;
    const removeLinkingSub = jest.fn();

    const throwingFactory = jest.fn(() => {
      throw new Error("Cannot find native module 'ExpoNotificationsEmitter'");
    });

    try {
      jest.resetModules();
      jest.doMock('expo-notifications', throwingFactory);
      const { Linking: isolatedLinking } = require('react-native');
      jest.spyOn(isolatedLinking, 'getInitialURL').mockResolvedValue(null);
      jest.spyOn(isolatedLinking, 'addEventListener').mockImplementation(((_type: string, cb: any) => {
        linkingUrlHandler = cb;
        return { remove: removeLinkingSub };
      }) as any);

      const isolatedNav = require('../AppNavigator') as typeof import('../AppNavigator');

      // Must NOT import expo-notifications on startup module load.
      expect(throwingFactory).not.toHaveBeenCalled();

      await expect(isolatedNav.APP_LINKING.getInitialURL()).resolves.toBeNull();
      expect(throwingFactory).toHaveBeenCalledTimes(1);

      const listener = jest.fn();
      const unsubscribe = isolatedNav.APP_LINKING.subscribe(listener);
      linkingUrlHandler?.({ url: 'silo://add' });
      expect(listener).toHaveBeenCalledWith('silo://add');

      expect(() => unsubscribe()).not.toThrow();
      expect(removeLinkingSub).toHaveBeenCalledTimes(1);
    } finally {
      jest.resetModules();
      jest.doMock('expo-notifications', () => originalNotificationsMock);
    }
  });

  it('guards APP_LINKING.getInitialURL and subscribe when expo-notifications methods throw UnavailabilityError', async () => {
    const { Linking: currentLinking } = require('react-native');
    const Notifications = require('expo-notifications');
    const removeLinkingSub = jest.fn();
    jest.spyOn(currentLinking, 'getInitialURL').mockResolvedValue(null);
    jest.spyOn(currentLinking, 'addEventListener').mockReturnValue({ remove: removeLinkingSub } as any);

    const { APP_LINKING } = require('../AppNavigator') as typeof import('../AppNavigator');

    (Notifications.getLastNotificationResponse as jest.Mock).mockImplementationOnce(() => {
      throw new Error("UnavailabilityError: 'getLastNotificationResponse' is not available");
    });
    await expect(APP_LINKING.getInitialURL()).resolves.toBeNull();

    (Notifications.addNotificationResponseReceivedListener as jest.Mock).mockImplementationOnce(() => {
      throw new Error("UnavailabilityError: 'addNotificationResponseReceivedListener' is not available");
    });
    const unsubscribe = APP_LINKING.subscribe(jest.fn());
    expect(() => unsubscribe()).not.toThrow();
    expect(removeLinkingSub).toHaveBeenCalledTimes(1);
  });

  it('routes silo://add on cold-launch and live notification tap when notifications are available', async () => {
    const { Linking: currentLinking } = require('react-native');
    const Notifications = require('expo-notifications');
    const removeLinkingSub = jest.fn();
    const removeNotifSub = jest.fn();
    let notifResponseCb: ((response: any) => void) | undefined;

    jest.spyOn(currentLinking, 'getInitialURL').mockResolvedValue(null);
    jest.spyOn(currentLinking, 'addEventListener').mockReturnValue({ remove: removeLinkingSub } as any);
    (Notifications.getLastNotificationResponse as jest.Mock).mockReturnValueOnce({
      notification: { request: { content: { data: { url: 'silo://add', kind: 'daily-reminder' } } } },
    });
    (Notifications.addNotificationResponseReceivedListener as jest.Mock).mockImplementationOnce((cb: any) => {
      notifResponseCb = cb;
      return { remove: removeNotifSub };
    });

    const { APP_LINKING } = require('../AppNavigator') as typeof import('../AppNavigator');

    await expect(APP_LINKING.getInitialURL()).resolves.toBe('silo://add');
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);

    const listener = jest.fn();
    const unsubscribe = APP_LINKING.subscribe(listener);
    notifResponseCb?.({
      notification: { request: { content: { data: { url: 'silo://add', kind: 'daily-reminder' } } } },
    });
    expect(listener).toHaveBeenCalledWith('silo://add');

    unsubscribe();
    expect(removeLinkingSub).toHaveBeenCalledTimes(1);
    expect(removeNotifSub).toHaveBeenCalledTimes(1);
  });

  it('defers modelLifecycle.initialize() until after first interactions and cancels on unmount', async () => {
    const freshReact = require('react');
    const FreshRenderer = require('react-test-renderer');
    const { AppState: freshAppState, InteractionManager: freshInteractionManager } = require('react-native');

    let scheduledTask: (() => void) | null = null;
    const cancelSpy = jest.fn();
    jest.spyOn(freshInteractionManager, 'runAfterInteractions').mockImplementation((cb: any) => {
      scheduledTask = cb;
      return { cancel: cancelSpy, then: jest.fn(), done: jest.fn() } as any;
    });
    jest.spyOn(freshAppState, 'addEventListener').mockReturnValue({ remove: jest.fn() } as any);

    const { useSettingsStore } = require('../../store/useSettingsStore');
    const { useTransactionStore } = require('../../store/useTransactionStore');
    const { useReceiptQueueStore } = require('../../store/useReceiptQueueStore');
    jest.spyOn(useSettingsStore.getState(), 'loadSettings').mockResolvedValue(undefined);
    jest.spyOn(useTransactionStore.getState(), 'initDB').mockResolvedValue(undefined);
    jest.spyOn(useReceiptQueueStore.getState(), 'load').mockImplementation(() => {});

    const { AppNavigator } = require('../AppNavigator') as typeof import('../AppNavigator');

    let renderer: any;
    await FreshRenderer.act(async () => {
      renderer = FreshRenderer.create(freshReact.createElement(AppNavigator));
    });

    // Eagerly hydrates small persisted provisioning manifests on mount, while deferring full
    // modelLifecycle.initialize() (directory setup, verification/download recovery, AppState) until after interactions
    expect(mockModelHydrate).toHaveBeenCalledTimes(1);
    expect(mockModelInitialize).not.toHaveBeenCalled();
    expect(scheduledTask).toEqual(expect.any(Function));

    // Once interactions settle, modelLifecycle.initialize() runs
    await FreshRenderer.act(async () => {
      scheduledTask?.();
    });
    expect(mockModelInitialize).toHaveBeenCalledTimes(1);

    await FreshRenderer.act(async () => {
      renderer.unmount();
    });
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });
});
