import { NavigatorScreenParams, RouteProp, CompositeNavigationProp } from '@react-navigation/native';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';

// 1. Define the Bottom Tabs
export type RootTabParamList = {
  Cashflow: undefined;
  Reports: undefined;
  Add: undefined; 
  Budget: undefined;
  More: undefined;
};

// 2. Define the Stack Screens
export type RootStackParamList = {
  // FIX: Tell TypeScript that MainTabs is a navigator that accepts Tab routes!
  MainTabs: NavigatorScreenParams<RootTabParamList>;
  Chatbot: { initialMessage?: string };
  AddTransactionStack: { transactionId?: number };
  Settings: undefined;
  SystemLogs: undefined;
};

export type NavigationProps = CompositeNavigationProp<
  BottomTabNavigationProp<RootTabParamList>,
  NativeStackNavigationProp<RootStackParamList>
>;

export type ChatbotScreenRouteProp = RouteProp<RootStackParamList, 'Chatbot'>;
export type AddTransactionScreenRouteProp = RouteProp<RootStackParamList, 'AddTransactionStack'>;