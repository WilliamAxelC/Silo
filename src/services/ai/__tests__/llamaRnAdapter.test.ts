import * as ExpoFileSystemLegacy from 'expo-file-system/legacy';
import { initLlama } from 'llama.rn';
import { getLlamaRnAdapter } from '../llamaRnAdapter';
import { getTotalDeviceMemoryBytes, canLoadModelWithinMemoryBudget } from '../hardware';

jest.mock('llama.rn', () => ({
  initLlama: jest.fn(),
  releaseAllLlama: jest.fn(async () => {}),
}));

jest.mock('../hardware', () => ({
  buildMemoryBudget: jest.fn(() => ({
    totalMemoryBytes: 8 * 1024 ** 3,
    modelFileSizeBytes: 1_000_000,
    estimatedRequiredMemoryBytes: 1_500_000,
    allowedBudgetBytes: 4 * 1024 ** 3,
    withinBudget: true,
  })),
  canLoadModelWithinMemoryBudget: jest.fn(async () => true),
  getDeviceCpuCoreCount: jest.fn(() => 8),
  getGpuLayersForDevice: jest.fn(() => 0),
  getTotalDeviceMemoryBytes: jest.fn(async () => 8 * 1024 ** 3),
  resolveRecommendedCpuThreads: jest.fn(() => 4),
}));

jest.mock('../modelLifecycle', () => ({
  getVisionProjectorUri: jest.fn(() => 'file:///mock/models/mmproj-F16.gguf'),
}));

