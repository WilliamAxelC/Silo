import { Platform } from 'react-native';
import DeviceInfo from 'react-native-device-info';
import { useAIStore } from '../../store/useAIStore';
import { getActiveModelConfig } from './config';

export const LOW_MEMORY_GPU_DISABLE_THRESHOLD_BYTES = 4 * 1024 * 1024 * 1024;
export const MODEL_MEMORY_MULTIPLIER = 1.5;
export const MAX_MODEL_RAM_FRACTION = 0.6;
export const DEFAULT_BIG_CORE_CPU_THREADS = 4;
export const FALLBACK_CPU_THREAD_COUNT = 4;
export const MIN_CPU_THREAD_COUNT = 2;
export const MAX_CPU_THREAD_COUNT = 6;

export interface QuantizationProfile {
  name: string;
  label: string;
  fileSizeBytes: number;
  minRamBudgetBytes: number;
}

export const QUANTIZATION_PROFILES: Record<string, QuantizationProfile> = {
  Q5_K_M: {
    name: 'Q5_K_M',
    label: '5-bit Medium (High Quality)',
    fileSizeBytes: 1_700_000_000,
    minRamBudgetBytes: 2_550_000_000,
  },
  Q4_K_M: {
    name: 'Q4_K_M',
    label: '4-bit Medium (Balanced)',
    fileSizeBytes: 1_400_000_000,
    minRamBudgetBytes: 2_100_000_000,
  },
  Q3_K_S: {
    name: 'Q3_K_S',
    label: '3-bit Small (Low Memory)',
    fileSizeBytes: 1_100_000_000,
    minRamBudgetBytes: 1_650_000_000,
  },
};

export type HardwareMemoryBudget = {
  totalMemoryBytes: number;
  modelFileSizeBytes: number;
  estimatedRequiredMemoryBytes: number;
  allowedBudgetBytes: number;
  withinBudget: boolean;
};

export async function getTotalDeviceMemoryBytes(): Promise<number> {
  const totalMemoryBytes = await DeviceInfo.getTotalMemory();
  return Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0 ? totalMemoryBytes : 0;
}

export async function getDevicePssMemoryBytes(): Promise<number> {
  try {
    const usedMemoryBytes = await DeviceInfo.getUsedMemory();
    return Number.isFinite(usedMemoryBytes) && usedMemoryBytes > 0 ? usedMemoryBytes : 0;
  } catch {
    return 0;
  }
}

export async function resolveOptimalQuantization(activeModelSizeBytes?: number | null): Promise<{
  recommendedQuantization: string;
  activeQuantization: string;
  fallbackTriggered: boolean;
  pssBytes: number;
  totalRamBytes: number;
}> {
  const totalRamBytes = await getTotalDeviceMemoryBytes();
  const pssBytes = await getDevicePssMemoryBytes();
  
  const activeConfig = getActiveModelConfig();
  const targetSizeBytes = activeModelSizeBytes ?? activeConfig.sizeBytes ?? QUANTIZATION_PROFILES.Q5_K_M.fileSizeBytes;
  const budgetBytes = buildMemoryBudget(totalRamBytes, targetSizeBytes).allowedBudgetBytes;
  const availableMemory = totalRamBytes > 0 && pssBytes > 0 ? Math.max(0, totalRamBytes - pssBytes) : budgetBytes;
  
  const effectiveMemory = Math.min(budgetBytes, availableMemory);
  
  let recommendedQuantization = 'Q5_K_M';
  let fallbackTriggered = false;
  
  if (effectiveMemory < QUANTIZATION_PROFILES.Q3_K_S.minRamBudgetBytes) {
    recommendedQuantization = 'Q3_K_S';
    fallbackTriggered = true;
  } else if (effectiveMemory < QUANTIZATION_PROFILES.Q4_K_M.minRamBudgetBytes) {
    recommendedQuantization = 'Q4_K_M';
    fallbackTriggered = true;
  } else if (effectiveMemory < QUANTIZATION_PROFILES.Q5_K_M.minRamBudgetBytes) {
    recommendedQuantization = 'Q4_K_M';
    fallbackTriggered = true;
  }
  
  const activeQuantization = activeConfig.quantization;
  
  return {
    recommendedQuantization,
    activeQuantization,
    fallbackTriggered,
    pssBytes,
    totalRamBytes,
  };
}

