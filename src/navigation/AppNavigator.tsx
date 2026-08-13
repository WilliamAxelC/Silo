import React, { useEffect } from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme, useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NavigationProps } from './types';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';

import { RootTabParamList, RootStackParamList } from './types';
import { useAppTheme } from '../theme/useAppTheme';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTransactionStore } from '../store/useTransactionStore';
import { getGenerationService } from '../services/ai/generationService';
import { getModelLifecycleManager } from '../services/ai/modelLifecycle';

import { CashflowScreen } from '../screens/CashflowScreen';
import { AddTransactionScreen } from '../screens/AddTransactionScreen';
import { ReportsScreen } from '../screens/ReportsScreen';
import { BudgetScreen } from '../screens/BudgetScreen';
import { MoreScreen } from '../screens/MoreScreen';
import { ChatbotScreen } from '../screens/ChatbotScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { SystemLogsScreen } from '../screens/SystemLogsScreen';

const Tab = createBottomTabNavigator<RootTabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

const TabNavigator = () => {
  const theme = useAppTheme();
  const globalNav = useNavigation<NavigationProps>();
  const insets = useSafeAreaInsets();
  const bottomInset = Math.max(insets.bottom, 10);
  const tabBarHeight = 60 + bottomInset;

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
            <View style={[styles.addButtonWrap, { bottom: Math.max(insets.bottom - 6, 0) }]} pointerEvents="box-none">
              <TouchableOpacity
                style={[styles.customButton, { backgroundColor: theme.primary }]}
                onPress={() => globalNav.navigate('AddTransactionStack', {})}
                accessibilityRole="button"
                accessibilityLabel="Add transaction"
              >
                <Ionicons name="add" size={32} color="#fff" />
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
  const isDarkMode = useSettingsStore((state) => state.isDarkMode);
  const loadSettings = useSettingsStore((state) => state.loadSettings);
  const theme = useAppTheme();

  useEffect(() => {
    loadSettings();
    useTransactionStore.getState().initDB();

    return () => {
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

  const linking = {
    prefixes: ['silo://', 'https://silo.app'],
    config: {
      screens: {
        MainTabs: { screens: { Cashflow: 'cashflow', Reports: 'reports', Budget: 'budget', More: 'more' } },
        Chatbot: 'chat',
        AddTransactionStack: 'add/:transactionId?',
        Settings: 'settings',
      },
    },
  };

  return (
    <View style={[styles.appShell, { backgroundColor: theme.background }]}>
      <NavigationContainer theme={navigationTheme} linking={linking}>
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
        </Stack.Navigator>
      </NavigationContainer>
    </View>
  );
};

const styles = StyleSheet.create({
  appShell: { flex: 1 },
  tabBar: {
    position: 'absolute',
    bottom: 0,
    elevation: 0,
    borderTopWidth: 1,
    paddingTop: 6,
  },
  addButtonWrap: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  customButton: {
    width: 60,
    height: 60,
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
  },
});
