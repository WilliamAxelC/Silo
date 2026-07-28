import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform, Alert, Keyboard } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import Markdown from 'react-native-markdown-display';
import * as Clipboard from 'expo-clipboard';

import { NavigationProps, ChatbotScreenRouteProp } from '../navigation/types';
import { getAIRuntimeAvailability, getProvisioningStatusLabel, useAIStore } from '../store/useAIStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useAppTheme } from '../theme/useAppTheme';
import type { LocalAiMode } from '../services/ai/agent';
import { getModelLifecycleManager } from '../services/ai/modelLifecycle';
import { getGenerationService, type GenerationServiceRuntimeSnapshot } from '../services/ai/generationService';
import { getErrorMessage } from '../services/ai/localInferenceTypes';
import { getChatRuntimePreloadService } from '../services/ai/chatRuntimePreloadService';
import { ChatChart } from '../components/ChatChart';

function parseMessageWithCharts(text: string) {
  const cleanText = text.replace(/<\/chart>/g, '');
  const chartRegex = /<chart\s+([^>]+)>/g;
  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = chartRegex.exec(cleanText)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'markdown', content: cleanText.substring(lastIndex, match.index) });
    }
    
    const attrString = match[1];
    const typeMatch = attrString.match(/type=(?:'|")([^'"]+)(?:'|")/);
    const dataMatch = attrString.match(/data=(?:'|")([^'"]+)(?:'|")/);
    
    parts.push({
      type: 'chart',
      chartType: typeMatch ? typeMatch[1] : 'bar',
      chartData: dataMatch ? dataMatch[1] : '[]',
    });
    lastIndex = chartRegex.lastIndex;
  }
  
  if (lastIndex < cleanText.length) {
    parts.push({ type: 'markdown', content: cleanText.substring(lastIndex) });
  }
  
  return parts;
}

