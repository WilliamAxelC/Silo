import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, TextInput, ScrollView, Animated } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { useAppTheme } from '../theme/useAppTheme';
import { useTransactionStore } from '../store/useTransactionStore';
import { useMonthlySummary } from '../hooks/useMonthlySummary';

// Custom component for the animated progress bar
const ProgressBar = ({ spent, limit, theme }: { spent: number, limit: number, theme: any }) => {
  const progressAnim = useRef(new Animated.Value(0)).current;
  const percentage = Math.min((spent / limit) * 100, 100);
  
  // Determine color based on how close they are to the limit
  let barColor = theme.income; // Green by default
  if (percentage > 75) barColor = '#eab308'; // Yellow/Warning
  if (percentage >= 95) barColor = theme.expense; // Red/Danger

  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: percentage,
      duration: 800,
      useNativeDriver: false,
    }).start();
  }, [percentage]);

  return (
    <View style={[styles.barBackground, { backgroundColor: theme.background }]}>
      <Animated.View 
        style={[
          styles.barFill, 
          { 
            backgroundColor: barColor, 
            width: progressAnim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }) 
          }
        ]} 
      />
    </View>
  );
};

export const BudgetScreen = () => {
  const theme = useAppTheme();
  
  // Get Categories and Budgets from the store
  const { categories, budgets, setBudget } = useTransactionStore();
  
  // Get this month's expenses using our centralized hook
  const { currentMonthExpenses } = useMonthlySummary(new Date());

  // Calculate total spent per category
  const categorySpending = currentMonthExpenses.reduce((acc, curr) => {
    const cat = curr.category || 'General';
    acc[cat] = (acc[cat] || 0) + Math.abs(curr.totalAmount);
    return acc;
  }, {} as Record<string, number>);

  // Modal State
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [budgetInput, setBudgetInput] = useState('');

  const handleOpenModal = (category: string) => {
    setSelectedCategory(category);
    setBudgetInput(budgets[category] ? budgets[category].toString() : '');
    setModalVisible(true);
  };

  const handleSaveBudget = async () => {
    const numericValue = parseFloat(budgetInput.replace(/,/g, ''));
    if (!isNaN(numericValue) && numericValue > 0) {
      await setBudget(selectedCategory, numericValue);
    }
    setModalVisible(false);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <Text style={[styles.headerTitle, { color: theme.text }]}>Monthly Budgets</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {categories.map((cat) => {
          const limit = budgets[cat];
          const spent = categorySpending[cat] || 0;
          
          return (
            <TouchableOpacity 
              key={cat} 
              style={[styles.budgetCard, { backgroundColor: theme.surface, borderColor: theme.border }]}
              onPress={() => handleOpenModal(cat)}
              activeOpacity={0.7}
            >
              <View style={styles.cardHeader}>
                <Text style={[styles.categoryTitle, { color: theme.text }]}>{cat}</Text>
                {limit ? (
                  <Text style={[styles.amountText, { color: theme.text }]}>
                    Rp {(spent || 0).toLocaleString()} <Text style={{ color: theme.textMuted }}>/ {(limit || 0).toLocaleString()}</Text>
                  </Text>
                ) : (
                  <Text style={[styles.tapToSet, { color: theme.primary }]}>Tap to set limit</Text>
                )}
              </View>

              {limit ? (
                <>
                  <ProgressBar spent={spent || 0} limit={limit} theme={theme} />
                  <Text style={[styles.remainingText, { color: (spent || 0) > limit ? theme.expense : theme.textMuted }]}>
                    {(spent || 0) > limit ? 'Over budget by ' : 'Remaining: '}
                    Rp {Math.abs((limit || 0) - (spent || 0)).toLocaleString()}
                  </Text>
                </>
              ) : null}
            </TouchableOpacity>
          );
        })}
        <View style={{ height: 100 }} />
      </ScrollView>

      {/* Set Budget Modal */}
      <Modal visible={modalVisible} transparent animationType="fade">
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setModalVisible(false)}>
          <View style={[styles.modalContent, { backgroundColor: theme.surface }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Set Budget for {selectedCategory}</Text>
            
            <View style={[styles.inputContainer, { borderColor: theme.border, backgroundColor: theme.background }]}>
              <Text style={{ color: theme.textMuted, marginRight: 8, fontWeight: 'bold' }}>Rp</Text>
              <TextInput 
                style={[styles.input, { color: theme.text }]}
                keyboardType="numeric"
                value={budgetInput}
                onChangeText={(text) => {
                  const numericValue = text.replace(/[^0-9]/g, '');
                  setBudgetInput(numericValue.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
                }}
                placeholder="0"
                placeholderTextColor={theme.textMuted}
                autoFocus
              />
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setModalVisible(false)}>
                <Text style={[styles.btnText, { color: theme.textMuted }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.saveBtn, { backgroundColor: theme.primary }]} onPress={handleSaveBudget}>
                <Text style={[styles.btnText, { color: '#fff' }]}>Save Budget</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { padding: 16, borderBottomWidth: 1, alignItems: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '600' },
  content: { padding: 16 },
  
  budgetCard: { padding: 16, borderRadius: 12, borderWidth: 1, marginBottom: 16 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  categoryTitle: { fontSize: 16, fontWeight: '600' },
  amountText: { fontSize: 14, fontWeight: 'bold' },
  tapToSet: { fontSize: 14, fontWeight: '600' },
  
  barBackground: { height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 8 },
  barFill: { height: '100%', borderRadius: 4 },
  remainingText: { fontSize: 12, textAlign: 'right' },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 },
  modalContent: { padding: 24, borderRadius: 16, elevation: 5 },
  modalTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 16, textAlign: 'center' },
  inputContainer: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 8, padding: 12, marginBottom: 24 },
  input: { flex: 1, fontSize: 18 },
  modalActions: { flexDirection: 'row', justifyContent: 'space-between' },
  cancelBtn: { padding: 14, flex: 1, alignItems: 'center', marginRight: 8, borderRadius: 8, backgroundColor: 'transparent' },
  saveBtn: { padding: 14, flex: 1, alignItems: 'center', marginLeft: 8, borderRadius: 8 },
  btnText: { fontSize: 16, fontWeight: 'bold' },
});