export async function recordMemoryTelemetry(activeModelSizeBytes?: number | null): Promise<void> {
  try {
    const telemetry = await resolveOptimalQuantization(activeModelSizeBytes);
    useAIStore.getState().updateMemoryTelemetry({
      pssBytes: telemetry.pssBytes,
      totalRamBytes: telemetry.totalRamBytes,
      recommendedQuantization: telemetry.recommendedQuantization,
      activeQuantization: telemetry.activeQuantization,
      fallbackTriggered: telemetry.fallbackTriggered,
    });
  } catch (error) {
    console.warn('[hardware] Failed to record memory telemetry:', error);
  }
}

export function estimateRequiredRamBytes(modelFileSizeBytes: number): number {
  if (!Number.isFinite(modelFileSizeBytes) || modelFileSizeBytes <= 0) {
    return 0;
  }

  return Math.ceil(modelFileSizeBytes * MODEL_MEMORY_MULTIPLIER);
}

export function buildMemoryBudget(totalMemoryBytes: number, modelFileSizeBytes: number): HardwareMemoryBudget {
  const estimatedRequiredMemoryBytes = estimateRequiredRamBytes(modelFileSizeBytes);
  const allowedBudgetBytes = Math.floor(Math.max(0, totalMemoryBytes) * MAX_MODEL_RAM_FRACTION);

  return {
    totalMemoryBytes,
    modelFileSizeBytes,
    estimatedRequiredMemoryBytes,
    allowedBudgetBytes,
    withinBudget: estimatedRequiredMemoryBytes > 0 && allowedBudgetBytes > 0 && estimatedRequiredMemoryBytes <= allowedBudgetBytes,
  };
}

export async function canLoadModelWithinMemoryBudget(modelFileSizeBytes: number): Promise<boolean> {
  const totalMemoryBytes = await getTotalDeviceMemoryBytes();
  return buildMemoryBudget(totalMemoryBytes, modelFileSizeBytes).withinBudget;
}

export function getDeviceCpuCoreCount(): number | null {
  const hardwareConcurrency = (globalThis as { navigator?: { hardwareConcurrency?: unknown } }).navigator
    ?.hardwareConcurrency;
  if (typeof hardwareConcurrency === 'number' && Number.isFinite(hardwareConcurrency) && hardwareConcurrency >= 1) {
    return Math.floor(hardwareConcurrency);
  }
  return null;
}

/**
 * Selects CPU threads from CPU core topology rather than RAM size.
 * On typical 4–8 core big.LITTLE Android phones, 4 threads targets the big/performance
 * cores without spilling onto slow LITTLE cores (llama.rn pins threads to the highest
 * max-frequency cores and clamps to hardware_concurrency() natively).
 */
export function resolveRecommendedCpuThreads(
  cpuCoreCount?: number | null,
  explicitThreadCount?: number | null,
): number {
  if (Number.isFinite(explicitThreadCount) && explicitThreadCount && explicitThreadCount > 0) {
    return Math.max(MIN_CPU_THREAD_COUNT, Math.min(Math.floor(explicitThreadCount), MAX_CPU_THREAD_COUNT));
  }

  if (typeof cpuCoreCount !== 'number' || !Number.isFinite(cpuCoreCount) || cpuCoreCount <= 0) {
    return FALLBACK_CPU_THREAD_COUNT;
  }

  const cores = Math.floor(cpuCoreCount);
  if (cores <= MIN_CPU_THREAD_COUNT) {
    return MIN_CPU_THREAD_COUNT;
  }

  if (cores <= DEFAULT_BIG_CORE_CPU_THREADS) {
    return cores;
  }

  if (cores <= 8) {
    return DEFAULT_BIG_CORE_CPU_THREADS;
  }

  return Math.max(
    DEFAULT_BIG_CORE_CPU_THREADS,
    Math.min(MAX_CPU_THREAD_COUNT, Math.floor(cores / 2)),
  );
}

/**
 * llama.rn 0.12.1 Android GPU offload uses OpenCL, which only supports Qualcomm Adreno 700+
 * GPUs with Q4_0/Q6_K weights (and requires libOpenCL.so in AndroidManifest.xml).
 * Silo ships Q4_K_M models where CPU (ARMv8.2 dotprod/i8mm) avoids OpenCL init overhead,
 * dequant/copy slowdowns on 0.8B models, and double-load GPU fallbacks.
 */
export function getGpuLayersForDevice(totalMemoryBytes: number, platform: string = Platform.OS): number {
  if (platform === 'android') {
    return 0;
  }

  return totalMemoryBytes <= LOW_MEMORY_GPU_DISABLE_THRESHOLD_BYTES ? 0 : 99;
}
