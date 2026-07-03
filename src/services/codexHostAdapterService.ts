import { openPath } from '@tauri-apps/plugin-opener';
import { callPlatformAdapter } from './platformAdapterService';
import type { InstanceProfile } from '../types/instance';
import type { CodexHostAccount, CodexHostQuickConfig } from '../types/codexHost';

export interface CodexHostAccountGroup {
  id: string;
  name: string;
  sortOrder: number;
  accountIds: string[];
  createdAt: number;
}

export type { CodexHostAccount, CodexHostQuickConfig } from '../types/codexHost';

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export async function listCodexHostAccounts(): Promise<CodexHostAccount[]> {
  return await callPlatformAdapter<CodexHostAccount[]>('codex', 'accounts.list');
}

export async function getCurrentCodexHostAccount(): Promise<CodexHostAccount | null> {
  return await callPlatformAdapter<CodexHostAccount | null>('codex', 'accounts.current');
}

export async function listCodexHostAccountGroups(): Promise<CodexHostAccountGroup[]> {
  const raw = await callPlatformAdapter<string>('codex', 'accounts.loadGroups');
  return parseJsonArray<CodexHostAccountGroup>(raw);
}

export async function refreshCurrentCodexHostQuota(): Promise<void> {
  await callPlatformAdapter('codex', 'quota.refreshCurrent');
}

export async function refreshCodexHostQuota(accountId: string): Promise<void> {
  await callPlatformAdapter('codex', 'quota.refresh', { accountId });
}

export async function switchCodexHostAccount(accountId: string): Promise<CodexHostAccount> {
  return await callPlatformAdapter<CodexHostAccount>('codex', 'switch.account', {
    accountId,
    autoRepairMode: true,
  });
}

export async function updateCodexHostAccountTags(
  accountId: string,
  tags: string[],
): Promise<CodexHostAccount> {
  return await callPlatformAdapter<CodexHostAccount>('codex', 'accounts.updateTags', {
    accountId,
    tags,
  });
}

export async function getCodexHostQuickConfig(): Promise<CodexHostQuickConfig> {
  return await callPlatformAdapter<CodexHostQuickConfig>('codex', 'config.quick.get');
}

export async function saveCodexHostQuickConfig(
  modelContextWindow?: number,
  autoCompactTokenLimit?: number,
): Promise<CodexHostQuickConfig> {
  return await callPlatformAdapter<CodexHostQuickConfig>('codex', 'config.quick.save', {
    modelContextWindow: modelContextWindow ?? null,
    autoCompactTokenLimit: autoCompactTokenLimit ?? null,
  });
}

export async function getCodexHostInstanceQuickConfig(
  instanceId: string,
): Promise<CodexHostQuickConfig> {
  return await callPlatformAdapter<CodexHostQuickConfig>('codex', 'instances.quickConfig.get', {
    instanceId,
  });
}

export async function saveCodexHostInstanceQuickConfig(
  instanceId: string,
  modelContextWindow?: number,
  autoCompactTokenLimit?: number,
): Promise<CodexHostQuickConfig> {
  return await callPlatformAdapter<CodexHostQuickConfig>('codex', 'instances.quickConfig.save', {
    instanceId,
    modelContextWindow: modelContextWindow ?? null,
    autoCompactTokenLimit: autoCompactTokenLimit ?? null,
  });
}

export async function openCodexHostInstanceConfigToml(instanceId: string): Promise<void> {
  const path = await callPlatformAdapter<string>('codex', 'instances.configPath', {
    instanceId,
  });
  await openPath(path);
}

export async function listCodexHostInstances(): Promise<InstanceProfile[]> {
  return await callPlatformAdapter<InstanceProfile[]>('codex', 'instances.list');
}

export async function updateCodexHostInstance(input: {
  instanceId: string;
  bindAccountId?: string | null;
  followLocalAccount?: boolean;
}): Promise<InstanceProfile> {
  return await callPlatformAdapter<InstanceProfile>('codex', 'instances.update', {
    instanceId: input.instanceId,
    bindAccountId: input.bindAccountId ?? null,
    bindAccountIdSet: input.bindAccountId !== undefined,
    followLocalAccount: input.followLocalAccount ?? null,
  });
}

export async function startCodexHostInstance(instanceId: string): Promise<InstanceProfile> {
  return await callPlatformAdapter<InstanceProfile>('codex', 'instances.start', { instanceId });
}

export async function openCodexHostConfigToml(): Promise<void> {
  const path = await callPlatformAdapter<string>('codex', 'config.path');
  await openPath(path);
}
