import { Platform } from 'react-native';
import DeviceInfo from 'react-native-device-info';
import { useAIStore } from '../../store/useAIStore';
import { getActiveModelConfig } from './config';

export const LOW_MEMORY_GPU_DISABLE_THRESHOLD_BYTES = 4 * 1024 * 1024 * 1024;
export const MODEL_MEMORY_MULTIPLIER = 1.5;
export const MAX_MODEL_RAM_FRACTION = 0.6;
export const DEFAULT_CPU_THREAD_COUNT = 4;
export const MIN_CPU_THREAD_COUNT = 1;
export const MAX_CPU_THREAD_COUNT = 8;

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

/**
 * Selects a fixed CPU thread target (4 on Android/mobile) rather than scaling off RAM
 * or unavailable browser globals (React Native/Hermes does not populate navigator.hardwareConcurrency).
 * llama.rn's native set_best_cores() pins threads to the highest max-frequency cores and
 * clamps n_threads to std::thread::hardware_concurrency() automatically.
 */
export function resolveRecommendedCpuThreads(
  explicitThreadCount?: number | null,
  _platform: string = Platform.OS,
): number {
  if (typeof explicitThreadCount === 'number' && Number.isFinite(explicitThreadCount) && explicitThreadCount > 0) {
    return Math.max(MIN_CPU_THREAD_COUNT, Math.min(Math.floor(explicitThreadCount), MAX_CPU_THREAD_COUNT));
  }

  return DEFAULT_CPU_THREAD_COUNT;
}

/**
 * Extracts the natively resolved thread count from llama.rn's systemInfo string
 * (e.g. "system_info: n_threads = 4 (n_threads_batch = 4) / 6 | ...").
 */
export function parseResolvedThreadsFromSystemInfo(systemInfo?: string | null): number | null {
  if (!systemInfo || typeof systemInfo !== 'string') {
    return null;
  }

  const match = systemInfo.match(/\bn_threads\s*=\s*(\d+)/);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
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
