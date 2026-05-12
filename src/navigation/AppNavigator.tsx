import React, { useEffect } from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme, useNavigation } from '@react-navigation/native';
import { NavigationProps } from './types';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';

import { RootTabParamList, RootStackParamList } from './types';
import { useAppTheme } from '../theme/useAppTheme';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTransactionStore } from '../store/useTransactionStore'; // NEW: Import to boot DB

// Import Screens
import { CashflowScreen } from '../screens/CashflowScreen';
import { AddTransactionScreen } from '../screens/AddTransactionScreen';
import { ReportsScreen } from '../screens/ReportsScreen';
import { BudgetScreen } from '../screens/BudgetScreen';
import { MoreScreen } from '../screens/MoreScreen';
import { ChatbotScreen } from '../screens/ChatbotScreen';
import { SettingsScreen } from '../screens/SettingsScreen'; 

const Tab = createBottomTabNavigator<RootTabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

const TabNavigator = () => {
  const theme = useAppTheme(); 
  const globalNav = useNavigation<NavigationProps>();

  return (
    <Tab.Navigator 
      screenOptions={({ route }) => ({
        // 1. FIX THE HEADER: This hides the default "Cashflow" top bar
        headerShown: false, 
        
        tabBarActiveTintColor: theme.primary,
        tabBarInactiveTintColor: theme.textMuted,
        tabBarStyle: styles.tabBar,
        
        // 2. FIX THE ICONS: This maps the correct icon to each tab
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
          tabBarButton: (props) => (
            <View style={{ top: -20, justifyContent: 'center', alignItems: 'center' }} pointerEvents="box-none">
              <TouchableOpacity 
                style={[styles.customButton, { backgroundColor: theme.primary }]} 
                onPress={() => globalNav.navigate('AddTransactionStack', {})}
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
  const isDarkMode = useSettingsStore(state => state.isDarkMode);
  const theme = useAppTheme();

  // FIX 2: Boot up the SQLite database exactly once when the app starts
  useEffect(() => {
    useTransactionStore.getState().initDB();
  }, []);

  const MyTheme = {
    ...(isDarkMode ? DarkTheme : DefaultTheme),
    colors: {
      ...(isDarkMode ? DarkTheme.colors : DefaultTheme.colors),
      background: theme.background,
      card: theme.surface,
      text: theme.text,
      border: theme.border,
    },
  };

  return (
    <NavigationContainer theme={MyTheme}>
      <Stack.Navigator initialRouteName="MainTabs" screenOptions={{ headerShown: false }}>
        <Stack.Screen name="MainTabs" component={TabNavigator} />
        <Stack.Screen name="Chatbot" component={ChatbotScreen} />
        {/* FIX: Give the Stack screen a unique name */}
        <Stack.Screen name="AddTransactionStack" component={AddTransactionScreen} />
        <Stack.Screen name="Settings" component={SettingsScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
};

const styles = StyleSheet.create({
  tabBar: { position: 'absolute', bottom: 0, elevation: 0, height: 70, paddingBottom: 10, borderTopWidth: 1 },
  customButton: { width: 60, height: 60, borderRadius: 30, justifyContent: 'center', alignItems: 'center', elevation: 5, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 3.84 }
});