describe('LlamaRnAdapter', () => {
  const mockCompletion = jest.fn();
  const mockStopCompletion = jest.fn(async () => {});
  const mockRelease = jest.fn(async () => {});
  const mockInitMultimodal = jest.fn(async () => true);
  const mockReleaseMultimodal = jest.fn(async () => {});

  const fsMock = ExpoFileSystemLegacy as unknown as {
    getInfoAsync: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    fsMock.getInfoAsync.mockResolvedValue({
      exists: true,
      size: 1_000_000,
      uri: 'file:///mock/model.gguf',
    });
    (getTotalDeviceMemoryBytes as jest.Mock).mockResolvedValue(8 * 1024 ** 3);
    (canLoadModelWithinMemoryBudget as jest.Mock).mockResolvedValue(true);

    mockCompletion.mockResolvedValue({
      text: '{"ok":true}',
      content: '{"ok":true}',
      tokens_evaluated: 12,
      tokens_predicted: 6,
      stopped_eos: true,
      timings: { prompt_ms: 10, predicted_ms: 20, predicted_per_second: 50 },
    });

    (initLlama as jest.Mock).mockResolvedValue({
      completion: mockCompletion,
      stopCompletion: mockStopCompletion,
      release: mockRelease,
      initMultimodal: mockInitMultimodal,
      releaseMultimodal: mockReleaseMultimodal,
    });

    await getLlamaRnAdapter().dispose();
    jest.clearAllMocks();
  });

  it('initializes context with fast CPU defaults, no redundant warmup completion, and forwards progress', async () => {
    const progressValues: number[] = [];
    (initLlama as jest.Mock).mockImplementationOnce(async (_params, onProgress?: (p: number) => void) => {
      onProgress?.(25.4);
      onProgress?.(100);
      return {
        gpu: false,
        completion: mockCompletion,
        stopCompletion: mockStopCompletion,
        release: mockRelease,
        initMultimodal: mockInitMultimodal,
        releaseMultimodal: mockReleaseMultimodal,
      };
    });

    const adapter = getLlamaRnAdapter();
    await adapter.initContext({
      modelPath: 'file:///mock/model.gguf',
      modelFileSizeBytes: 1_000_000,
      onProgress: (p) => progressValues.push(p),
    });

    expect(initLlama).toHaveBeenCalledTimes(1);
    const [initParams, progressCb] = (initLlama as jest.Mock).mock.calls[0];
    expect(initParams).toEqual(
      expect.objectContaining({
        n_ctx: 2048,
        n_batch: 512,
        n_ubatch: 512,
        n_threads: 4,
        n_gpu_layers: 0,
        no_gpu_devices: true,
        flash_attn_type: 'auto',
        use_progress_callback: true,
        use_mmap: true,
        use_mlock: false,
      }),
    );
    expect(typeof progressCb).toBe('function');
    expect(progressValues).toEqual([25, 100]);
    expect(mockCompletion).not.toHaveBeenCalled();
    expect(mockInitMultimodal).not.toHaveBeenCalled();
    expect(adapter.isMultimodalReady()).toBe(false);
  });

  it('does not load the vision projector during text-only chat completions', async () => {
    const adapter = getLlamaRnAdapter();
    await adapter.initContext({
      modelPath: 'file:///mock/model.gguf',
      modelFileSizeBytes: 1_000_000,
    });

    await adapter.completion('req-text-only', {
      messages: [
        { role: 'system', content: 'You are Silo AI.' },
        { role: 'user', content: 'How can I save 20%?' },
      ],
      disableThinking: true,
    });

    expect(mockInitMultimodal).not.toHaveBeenCalled();
    expect(adapter.isMultimodalReady()).toBe(false);
  });

  it('passes response_format json_schema and enable_thinking: false with messages to llama.rn', async () => {
    const adapter = getLlamaRnAdapter();
    await adapter.initContext({
      modelPath: 'file:///mock/model.gguf',
      modelFileSizeBytes: 1_000_000,
    });
    mockCompletion.mockClear();

    const schema = {
      type: 'object',
      properties: { merchantName: { type: 'string' } },
      required: ['merchantName'],
    };

    const result = await adapter.completion('req-1', {
      messages: [
        { role: 'system', content: 'Extract JSON.' },
        { role: 'user', content: 'Coffee 50000' },
      ],
      jsonSchema: schema,
      disableThinking: true,
      maxTokens: 64,
      temperature: 0.1,
      topP: 0.9,
    });

    expect(result.text).toBe('{"ok":true}');
    expect(mockCompletion).toHaveBeenCalledTimes(1);
    const passedParams = mockCompletion.mock.calls[0][0];
    expect(passedParams.messages).toEqual([
      { role: 'system', content: 'Extract JSON.' },
      { role: 'user', content: 'Coffee 50000' },
    ]);
    expect(passedParams.prompt).toBeUndefined();
    expect(passedParams.response_format).toEqual({
      type: 'json_schema',
      json_schema: { schema },
    });
    expect(passedParams.enable_thinking).toBe(false);
    expect(passedParams.n_predict).toBe(64);
  });

  it('passes raw prompt when messages is omitted and omits optional flags when unset', async () => {
    const adapter = getLlamaRnAdapter();
    await adapter.initContext({
      modelPath: 'file:///mock/model.gguf',
      modelFileSizeBytes: 1_000_000,
    });
    mockCompletion.mockClear();

    await adapter.completion('req-2', {
      prompt: '<|im_start|>user\nHi<|im_end|>',
      maxTokens: 32,
    });

    const passedParams = mockCompletion.mock.calls[0][0];
    expect(passedParams.prompt).toBe('<|im_start|>user\nHi<|im_end|>');
    expect(passedParams.messages).toBeUndefined();
    expect(passedParams.response_format).toBeUndefined();
    expect(passedParams.enable_thinking).toBeUndefined();
  });

  describe('Multimodal vision support', () => {
    it('image request calls initMultimodal once then completion with an image_url part', async () => {
      const adapter = getLlamaRnAdapter();
      await adapter.initContext({
        modelPath: 'file:///mock/model.gguf',
        modelFileSizeBytes: 1_000_000,
        contextTokens: 4096,
      });
      mockCompletion.mockClear();
      mockInitMultimodal.mockClear();

      const imageMessages = [
        { role: 'system', content: 'You are an accurate receipt parser.' },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'file:///path/to/receipt.jpg' } },
            { type: 'text', text: 'Parse this receipt.' },
          ],
        },
      ];

      const res1 = await adapter.completion('req-img-1', {
        messages: imageMessages,
        imageUri: 'file:///path/to/receipt.jpg',
      });

      expect(res1.text).toBe('{"ok":true}');
      expect(mockInitMultimodal).toHaveBeenCalledTimes(1);
      expect(mockInitMultimodal).toHaveBeenCalledWith({
        path: 'file:///mock/models/mmproj-F16.gguf',
        use_gpu: false,
      });
      expect(mockCompletion).toHaveBeenCalledTimes(1);
      const passedParams1 = mockCompletion.mock.calls[0][0];
      expect(passedParams1.messages).toEqual(imageMessages);

      // Subsequent image request on same context does NOT call initMultimodal again
      await adapter.completion('req-img-2', {
        messages: imageMessages,
        imageUri: 'file:///path/to/receipt2.jpg',
      });
      expect(mockInitMultimodal).toHaveBeenCalledTimes(1);
      expect(mockCompletion).toHaveBeenCalledTimes(2);
    });

    it('re-initializes context with >= 4096 tokens when an image request arrives on a smaller context', async () => {
      const adapter = getLlamaRnAdapter();
      // Initialize with default 2048 tokens
      await adapter.initContext({
        modelPath: 'file:///mock/model.gguf',
        modelFileSizeBytes: 1_000_000,
      });

      expect((initLlama as jest.Mock).mock.calls[0][0].n_ctx).toBe(2048);

      // Now send image request
      await adapter.completion('req-img-expand', {
        prompt: 'Parse receipt',
        imageUri: 'file:///path/to/receipt.jpg',
      });

      // Context was re-initialized with n_ctx: 4096
      const lastInitCall = (initLlama as jest.Mock).mock.calls[(initLlama as jest.Mock).mock.calls.length - 1][0];
      expect(lastInitCall.n_ctx).toBe(4096);
      expect(mockInitMultimodal).toHaveBeenCalledTimes(1);
    });

    it('throws a clear error when initMultimodal fails so caller can fall back', async () => {
      const adapter = getLlamaRnAdapter();
      await adapter.initContext({
        modelPath: 'file:///mock/model.gguf',
        modelFileSizeBytes: 1_000_000,
        contextTokens: 4096,
      });
      mockInitMultimodal.mockRejectedValueOnce(new Error('Projector file corrupted or missing'));

      await expect(
        adapter.completion('req-img-fail', {
          prompt: 'Parse receipt',
          imageUri: 'file:///path/to/receipt.jpg',
        }),
      ).rejects.toThrow('Failed to initialize vision multimodal projector: Projector file corrupted or missing');
    });

    it('releases multimodal when adapter context is disposed', async () => {
      const adapter = getLlamaRnAdapter();
      await adapter.initContext({
        modelPath: 'file:///mock/model.gguf',
        modelFileSizeBytes: 1_000_000,
        contextTokens: 4096,
      });

      await adapter.completion('req-img-rel', {
        prompt: 'Parse receipt',
        imageUri: 'file:///path/to/receipt.jpg',
      });
      expect(adapter.isMultimodalReady()).toBe(true);

      await adapter.dispose();
      expect(mockReleaseMultimodal).toHaveBeenCalledTimes(1);
      expect(adapter.isMultimodalReady()).toBe(false);
    });
  });
});
