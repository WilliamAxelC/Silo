import DeviceInfo from 'react-native-device-info';
import { useAIStore } from '../../store/useAIStore';

export const LOW_MEMORY_GPU_DISABLE_THRESHOLD_BYTES = 4 * 1024 * 1024 * 1024;
export const MODEL_MEMORY_MULTIPLIER = 1.5;
export const MAX_MODEL_RAM_FRACTION = 0.6;
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
  
  const targetSizeBytes = activeModelSizeBytes ?? QUANTIZATION_PROFILES.Q5_K_M.fileSizeBytes;
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
  
  const activeQuantization = 'Q5_K_M';
  
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

export function resolveRecommendedCpuThreads(totalMemoryBytes: number, explicitThreadCount?: number | null): number {
  if (Number.isFinite(explicitThreadCount) && explicitThreadCount && explicitThreadCount > 0) {
    return Math.max(MIN_CPU_THREAD_COUNT, Math.min(Math.floor(explicitThreadCount), MAX_CPU_THREAD_COUNT));
  }

  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    return FALLBACK_CPU_THREAD_COUNT;
  }

  const totalMemoryGb = totalMemoryBytes / (1024 * 1024 * 1024);
  if (totalMemoryGb <= 4) {
    return 2;
  }

  if (totalMemoryGb <= 6) {
    return 3;
  }

  if (totalMemoryGb <= 8) {
    return 4;
  }

  return MAX_CPU_THREAD_COUNT;
}

export function getGpuLayersForDevice(totalMemoryBytes: number): number {
  return totalMemoryBytes <= LOW_MEMORY_GPU_DISABLE_THRESHOLD_BYTES ? 0 : 99;
}
