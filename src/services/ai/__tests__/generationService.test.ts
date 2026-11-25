import * as ExpoFileSystemLegacy from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { db } from '../../../db/index';
import { getGenerationService, isVisionAvailable, type GenerationServiceRuntimeSnapshot } from '../generationService';
import { getLlamaRnAdapter } from '../llamaRnAdapter';
import {
  getActiveModelFileUri,
  getModelLifecycleManager,
  isActiveModelInstalled,
  isVisionProjectorInstalled,
} from '../modelLifecycle';
import {
  getAIRuntimeAvailability,
  useAIStore,
  createInitialProvisioningSnapshot,
  createInitialRuntimeSnapshot,
} from '../../../store/useAIStore';
import { useSettingsStore } from '../../../store/useSettingsStore';

jest.mock('../modelLifecycle', () => ({
  ...jest.requireActual('../modelLifecycle'),
  isActiveModelInstalled: jest.fn(async () => true),
  isVisionProjectorInstalled: jest.fn(async () => true),
}));

jest.mock('../llamaRnAdapter', () => {
  const adapter = {
    initContext: jest.fn(async () => {}),
    completion: jest.fn(async () => ({
      requestId: 'req-1',
      text: 'Local response',
      stopReason: 'stop' as const,
      promptTokens: 5,
      completionTokens: 4,
    })),
    stopCompletion: jest.fn(async () => {}),
    releaseContext: jest.fn(async () => {}),
    dispose: jest.fn(async () => {}),
    getContextTokens: jest.fn(() => 2048),
    getRuntimeInfo: jest.fn(async () => ({
      backend: 'llama.rn-cpu',
      version: null,
      supportsStreaming: true,
      isModelLoaded: true,
      loadedModelFamily: 'qwen',
      loadedModelPath: 'file:///mock/model.gguf',
    })),
  };
  return {
    getLlamaRnAdapter: jest.fn(() => adapter),
  };
});

type MockXhrInstance = {
  open: jest.Mock;
  setRequestHeader: jest.Mock;
  send: jest.Mock;
  abort: jest.Mock;
  status: number;
  responseText: string;
  onprogress: (() => void) | null;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
};

