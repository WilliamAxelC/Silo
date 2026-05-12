import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform, Alert, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import Markdown from 'react-native-markdown-display';
import * as Clipboard from 'expo-clipboard';

import { NavigationProps, ChatbotScreenRouteProp } from '../navigation/types';
import { useAIStore } from '../store/useAIStore';
import { useAppTheme } from '../theme/useAppTheme';
import { askFinancialAgent } from '../services/ai/agent';

export const ChatbotScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const route = useRoute<ChatbotScreenRouteProp>();
  const theme = useAppTheme();
  
  const { 
    apiKey, setApiKey, 
    selectedModel, setSelectedModel, 
    availableModels, setAvailableModels,
    chatHistory, addChatMessage, clearChatHistory 
  } = useAIStore();

  const scrollViewRef = useRef<ScrollView>(null);
  
  const initialMessage = route.params?.initialMessage || '';
  const [inputText, setInputText] = useState(initialMessage);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState('');
  
  const [tempKey, setTempKey] = useState('');
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [isModelPickerVisible, setIsModelPickerVisible] = useState(false);

  // NEW: State to track which strategy we are testing
  const [aiMode, setAiMode] = useState<'rag' | 'dump'>('rag');

  const handleCopyToClipboard = async (text: string) => {
    await Clipboard.setStringAsync(text);
    Alert.alert("Copied", "Message copied to clipboard!");
  };

  const handleVerifyKey = async (keyToVerify: string) => {
    if (!keyToVerify.trim()) return;
    setIsFetchingModels(true);
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${keyToVerify}`);
      if (!response.ok) throw new Error("Invalid API Key");
      
      const data = await response.json();
      const validModels = data.models.filter((m: any) => m.supportedGenerationMethods.includes('generateContent') && !m.name.includes('vision') && !m.name.includes('embedding'));
      
      setAvailableModels(validModels);
      if (!apiKey) setApiKey(keyToVerify); 
    } catch (error) {
      Alert.alert("Error", "Invalid API Key or network issue.");
    } finally {
      setIsFetchingModels(false);
    }
  };

  const handleSelectModel = (modelName: string) => {
    setSelectedModel(modelName);
    setIsModelPickerVisible(false);
  };

  useEffect(() => {
    if (apiKey && availableModels.length === 0) handleVerifyKey(apiKey);
  }, [apiKey]);

  const handleSend = async () => {
    if (!inputText.trim() || !apiKey || !selectedModel) return;
    const userQuery = inputText;
    setInputText('');
    
    addChatMessage({ role: 'user', text: userQuery });
    setIsLoading(true);
    setLoadingStatus('Connecting to AI...');

    // PASS THE MODE TO THE AGENT
    const responseText = await askFinancialAgent(userQuery, apiKey, selectedModel, aiMode, setLoadingStatus);

    addChatMessage({ role: 'ai', text: responseText });
    setIsLoading(false);
    setLoadingStatus('');
  };

  if (!apiKey || (!selectedModel && availableModels.length === 0)) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
        <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
            <Ionicons name="chevron-back" size={28} color={theme.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: theme.text }]}>AI Setup</Text>
          <View style={{ width: 28 }} />
        </View>
        {/* ... setup view ... */}
        <ScrollView contentContainerStyle={styles.setupArea}>
          <Ionicons name="sparkles" size={64} color={theme.primary} style={{ marginBottom: 16 }} />
          <View style={{ width: '100%', alignItems: 'center' }}>
            <Text style={[styles.setupTitle, { color: theme.text }]}>Bring Your Own Key</Text>
            <Text style={[styles.setupDesc, { color: theme.textMuted }]}>Please enter your free Gemini API key to activate the assistant securely.</Text>
            <TextInput style={[styles.keyInput, { backgroundColor: theme.surface, borderColor: theme.border, color: theme.text }]} placeholderTextColor={theme.textMuted} placeholder="Paste Gemini API Key here..." value={tempKey} onChangeText={setTempKey} secureTextEntry />
            <TouchableOpacity style={[styles.saveBtn, { backgroundColor: theme.primary }]} onPress={() => handleVerifyKey(tempKey)} disabled={isFetchingModels}>
              {isFetchingModels ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Verify & Continue</Text>}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? 10 : 0}>
        
        <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
            <Ionicons name="chevron-back" size={28} color={theme.text} />
          </TouchableOpacity>
          <TouchableOpacity style={{ alignItems: 'center' }} onPress={() => setIsModelPickerVisible(true)}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={[styles.headerTitle, { color: theme.text }]}>Silo AI </Text>
              <Ionicons name="chevron-down" size={16} color={theme.textMuted} />
            </View>
            <Text style={{ fontSize: 10, color: theme.primary, fontWeight: 'bold' }}>
              {selectedModel ? selectedModel.replace('models/', '') : "Select a model"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={clearChatHistory} style={styles.backButton}>
             <Ionicons name="trash-outline" size={24} color={theme.expense} />
          </TouchableOpacity>
        </View>

        {/* NEW: THE MODE TOGGLE UI */}
        <View style={[styles.toggleContainer, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
          <TouchableOpacity 
            style={[styles.toggleBtn, aiMode === 'rag' && { backgroundColor: theme.primary }]} 
            onPress={() => setAiMode('rag')}
          >
            <Text style={[styles.toggleText, { color: aiMode === 'rag' ? '#fff' : theme.textMuted }]}>RAG (SQL Tool)</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={[styles.toggleBtn, aiMode === 'dump' && { backgroundColor: theme.primary }]} 
            onPress={() => setAiMode('dump')}
          >
            <Text style={[styles.toggleText, { color: aiMode === 'dump' ? '#fff' : theme.textMuted }]}>DB Dump (Context)</Text>
          </TouchableOpacity>
        </View>

        <ScrollView ref={scrollViewRef} style={styles.chatArea} contentContainerStyle={{ padding: 16 }} onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}>
          {chatHistory.length === 0 && (
            <Text style={[styles.placeholderText, { color: theme.textMuted }]}>Try asking: "How much did I spend on food in the last 30 days?"</Text>
          )}
          
          {chatHistory.map((msg, index) => (
            <TouchableOpacity 
              key={index} 
              activeOpacity={0.8}
              onLongPress={() => handleCopyToClipboard(msg.text)}
              style={[styles.messageBubble, msg.role === 'user' ? [styles.userBubble, { backgroundColor: theme.primary }] : [styles.aiBubble, { backgroundColor: theme.surface, borderColor: theme.border }]]}
            >
              {msg.role === 'user' ? (
                <Text selectable={true} style={{ fontSize: 16, color: '#fff' }}>{msg.text}</Text>
              ) : (
                <Markdown style={{ body: { fontSize: 16, color: theme.text } }}>{msg.text}</Markdown>
              )}
            </TouchableOpacity>
          ))}
          
          {isLoading && (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 16 }}>
              <ActivityIndicator color={theme.primary} />
              <Text style={{ marginLeft: 8, color: theme.textMuted, fontSize: 12 }}>{loadingStatus}</Text>
            </View>
          )}
        </ScrollView>

        <View style={[styles.inputArea, { backgroundColor: theme.surface, borderTopColor: theme.border }]}>
          <TextInput style={[styles.input, { backgroundColor: theme.background, borderColor: theme.border, color: theme.text }]} placeholderTextColor={theme.textMuted} placeholder="Ask about your finances..." value={inputText} onChangeText={setInputText} onSubmitEditing={handleSend} />
          <TouchableOpacity style={[styles.sendBtn, { backgroundColor: theme.primary }]} onPress={handleSend} disabled={isLoading}>
            <Ionicons name="send" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      <Modal visible={isModelPickerVisible} animationType="slide" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: theme.background }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.text }]}>Select AI Engine</Text>
              <TouchableOpacity onPress={() => setIsModelPickerVisible(false)}>
                <Ionicons name="close" size={24} color={theme.text} />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 400 }}>
              {availableModels.map((model) => (
                <TouchableOpacity key={model.name} style={[styles.modelCard, { backgroundColor: theme.surface, borderColor: selectedModel === model.name ? theme.primary : theme.border }]} onPress={() => handleSelectModel(model.name)}>
                  <Text style={[styles.modelName, { color: theme.text }]}>{model.displayName}</Text>
                  <Text style={[styles.modelDesc, { color: theme.textMuted }]}>{model.description.split('.')[0]}</Text>
                  <View style={styles.limitRow}>
                    <Ionicons name="hardware-chip-outline" size={14} color={theme.textMuted} />
                    <Text style={[styles.limitText, { color: theme.primary }]}> Max Input Context: {(model.inputTokenLimit / 1000).toFixed(0)}k tokens</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1 },
  headerTitle: { fontSize: 18, fontWeight: '600' },
  backButton: { padding: 4 },
  
  // NEW TOGGLE STYLES
  toggleContainer: { flexDirection: 'row', padding: 8, borderBottomWidth: 1 },
  toggleBtn: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8 },
  toggleText: { fontSize: 14, fontWeight: 'bold' },

  chatArea: { flex: 1 },
  placeholderText: { textAlign: 'center', marginTop: 40 },
  messageBubble: { maxWidth: '85%', padding: 12, borderRadius: 12, marginBottom: 16 },
  userBubble: { alignSelf: 'flex-end', borderBottomRightRadius: 2 },
  aiBubble: { alignSelf: 'flex-start', borderWidth: 1, borderBottomLeftRadius: 2 },
  inputArea: { flexDirection: 'row', padding: 16, borderTopWidth: 1 },
  input: { flex: 1, borderWidth: 1, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, marginRight: 12 },
  sendBtn: { width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center' },
  setupArea: { flexGrow: 1, padding: 24, alignItems: 'center' },
  setupTitle: { fontSize: 22, fontWeight: 'bold', marginBottom: 8, textAlign: 'center' },
  setupDesc: { textAlign: 'center', marginBottom: 24, lineHeight: 22 },
  keyInput: { width: '100%', borderWidth: 1, borderRadius: 8, padding: 16, marginBottom: 16 },
  saveBtn: { width: '100%', padding: 16, borderRadius: 8, alignItems: 'center' },
  saveBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 40 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  modalTitle: { fontSize: 18, fontWeight: 'bold' },
  modelCard: { width: '100%', padding: 16, borderRadius: 8, borderWidth: 1, marginBottom: 12 },
  modelName: { fontSize: 16, fontWeight: 'bold', marginBottom: 4 },
  modelDesc: { fontSize: 14, marginBottom: 8 },
  limitRow: { flexDirection: 'row', alignItems: 'center' },
  limitText: { fontSize: 12, fontWeight: '600' }
});