import React, { useEffect } from 'react';
import { AppState, InteractionManager, Linking, StyleSheet, TouchableOpacity, View } from 'react-native';
import {
  NavigationContainer,
  DefaultTheme,
  DarkTheme,
  createNavigationContainerRef,
  useNavigation,
} from '@react-navigation/native';
import { addShareListener, takeSharedImages } from '../services/ocr/normalizeImage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NavigationProps } from './types';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import Ionicons from '@expo/vector-icons/Ionicons';

import { RootTabParamList, RootStackParamList } from './types';
import { useAppTheme } from '../theme/useAppTheme';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTransactionStore } from '../store/useTransactionStore';
import { getGenerationService } from '../services/ai/generationService';
import { getModelLifecycleManager } from '../services/ai/modelLifecycle';
import {
  configureNotificationHandler,
  getInitialNotificationDeepLink,
  subscribeToNotificationDeepLinks,
} from '../services/notifications';

import { CashflowScreen } from '../screens/CashflowScreen';
import { AddTransactionScreen } from '../screens/AddTransactionScreen';
import { ReportsScreen } from '../screens/ReportsScreen';
import { BudgetScreen } from '../screens/BudgetScreen';
import { MoreScreen } from '../screens/MoreScreen';
import { ChatbotScreen } from '../screens/ChatbotScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { SystemLogsScreen } from '../screens/SystemLogsScreen';
import { ReceiptInboxScreen } from '../screens/ReceiptInboxScreen';
import { AccountsScreen } from '../screens/AccountsScreen';
import { AccountDetailScreen } from '../screens/AccountDetailScreen';
import { ActivityScreen } from '../screens/ActivityScreen';
import { useReceiptQueueStore } from '../store/useReceiptQueueStore';
import { materializeDueRecurring } from '../services/recurring';
import { useUpdateStore } from '../services/updates';
import { runAutoBackupIfDue } from '../services/autoBackup';
import { RecurringScreen } from '../screens/RecurringScreen';
import { ReportScreen } from '../screens/ReportScreen';
import { PrivacyScreen } from '../screens/PrivacyScreen';
import { GoalsScreen } from '../screens/GoalsScreen';

/** How long after Silo goes to the background the AI model is released. */
const BACKGROUND_MODEL_UNLOAD_MS = 10_000;

const Tab = createBottomTabNavigator<RootTabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

export const APP_LINKING = {
  prefixes: ['silo://'],
  config: {
    screens: {
      MainTabs: { screens: { Cashflow: 'cashflow', Reports: 'reports', Budget: 'budget', More: 'more' } },
      Chatbot: 'chat',
      AddTransactionStack: 'add/:transactionId?',
      Settings: 'settings',
      SystemLogs: 'logs',
      ReceiptInbox: 'receipts',
      Accounts: 'accounts',
      AccountDetail: 'accounts/:walletId',
      Activity: 'activity',
      Recurring: 'recurring',
      Report: 'report',
      Privacy: 'privacy',
      Goals: 'goals',
    },
  },
  async getInitialURL() {
    const initialUrl = await Linking.getInitialURL();
    if (initialUrl != null) {
      return initialUrl;
    }
    try {
      return await getInitialNotificationDeepLink();
    } catch {
      return null;
    }
  },
  subscribe(listener: (url: string) => void) {
    const linkingSub = Linking.addEventListener('url', ({ url }) => {
      listener(url);
    });
    let unsubscribeNotifications = () => {};
    try {
      unsubscribeNotifications = subscribeToNotificationDeepLinks(listener);
    } catch {
      // Notifications native module unavailable; URL linking continues to work.
    }
    return () => {
      linkingSub.remove();
      try {
        unsubscribeNotifications();
      } catch {
        // Ignore teardown errors when native notifications are unavailable.
      }
    };
  },
};

const navigationRef = createNavigationContainerRef<RootStackParamList>();

/**
 * Receipts shared to Silo from Gallery or any app: one photo opens a scan on Add Transaction,
 * several go to the Receipt Inbox (scanned and read in the background).
 */
async function handleSharedReceipts() {
  const uris = await takeSharedImages();
  if (uris.length === 0 || !navigationRef.isReady()) return;
  if (uris.length === 1) {
    navigationRef.navigate('AddTransactionStack', { sharedImageUri: uris[0] });
    return;
  }
  await useReceiptQueueStore.getState().enqueue(uris, { scan: true });
  navigationRef.navigate('ReceiptInbox');
}

