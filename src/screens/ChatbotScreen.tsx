import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';
import Markdown from 'react-native-markdown-display';
import * as Clipboard from 'expo-clipboard';

import { NavigationProps, ChatbotScreenRouteProp } from '../navigation/types';
import { getAIRuntimeAvailability, getProvisioningStatusLabel, useAIStore, type Message } from '../store/useAIStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useAppTheme } from '../theme/useAppTheme';
import { replaceFalseConnectivityClaim, type LocalAiMode } from '../services/ai/agent';
import { getModelLifecycleManager } from '../services/ai/modelLifecycle';
import { getGenerationService, type GenerationServiceRuntimeSnapshot } from '../services/ai/generationService';
import { getErrorMessage } from '../services/ai/localInferenceTypes';
import { getChatRuntimePreloadService, type ChatRuntimePreloadSnapshot } from '../services/ai/chatRuntimePreloadService';
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

const QUICK_SUGGESTIONS = [
  { icon: 'wallet-outline', text: 'What is my total balance?' },
  { icon: 'fast-food-outline', text: 'How much did I spend on food in the last 30 days?' },
  { icon: 'receipt-outline', text: 'Show my recent transactions' },
  { icon: 'trending-up-outline', text: 'How can I save 20% of my income?' },
];

interface MessageBubbleProps {
  message: Message;
  durationLabel: string | null;
  onLongPress: (text: string) => void;
}

const MessageBubble = React.memo(function MessageBubble({
  message,
  durationLabel,
  onLongPress,
}: MessageBubbleProps) {
  const theme = useAppTheme();
  const markdownStyles = useMemo(
    () => ({
      body: { fontSize: 15, color: theme.text, lineHeight: 22 },
      paragraph: { marginTop: 2, marginBottom: 6, width: undefined },
      code_inline: { backgroundColor: theme.background, color: theme.primary },
      bullet_list_icon: { marginLeft: 4, marginRight: 8 },
      ordered_list_icon: { marginLeft: 4, marginRight: 8 },
      bullet_list_content: { flex: undefined, flexGrow: 0, flexShrink: 1 },
      ordered_list_content: { flex: undefined, flexGrow: 0, flexShrink: 1 },
    }),
    [theme.background, theme.primary, theme.text]
  );
  const parsedParts = useMemo(
    () => (message.role === 'ai' && message.text ? parseMessageWithCharts(message.text) : null),
    [message.role, message.text]
  );
  const handleLongPress = useCallback(() => {
    onLongPress(message.text);
  }, [message.text, onLongPress]);

  return (
    <View style={styles.messageWrap}>
      <TouchableOpacity
        activeOpacity={0.85}
        onLongPress={handleLongPress}
        style={[
          styles.messageBubble,
          message.role === 'user'
            ? [styles.userBubble, { backgroundColor: theme.primary }]
            : [styles.aiBubble, { backgroundColor: theme.surface, borderColor: theme.border }],
        ]}
      >
        {message.role === 'user' ? (
          <Text selectable style={{ fontSize: 15, color: theme.onPrimary, lineHeight: 22 }}>
            {message.text}
          </Text>
        ) : parsedParts ? (
          parsedParts.map((part, partIndex) =>
            part.type === 'markdown' ? (
              <Markdown key={partIndex} style={markdownStyles}>
                {part.content}
              </Markdown>
            ) : (
              <ChatChart key={partIndex} type={part.chartType!} data={part.chartData!} />
            )
          )
        ) : (
          <View style={styles.messageLoadingRow}>
            <ActivityIndicator color={theme.primary} size="small" />
            <Text style={[styles.messageLoadingText, { color: theme.textMuted }]}>Thinking…</Text>
          </View>
        )}
        {message.role === 'ai' && message.status && message.status !== 'complete' && (
          <Text style={[styles.messageMeta, { color: message.status === 'error' ? theme.expense : theme.textMuted }]}>
            {message.status === 'streaming' ? 'Generating response…' : message.status === 'cancelled' ? 'Cancelled' : 'Error'}
          </Text>
        )}
      </TouchableOpacity>
      {durationLabel && <Text style={[styles.durationText, { color: theme.textMuted }]}>{durationLabel}</Text>}
    </View>
  );
});