describe('GenerationService', () => {
  const adapter = getLlamaRnAdapter() as unknown as {
    initContext: jest.Mock;
    completion: jest.Mock;
    stopCompletion: jest.Mock;
    releaseContext: jest.Mock;
    dispose: jest.Mock;
    getRuntimeInfo: jest.Mock;
  };
  const fsMock = ExpoFileSystemLegacy as unknown as {
    documentDirectory: string;
    getInfoAsync: jest.Mock;
  };

  let xhrInstances: MockXhrInstance[];
  let originalXhr: typeof XMLHttpRequest;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useRealTimers();
    Object.defineProperty(Platform, 'OS', { get: () => 'android', configurable: true });
    fsMock.documentDirectory = 'file:///mock/data/user/0/com.LCSdev.silo/files/';
    fsMock.getInfoAsync.mockResolvedValue({ exists: true, size: 1024, uri: getActiveModelFileUri() });

    xhrInstances = [];
    originalXhr = global.XMLHttpRequest;
    global.XMLHttpRequest = jest.fn(() => {
      const instance: MockXhrInstance = {
        open: jest.fn(),
        setRequestHeader: jest.fn(),
        send: jest.fn(),
        abort: jest.fn(),
        status: 200,
        responseText: '',
        onprogress: null,
        onload: null,
        onerror: null,
        onabort: null,
      };
      xhrInstances.push(instance);
      return instance as unknown as XMLHttpRequest;
    }) as unknown as typeof XMLHttpRequest;

    useSettingsStore.setState({
      aiInferenceMode: 'local',
      activeModelId: 'qwen3.5-2b',
      externalApiProvider: 'openai',
      externalApiUrl: 'https://api.openai.com/v1',
      externalApiModel: 'gpt-4o-mini',
      externalApiKey: '',
      externalApiCustomHeaders: '{}',
      localSystemPrompt: '',
      externalSystemPrompt: '',
    });

    useAIStore.setState({
      provisioning: createInitialProvisioningSnapshot(),
      runtime: createInitialRuntimeSnapshot(),
      runtimeReady: false,
      warmupPending: false,
      chatHistory: [],
      logs: [],
    });

    await getGenerationService().dispose();
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.XMLHttpRequest = originalXhr;
  });

  describe('A8 model path single source of truth', () => {
    it('falls back to getActiveModelFileUri() when provisioning.modelPath is null and reports load progress', async () => {
      const statuses: string[] = [];
      adapter.initContext.mockImplementationOnce(async ({ onProgress }: { onProgress?: (percent: number) => void }) => {
        onProgress?.(27);
        onProgress?.(100);
      });

      const service = getGenerationService();
      const sub = service.subscribe((snapshot) => {
        if (snapshot.runtimeStatus) {
          statuses.push(snapshot.runtimeStatus);
        }
      });

      await service.ensureChatRuntimeReady();
      sub.unsubscribe();

      expect(adapter.initContext).toHaveBeenCalledWith(
        expect.objectContaining({
          modelPath: getActiveModelFileUri(),
          modelFileSizeBytes: 1024,
          onProgress: expect.any(Function),
        }),
      );
      expect(statuses).toContain('Loading local model (25%)...');
      expect(statuses).toContain('Finalizing local model...');
    });
  });

  describe('A6 try/finally error safety', () => {
    it('resets isGenerating and generationStatus if ensureChatRuntimeReady rejects', async () => {
      adapter.initContext.mockRejectedValueOnce(new Error('Model file missing'));
      const service = getGenerationService();

      await expect(
        service.startGeneration({ prompt: 'Hello', mode: 'chat' }),
      ).rejects.toThrow('Model file missing');

      expect(service.getSnapshot().isGenerating).toBe(false);
      expect(service.getSnapshot().generationStatus).toBe('');
      expect(useAIStore.getState().runtime.activeGenerationRequestId).toBeNull();
    });
  });

  describe('A10 scheduleModelUnload & dispose timer safety', () => {
    it('does not unload while a generation is in flight and reschedules until idle', async () => {
      jest.useFakeTimers();
      const service = getGenerationService();

      let resolveCompletion!: (value: any) => void;
      let notifyCompletionStarted!: () => void;
      const completionStarted = new Promise<void>((resolve) => {
        notifyCompletionStarted = resolve;
      });
      adapter.completion.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCompletion = resolve;
            notifyCompletionStarted();
          }),
      );

      const genPromise = service.startGeneration({ prompt: 'Hi', mode: 'chat' });
      await completionStarted;

      await service.scheduleModelUnload(1000);
      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      expect(adapter.releaseContext).not.toHaveBeenCalled();

      resolveCompletion({
        requestId: 'req-1',
        text: 'Done',
        stopReason: 'stop',
      });
      await genPromise;

      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(adapter.releaseContext).toHaveBeenCalledTimes(1);
    });

    it('clears pending unloadTimer in dispose()', async () => {
      jest.useFakeTimers();
      const service = getGenerationService();

      await service.scheduleModelUnload(5000);
      await service.dispose();

      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      expect(adapter.releaseContext).not.toHaveBeenCalled();
    });
  });

  describe('A2 privacy & A23 URL validation', () => {
    it('refuses failover to default OpenAI when externalApiKey is empty', async () => {
      Object.defineProperty(Platform, 'OS', { get: () => 'ios', configurable: true });
      useAIStore.setState({
        runtime: createInitialRuntimeSnapshot(),
      });

      const service = getGenerationService();
      await expect(
        service.startGeneration({ prompt: 'My balance', mode: 'chat' }),
      ).rejects.toThrow('Local model not ready — download it in Settings or configure an external API');
      expect(xhrInstances).toHaveLength(0);
    });

    it('fails over when externalApiKey is configured and sets failover generationStatus', async () => {
      Object.defineProperty(Platform, 'OS', { get: () => 'ios', configurable: true });
      useAIStore.setState({ runtime: createInitialRuntimeSnapshot() });
      useSettingsStore.setState({
        externalApiUrl: 'https://api.openai.com/v1',
        externalApiModel: 'gpt-4o-mini',
        externalApiKey: 'sk-test-123',
      });

      const service = getGenerationService();
      const snapshots: GenerationServiceRuntimeSnapshot[] = [];
      const sub = service.subscribe((s) => snapshots.push(s));

      const promise = service.startGeneration({ prompt: 'Summarize', mode: 'chat' });
      expect(xhrInstances).toHaveLength(1);
      expect(snapshots.some((s) => s.generationStatus === 'Using external API (local model unavailable)')).toBe(true);

      xhrInstances[0].responseText = JSON.stringify({ choices: [{ message: { content: 'Summary ok' } }] });
      xhrInstances[0].onload?.();

      await expect(promise).resolves.toBe('Summary ok');
      sub.unsubscribe();
    });

    it('fails over without API key when URL is private LAN (10.0.2.2) or localhost', async () => {
      Object.defineProperty(Platform, 'OS', { get: () => 'ios', configurable: true });
      useAIStore.setState({ runtime: createInitialRuntimeSnapshot() });
      useSettingsStore.setState({
        externalApiUrl: 'http://10.0.2.2:11434/v1',
        externalApiModel: 'qwen2.5:3b',
        externalApiKey: '',
      });

      const service = getGenerationService();
      const promise = service.startGeneration({ prompt: 'Hi', mode: 'chat' });
      expect(xhrInstances).toHaveLength(1);
      expect(service.getSnapshot().generationStatus).toBe('Using external API (local model unavailable)');

      xhrInstances[0].responseText = JSON.stringify({ choices: [{ message: { content: 'Local LAN ok' } }] });
      xhrInstances[0].onload?.();

      await expect(promise).resolves.toBe('Local LAN ok');
    });

    it.each([
      'http://api.openai.com/v1',
      'http://172.15.0.1:8080/v1',
      'http://172.32.0.1:8080/v1',
      'http://192.169.1.1:8080/v1',
    ])('rejects insecure non-private http:// URL %s', async (badUrl) => {
      useSettingsStore.setState({
        aiInferenceMode: 'external',
        externalApiUrl: badUrl,
        externalApiKey: 'sk-test',
      });

      const service = getGenerationService();
      await expect(
        service.startGeneration({ prompt: 'Hello', mode: 'chat' }),
      ).rejects.toThrow(/https:\/\//i);
      expect(xhrInstances).toHaveLength(0);
      expect(service.getSnapshot().isGenerating).toBe(false);
    });

    it.each([
      'http://localhost:11434/v1',
      'http://127.0.0.1:11434/v1',
      'http://10.0.2.2:11434/v1',
      'http://192.168.1.50:11434/v1',
      'http://172.16.0.5:11434/v1',
      'http://172.31.255.1:11434/v1',
    ])('allows private/loopback http:// URL %s', async (allowedUrl) => {
      useSettingsStore.setState({
        aiInferenceMode: 'external',
        externalApiUrl: allowedUrl,
        externalApiModel: 'qwen2.5:3b',
        externalApiKey: '',
      });

      const service = getGenerationService();
      const promise = service.startGeneration({ prompt: 'Hello', mode: 'chat' });
      expect(xhrInstances).toHaveLength(1);

      xhrInstances[0].responseText = JSON.stringify({ choices: [{ message: { content: 'ok' } }] });
      xhrInstances[0].onload?.();
      await expect(promise).resolves.toBe('ok');
    });
  });

  describe('Structured output & prompt seam', () => {
    it('passes systemPrompt via messages, jsonSchema, and disableThinking locally', async () => {
      const schema = {
        type: 'object',
        properties: { merchantName: { type: 'string' } },
      };
      const service = getGenerationService();

      await service.startGeneration({
        prompt: 'Coffee 25000',
        mode: 'chat',
        systemPrompt: 'Parse receipt into JSON.',
        jsonSchema: schema,
        disableThinking: true,
      });

      expect(adapter.completion).toHaveBeenCalledTimes(1);
      const callArgs = adapter.completion.mock.calls[0][1];
      expect(callArgs.messages).toEqual([
        { role: 'system', content: 'Parse receipt into JSON.' },
        { role: 'user', content: 'Coffee 25000' },
      ]);
      expect(callArgs.prompt).toBeUndefined();
      expect(callArgs.jsonSchema).toEqual(schema);
      expect(callArgs.disableThinking).toBe(true);
    });

    // Reported 2026-11-24 (screenshots): "Whats my most spending category" in Chat mode got generic tips,
    // because only Grounded mode looked up the user's records.
    it('regression: looks up the user\'s records for Chat mode too and sends them to the model', async () => {
      const agent = require('../agent');
      const spy = jest.spyOn(agent, 'buildRetrievedContext').mockReturnValue([
        { id: 'top', kind: 'top-categories', label: 'Top', content: 'Top categories: Food & Dining Rp 1.100.000', score: 1 },
      ]);
      const service = getGenerationService();
      await service.startGeneration({ prompt: 'Whats my most spending category', mode: 'chat' });
      expect(spy).toHaveBeenCalledWith('Whats my most spending category', { previousUserPrompts: [] });
      const args = adapter.completion.mock.calls[0][1];
      expect(args.messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('Top categories: Food & Dining Rp 1.100.000') });
      spy.mockRestore();
    });

    it('disables Qwen thinking by default and sends structured messages in both local chat and grounded (rag) modes', async () => {
      const service = getGenerationService();

      await service.startGeneration({ prompt: 'How can I save 20%?', mode: 'chat' });
      const chatArgs = adapter.completion.mock.calls[0][1];
      expect(chatArgs.disableThinking).toBe(true);
      expect(chatArgs.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'system' }),
          expect.objectContaining({ role: 'user', content: 'How can I save 20%?' }),
        ]),
      );
      expect(chatArgs.prompt).toBeUndefined();
      expect(chatArgs.imageUri).toBeUndefined();

      await service.startGeneration({ prompt: 'What is my total balance?', mode: 'rag' });
      const ragArgs = adapter.completion.mock.calls[1][1];
      expect(ragArgs.disableThinking).toBe(true);
      expect(ragArgs.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'system', content: expect.stringContaining('Grounded local facts:') }),
          expect.objectContaining({ role: 'user', content: 'What is my total balance?' }),
        ]),
      );
      expect(ragArgs.prompt).toBeUndefined();
      expect(ragArgs.imageUri).toBeUndefined();
    });

    it('keeps bypassChatTemplate working locally while forwarding jsonSchema and disableThinking', async () => {
      const schema = { type: 'object' };
      const service = getGenerationService();

      await service.startGeneration({
        prompt: '<|im_start|>user\nRaw<|im_end|>',
        mode: 'chat',
        bypassChatTemplate: true,
        jsonSchema: schema,
        disableThinking: true,
      });

      const callArgs = adapter.completion.mock.calls[0][1];
      expect(callArgs.prompt).toBe('<|im_start|>user\nRaw<|im_end|>');
      expect(callArgs.messages).toBeUndefined();
      expect(callArgs.jsonSchema).toEqual(schema);
      expect(callArgs.disableThinking).toBe(true);
    });

    it('sends systemPrompt, json_object response_format, and schema instruction to external API', async () => {
      useSettingsStore.setState({
        aiInferenceMode: 'external',
        externalApiUrl: 'https://api.openai.com/v1',
        externalApiModel: 'gpt-4o-mini',
        externalApiKey: 'sk-test',
      });

      const schema = { type: 'object', properties: { total: { type: 'number' } } };
      const service = getGenerationService();
      const promise = service.startGeneration({
        prompt: 'Lunch 45000',
        mode: 'chat',
        systemPrompt: 'You are a receipt parser.',
        jsonSchema: schema,
      });

      const sentBody = JSON.parse(xhrInstances[0].send.mock.calls[0][0]);
      expect(sentBody.response_format).toEqual({ type: 'json_object' });
      expect(sentBody.messages).toEqual([
        {
          role: 'system',
          content: `You are a receipt parser.\n\nRespond with JSON matching this schema: ${JSON.stringify(schema)}`,
        },
        { role: 'user', content: 'Lunch 45000' },
      ]);

      xhrInstances[0].responseText = JSON.stringify({ choices: [{ message: { content: '{"total":45000}' } }] });
      xhrInstances[0].onload?.();
      await expect(promise).resolves.toBe('{"total":45000}');
    });

    it('strips ChatML tags into system/user messages for external API when bypassChatTemplate is true', async () => {
      useSettingsStore.setState({
        aiInferenceMode: 'external',
        externalApiUrl: 'https://api.openai.com/v1',
        externalApiModel: 'gpt-4o-mini',
        externalApiKey: 'sk-test',
      });

      const chatMlPrompt = `<|im_start|>system
You are a fast financial receipt parser.<|im_end|>
<|im_start|>user
Receipt text:
Kopiko 15000
<|im_end|>
<|im_start|>assistant
{"merchantName":`;

      const service = getGenerationService();
      const promise = service.startGeneration({
        prompt: chatMlPrompt,
        mode: 'chat',
        bypassChatTemplate: true,
      });

      const sentBody = JSON.parse(xhrInstances[0].send.mock.calls[0][0]);
      expect(sentBody.messages).toEqual([
        { role: 'system', content: 'You are a fast financial receipt parser.' },
        { role: 'user', content: 'Receipt text:\nKopiko 15000' },
      ]);

      xhrInstances[0].responseText = JSON.stringify({ choices: [{ message: { content: '{"merchantName":"Kopiko"}' } }] });
      xhrInstances[0].onload?.();
      await expect(promise).resolves.toBe('{"merchantName":"Kopiko"}');
    });

    it('resets state cleanly on XHR error and abort (A21)', async () => {
      useSettingsStore.setState({
        aiInferenceMode: 'external',
        externalApiUrl: 'https://api.openai.com/v1',
        externalApiModel: 'gpt-4o-mini',
        externalApiKey: 'sk-test',
      });

      const service = getGenerationService();
      const p1 = service.startGeneration({ prompt: 'Hi', mode: 'chat' });
      xhrInstances[0].onerror?.();
      await expect(p1).rejects.toThrow('Network error connecting to external API.');
      expect(service.getSnapshot().isGenerating).toBe(false);
      expect(useAIStore.getState().runtime.activeGenerationRequestId).toBeNull();

      const p2 = service.startGeneration({ prompt: 'Hi again', mode: 'chat' });
      xhrInstances[1].onabort?.();
      await expect(p2).rejects.toThrow('Generation cancelled by user.');
      expect(service.getSnapshot().isGenerating).toBe(false);
      expect(useAIStore.getState().runtime.activeGenerationRequestId).toBeNull();
    });
  });

  describe('isVisionAvailable seam', () => {
    it('returns true when local model and projector are both installed', async () => {
      useSettingsStore.setState({ aiInferenceMode: 'local', externalApiKey: '' });
      (isActiveModelInstalled as jest.Mock).mockResolvedValue(true);
      (isVisionProjectorInstalled as jest.Mock).mockResolvedValue(true);

      const available = await isVisionAvailable();
      expect(available).toBe(true);
    });

    it('returns false when local model is installed but vision projector is not', async () => {
      useSettingsStore.setState({
        aiInferenceMode: 'local',
        externalApiUrl: 'https://api.openai.com/v1',
        externalApiModel: 'gpt-4o-mini',
        externalApiKey: '', // not configured
      });
      (isActiveModelInstalled as jest.Mock).mockResolvedValue(true);
      (isVisionProjectorInstalled as jest.Mock).mockResolvedValue(false);

      const available = await isVisionAvailable();
      expect(available).toBe(false);
    });

    it('returns true when external mode is configured', async () => {
      useSettingsStore.setState({
        aiInferenceMode: 'external',
        externalApiUrl: 'https://api.openai.com/v1',
        externalApiModel: 'gpt-4o-mini',
        externalApiKey: 'sk-test-key',
      });

      const available = await isVisionAvailable();
      expect(available).toBe(true);
    });

    it('returns false when external mode is selected but not configured', async () => {
      useSettingsStore.setState({
        aiInferenceMode: 'external',
        externalApiUrl: '',
        externalApiModel: '',
        externalApiKey: '',
      });

      const available = await isVisionAvailable();
      expect(available).toBe(false);
    });
  });

  describe('Multimodal vision generation', () => {
    it('passes image messages and ensures context tokens >= 4096 for local image request', async () => {
      useSettingsStore.setState({ aiInferenceMode: 'local' });
      const service = getGenerationService();

      const schema = {
        type: 'object',
        properties: { total: { type: 'number' } },
        required: ['total'],
      };

      await service.startGeneration({
        prompt: 'Parse Indonesian receipt',
        mode: 'chat',
        imageUri: 'file:///data/user/0/receipt.jpg',
        systemPrompt: 'You are an accurate receipt parser.',
        jsonSchema: schema,
        disableThinking: true,
      });

      expect(adapter.initContext).toHaveBeenCalledWith(
        expect.objectContaining({
          modelPath: getActiveModelFileUri(),
          modelFileSizeBytes: 1024,
          contextTokens: 4096,
          onProgress: expect.any(Function),
        }),
      );

      expect(adapter.completion).toHaveBeenCalledTimes(1);
      const completionCall = adapter.completion.mock.calls[0][1];
      expect(completionCall.imageUri).toBe('file:///data/user/0/receipt.jpg');
      expect(completionCall.messages).toEqual([
        { role: 'system', content: 'You are an accurate receipt parser.' },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'file:///data/user/0/receipt.jpg' } },
            { type: 'text', text: 'Parse Indonesian receipt' },
          ],
        },
      ]);
      expect(completionCall.jsonSchema).toEqual(schema);
      expect(completionCall.disableThinking).toBe(true);
    });

    it('sends OpenAI vision formatted payload with base64 data URL for external image request', async () => {
      useSettingsStore.setState({
        aiInferenceMode: 'external',
        externalApiUrl: 'https://api.openai.com/v1',
        externalApiModel: 'gpt-4o-mini',
        externalApiKey: 'sk-test',
      });

      (ExpoFileSystemLegacy as unknown as { readAsStringAsync?: jest.Mock }).readAsStringAsync = jest.fn(
        async () => 'QUJDREVGR0g=',
      );

      const service = getGenerationService();
      const schema = { type: 'object', properties: { total: { type: 'number' } } };
      const promise = service.startGeneration({
        prompt: 'Extract receipt items and total',
        mode: 'chat',
        imageUri: 'file:///mock/receipt.jpg',
        systemPrompt: 'Receipt OCR engine',
        jsonSchema: schema,
      });

      await Promise.resolve();
      await Promise.resolve();

      expect((ExpoFileSystemLegacy as unknown as { readAsStringAsync: jest.Mock }).readAsStringAsync).toHaveBeenCalledWith(
        'file:///mock/receipt.jpg',
        { encoding: 'base64' },
      );

      expect(xhrInstances).toHaveLength(1);
      const sentPayload = JSON.parse(xhrInstances[0].send.mock.calls[0][0]);
      expect(sentPayload.messages[0].role).toBe('system');
      expect(sentPayload.messages[0].content).toContain('Receipt OCR engine');
      expect(sentPayload.messages[0].content).toContain(JSON.stringify(schema));

      expect(sentPayload.messages[1].role).toBe('user');
      expect(sentPayload.messages[1].content).toEqual([
        {
          type: 'image_url',
          image_url: {
            url: 'data:image/jpeg;base64,QUJDREVGR0g=',
          },
        },
        {
          type: 'text',
          text: 'Extract receipt items and total',
        },
      ]);
      expect(sentPayload.response_format).toEqual({ type: 'json_object' });

      xhrInstances[0].responseText = JSON.stringify({
        choices: [{ message: { content: '{"total": 50000}' } }],
      });
      xhrInstances[0].onload?.();
      await expect(promise).resolves.toBe('{"total": 50000}');
    });
  });

  describe('Local generation cancellation', () => {
    it('keeps the local model healthy and avoids reloading after cancelling a local generation', async () => {
      const modelPath = 'file:///mock/model.gguf';
      fsMock.getInfoAsync.mockResolvedValue({ exists: true, size: 1024, uri: modelPath });
      useAIStore.setState({
        provisioning: {
          ...createInitialProvisioningSnapshot(),
          status: 'ready',
          modelPath,
          progress: 1,
        },
      });

      const service = getGenerationService();
      await service.ensureChatRuntimeReady();
      expect(adapter.initContext).toHaveBeenCalledTimes(1);

      let rejectCancelledCompletion!: (err: Error) => void;
      let notifyCompletionStarted!: () => void;
      const completionStarted = new Promise<void>((resolve) => {
        notifyCompletionStarted = resolve;
      });
      adapter.completion.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectCancelledCompletion = reject;
            notifyCompletionStarted();
          }),
      );
      adapter.stopCompletion.mockImplementationOnce(async () => {
        rejectCancelledCompletion(
          Object.assign(new Error('Generation cancelled by user.'), { code: 'generation-cancelled' }),
        );
      });

      const firstRun = service.startGeneration({ prompt: 'First question', mode: 'chat' });
      await completionStarted;

      const cancelled = await service.cancelGeneration('Generation cancelled by user.');
      expect(cancelled).toBe(true);
      await expect(firstRun).rejects.toThrow('Generation cancelled by user.');

      const afterCancel = useAIStore.getState();
      expect(afterCancel.runtime.lastRuntimeError).toBeNull();
      expect(afterCancel.runtime.generationHealthy).toBe(true);
      expect(afterCancel.runtime.runtimeState).toBe('healthy');
      expect(afterCancel.runtimeReady).toBe(true);
      expect(getAIRuntimeAvailability(afterCancel).canRunNativeChat).toBe(true);

      const secondReply = await service.startGeneration({ prompt: 'Second question', mode: 'chat' });
      expect(secondReply).toBe('Local response');
      expect(adapter.initContext).toHaveBeenCalledTimes(1);
    });
  });

  describe('R4-01 & R4-02 startup races: modelLifecycle readiness & SecureStore secret hydration', () => {
    it('awaits shared modelLifecycle.ensureInitialized() before loading llama.rn in ensureChatRuntimeReady (R4-01)', async () => {
      const manager = getModelLifecycleManager();
      manager.dispose();

      let resolveInit!: () => void;
      const isInitSpy = jest.spyOn(manager, 'isInitialized').mockReturnValue(false);
      const ensureSpy = jest.spyOn(manager, 'ensureInitialized').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveInit = resolve;
          }),
      );

      try {
        const service = getGenerationService();
        const readyPromise = service.ensureChatRuntimeReady();

        for (let i = 0; i < 6; i++) await Promise.resolve();
        expect(ensureSpy).toHaveBeenCalledTimes(1);
        expect(adapter.initContext).not.toHaveBeenCalled();

        resolveInit();
        await readyPromise;

        expect(adapter.initContext).toHaveBeenCalledTimes(1);
        expect(useAIStore.getState().runtimeReady).toBe(true);
      } finally {
        isInitSpy.mockRestore();
        ensureSpy.mockRestore();
      }
    });

    it('awaits pending SecureStore secret hydration before sending external API requests (R4-02)', async () => {
      let resolveKey!: (v: string | null) => void;
      let resolveHeaders!: (v: string | null) => void;
      const secureSpy = jest
        .spyOn(SecureStore, 'getItemAsync')
        .mockImplementationOnce(() => new Promise<string | null>((resolve) => { resolveKey = resolve; }))
        .mockImplementationOnce(() => new Promise<string | null>((resolve) => { resolveHeaders = resolve; }));
      const dbSelectSpy = jest.spyOn(db, 'select').mockReturnValueOnce({
        from: jest.fn(() =>
          Promise.resolve([
            { key: 'aiInferenceMode', value: 'external' },
            { key: 'externalApiUrl', value: 'https://api.openai.com/v1' },
            { key: 'externalApiModel', value: 'gpt-4o-mini' },
          ]),
        ),
      } as any);

      try {
        useSettingsStore.setState({
          isLoaded: false,
          secretsLoaded: false,
          secretsHydrationError: null,
          aiInferenceMode: 'local',
          externalApiKey: '',
          externalApiCustomHeaders: '{}',
        });

        const loadPromise = useSettingsStore.getState().loadSettings();
        await useSettingsStore.getState().waitForSettingsLoaded();

        // SQLite committed external mode immediately, while SecureStore is still pending!
        expect(useSettingsStore.getState().isLoaded).toBe(true);
        expect(useSettingsStore.getState().aiInferenceMode).toBe('external');
        expect(useSettingsStore.getState().externalApiKey).toBe('');

        const service = getGenerationService();
        const genPromise = service.startGeneration({ prompt: 'Summarize spending', mode: 'chat' });

        for (let i = 0; i < 6; i++) await Promise.resolve();
        // MUST NOT send an unauthenticated XHR while SecureStore hydration is still in flight!
        expect(xhrInstances).toHaveLength(0);

        resolveKey('sk-hydrated-live-key');
        resolveHeaders('{"X-Tenant-Auth":"tenant-secret"}');
        await loadPromise;
        for (let i = 0; i < 6; i++) await Promise.resolve();

        expect(xhrInstances).toHaveLength(1);
        expect(xhrInstances[0].setRequestHeader).toHaveBeenCalledWith('Authorization', 'Bearer sk-hydrated-live-key');
        expect(xhrInstances[0].setRequestHeader).toHaveBeenCalledWith('X-Tenant-Auth', 'tenant-secret');

        xhrInstances[0].responseText = JSON.stringify({
          choices: [{ message: { content: 'Authenticated reply' } }],
        });
        xhrInstances[0].onload?.();
        await expect(genPromise).resolves.toBe('Authenticated reply');
      } finally {
        secureSpy.mockRestore();
        dbSelectSpy.mockRestore();
      }
    });

    it('isVisionAvailable awaits pending SecureStore hydration for external cloud endpoints (R4-02)', async () => {
      let resolveKey!: (v: string | null) => void;
      let resolveHeaders!: (v: string | null) => void;
      const secureSpy = jest
        .spyOn(SecureStore, 'getItemAsync')
        .mockImplementationOnce(() => new Promise<string | null>((resolve) => { resolveKey = resolve; }))
        .mockImplementationOnce(() => new Promise<string | null>((resolve) => { resolveHeaders = resolve; }));
      const dbSelectSpy = jest.spyOn(db, 'select').mockReturnValueOnce({
        from: jest.fn(() =>
          Promise.resolve([
            { key: 'aiInferenceMode', value: 'external' },
            { key: 'externalApiUrl', value: 'https://api.openai.com/v1' },
            { key: 'externalApiModel', value: 'gpt-4o-mini' },
          ]),
        ),
      } as any);

      try {
        useSettingsStore.setState({
          isLoaded: false,
          secretsLoaded: false,
          secretsHydrationError: null,
          externalApiKey: '',
          externalApiCustomHeaders: '{}',
        });

        const loadPromise = useSettingsStore.getState().loadSettings();
        await useSettingsStore.getState().waitForSettingsLoaded();

        let visionResult: boolean | null = null;
        const visionPromise = isVisionAvailable().then((res) => {
          visionResult = res;
          return res;
        });

        for (let i = 0; i < 6; i++) await Promise.resolve();
        expect(visionResult).toBeNull();

        resolveKey('sk-vision-secret');
        resolveHeaders('{}');
        await loadPromise;

        await expect(visionPromise).resolves.toBe(true);
      } finally {
        secureSpy.mockRestore();
        dbSelectSpy.mockRestore();
      }
    });

    it('fails closed without sending an unauthenticated XHR when SecureStore fails to hydrate credentials (R4-02)', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const secureSpy = jest.spyOn(SecureStore, 'getItemAsync').mockRejectedValue(new Error('Keystore locked'));
      const dbSelectSpy = jest.spyOn(db, 'select').mockReturnValueOnce({
        from: jest.fn(() =>
          Promise.resolve([
            { key: 'aiInferenceMode', value: 'external' },
            { key: 'externalApiUrl', value: 'https://api.openai.com/v1' },
            { key: 'externalApiModel', value: 'gpt-4o-mini' },
          ]),
        ),
      } as any);

      try {
        useSettingsStore.setState({
          isLoaded: false,
          secretsLoaded: false,
          secretsHydrationError: null,
          externalApiKey: '',
          externalApiCustomHeaders: '{}',
        });

        await useSettingsStore.getState().loadSettings();
        const service = getGenerationService();

        await expect(service.startGeneration({ prompt: 'Hello', mode: 'chat' })).rejects.toThrow(
          /secure storage/i,
        );
        expect(xhrInstances).toHaveLength(0);
      } finally {
        secureSpy.mockRestore();
        dbSelectSpy.mockRestore();
        warnSpy.mockRestore();
        useSettingsStore.setState({ secretsHydrationError: null, secretsLoaded: false });
      }
    });
  });
});
