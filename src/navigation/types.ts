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
  Chatbot: { initialMessage?: string; autoSend?: boolean };
  AddTransactionStack: {
    transactionId?: number;
    receiptQueueId?: number;
    reviewBatchIndex?: number;
    reviewBatchTotal?: number;
    duplicateFromId?: number;
    /** Optional epoch ms timestamp to prefill the transaction date (e.g. from Calendar view). */
    initialDate?: number;
    /** A receipt photo shared to Silo from another app: scanned as soon as the screen opens. */
    sharedImageUri?: string;
    /** After saving a new expense, jump directly to SplitBillEditor for that transaction. */
    openSplitAfterSave?: boolean;
  };
  ReceiptInbox: undefined;
  /** editWalletId: open the account editor for that account on arrival. */
  Accounts: { editWalletId?: number } | undefined;
  AccountDetail: { walletId: number };
  Activity: undefined;
  Recurring: undefined;
  Report: { kind?: 'bug' | 'feature' } | undefined;
  Privacy: undefined;
  Goals: undefined;
  SplitBills: undefined;
  SplitBillEditor: { transactionId: number };
  Settings: undefined;
  SystemLogs: undefined;
};

export type NavigationProps = CompositeNavigationProp<
  BottomTabNavigationProp<RootTabParamList>,
  NativeStackNavigationProp<RootStackParamList>
>;

export type ChatbotScreenRouteProp = RouteProp<RootStackParamList, 'Chatbot'>;
export type AddTransactionScreenRouteProp = RouteProp<RootStackParamList, 'AddTransactionStack'>;