export const ChatbotScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const route = useRoute<ChatbotScreenRouteProp>();
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { aiInferenceMode, externalApiProvider, externalApiModel } = useSettingsStore();

  const {
    chatHistory,
    addChatMessage,
    updateChatMessage,
    clearChatHistory,
    provisioning,
    runtime,
    selectedMode,
    setSelectedMode,
    runtimeReady,
    warmupPending,
    localModelDisplayName,
  } = useAIStore();

  const generationService = useMemo(() => getGenerationService(), []);
  const chatRuntimePreloadService = useMemo(() => getChatRuntimePreloadService(), []);
  const scrollViewRef = useRef<ScrollView>(null);
  const initialMessage = route.params?.initialMessage || '';
  const [inputText, setInputText] = useState(initialMessage);
  const [chatRuntimeRequested, setChatRuntimeRequested] = useState(selectedMode === 'chat');
  const pendingAssistantMessageIdRef = useRef<string | null>(null);
  const assistantMessageStartedAtRef = useRef<Record<string, number>>({});
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [serviceSnapshot, setServiceSnapshot] = useState<GenerationServiceRuntimeSnapshot>(generationService.getSnapshot());

  useEffect(() => {
    if (initialMessage && chatHistory.length === 0) {
      setInputText(initialMessage);
    }
  }, [initialMessage, chatHistory.length]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSubscription = Keyboard.addListener(showEvent, (event) => {
      setKeyboardHeight(event.endCoordinates?.height ?? 0);
      requestAnimationFrame(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      });
    });
    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  useEffect(() => {
    const subscription = generationService.subscribe(setServiceSnapshot);
    return () => {
      subscription.unsubscribe();
    };
  }, [generationService]);

  const handleCopyToClipboard = async (text: string) => {
    await Clipboard.setStringAsync(text);
    Alert.alert('Copied', 'Message copied to clipboard!');
  };

  const formatElapsed = useCallback((seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }, []);

  const aiMode = selectedMode;
  const {
    runtimePhaseActive,
    canRunGroundedQueries,
    canRunNativeChat,
    hasUsableLocalInferenceBackend,
    localInferenceStatusMessage,
  } = getAIRuntimeAvailability({ provisioning, runtimeReady, warmupPending, runtime });
  const canSendMessage = aiMode === 'rag' ? canRunGroundedQueries : canRunNativeChat;
  const canStartOrRetryProvisioning = aiInferenceMode === 'local' && hasUsableLocalInferenceBackend && ['failed', 'not-installed', 'update-available'].includes(provisioning.status);
  const isBusyProvisioning = aiInferenceMode === 'local' && hasUsableLocalInferenceBackend && ['queued', 'downloading', 'verifying', 'unpacking', 'registering', 'warming', 'indexing'].includes(provisioning.status);
  const showPrimaryProvisionAction = aiInferenceMode === 'local' && hasUsableLocalInferenceBackend && !canRunNativeChat && canStartOrRetryProvisioning;
  const isPreparingChatRuntime = aiInferenceMode === 'local' ? serviceSnapshot.isPreparingRuntime : false;
  const chatRuntimeStatus = serviceSnapshot.runtimeStatus;
  const isLoading = serviceSnapshot.isGenerating;
  const loadingStatus = serviceSnapshot.generationStatus;

  useEffect(() => {
    if (selectedMode !== 'chat' || aiInferenceMode !== 'local') {
      chatRuntimePreloadService.clearRequest();
      return;
    }

    setChatRuntimeRequested(true);
    void chatRuntimePreloadService.requestPreload();
  }, [chatRuntimePreloadService, selectedMode, aiInferenceMode]);

  useEffect(() => {
    const activeStartedAt = runtime.activePhaseStartedAt;
    const shouldRun = Boolean(activeStartedAt)
      && (isPreparingChatRuntime || isLoading || isBusyProvisioning || Boolean(runtime.activeGenerationRequestId) || Boolean(runtime.activeStatusLabel));

    if (!shouldRun || !activeStartedAt) {
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
      setElapsedSeconds(0);
      return;
    }

    const updateElapsed = () => {
      const started = Date.parse(activeStartedAt);
      if (Number.isNaN(started)) {
        setElapsedSeconds(0);
        return;
      }
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    };

    updateElapsed();
    elapsedTimerRef.current = setInterval(updateElapsed, 1000);

    return () => {
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
    };
  }, [isBusyProvisioning, isLoading, isPreparingChatRuntime, runtime.activeGenerationRequestId, runtime.activePhaseStartedAt, runtime.activeStatusLabel]);

  useEffect(() => {
    const pendingId = pendingAssistantMessageIdRef.current;
    if (!pendingId) {
      return;
    }

    if (runtime.streamingResponseText) {
      updateChatMessage(pendingId, (message) => ({
        ...message,
        text: runtime.streamingResponseText,
        status: 'streaming',
      }));
      return;
    }

    if (!runtime.activeGenerationRequestId) {
      updateChatMessage(pendingId, (message) => ({
        ...message,
        status: message.status === 'cancelled' || message.status === 'error' ? message.status : 'complete',
      }));
      pendingAssistantMessageIdRef.current = null;
    }
  }, [runtime.activeGenerationRequestId, runtime.streamingResponseText, updateChatMessage]);

  const progressPercent = useMemo(() => {
    if (provisioning.totalBytes && provisioning.totalBytes > 0) {
      return Math.round((provisioning.downloadedBytes / provisioning.totalBytes) * 100);
    }

    return Math.round(provisioning.progress * 100);
  }, [provisioning.downloadedBytes, provisioning.progress, provisioning.totalBytes]);

  const stageStatusMessage = useMemo(() => {
    if (runtime.activeStatusLabel) {
      return runtime.activeStatusLabel;
    }

    if (isPreparingChatRuntime) {
      return chatRuntimeStatus || 'Preparing the local chatbot on this device...';
    }

    if (isLoading) {
      return loadingStatus || (aiInferenceMode === 'external' ? 'Generating response from external API...' : 'Generating a local response on-device...');
    }

    if (provisioning.status === 'queued') {
      return 'Queuing local model setup...';
    }
    if (provisioning.status === 'downloading') {
      return `Downloading the local Qwen model${progressPercent > 0 ? ` (${progressPercent}%)` : '...'} `;
    }
    if (provisioning.status === 'verifying') {
      return 'Verifying the downloaded model before activation...';
    }
    if (provisioning.status === 'unpacking') {
      return 'Moving the verified model into the active offline runtime location...';
    }
    if (provisioning.status === 'registering') {
      return 'Loading the model into the Android runtime. This can take a while on older phones.';
    }
    if (provisioning.status === 'warming') {
      return 'Warming up the local runtime so your first real question is more stable.';
    }
    if (provisioning.status === 'indexing') {
      return 'Finalizing on-device AI setup and preparing local knowledge caches.';
    }
    if (runtime.activeGenerationRequestId) {
      return aiInferenceMode === 'external' ? 'Generating response from external API...' : 'Generating a response locally on your device.';
    }
    return null;
  }, [aiInferenceMode, chatRuntimeStatus, isLoading, isPreparingChatRuntime, loadingStatus, progressPercent, provisioning.status, runtime.activeGenerationRequestId, runtime.activeStatusLabel]);

  const compactStatusTone = runtime.activeGenerationRequestId || isLoading || isPreparingChatRuntime || isBusyProvisioning ? theme.primary : theme.textMuted;

  const transferRateLabel = useMemo(() => {
    if (!provisioning.transfer.bytesPerSecond || provisioning.transfer.bytesPerSecond <= 0) {
      return null;
    }

    return `${(provisioning.transfer.bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`;
  }, [provisioning.transfer.bytesPerSecond]);

  const handleProvisionAction = async () => {
    const manager = getModelLifecycleManager();

    try {
      if (canStartOrRetryProvisioning) {
        await manager.retryProvisioning();
      }
    } catch (error) {
      Alert.alert('AI Setup', getErrorMessage(error, 'Unable to continue model setup.'));
    }
  };

  const handleCancelDownload = async () => {
    try {
      await getModelLifecycleManager().cancelDownload();
    } catch (error) {
      Alert.alert('AI Setup', getErrorMessage(error, 'Unable to cancel setup.'));
    }
  };

  const handleSend = async () => {
    if (!inputText.trim() || isLoading || isPreparingChatRuntime || runtime.activeGenerationRequestId || !canSendMessage) {
      return;
    }

    const userQuery = inputText.trim();
    const userMessageId = `user-${Date.now()}`;
    const assistantMessageId = `assistant-${Date.now()}`;
    const startedAt = Date.now();

    assistantMessageStartedAtRef.current[assistantMessageId] = startedAt;
    pendingAssistantMessageIdRef.current = assistantMessageId;
    setInputText('');
    addChatMessage({ role: 'user', text: userQuery, id: userMessageId, createdAt: new Date(startedAt).toISOString() });
    addChatMessage({ role: 'ai', text: '', id: assistantMessageId, status: 'streaming', createdAt: new Date(startedAt).toISOString() });
    requestAnimationFrame(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    });

    try {
      const responseText = await generationService.startGeneration({ prompt: userQuery, mode: aiMode as LocalAiMode });
      const durationMs = Date.now() - startedAt;
      updateChatMessage(assistantMessageId, {
        text: responseText,
        status: 'complete',
        createdAt: new Date(startedAt).toISOString(),
      });
      assistantMessageStartedAtRef.current[assistantMessageId] = durationMs;
      pendingAssistantMessageIdRef.current = null;
    } catch (error) {
      const message = getErrorMessage(error, 'Local AI failed unexpectedly.');
      const isCancelled = message.toLowerCase().includes('cancel');
      const durationMs = Date.now() - startedAt;
      updateChatMessage(assistantMessageId, {
        text: message,
        status: isCancelled ? 'cancelled' : 'error',
        createdAt: new Date(startedAt).toISOString(),
      });
      assistantMessageStartedAtRef.current[assistantMessageId] = durationMs;
      pendingAssistantMessageIdRef.current = null;
    } finally {
      requestAnimationFrame(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      });
    }
  };

  const handleCancelGeneration = async () => {
    try {
      const cancelled = await generationService.cancelGeneration('Generation cancelled by user.');
      if (cancelled && pendingAssistantMessageIdRef.current) {
        updateChatMessage(pendingAssistantMessageIdRef.current, (message) => ({
          ...message,
          text: message.text || 'Generation cancelled by user.',
          status: 'cancelled',
        }));
        pendingAssistantMessageIdRef.current = null;
      }
    } catch (error) {
      Alert.alert('Cancel generation', getErrorMessage(error, 'Unable to cancel generation.'));
    }
  };

  const showChatRuntimeGate = aiMode === 'chat' && chatRuntimeRequested && (!canRunNativeChat || isPreparingChatRuntime || isBusyProvisioning);
  const chatRuntimeActionLabel = canStartOrRetryProvisioning ? 'Retry chat setup' : 'Preparing chatbot';
  const statusMetaLabel = elapsedSeconds > 0 ? `${formatElapsed(elapsedSeconds)} elapsed` : null;
  const inlineModelStatusLabel = aiInferenceMode === 'external'
    ? 'External API'
    : hasUsableLocalInferenceBackend
    ? `${getProvisioningStatusLabel(provisioning.status)}${progressPercent > 0 && provisioning.status !== 'ready' ? ` · ${progressPercent}%` : ''}`
    : 'Unavailable';
  const displayModelSubtitle = aiInferenceMode === 'external'
    ? `${externalApiProvider.toUpperCase()} · ${externalApiModel}`
    : localModelDisplayName;
  const showCompactLoader = Boolean(stageStatusMessage) && (isBusyProvisioning || isPreparingChatRuntime || isLoading || Boolean(runtime.activeGenerationRequestId) || Boolean(runtime.activeStatusLabel));

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <KeyboardAvoidingView style={styles.keyboardShell} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? Math.max(insets.top, 8) : 0}>
        <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}> 
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
            <Ionicons name="chevron-back" size={24} color={theme.text} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <View style={styles.headerTitleRow}>
              <Text style={[styles.headerTitle, { color: theme.text }]}>Silo AI</Text>
              <View style={[styles.inlineStatusChip, { backgroundColor: theme.background, borderColor: theme.border }]}>
                <View style={[styles.inlineStatusDot, { backgroundColor: canRunNativeChat ? theme.primary : hasUsableLocalInferenceBackend ? theme.textMuted : theme.expense }]} />
                <Text style={[styles.inlineStatusChipText, { color: canRunNativeChat ? theme.primary : theme.textMuted }]}>{inlineModelStatusLabel}</Text>
              </View>
            </View>
            <Text style={[styles.headerSubtitle, { color: theme.textMuted }]} numberOfLines={1}>{displayModelSubtitle}</Text>
          </View>
          <TouchableOpacity onPress={clearChatHistory} style={styles.backButton}>
            <Ionicons name="trash-outline" size={20} color={theme.expense} />
          </TouchableOpacity>
        </View>

        <View style={[styles.statusCard, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
          <View style={styles.statusHeaderRow}>
            <Text style={[styles.statusMessage, styles.statusMessageTight, { color: hasUsableLocalInferenceBackend ? theme.textMuted : theme.expense }]}>
              {localInferenceStatusMessage}
            </Text>
            {showPrimaryProvisionAction ? (
              <TouchableOpacity style={[styles.primaryMiniButton, { backgroundColor: theme.primary }]} onPress={handleProvisionAction}>
                <Text style={styles.primaryMiniButtonText}>Retry</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {showCompactLoader ? (
            <View style={[styles.compactStatusBar, { backgroundColor: theme.background, borderColor: theme.border }]}>
              <ActivityIndicator color={theme.primary} size="small" />
              <View style={styles.compactStatusCopy}>
                <Text style={[styles.compactStatusTitle, { color: compactStatusTone }]} numberOfLines={2}>{stageStatusMessage || 'Provisioning local Qwen model...'}</Text>
                {statusMetaLabel ? <Text style={[styles.compactStatusMeta, { color: theme.textMuted }]}>{statusMetaLabel}</Text> : null}
              </View>
              {runtime.activeGenerationRequestId ? (
                <TouchableOpacity onPress={handleCancelGeneration} style={styles.pauseButton}>
                  <Text style={[styles.pauseButtonText, { color: theme.expense }]}>Stop</Text>
                </TouchableOpacity>
              ) : isBusyProvisioning ? (
                <TouchableOpacity onPress={handleCancelDownload} style={styles.pauseButton}>
                  <Text style={[styles.pauseButtonText, { color: theme.expense }]}>Cancel</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}
          {aiInferenceMode === 'local' && hasUsableLocalInferenceBackend && transferRateLabel && !showCompactLoader ? (
            <Text style={[styles.metaLine, { color: theme.textMuted }]}>Transfer rate: {transferRateLabel}</Text>
          ) : null}
          {aiInferenceMode === 'local' && hasUsableLocalInferenceBackend && provisioning.lastError ? (
            <Text style={[styles.metaLine, { color: theme.expense }]}>{provisioning.lastError}</Text>
          ) : null}
          {aiInferenceMode === 'local' && hasUsableLocalInferenceBackend && provisioning.pausedReason ? (
            <Text style={[styles.metaLine, { color: theme.textMuted }]}>{provisioning.pausedReason}</Text>
          ) : null}
          {aiInferenceMode === 'local' && hasUsableLocalInferenceBackend && !provisioning.lastError && !provisioning.pausedReason && !canRunNativeChat && !showCompactLoader ? (
            <Text style={[styles.metaLine, { color: theme.textMuted }]}>
              {runtimePhaseActive
                ? 'The local model file is installed and the runtime is finishing registration, warmup, and index initialization.'
                : 'Model download must complete in one uninterrupted pass so partial files are never treated as installed.'}
            </Text>
          ) : null}
        </View>

        <View style={[styles.toggleContainer, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
          <TouchableOpacity
            style={[styles.toggleBtn, aiMode === 'rag' && { backgroundColor: theme.primary }]}
            onPress={() => setSelectedMode('rag')}
          >
            <Text style={[styles.toggleText, { color: aiMode === 'rag' ? '#fff' : theme.textMuted }]}>Grounded</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toggleBtn, aiMode === 'chat' && { backgroundColor: theme.primary }]}
            onPress={() => {
              setChatRuntimeRequested(true);
              setSelectedMode('chat');
            }}
          >
            <Text style={[styles.toggleText, { color: aiMode === 'chat' ? '#fff' : theme.textMuted }]}>Chat</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          ref={scrollViewRef}
          style={styles.chatArea}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 14, paddingBottom: Math.max(88, insets.bottom + keyboardHeight + 72) }}
          onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
        >
          {showChatRuntimeGate ? (
            <View style={styles.emptyStateWrap}>
              <View style={[styles.chatGateCard, styles.chatGateCardCompact, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <Ionicons name="sparkles-outline" size={18} color={theme.primary} />
                <Text style={[styles.chatGateText, { color: theme.textMuted }]}>
                  {stageStatusMessage ?? 'Loading the offline chatbot only after entering this screen.'}
                </Text>
                {canStartOrRetryProvisioning ? (
                  <TouchableOpacity style={[styles.chatGateButton, { backgroundColor: theme.primary }]} onPress={handleProvisionAction}>
                    <Text style={styles.chatGateButtonText}>{chatRuntimeActionLabel}</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          ) : chatHistory.length === 0 ? (
            <View style={styles.emptyStateWrap}>
              <Text style={[styles.placeholderText, { color: theme.textMuted }]}>
                {canSendMessage
                  ? 'Try asking: "How much did I spend on food in the last 30 days?"'
                  : aiMode === 'rag'
                    ? 'Grounded questions are answered from records stored on this device only.'
                    : 'Chat mode is disabled because this build does not include a usable on-device generation runtime.'}
              </Text>
              {stageStatusMessage ? (
                <View style={[styles.inlineStatusCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                  <ActivityIndicator color={theme.primary} />
                  <Text style={[styles.inlineStatusText, { color: theme.textMuted }]}>{stageStatusMessage}</Text>
                </View>
              ) : null}
            </View>
          ) : null}

          {chatHistory.map((msg, index) => {
            const measuredDuration = msg.id ? assistantMessageStartedAtRef.current[msg.id] : null;
            const durationLabel = typeof measuredDuration === 'number' && msg.role === 'ai' && msg.status === 'complete' && measuredDuration < 600000
              ? `${(measuredDuration / 1000).toFixed(measuredDuration >= 10000 ? 0 : 1)}s inference`
              : null;

            return (
              <View key={msg.id ?? index} style={styles.messageWrap}>
                <TouchableOpacity
                  activeOpacity={0.8}
                  onLongPress={() => handleCopyToClipboard(msg.text)}
                  style={[
                    styles.messageBubble,
                    msg.role === 'user'
                      ? [styles.userBubble, { backgroundColor: theme.primary }]
                      : [styles.aiBubble, { backgroundColor: theme.surface, borderColor: theme.border }],
                  ]}
                >
                  {msg.role === 'user' ? (
                    <Text selectable style={{ fontSize: 16, color: '#fff' }}>{msg.text}</Text>
                  ) : msg.text ? (
                    parseMessageWithCharts(msg.text).map((part, partIndex) => (
                      part.type === 'markdown' ? (
                        <Markdown key={partIndex} style={{ body: { fontSize: 16, color: theme.text } }}>{part.content}</Markdown>
                      ) : (
                        <ChatChart key={partIndex} type={part.chartType!} data={part.chartData!} />
                      )
                    ))
                  ) : (
                    <View style={styles.messageLoadingRow}>
                      <ActivityIndicator color={theme.primary} size="small" />
                      <Text style={[styles.messageLoadingText, { color: theme.textMuted }]}>Thinking…</Text>
                    </View>
                  )}
                  {msg.role === 'ai' && msg.status && msg.status !== 'complete' ? (
                    <Text style={[styles.messageMeta, { color: msg.status === 'error' ? theme.expense : theme.textMuted }]}>
                      {msg.status === 'streaming' ? 'Thinking locally…' : msg.status === 'cancelled' ? 'Cancelled' : 'Error'}
                    </Text>
                  ) : null}
                </TouchableOpacity>
                {durationLabel ? <Text style={[styles.durationText, { color: theme.textMuted }]}>{durationLabel}</Text> : null}
              </View>
            );
          })}
        </ScrollView>

        <View style={[styles.inputArea, { backgroundColor: theme.surface, borderTopColor: theme.border, paddingBottom: Math.max(insets.bottom + 10, keyboardHeight > 0 && Platform.OS === 'android' ? 12 : 16) }]}>
          <TextInput
            style={[styles.input, { backgroundColor: theme.background, borderColor: theme.border, color: theme.text, opacity: canSendMessage && !showChatRuntimeGate ? 1 : 0.7 }]}
            placeholderTextColor={theme.textMuted}
            placeholder={
              showChatRuntimeGate
                ? 'Waiting for the local chatbot to finish loading...'
                : canSendMessage
                  ? 'Ask about your finances...'
                  : aiMode === 'rag'
                    ? 'Ask a grounded question about your local records...'
                    : 'Chat mode unavailable: no local inference backend wired'
            }
            value={inputText}
            onChangeText={setInputText}
            onSubmitEditing={handleSend}
            editable={canSendMessage && !showChatRuntimeGate}
            multiline
            maxLength={2000}
          />
          {runtime.activeGenerationRequestId ? (
            <TouchableOpacity style={[styles.sendBtn, { backgroundColor: theme.expense }]} onPress={handleCancelGeneration}>
              <Ionicons name="stop" size={18} color="#fff" />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={[styles.sendBtn, { backgroundColor: canSendMessage && !showChatRuntimeGate && !runtime.activeGenerationRequestId ? theme.primary : theme.border }]} onPress={handleSend} disabled={!canSendMessage || isLoading || showChatRuntimeGate || Boolean(runtime.activeGenerationRequestId)}>
              <Ionicons name="send" size={20} color="#fff" />
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  keyboardShell: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1 },
  headerCenter: { flex: 1, marginHorizontal: 8 },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: { fontSize: 17, fontWeight: '600' },
  headerSubtitle: { fontSize: 10, marginTop: 1 },
  inlineStatusChip: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, maxWidth: '68%' },
  inlineStatusDot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  inlineStatusChipText: { fontSize: 10, fontWeight: '700', flexShrink: 1 },
  backButton: { padding: 4 },
  statusCard: { paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1 },
  statusHeaderRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  statusCopy: { flex: 1, paddingRight: 12 },
  statusTitle: { fontSize: 12, fontWeight: '700', marginBottom: 2 },
  statusSubtitle: { fontSize: 11, fontWeight: '600' },
  statusMessage: { fontSize: 11, lineHeight: 15, marginTop: 2, flex: 1 },
  statusMessageTight: { marginTop: 0 },
  metaLine: { fontSize: 10, lineHeight: 14, marginTop: 4 },
  progressRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  progressText: { marginLeft: 8, fontSize: 12, flex: 1 },
  pauseButton: { paddingHorizontal: 8, paddingVertical: 4 },
  pauseButtonText: { fontSize: 12, fontWeight: '700' },
  primaryMiniButton: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  primaryMiniButtonText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  toggleContainer: { flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 5, borderBottomWidth: 1 },
  toggleBtn: { flex: 1, paddingVertical: 6, alignItems: 'center', borderRadius: 8 },
  toggleText: { fontSize: 14, fontWeight: 'bold' },
  chatArea: { flex: 1 },
  emptyStateWrap: { marginTop: 24, gap: 12 },
  chatGateCard: { borderWidth: 1, borderRadius: 18, padding: 16, alignItems: 'center', gap: 10 },
  chatGateCardCompact: { paddingVertical: 14 },
  chatGateTitle: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  chatGateText: { fontSize: 12, lineHeight: 18, textAlign: 'center' },
  chatGateMeta: { fontSize: 12, lineHeight: 18, textAlign: 'center' },
  chatGateButton: { borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10, marginTop: 4 },
  chatGateButtonText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  placeholderText: { textAlign: 'center' },
  inlineStatusCard: { borderWidth: 1, borderRadius: 14, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  inlineStatusText: { flex: 1, fontSize: 11, lineHeight: 16 },
  compactStatusBar: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, marginTop: 6, paddingHorizontal: 10, paddingVertical: 7 },
  compactStatusCopy: { flex: 1 },
  compactStatusTitle: { fontSize: 12, fontWeight: '700' },
  compactStatusMeta: { fontSize: 11, marginTop: 2 },
  messageWrap: { marginBottom: 10 },
  messageBubble: { maxWidth: '85%', padding: 11, borderRadius: 12 },
  userBubble: { alignSelf: 'flex-end', borderBottomRightRadius: 2 },
  aiBubble: { alignSelf: 'flex-start', borderWidth: 1, borderBottomLeftRadius: 2 },
  messageLoadingRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  messageLoadingText: { marginLeft: 8, fontSize: 12, flex: 1 },
  messageMeta: { marginTop: 8, fontSize: 11, fontWeight: '600' },
  durationText: { fontSize: 11, marginTop: 4, marginLeft: 4 },
  inputArea: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 12, paddingTop: 8, borderTopWidth: 1 },
  input: { flex: 1, minHeight: 44, maxHeight: 120, borderWidth: 1, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, marginRight: 10, textAlignVertical: 'top' },
  sendBtn: { width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center', marginBottom: 2 },
});