export const ChatbotScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const route = useRoute<ChatbotScreenRouteProp>();
  const theme = useAppTheme();
  const aiInferenceMode = useSettingsStore((state) => state.aiInferenceMode);
  const externalApiProvider = useSettingsStore((state) => state.externalApiProvider);
  const externalApiModel = useSettingsStore((state) => state.externalApiModel);

  const chatHistory = useAIStore((state) => state.chatHistory);
  const addChatMessage = useAIStore((state) => state.addChatMessage);
  const updateChatMessage = useAIStore((state) => state.updateChatMessage);
  const clearChatHistory = useAIStore((state) => state.clearChatHistory);
  const provisioning = useAIStore((state) => state.provisioning);
  const provisioningHydrated = useAIStore((state) => state.provisioningHydrated);
  const runtime = useAIStore((state) => state.runtime);
  const selectedMode = useAIStore((state) => state.selectedMode);
  const setSelectedMode = useAIStore((state) => state.setSelectedMode);
  const runtimeReady = useAIStore((state) => state.runtimeReady);
  const warmupPending = useAIStore((state) => state.warmupPending);
  const localModelDisplayName = useAIStore((state) => state.localModelDisplayName);

  const generationService = useMemo(() => getGenerationService(), []);
  const chatRuntimePreloadService = useMemo(() => getChatRuntimePreloadService(), []);
  const flatListRef = useRef<FlatList<Message>>(null);
  const initialMessage = route.params?.initialMessage || '';
  const [inputText, setInputText] = useState(initialMessage);
  const [chatRuntimeRequested, setChatRuntimeRequested] = useState(selectedMode === 'chat');
  const [isScreenFocused, setIsScreenFocused] = useState(false);
  const pendingAssistantMessageIdRef = useRef<string | null>(null);
  const chatHistoryLengthRef = useRef(chatHistory.length);
  const assistantMessageStartedAtRef = useRef<Record<string, number>>({});
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [serviceSnapshot, setServiceSnapshot] = useState<GenerationServiceRuntimeSnapshot>(() => generationService.getSnapshot());
  const [preloadSnapshot, setPreloadSnapshot] = useState<ChatRuntimePreloadSnapshot>(() => chatRuntimePreloadService.getSnapshot());
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(null);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(() =>
    Platform.OS === 'android' && typeof Keyboard.isVisible === 'function' ? Keyboard.isVisible() : false
  );

  useEffect(() => {
    chatHistoryLengthRef.current = chatHistory.length;
  }, [chatHistory.length]);

  const scrollToEnd = useCallback((animated: boolean) => {
    flatListRef.current?.scrollToEnd({ animated });
  }, []);

  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => {
        if (Platform.OS === 'android') {
          setIsKeyboardVisible(true);
        }
        if (chatHistoryLengthRef.current > 0) {
          requestAnimationFrame(() => scrollToEnd(true));
        }
      }
    );
    const hideSub =
      Platform.OS === 'android'
        ? Keyboard.addListener('keyboardDidHide', () => {
            setIsKeyboardVisible(false);
          })
        : null;
    return () => {
      showSub.remove();
      hideSub?.remove();
    };
  }, [scrollToEnd]);

  useEffect(() => {
    if (initialMessage && chatHistory.length === 0) {
      setInputText(initialMessage);
    }
  }, [initialMessage, chatHistory.length]);

  useEffect(() => {
    const subscription = generationService.subscribe(setServiceSnapshot);
    return () => {
      subscription.unsubscribe();
    };
  }, [generationService]);

  useEffect(() => {
    const subscription = chatRuntimePreloadService.subscribe(setPreloadSnapshot);
    return () => {
      subscription.unsubscribe();
    };
  }, [chatRuntimePreloadService]);

  useEffect(() => {
    void getModelLifecycleManager()?.ensureInitialized?.();
  }, []);

  const handleCopyToClipboard = useCallback(async (text: string) => {
    await Clipboard.setStringAsync(text);
    Alert.alert('Copied', 'Message copied to clipboard.');
  }, []);

  const handleClearHistoryWithConfirm = () => {
    if (chatHistory.length === 0) return;
    Alert.alert(
      'Clear Chat History',
      'Are you sure you want to delete all messages in this conversation?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear All',
          style: 'destructive',
          onPress: () => {
            clearChatHistory();
            setLastFailedPrompt(null);
          },
        },
      ]
    );
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
  } = getAIRuntimeAvailability({ provisioning, runtimeReady, warmupPending, runtime, provisioningHydrated });
  const isCheckingLocalProvisioning =
    aiInferenceMode === 'local' &&
    hasUsableLocalInferenceBackend &&
    !provisioningHydrated &&
    provisioning.status === 'not-installed';
  const canSendMessage = aiMode === 'rag' ? canRunGroundedQueries : canRunNativeChat;
  const canStartOrRetryProvisioning =
    aiInferenceMode === 'local' &&
    hasUsableLocalInferenceBackend &&
    !isCheckingLocalProvisioning &&
    ['failed', 'not-installed', 'update-available'].includes(provisioning.status);
  const isBusyProvisioning =
    aiInferenceMode === 'local' &&
    hasUsableLocalInferenceBackend &&
    ['queued', 'downloading', 'verifying', 'unpacking', 'registering', 'warming', 'indexing'].includes(provisioning.status);
  const showPrimaryProvisionAction =
    aiInferenceMode === 'local' && hasUsableLocalInferenceBackend && !canRunNativeChat && canStartOrRetryProvisioning;
  const isPreparingChatRuntime = aiInferenceMode === 'local' ? serviceSnapshot.isPreparingRuntime : false;
  const chatRuntimeStatus = serviceSnapshot.runtimeStatus;
  const isLoading = serviceSnapshot.isGenerating;
  const loadingStatus = serviceSnapshot.generationStatus;
  const activeRuntimeErrorMessage =
    runtime.lastRuntimeError && runtime.lastRuntimeError.code !== 'generation-cancelled'
      ? runtime.lastRuntimeError.message
      : null;
  const runtimeLoadError =
    aiInferenceMode === 'local' &&
    hasUsableLocalInferenceBackend &&
    provisioning.status === 'ready' &&
    !canRunNativeChat &&
    !isPreparingChatRuntime
      ? activeRuntimeErrorMessage ?? preloadSnapshot.error
      : null;
  const canRetryRuntimeLoad =
    aiInferenceMode === 'local' &&
    hasUsableLocalInferenceBackend &&
    provisioning.status === 'ready' &&
    !canRunNativeChat &&
    !isPreparingChatRuntime &&
    !isBusyProvisioning &&
    Boolean(runtimeLoadError);
  const isExternalUnconfigured = aiInferenceMode === 'external' && !canRunNativeChat;

  useFocusEffect(
    useCallback(() => {
      generationService.cancelScheduledUnload();
      setIsScreenFocused(true);

      return () => {
        setIsScreenFocused(false);
        chatRuntimePreloadService.clearRequest();
        generationService.scheduleModelUnload(30000);
      };
    }, [chatRuntimePreloadService, generationService])
  );

  useEffect(() => {
    if (!isScreenFocused) {
      return;
    }

    if (aiInferenceMode === 'local') {
      void chatRuntimePreloadService.requestPreload();
    } else {
      chatRuntimePreloadService.clearRequest();
    }
  }, [aiInferenceMode, chatRuntimePreloadService, isScreenFocused]);

  useEffect(() => {
    if (isScreenFocused && selectedMode === 'chat' && aiInferenceMode === 'local') {
      setChatRuntimeRequested(true);
    }
  }, [aiInferenceMode, isScreenFocused, selectedMode]);

  useEffect(() => {
    const activeStartedAt = runtime.activePhaseStartedAt;
    const shouldRun =
      Boolean(activeStartedAt) &&
      (isPreparingChatRuntime ||
        isLoading ||
        isBusyProvisioning ||
        Boolean(runtime.activeGenerationRequestId));

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
  }, [
    isBusyProvisioning,
    isLoading,
    isPreparingChatRuntime,
    runtime.activeGenerationRequestId,
    runtime.activePhaseStartedAt,
  ]);

  // Smooth scroll down when token streaming without jumping
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

      scrollToEnd(false);
      return;
    }

    if (!runtime.activeGenerationRequestId) {
      updateChatMessage(pendingId, (message) => {
        let finalStatus: 'cancelled' | 'error' | 'complete' | 'streaming' | undefined =
          message.status === 'cancelled' || message.status === 'error' ? message.status : 'complete';
        let finalText = message.text;

        if (finalStatus === 'complete' && !message.text) {
          finalStatus = 'error';
          finalText = 'Generation failed to return any response.';
        }

        return {
          ...message,
          text: finalText,
          status: finalStatus,
        };
      });
      pendingAssistantMessageIdRef.current = null;
      scrollToEnd(true);
    }
  }, [runtime.activeGenerationRequestId, runtime.streamingResponseText, scrollToEnd, updateChatMessage]);

  useEffect(() => {
    return () => {
      pendingAssistantMessageIdRef.current = null;
    };
  }, []);

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

    if (isCheckingLocalProvisioning) {
      return 'Checking local AI model status...';
    }

    if (provisioning.status === 'queued') {
      return 'Queuing local model setup...';
    }
    if (provisioning.status === 'downloading') {
      return `Downloading local model${progressPercent > 0 ? ` (${progressPercent}%)` : '...'} `;
    }
    if (provisioning.status === 'verifying') {
      return 'Verifying downloaded model...';
    }
    if (provisioning.status === 'unpacking') {
      return 'Preparing offline runtime...';
    }
    if (provisioning.status === 'registering') {
      return 'Loading model into device memory...';
    }
    if (provisioning.status === 'warming') {
      return 'Warming up local inference...';
    }
    if (provisioning.status === 'indexing') {
      return 'Finalizing local index...';
    }
    if (runtime.activeGenerationRequestId) {
      return aiInferenceMode === 'external' ? 'Generating response from external API...' : 'Generating response locally on device.';
    }
    return null;
  }, [
    aiInferenceMode,
    chatRuntimeStatus,
    isCheckingLocalProvisioning,
    isLoading,
    isPreparingChatRuntime,
    loadingStatus,
    progressPercent,
    provisioning.status,
    runtime.activeGenerationRequestId,
    runtime.activeStatusLabel,
  ]);

  const compactStatusTone =
    runtime.activeGenerationRequestId || isLoading || isPreparingChatRuntime || isBusyProvisioning
      ? theme.primary
      : theme.textMuted;

  const transferRateLabel = useMemo(() => {
    if (!provisioning.transfer.bytesPerSecond || provisioning.transfer.bytesPerSecond <= 0) {
      return null;
    }

    return `${(provisioning.transfer.bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`;
  }, [provisioning.transfer.bytesPerSecond]);

  const handleProvisionAction = async () => {
    try {
      if (provisioning.status === 'not-installed') {
        navigation.navigate('Settings');
        return;
      }
      if (['failed', 'update-available'].includes(provisioning.status)) {
        await getModelLifecycleManager().retryProvisioning();
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

  const handleRetryChatRuntime = useCallback(() => {
    void chatRuntimePreloadService.retryPreload();
  }, [chatRuntimePreloadService]);

  const executeSend = async (queryText: string) => {
    if (!queryText.trim() || isLoading || isPreparingChatRuntime || runtime.activeGenerationRequestId || !canSendMessage) {
      return;
    }

    const userQuery = queryText.trim();
    const userMessageId = `user-${Date.now()}`;
    const assistantMessageId = `assistant-${Date.now()}`;
    const startedAt = Date.now();

    setLastFailedPrompt(null);
    assistantMessageStartedAtRef.current[assistantMessageId] = startedAt;
    pendingAssistantMessageIdRef.current = assistantMessageId;
    setInputText('');
    addChatMessage({ role: 'user', text: userQuery, id: userMessageId, createdAt: new Date(startedAt).toISOString() });
    addChatMessage({ role: 'ai', text: '', id: assistantMessageId, status: 'streaming', createdAt: new Date(startedAt).toISOString() });

    requestAnimationFrame(() => {
      scrollToEnd(true);
    });

    try {
      const responseText = await generationService.startGeneration({
        prompt: userQuery,
        mode: aiMode as LocalAiMode,
        disableThinking: true,
      });
      const durationMs = Date.now() - startedAt;
      updateChatMessage(assistantMessageId, {
        text: replaceFalseConnectivityClaim(responseText, aiMode as LocalAiMode),
        status: 'complete',
        createdAt: new Date(startedAt).toISOString(),
      });
      assistantMessageStartedAtRef.current[assistantMessageId] = durationMs;
      pendingAssistantMessageIdRef.current = null;
    } catch (error) {
      const message = getErrorMessage(error, 'Silo AI query failed.');
      const isCancelled = message.toLowerCase().includes('cancel');
      const durationMs = Date.now() - startedAt;
      updateChatMessage(assistantMessageId, {
        text: message,
        status: isCancelled ? 'cancelled' : 'error',
        createdAt: new Date(startedAt).toISOString(),
      });
      assistantMessageStartedAtRef.current[assistantMessageId] = durationMs;
      pendingAssistantMessageIdRef.current = null;
      if (!isCancelled) {
        setLastFailedPrompt(userQuery);
      }
    } finally {
      requestAnimationFrame(() => {
        scrollToEnd(true);
      });
    }
  };

  const handleSend = () => {
    executeSend(inputText);
  };

  const handleSuggestionPress = (suggestion: string) => {
    executeSend(suggestion);
  };

  const handleRetryLast = () => {
    if (lastFailedPrompt) {
      executeSend(lastFailedPrompt);
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

  const keyExtractor = useCallback((item: Message, index: number) => item.id ?? String(index), []);

  const renderMessageItem = useCallback(
    ({ item }: { item: Message }) => {
      const measuredDuration = item.id ? assistantMessageStartedAtRef.current[item.id] : null;
      const durationLabel =
        typeof measuredDuration === 'number' && item.role === 'ai' && item.status === 'complete' && measuredDuration < 600000
          ? `${(measuredDuration / 1000).toFixed(measuredDuration >= 10000 ? 0 : 1)}s inference`
          : null;

      return <MessageBubble message={item} durationLabel={durationLabel} onLongPress={handleCopyToClipboard} />;
    },
    [handleCopyToClipboard]
  );

  const showChatRuntimeGate = aiMode === 'chat' && chatRuntimeRequested && (!canRunNativeChat || isPreparingChatRuntime || isBusyProvisioning);
  const isNotInstalled = !isCheckingLocalProvisioning && provisioning.status === 'not-installed';
  const chatRuntimeActionLabel = isNotInstalled ? 'Set Up AI Model' : canStartOrRetryProvisioning ? 'Retry chat setup' : 'Preparing chatbot';
  const statusMetaLabel = elapsedSeconds > 0 ? `${formatElapsed(elapsedSeconds)} elapsed` : null;
  const inlineModelStatusLabel =
    aiInferenceMode === 'external'
      ? canRunNativeChat
        ? 'External API'
        : 'Setup needed'
      : !hasUsableLocalInferenceBackend
      ? 'Unavailable'
      : isCheckingLocalProvisioning
      ? 'Checking…'
      : isPreparingChatRuntime
      ? 'Loading'
      : runtimeLoadError
      ? 'Load failed'
      : `${getProvisioningStatusLabel(provisioning.status)}${progressPercent > 0 && provisioning.status !== 'ready' ? ` · ${progressPercent}%` : ''}`;
  const trimmedExternalModel = externalApiModel.trim();
  const displayModelSubtitle =
    aiInferenceMode === 'external'
      ? trimmedExternalModel
        ? `${externalApiProvider.toUpperCase()} · ${trimmedExternalModel}`
        : `${externalApiProvider.toUpperCase()} · Not configured`
      : localModelDisplayName;
  const showEmptyChatPrepareGate =
    chatHistory.length === 0 &&
    showChatRuntimeGate &&
    isPreparingChatRuntime &&
    !isBusyProvisioning &&
    !isLoading &&
    !runtime.activeGenerationRequestId;
  const showCompactLoader =
    Boolean(stageStatusMessage) &&
    !showEmptyChatPrepareGate &&
    (isBusyProvisioning || isPreparingChatRuntime || isLoading || Boolean(runtime.activeGenerationRequestId));
  const hasStatusError =
    !hasUsableLocalInferenceBackend ||
    Boolean(runtimeLoadError) ||
    provisioning.status === 'failed' ||
    isExternalUnconfigured;
  const isBusyChatAction = isLoading || isPreparingChatRuntime || Boolean(runtime.activeGenerationRequestId);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.keyboardShell}
        behavior="padding"
        enabled={Platform.OS === 'ios' || isKeyboardVisible}
      >
        {/* Header */}
        <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={styles.headerIconButton}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="chevron-back" size={24} color={theme.text} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <View style={styles.headerTitleRow}>
              <Text style={[styles.headerTitle, { color: theme.text }]}>Silo AI</Text>
              <View style={[styles.inlineStatusChip, { backgroundColor: theme.background, borderColor: theme.border }]}>
                <View
                  style={[
                    styles.inlineStatusDot,
                    { backgroundColor: canRunNativeChat ? theme.primary : hasStatusError ? theme.expense : theme.textMuted },
                  ]}
                />
                <Text style={[styles.inlineStatusChipText, { color: canRunNativeChat ? theme.primary : hasStatusError ? theme.expense : theme.textMuted }]}>
                  {inlineModelStatusLabel}
                </Text>
              </View>
            </View>
            <Text style={[styles.headerSubtitle, { color: theme.textMuted }]} numberOfLines={1}>
              {displayModelSubtitle}
            </Text>
          </View>
          <TouchableOpacity
            onPress={handleClearHistoryWithConfirm}
            disabled={chatHistory.length === 0}
            style={[styles.headerIconButton, chatHistory.length === 0 && { opacity: 0.35 }]}
            accessibilityRole="button"
            accessibilityLabel="Clear chat history"
          >
            <Ionicons name="trash-outline" size={20} color={theme.expense} />
          </TouchableOpacity>
        </View>

        {/* Status Card & Loader */}
        <View style={[styles.statusCard, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
          <View style={styles.statusHeaderRow}>
            <Text
              style={[
                styles.statusMessage,
                styles.statusMessageTight,
                { color: hasStatusError ? theme.expense : theme.textMuted },
              ]}
            >
              {runtimeLoadError || localInferenceStatusMessage}
            </Text>
            {showPrimaryProvisionAction ? (
              <TouchableOpacity
                style={[styles.primaryMiniButton, { backgroundColor: theme.primary }]}
                onPress={handleProvisionAction}
                hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                accessibilityRole="button"
                accessibilityLabel={isNotInstalled ? 'Set up AI model' : 'Retry AI model setup'}
              >
                <Text style={[styles.primaryMiniButtonText, { color: theme.onPrimary }]}>
                  {isNotInstalled ? 'Set up' : 'Retry'}
                </Text>
              </TouchableOpacity>
            ) : canRetryRuntimeLoad ? (
              <TouchableOpacity
                style={[styles.primaryMiniButton, { backgroundColor: theme.primary }]}
                onPress={handleRetryChatRuntime}
                hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                accessibilityRole="button"
                accessibilityLabel="Retry loading AI model"
              >
                <Text style={[styles.primaryMiniButtonText, { color: theme.onPrimary }]}>Retry</Text>
              </TouchableOpacity>
            ) : isExternalUnconfigured ? (
              <TouchableOpacity
                style={[styles.primaryMiniButton, { backgroundColor: theme.primary }]}
                onPress={() => navigation.navigate('Settings')}
                hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                accessibilityRole="button"
                accessibilityLabel="Configure external API"
              >
                <Text style={[styles.primaryMiniButtonText, { color: theme.onPrimary }]}>Settings</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          {showCompactLoader && (
            <View style={[styles.compactStatusBar, { backgroundColor: theme.background, borderColor: theme.border }]}>
              <ActivityIndicator color={theme.primary} size="small" />
              <View style={styles.compactStatusCopy}>
                <Text style={[styles.compactStatusTitle, { color: compactStatusTone }]} numberOfLines={2}>
                  {stageStatusMessage || 'Preparing AI model...'}
                </Text>
                {statusMetaLabel && (
                  <Text style={[styles.compactStatusMeta, { color: theme.textMuted }]}>{statusMetaLabel}</Text>
                )}
              </View>
              {runtime.activeGenerationRequestId ? (
                <TouchableOpacity
                  onPress={handleCancelGeneration}
                  style={styles.pauseButton}
                  hitSlop={{ top: 4, bottom: 4, left: 8, right: 8 }}
                  accessibilityRole="button"
                  accessibilityLabel="Stop generation"
                >
                  <Text style={[styles.pauseButtonText, { color: theme.expense }]}>Stop</Text>
                </TouchableOpacity>
              ) : isBusyProvisioning ? (
                <TouchableOpacity
                  onPress={handleCancelDownload}
                  style={styles.pauseButton}
                  hitSlop={{ top: 4, bottom: 4, left: 8, right: 8 }}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel download"
                >
                  <Text style={[styles.pauseButtonText, { color: theme.expense }]}>Cancel</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          )}

          {aiInferenceMode === 'local' && hasUsableLocalInferenceBackend && transferRateLabel && !showCompactLoader && (
            <Text style={[styles.metaLine, { color: theme.textMuted }]}>Transfer speed: {transferRateLabel}</Text>
          )}
        </View>

        {/* Actionable Error Banner if last request failed */}
        {lastFailedPrompt && (
          <View style={[styles.errorBanner, { backgroundColor: theme.expenseMuted, borderColor: theme.expense }]}>
            <Ionicons name="alert-circle-outline" size={18} color={theme.expense} style={{ marginRight: 8 }} />
            <Text style={[styles.errorBannerText, { color: theme.expense }]}>
              Previous query encountered an error.
            </Text>
            <TouchableOpacity
              style={[styles.retryPill, { backgroundColor: theme.expense }]}
              onPress={handleRetryLast}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Retry last query"
            >
              <Ionicons name="refresh" size={14} color={theme.onPrimary} style={{ marginRight: 4 }} />
              <Text style={[styles.retryPillText, { color: theme.onPrimary }]}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Mode Toggle: Grounded vs Chat */}
        <View style={[styles.toggleContainer, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
          <TouchableOpacity
            style={[styles.toggleBtn, aiMode === 'rag' && { backgroundColor: theme.primary }]}
            hitSlop={{ top: 4, bottom: 4, left: 0, right: 0 }}
            onPress={() => setSelectedMode('rag')}
            accessibilityRole="button"
            accessibilityLabel="Switch to Grounded mode"
          >
            <Text style={[styles.toggleText, { color: aiMode === 'rag' ? theme.onPrimary : theme.textMuted }]}>Grounded</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toggleBtn, aiMode === 'chat' && { backgroundColor: theme.primary }]}
            hitSlop={{ top: 4, bottom: 4, left: 0, right: 0 }}
            onPress={() => {
              setChatRuntimeRequested(true);
              setSelectedMode('chat');
            }}
            accessibilityRole="button"
            accessibilityLabel="Switch to Chat mode"
          >
            <Text style={[styles.toggleText, { color: aiMode === 'chat' ? theme.onPrimary : theme.textMuted }]}>Chat</Text>
          </TouchableOpacity>
        </View>

        {/* Chat History List */}
        <FlatList
          ref={flatListRef}
          style={styles.chatArea}
          data={chatHistory}
          keyExtractor={keyExtractor}
          renderItem={renderMessageItem}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          contentContainerStyle={{
            paddingHorizontal: 14,
            paddingTop: 14,
            paddingBottom: 20,
          }}
          onContentSizeChange={() => {
            if (runtime.activeGenerationRequestId) {
              scrollToEnd(false);
            }
          }}
          ListEmptyComponent={
            showChatRuntimeGate ? (
              <View style={styles.emptyStateWrap}>
                <View style={[styles.chatGateCard, styles.chatGateCardCompact, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                  {isPreparingChatRuntime || isBusyProvisioning || isCheckingLocalProvisioning ? (
                    <>
                      <ActivityIndicator color={theme.primary} size="small" />
                      <Text style={[styles.chatGateText, { color: theme.textMuted }]}>
                        {stageStatusMessage ?? 'Opening local chatbot...'}
                      </Text>
                      {statusMetaLabel ? (
                        <Text style={[styles.compactStatusMeta, { color: theme.textMuted }]}>{statusMetaLabel}</Text>
                      ) : null}
                    </>
                  ) : canRetryRuntimeLoad ? (
                    <>
                      <Ionicons name="alert-circle-outline" size={24} color={theme.expense} />
                      <Text style={[styles.chatGateText, { color: theme.expense }]}>
                        {runtimeLoadError}
                      </Text>
                      <TouchableOpacity
                        style={[styles.chatGateButton, { backgroundColor: theme.primary }]}
                        onPress={handleRetryChatRuntime}
                        accessibilityRole="button"
                        accessibilityLabel="Retry loading AI model"
                      >
                        <Text style={[styles.chatGateButtonText, { color: theme.onPrimary }]}>Retry</Text>
                      </TouchableOpacity>
                    </>
                  ) : isNotInstalled ? (
                    <>
                      <Ionicons name="sparkles-outline" size={22} color={theme.primary} />
                      <Text style={[styles.chatGateText, { color: theme.textMuted }]}>
                        Download the local AI model in Settings to use offline Chat mode.
                      </Text>
                      <TouchableOpacity
                        style={[styles.chatGateButton, { backgroundColor: theme.primary }]}
                        onPress={handleProvisionAction}
                        accessibilityRole="button"
                        accessibilityLabel={chatRuntimeActionLabel}
                      >
                        <Text style={[styles.chatGateButtonText, { color: theme.onPrimary }]}>{chatRuntimeActionLabel}</Text>
                      </TouchableOpacity>
                    </>
                  ) : canStartOrRetryProvisioning ? (
                    <>
                      <Ionicons name="alert-circle-outline" size={24} color={theme.expense} />
                      <Text style={[styles.chatGateText, { color: theme.expense }]}>
                        {provisioning.lastError || localInferenceStatusMessage}
                      </Text>
                      <TouchableOpacity
                        style={[styles.chatGateButton, { backgroundColor: theme.primary }]}
                        onPress={handleProvisionAction}
                        accessibilityRole="button"
                        accessibilityLabel={chatRuntimeActionLabel}
                      >
                        <Text style={[styles.chatGateButtonText, { color: theme.onPrimary }]}>{chatRuntimeActionLabel}</Text>
                      </TouchableOpacity>
                    </>
                  ) : isExternalUnconfigured ? (
                    <>
                      <Ionicons name="settings-outline" size={22} color={theme.primary} />
                      <Text style={[styles.chatGateText, { color: theme.textMuted }]}>
                        Configure an external API URL and model in Settings to use Chat mode.
                      </Text>
                      <TouchableOpacity
                        style={[styles.chatGateButton, { backgroundColor: theme.primary }]}
                        onPress={() => navigation.navigate('Settings')}
                        accessibilityRole="button"
                        accessibilityLabel="Open Settings"
                      >
                        <Text style={[styles.chatGateButtonText, { color: theme.onPrimary }]}>Open Settings</Text>
                      </TouchableOpacity>
                    </>
                  ) : !hasUsableLocalInferenceBackend ? (
                    <>
                      <Ionicons name="alert-circle-outline" size={24} color={theme.expense} />
                      <Text style={[styles.chatGateText, { color: theme.expense }]}>
                        {localInferenceStatusMessage}
                      </Text>
                    </>
                  ) : (
                    <>
                      <Ionicons name="sparkles-outline" size={22} color={theme.primary} />
                      <Text style={[styles.chatGateText, { color: theme.textMuted }]}>
                        {localInferenceStatusMessage}
                      </Text>
                      {aiInferenceMode === 'local' && provisioning.status === 'ready' ? (
                        <TouchableOpacity
                          style={[styles.chatGateButton, { backgroundColor: theme.primary }]}
                          onPress={handleRetryChatRuntime}
                          accessibilityRole="button"
                          accessibilityLabel="Load AI Model"
                        >
                          <Text style={[styles.chatGateButtonText, { color: theme.onPrimary }]}>Load AI Model</Text>
                        </TouchableOpacity>
                      ) : null}
                    </>
                  )}
                </View>
              </View>
            ) : (
              <View style={styles.emptyStateWrap}>
                <Text style={[styles.placeholderText, { color: theme.textMuted }]}>
                  {canSendMessage
                    ? 'Ask anything about your personal finances or tap a quick question:'
                    : aiMode === 'rag'
                    ? 'Grounded queries are answered from records stored on this device only.'
                    : 'Chat mode is disabled because on-device generation is unavailable.'}
                </Text>

                {/* Interactive Quick Suggestion Pills */}
                {canSendMessage && (
                  <View style={styles.suggestionGrid}>
                    {QUICK_SUGGESTIONS.map((suggestion, idx) => (
                      <TouchableOpacity
                        key={idx}
                        disabled={isBusyChatAction}
                        style={[
                          styles.suggestionPill,
                          {
                            backgroundColor: theme.surface,
                            borderColor: theme.border,
                            opacity: isBusyChatAction ? 0.55 : 1,
                          },
                        ]}
                        onPress={() => handleSuggestionPress(suggestion.text)}
                        accessibilityRole="button"
                        accessibilityLabel={suggestion.text}
                      >
                        <Ionicons
                          name={suggestion.icon as any}
                          size={16}
                          color={theme.primary}
                          style={{ marginRight: 8 }}
                        />
                        <Text style={[styles.suggestionText, { color: theme.text }]}>{suggestion.text}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            )
          }
        />

        {/* Input Bar */}
        <View
          style={[
            styles.inputArea,
            {
              backgroundColor: theme.surface,
              borderTopColor: theme.border,
              paddingBottom: 10,
            },
          ]}
        >
          <TextInput
            style={[
              styles.input,
              {
                backgroundColor: theme.background,
                borderColor: theme.border,
                color: theme.text,
                opacity: canSendMessage && !showChatRuntimeGate ? 1 : 0.7,
              },
            ]}
            placeholderTextColor={theme.textMuted}
            placeholder={
              isPreparingChatRuntime || isBusyProvisioning
                ? 'Waiting for AI chatbot to load...'
                : canRetryRuntimeLoad
                ? 'Model failed to load — tap Retry above'
                : showChatRuntimeGate && isNotInstalled
                ? 'Set up the AI model in Settings to chat'
                : showChatRuntimeGate
                ? 'Chat mode unavailable right now'
                : canSendMessage
                ? 'Ask about your finances or spending...'
                : aiMode === 'rag'
                ? 'Ask a grounded query about your records...'
                : 'Chat mode unavailable on this build'
            }
            value={inputText}
            onChangeText={setInputText}
            onSubmitEditing={handleSend}
            editable={canSendMessage && !showChatRuntimeGate}
            multiline
            maxLength={2000}
          />
          {runtime.activeGenerationRequestId ? (
            <TouchableOpacity
              style={[styles.sendBtn, { backgroundColor: theme.expense }]}
              onPress={handleCancelGeneration}
              accessibilityRole="button"
              accessibilityLabel="Stop generation"
            >
              <Ionicons name="stop" size={18} color={theme.onPrimary} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[
                styles.sendBtn,
                {
                  backgroundColor:
                    canSendMessage && !showChatRuntimeGate && !runtime.activeGenerationRequestId && inputText.trim()
                      ? theme.primary
                      : theme.border,
                },
              ]}
              onPress={handleSend}
              disabled={!canSendMessage || isLoading || showChatRuntimeGate || Boolean(runtime.activeGenerationRequestId) || !inputText.trim()}
              accessibilityRole="button"
              accessibilityLabel="Send message"
            >
              <Ionicons name="send" size={18} color={theme.onPrimary} />
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  headerIconButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  headerCenter: { flex: 1, marginHorizontal: 8 },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  headerSubtitle: { fontSize: 11, marginTop: 1 },
  inlineStatusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    maxWidth: '68%',
  },
  inlineStatusDot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  inlineStatusChipText: { fontSize: 10, fontWeight: '700', flexShrink: 1 },
  statusCard: { paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1 },
  statusHeaderRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  statusMessage: { fontSize: 11, lineHeight: 15, marginTop: 2, flex: 1 },
  statusMessageTight: { marginTop: 0 },
  metaLine: { fontSize: 10, lineHeight: 14, marginTop: 4 },
  pauseButton: { paddingHorizontal: 8, paddingVertical: 4, minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  pauseButtonText: { fontSize: 12, fontWeight: '700' },
  primaryMiniButton: { borderRadius: 999, paddingHorizontal: 14, minHeight: 36, justifyContent: 'center', alignItems: 'center' },
  primaryMiniButtonText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginHorizontal: 12,
    marginTop: 8,
    borderRadius: 12,
  },
  errorBannerText: { flex: 1, fontSize: 12, fontWeight: '600' },
  retryPill: { flexDirection: 'row', alignItems: 'center', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, minHeight: 32 },
  retryPillText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  toggleContainer: { flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: 1 },
  toggleBtn: { flex: 1, minHeight: 38, justifyContent: 'center', alignItems: 'center', borderRadius: 10 },
  toggleText: { fontSize: 13, fontWeight: '700' },
  chatArea: { flex: 1 },
  emptyStateWrap: { marginTop: 20, gap: 14 },
  chatGateCard: { borderWidth: 1, borderRadius: 18, padding: 16, alignItems: 'center', gap: 10 },
  chatGateCardCompact: { paddingVertical: 14 },
  chatGateText: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  chatGateButton: { borderRadius: 999, paddingHorizontal: 18, minHeight: 48, justifyContent: 'center', marginTop: 4 },
  chatGateButtonText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  placeholderText: { textAlign: 'center', fontSize: 13, lineHeight: 18, paddingHorizontal: 16 },
  suggestionGrid: { flexDirection: 'column', gap: 8, paddingHorizontal: 4 },
  suggestionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: 1,
  },
  suggestionText: { fontSize: 13, fontWeight: '600', flex: 1 },
  compactStatusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  compactStatusCopy: { flex: 1 },
  compactStatusTitle: { fontSize: 12, fontWeight: '700' },
  compactStatusMeta: { fontSize: 11, marginTop: 2 },
  messageWrap: { marginBottom: 12 },
  messageBubble: { maxWidth: '85%', padding: 12, borderRadius: 16 },
  userBubble: { alignSelf: 'flex-end', borderBottomRightRadius: 4 },
  aiBubble: { alignSelf: 'flex-start', borderWidth: 1, borderBottomLeftRadius: 4 },
  messageLoadingRow: { flexDirection: 'row', alignItems: 'center' },
  messageLoadingText: { marginLeft: 8, fontSize: 13 },
  messageMeta: { marginTop: 8, fontSize: 11, fontWeight: '600' },
  durationText: { fontSize: 10, marginTop: 4, marginLeft: 4 },
  inputArea: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: 1,
  },
  input: {
    flex: 1,
    minHeight: 48,
    maxHeight: 120,
    borderWidth: 1,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginRight: 8,
    textAlignVertical: 'top',
    fontSize: 14,
  },
  sendBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 2,
  },
});