const TabNavigator = () => {
  const theme = useAppTheme();
  const globalNav = useNavigation<NavigationProps>();
  const insets = useSafeAreaInsets();
  // Extra room under the labels so they clear the phone's gesture bar / nav buttons.
  const bottomInset = Math.max(insets.bottom, 8) + 10;
  const tabBarHeight = 62 + bottomInset;

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        sceneStyle: { backgroundColor: theme.background },
        tabBarActiveTintColor: theme.primary,
        tabBarInactiveTintColor: theme.textMuted,
        tabBarStyle: [styles.tabBar, { backgroundColor: theme.surface, borderTopColor: theme.border, height: tabBarHeight, paddingBottom: bottomInset }],
        tabBarItemStyle: { paddingTop: 6 },
        tabBarLabelStyle: { paddingBottom: 4 },
        tabBarIcon: ({ focused, color, size }) => {
          let iconName: keyof typeof Ionicons.glyphMap = 'help';

          if (route.name === 'Cashflow') {
            iconName = focused ? 'wallet' : 'wallet-outline';
          } else if (route.name === 'Reports') {
            iconName = focused ? 'pie-chart' : 'pie-chart-outline';
          } else if (route.name === 'Budget') {
            iconName = focused ? 'calculator' : 'calculator-outline';
          } else if (route.name === 'More') {
            iconName = focused ? 'grid' : 'grid-outline';
          }

          return <Ionicons name={iconName} size={size} color={color} />;
        },
      })}
    >
      <Tab.Screen name="Cashflow" component={CashflowScreen} />
      <Tab.Screen name="Reports" component={ReportsScreen} />

      <Tab.Screen
        name="Add"
        component={View}
        options={{
          tabBarLabel: '',
          tabBarButton: () => (
            <View style={styles.addButtonWrap} pointerEvents="box-none">
              <TouchableOpacity
                testID="tab-add-button"
                style={[styles.customButton, { backgroundColor: theme.primary, borderColor: theme.surface }]}
                onPress={() => globalNav.navigate('AddTransactionStack', {})}
                accessibilityRole="button"
                accessibilityLabel="Add transaction"
              >
                <Ionicons name="add" size={34} color={theme.onPrimary} />
              </TouchableOpacity>
            </View>
          ),
        }}
      />

      <Tab.Screen name="Budget" component={BudgetScreen} />
      <Tab.Screen name="More" component={MoreScreen} />
    </Tab.Navigator>
  );
};

export const AppNavigator = () => {
  const loadSettings = useSettingsStore((state) => state.loadSettings);
  const theme = useAppTheme();
  const isDarkMode = theme.isDarkMode;

  useEffect(() => {
    try {
      configureNotificationHandler();
    } catch {
      // Ignore notification handler setup errors on builds without native notifications.
    }
    loadSettings();
    void getModelLifecycleManager().hydratePersistedState?.();
    const runRecurring = async () => {
      const store = useTransactionStore.getState();
      try {
        if ((await materializeDueRecurring(store.addTransaction)) > 0) await store.fetchTransactions();
      } catch (error) {
        console.warn('Recurring transactions failed:', error);
      }
    };
    void useTransactionStore
      .getState()
      .initDB()
      .then(runRecurring)
      .then(() => {
        // New-version notice: reads a small static file from the download page at most once a day.
        useUpdateStore.getState().hydrate();
        void useUpdateStore.getState().check();
        // Today's automatic backup, a few seconds after startup so it never slows the first screen.
        setTimeout(() => void runAutoBackupIfDue(), 5000);
      });
    useReceiptQueueStore.getState().load();
    const removeShareListener = addShareListener(() => void handleSharedReceipts());
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void runRecurring();
        void handleSharedReceipts();
        void useUpdateStore.getState().check();
      }
      // Free the on-device AI model's memory (~1 GB) soon after Silo leaves the screen, unless the
      // Receipt Inbox is still reading receipts in the background (it frees it when it finishes).
      if (state === 'background' && !useReceiptQueueStore.getState().isProcessing) {
        void getGenerationService().scheduleModelUnload(BACKGROUND_MODEL_UNLOAD_MS);
      }
    });
    const modelInitHandle = InteractionManager.runAfterInteractions(() => {
      void getModelLifecycleManager().initialize();
    });

    return () => {
      modelInitHandle?.cancel?.();
      appStateSub.remove();
      removeShareListener();
      void getGenerationService().dispose();
      getModelLifecycleManager().dispose();
    };
  }, []);

  const navigationTheme = {
    ...(isDarkMode ? DarkTheme : DefaultTheme),
    dark: isDarkMode,
    colors: {
      ...(isDarkMode ? DarkTheme.colors : DefaultTheme.colors),
      primary: theme.primary,
      background: theme.background,
      card: theme.surface,
      text: theme.text,
      border: theme.border,
      notification: theme.primary,
    },
  };

  return (
    <View style={[styles.appShell, { backgroundColor: theme.background }]}>
      <NavigationContainer
        ref={navigationRef}
        theme={navigationTheme}
        linking={APP_LINKING as any}
        onReady={() => void handleSharedReceipts()}
      >
        <Stack.Navigator
          initialRouteName="MainTabs"
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: theme.background },
            animation: 'slide_from_right',
          }}
        >
          <Stack.Screen name="MainTabs" component={TabNavigator} />
          <Stack.Screen name="Chatbot" component={ChatbotScreen} />
          <Stack.Screen name="AddTransactionStack" component={AddTransactionScreen} />
          <Stack.Screen name="Settings" component={SettingsScreen} />
          <Stack.Screen name="SystemLogs" component={SystemLogsScreen} />
          <Stack.Screen name="ReceiptInbox" component={ReceiptInboxScreen} />
          <Stack.Screen name="Accounts" component={AccountsScreen} />
          <Stack.Screen name="AccountDetail" component={AccountDetailScreen} />
          <Stack.Screen name="Activity" component={ActivityScreen} />
          <Stack.Screen name="Recurring" component={RecurringScreen} />
          <Stack.Screen name="Report" component={ReportScreen} />
          <Stack.Screen name="Privacy" component={PrivacyScreen} />
          <Stack.Screen name="Goals" component={GoalsScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </View>
  );
};

const styles = StyleSheet.create({
  appShell: { flex: 1 },
  tabBar: {
    elevation: 0,
    overflow: 'visible',
    borderTopWidth: 1,
    paddingTop: 6,
  },
  addButtonWrap: {
    flex: 1,
    alignItems: 'center',
    overflow: 'visible',
  },
  // Larger than the tab icons and lifted half out of the bar, with a ring in the bar colour.
  customButton: {
    width: 62,
    height: 62,
    borderRadius: 31,
    borderWidth: 4,
    marginTop: -24,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 5,
  },
});
