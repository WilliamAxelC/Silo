import DeviceInfo from 'react-native-device-info';

export const LOW_MEMORY_GPU_DISABLE_THRESHOLD_BYTES = 4 * 1024 * 1024 * 1024;
export const MODEL_MEMORY_MULTIPLIER = 1.5;
export const MAX_MODEL_RAM_FRACTION = 0.6;
export const FALLBACK_CPU_THREAD_COUNT = 4;
export const MIN_CPU_THREAD_COUNT = 2;
export const MAX_CPU_THREAD_COUNT = 6;

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
