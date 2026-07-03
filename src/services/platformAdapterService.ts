import { invoke } from '@tauri-apps/api/core';
import type { PlatformId } from '../types/platform';

export interface PlatformAdapterCallOptions {
  timeoutMs?: number;
}

export async function callPlatformAdapter<T>(
  platformId: PlatformId,
  method: string,
  payload: Record<string, unknown> = {},
  options: PlatformAdapterCallOptions = {},
): Promise<T> {
  return await invoke<T>('platform_adapter_call', {
    platformId,
    method,
    payload,
    timeoutMs: options.timeoutMs ?? null,
  });
}
