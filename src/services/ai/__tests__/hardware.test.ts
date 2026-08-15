import DeviceInfo from 'react-native-device-info';
import {
  getTotalDeviceMemoryBytes,
  getDevicePssMemoryBytes,
  estimateRequiredRamBytes,
  buildMemoryBudget,
  canLoadModelWithinMemoryBudget,
  resolveRecommendedCpuThreads,
  getGpuLayersForDevice,
  resolveOptimalQuantization,
  recordMemoryTelemetry,
  QUANTIZATION_PROFILES,
  LOW_MEMORY_GPU_DISABLE_THRESHOLD_BYTES,
  FALLBACK_CPU_THREAD_COUNT,
  MIN_CPU_THREAD_COUNT,
  MAX_CPU_THREAD_COUNT,
} from '../hardware';
import { useAIStore } from '../../../store/useAIStore';

describe('hardware utilities and memory budgeting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getTotalDeviceMemoryBytes and getDevicePssMemoryBytes', () => {
    it('returns device total memory from DeviceInfo', async () => {
      (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValueOnce(8 * 1024 * 1024 * 1024);
      const total = await getTotalDeviceMemoryBytes();
      expect(total).toBe(8 * 1024 * 1024 * 1024);
    });

    it('returns 0 when DeviceInfo returns non-finite or negative values', async () => {
      (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValueOnce(-1);
      expect(await getTotalDeviceMemoryBytes()).toBe(0);

      (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValueOnce(NaN);
      expect(await getTotalDeviceMemoryBytes()).toBe(0);
    });

    it('returns PSS memory or 0 when DeviceInfo throws', async () => {
      (DeviceInfo.getUsedMemory as jest.Mock).mockResolvedValueOnce(1024 * 1024 * 1024);
      expect(await getDevicePssMemoryBytes()).toBe(1024 * 1024 * 1024);

      (DeviceInfo.getUsedMemory as jest.Mock).mockRejectedValueOnce(new Error('Native error'));
      expect(await getDevicePssMemoryBytes()).toBe(0);
    });
  });

  describe('estimateRequiredRamBytes', () => {
    it('applies 1.5x multiplier to model file size', () => {
      const modelSize = 1_000_000_000;
      expect(estimateRequiredRamBytes(modelSize)).toBe(1_500_000_000);
    });

    it('returns 0 for zero, negative, or non-finite inputs', () => {
      expect(estimateRequiredRamBytes(0)).toBe(0);
      expect(estimateRequiredRamBytes(-100)).toBe(0);
      expect(estimateRequiredRamBytes(NaN)).toBe(0);
    });
  });

  describe('buildMemoryBudget and canLoadModelWithinMemoryBudget', () => {
    it('calculates 60% allowed RAM budget correctly', () => {
      const totalRam = 6 * 1024 * 1024 * 1024; // 6 GB
      const modelSize = 1_400_000_000; // ~1.4 GB
      const budget = buildMemoryBudget(totalRam, modelSize);

      expect(budget.totalMemoryBytes).toBe(totalRam);
      expect(budget.allowedBudgetBytes).toBe(Math.floor(totalRam * 0.6));
      expect(budget.estimatedRequiredMemoryBytes).toBe(Math.ceil(modelSize * 1.5));
      expect(budget.withinBudget).toBe(true);
    });

    it('flags withinBudget as false when model exceeds allowed budget', () => {
      const totalRam = 2 * 1024 * 1024 * 1024; // 2 GB -> 1.2 GB budget
      const modelSize = 1_500_000_000; // required RAM = 2.25 GB
      const budget = buildMemoryBudget(totalRam, modelSize);

      expect(budget.withinBudget).toBe(false);
    });

    it('evaluates canLoadModelWithinMemoryBudget using DeviceInfo total RAM', async () => {
      (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValueOnce(8 * 1024 * 1024 * 1024);
      const canLoad = await canLoadModelWithinMemoryBudget(1_400_000_000);
      expect(canLoad).toBe(true);

      (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValueOnce(2 * 1024 * 1024 * 1024);
      const cannotLoad = await canLoadModelWithinMemoryBudget(2_000_000_000);
      expect(cannotLoad).toBe(false);
    });
  });

  describe('resolveRecommendedCpuThreads', () => {
    it('allocates 2 threads for devices with <= 4GB RAM', () => {
      const ram4Gb = 4 * 1024 * 1024 * 1024;
      expect(resolveRecommendedCpuThreads(ram4Gb)).toBe(2);

      const ram3Gb = 3 * 1024 * 1024 * 1024;
      expect(resolveRecommendedCpuThreads(ram3Gb)).toBe(2);
    });

    it('allocates 3 threads for devices with <= 6GB RAM', () => {
      const ram6Gb = 6 * 1024 * 1024 * 1024;
      expect(resolveRecommendedCpuThreads(ram6Gb)).toBe(3);
    });

    it('allocates 4 threads for devices with <= 8GB RAM', () => {
      const ram8Gb = 8 * 1024 * 1024 * 1024;
      expect(resolveRecommendedCpuThreads(ram8Gb)).toBe(4);
    });

    it('allocates max 6 threads for devices with > 8GB RAM', () => {
      const ram12Gb = 12 * 1024 * 1024 * 1024;
      expect(resolveRecommendedCpuThreads(ram12Gb)).toBe(MAX_CPU_THREAD_COUNT);
    });

    it('honors explicit thread count within min/max bounds', () => {
      expect(resolveRecommendedCpuThreads(8 * 1024 * 1024 * 1024, 5)).toBe(5);
      expect(resolveRecommendedCpuThreads(8 * 1024 * 1024 * 1024, 1)).toBe(MIN_CPU_THREAD_COUNT);
      expect(resolveRecommendedCpuThreads(8 * 1024 * 1024 * 1024, 16)).toBe(MAX_CPU_THREAD_COUNT);
    });

    it('falls back to default thread count on invalid total RAM', () => {
      expect(resolveRecommendedCpuThreads(0)).toBe(FALLBACK_CPU_THREAD_COUNT);
      expect(resolveRecommendedCpuThreads(NaN)).toBe(FALLBACK_CPU_THREAD_COUNT);
    });
  });

  describe('getGpuLayersForDevice', () => {
    it('disables GPU (returns 0) for low-memory devices (<= 4GB)', () => {
      expect(getGpuLayersForDevice(4 * 1024 * 1024 * 1024)).toBe(0);
      expect(getGpuLayersForDevice(LOW_MEMORY_GPU_DISABLE_THRESHOLD_BYTES)).toBe(0);
      expect(getGpuLayersForDevice(2 * 1024 * 1024 * 1024)).toBe(0);
    });

    it('enables full GPU offloading (returns 99) for devices with > 4GB RAM', () => {
      expect(getGpuLayersForDevice(6 * 1024 * 1024 * 1024)).toBe(99);
      expect(getGpuLayersForDevice(8 * 1024 * 1024 * 1024)).toBe(99);
    });
  });

  describe('resolveOptimalQuantization and recordMemoryTelemetry', () => {
    it('recommends Q5_K_M for devices with plenty of available RAM', async () => {
      // 8GB Total, 1GB PSS -> ~4.8GB budget, ~7GB available -> effective = 4.8GB (> 2.55GB)
      (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValueOnce(8 * 1024 * 1024 * 1024);
      (DeviceInfo.getUsedMemory as jest.Mock).mockResolvedValueOnce(1 * 1024 * 1024 * 1024);

      const result = await resolveOptimalQuantization();
      expect(result.recommendedQuantization).toBe('Q5_K_M');
      expect(result.fallbackTriggered).toBe(false);
    });

    it('recommends Q4_K_M when available memory is constrained', async () => {
      // 4GB Total, 2.2GB PSS -> allowed budget = 2.4GB, available = 1.8GB -> effective = 1.8GB
      // (1.8GB is < Q4_K_M minRamBudgetBytes of 2.1GB but >= Q3_K_S min of 1.65GB)
      (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValueOnce(4 * 1024 * 1024 * 1024);
      (DeviceInfo.getUsedMemory as jest.Mock).mockResolvedValueOnce(2.2 * 1024 * 1024 * 1024);

      const result = await resolveOptimalQuantization();
      expect(result.recommendedQuantization).toBe('Q4_K_M');
      expect(result.fallbackTriggered).toBe(true);
    });

    it('recommends Q3_K_S when memory is extremely constrained', async () => {
      // 3GB Total, 2GB PSS -> allowed budget = 1.8GB, available = 1.0GB -> effective = 1.0GB (< 1.65GB)
      (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValueOnce(3 * 1024 * 1024 * 1024);
      (DeviceInfo.getUsedMemory as jest.Mock).mockResolvedValueOnce(2 * 1024 * 1024 * 1024);

      const result = await resolveOptimalQuantization();
      expect(result.recommendedQuantization).toBe('Q3_K_S');
      expect(result.fallbackTriggered).toBe(true);
    });

    it('recommends Q4_K_M when effective memory is between Q4_K_M and Q5_K_M thresholds', async () => {
      // 3.8GB Total -> allowed budget = 2.28GB (< 2.55GB, >= 2.1GB)
      (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValueOnce(3.8 * 1024 * 1024 * 1024);
      (DeviceInfo.getUsedMemory as jest.Mock).mockResolvedValueOnce(1.0 * 1024 * 1024 * 1024);

      const result = await resolveOptimalQuantization();
      expect(result.recommendedQuantization).toBe('Q4_K_M');
      expect(result.fallbackTriggered).toBe(true);
    });

    it('records telemetry in useAIStore without throwing', async () => {
      (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValueOnce(8 * 1024 * 1024 * 1024);
      (DeviceInfo.getUsedMemory as jest.Mock).mockResolvedValueOnce(1 * 1024 * 1024 * 1024);

      const updateTelemetrySpy = jest.spyOn(useAIStore.getState(), 'updateMemoryTelemetry');
      await recordMemoryTelemetry();
      expect(updateTelemetrySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          recommendedQuantization: 'Q5_K_M',
          activeQuantization: 'Q5_K_M',
          fallbackTriggered: false,
        })
      );
    });

    it('catches and handles errors in recordMemoryTelemetry gracefully', async () => {
      (DeviceInfo.getTotalMemory as jest.Mock).mockRejectedValueOnce(new Error('Total memory query failed'));
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(recordMemoryTelemetry()).resolves.not.toThrow();
      warnSpy.mockRestore();
    });
  });
});
