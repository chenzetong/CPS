import { useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAccountStore } from '../stores/useAccountStore';
import { useCodexAccountStore } from '../stores/useCodexAccountStore';
import { useGitHubCopilotAccountStore } from '../stores/useGitHubCopilotAccountStore';
import { useWindsurfAccountStore } from '../stores/useWindsurfAccountStore';
import { useKiroAccountStore } from '../stores/useKiroAccountStore';

interface GeneralConfig {
  language: string;
  theme: string;
  auto_refresh_minutes: number;
  codex_auto_refresh_minutes: number;
  ghcp_auto_refresh_minutes: number;
  windsurf_auto_refresh_minutes: number;
  kiro_auto_refresh_minutes: number;
  auto_switch_enabled: boolean;
  close_behavior: string;
  opencode_app_path?: string;
  antigravity_app_path?: string;
  codex_app_path?: string;
  vscode_app_path?: string;
  windsurf_app_path?: string;
  opencode_sync_on_switch?: boolean;
}

export function useAutoRefresh() {
  const refreshAllQuotas = useAccountStore((state) => state.refreshAllQuotas);
  const syncCurrentFromClient = useAccountStore((state) => state.syncCurrentFromClient);
  const fetchAccounts = useAccountStore((state) => state.fetchAccounts);
  const fetchCurrentAccount = useAccountStore((state) => state.fetchCurrentAccount);

  const refreshAllCodexQuotas = useCodexAccountStore((state) => state.refreshAllQuotas);
  const refreshAllGhcpTokens = useGitHubCopilotAccountStore((state) => state.refreshAllTokens);
  const refreshAllWindsurfTokens = useWindsurfAccountStore((state) => state.refreshAllTokens);
  const refreshAllKiroTokens = useKiroAccountStore((state) => state.refreshAllTokens);

  const agIntervalRef = useRef<number | null>(null);
  const autoSwitchIntervalRef = useRef<number | null>(null);
  const codexIntervalRef = useRef<number | null>(null);
  const ghcpIntervalRef = useRef<number | null>(null);
  const windsurfIntervalRef = useRef<number | null>(null);
  const kiroIntervalRef = useRef<number | null>(null);

  const agRefreshingRef = useRef(false);
  const codexRefreshingRef = useRef(false);
  const ghcpRefreshingRef = useRef(false);
  const windsurfRefreshingRef = useRef(false);
  const kiroRefreshingRef = useRef(false);
  const autoSwitchRefreshingRef = useRef(false);

  const setupRunningRef = useRef(false);
  const setupPendingRef = useRef(false);
  const destroyedRef = useRef(false);

  const clearAllIntervals = useCallback(() => {
    if (agIntervalRef.current) {
      window.clearInterval(agIntervalRef.current);
      agIntervalRef.current = null;
    }
    if (codexIntervalRef.current) {
      window.clearInterval(codexIntervalRef.current);
      codexIntervalRef.current = null;
    }
    if (ghcpIntervalRef.current) {
      window.clearInterval(ghcpIntervalRef.current);
      ghcpIntervalRef.current = null;
    }
    if (autoSwitchIntervalRef.current) {
      window.clearInterval(autoSwitchIntervalRef.current);
      autoSwitchIntervalRef.current = null;
    }
    if (windsurfIntervalRef.current) {
      window.clearInterval(windsurfIntervalRef.current);
      windsurfIntervalRef.current = null;
    }
    if (kiroIntervalRef.current) {
      window.clearInterval(kiroIntervalRef.current);
      kiroIntervalRef.current = null;
    }
  }, []);

  const setupAutoRefresh = useCallback(async () => {
    if (destroyedRef.current) {
      return;
    }

    if (setupRunningRef.current) {
      setupPendingRef.current = true;
      return;
    }

    setupRunningRef.current = true;

    try {
      do {
        setupPendingRef.current = false;

        try {
          const config = await invoke<GeneralConfig>('get_general_config');
          if (destroyedRef.current) {
            return;
          }

          // 检测配额重置任务状态及唤醒总开关
          const wakeupEnabled = localStorage.getItem('agtools.wakeup.enabled') === 'true';
          if (wakeupEnabled) {
            const tasksJson = localStorage.getItem('agtools.wakeup.tasks');
            if (tasksJson) {
              try {
                const tasks = JSON.parse(tasksJson);
                const hasActiveResetTask = Array.isArray(tasks) && tasks.some(
                  (task: unknown) => {
                    if (!task || typeof task !== 'object') {
                      return false;
                    }
                    const taskObj = task as {
                      enabled?: boolean;
                      schedule?: { wakeOnReset?: boolean };
                    };
                    return Boolean(taskObj.enabled && taskObj.schedule?.wakeOnReset);
                  },
                );

                // 如果有活跃的重置任务，且刷新间隔为禁用(-1)或大于2分钟，则强制修正为2分钟
                if (hasActiveResetTask && (config.auto_refresh_minutes === -1 || config.auto_refresh_minutes > 2)) {
                  console.log(`[AutoRefresh] 检测到活跃的配额重置任务，自动修正刷新间隔: ${config.auto_refresh_minutes} -> 2`);
                  await invoke('save_general_config', {
                    language: config.language,
                    theme: config.theme,
                    autoRefreshMinutes: 2,
                    codexAutoRefreshMinutes: config.codex_auto_refresh_minutes,
                    ghcpAutoRefreshMinutes: config.ghcp_auto_refresh_minutes,
                    windsurfAutoRefreshMinutes: config.windsurf_auto_refresh_minutes,
                    kiroAutoRefreshMinutes: config.kiro_auto_refresh_minutes,
                    closeBehavior: config.close_behavior || 'ask',
                    opencodeAppPath: config.opencode_app_path ?? '',
                    antigravityAppPath: config.antigravity_app_path ?? '',
                    codexAppPath: config.codex_app_path ?? '',
                    vscodeAppPath: config.vscode_app_path ?? '',
                    windsurfAppPath: config.windsurf_app_path ?? '',
                    opencodeSyncOnSwitch: config.opencode_sync_on_switch ?? true,
                  });
                  config.auto_refresh_minutes = 2;
                }
              } catch (e) {
                console.error('[AutoRefresh] 解析任务列表失败:', e);
              }
            }
          }

          if (destroyedRef.current) {
            return;
          }

          clearAllIntervals();

          if (config.auto_refresh_minutes > 0) {
            console.log(`[AutoRefresh] Antigravity 已启用: 每 ${config.auto_refresh_minutes} 分钟`);
            const agMs = config.auto_refresh_minutes * 60 * 1000;

            agIntervalRef.current = window.setInterval(async () => {
              if (agRefreshingRef.current) {
                return;
              }
              agRefreshingRef.current = true;

              try {
                console.log('[AutoRefresh] 触发定时配额刷新...');
                await syncCurrentFromClient();
                await refreshAllQuotas();
              } catch (e) {
                console.error('[AutoRefresh] 刷新失败:', e);
              } finally {
                agRefreshingRef.current = false;
              }
            }, agMs);
          } else {
            console.log('[AutoRefresh] Antigravity 已禁用');
          }

          if (config.codex_auto_refresh_minutes > 0) {
            console.log(`[AutoRefresh] Codex 已启用: 每 ${config.codex_auto_refresh_minutes} 分钟`);
            const codexMs = config.codex_auto_refresh_minutes * 60 * 1000;

            codexIntervalRef.current = window.setInterval(async () => {
              if (codexRefreshingRef.current) {
                return;
              }
              codexRefreshingRef.current = true;

              try {
                console.log('[AutoRefresh] 触发 Codex 配额刷新...');
                await refreshAllCodexQuotas();
              } catch (e) {
                console.error('[AutoRefresh] Codex 刷新失败:', e);
              } finally {
                codexRefreshingRef.current = false;
              }
            }, codexMs);
          } else {
            console.log('[AutoRefresh] Codex 已禁用');
          }

          if (config.ghcp_auto_refresh_minutes > 0) {
            console.log(`[AutoRefresh] GitHub Copilot 已启用: 每 ${config.ghcp_auto_refresh_minutes} 分钟`);
            const ghcpMs = config.ghcp_auto_refresh_minutes * 60 * 1000;

            ghcpIntervalRef.current = window.setInterval(async () => {
              if (ghcpRefreshingRef.current) {
                return;
              }
              ghcpRefreshingRef.current = true;

              try {
                console.log('[AutoRefresh] 触发 GitHub Copilot Token 刷新...');
                await refreshAllGhcpTokens();
              } catch (e) {
                console.error('[AutoRefresh] GitHub Copilot 刷新失败:', e);
              } finally {
                ghcpRefreshingRef.current = false;
              }
            }, ghcpMs);
          } else {
            console.log('[AutoRefresh] GitHub Copilot 已禁用');
          }

          if (config.windsurf_auto_refresh_minutes > 0) {
            console.log(`[AutoRefresh] Windsurf 已启用: 每 ${config.windsurf_auto_refresh_minutes} 分钟`);
            const windsurfMs = config.windsurf_auto_refresh_minutes * 60 * 1000;

            windsurfIntervalRef.current = window.setInterval(async () => {
              if (windsurfRefreshingRef.current) {
                return;
              }
              windsurfRefreshingRef.current = true;

              try {
                console.log('[AutoRefresh] 触发 Windsurf 配额刷新...');
                await refreshAllWindsurfTokens();
              } catch (e) {
                console.error('[AutoRefresh] Windsurf 刷新失败:', e);
              } finally {
                windsurfRefreshingRef.current = false;
              }
            }, windsurfMs);
          } else {
            console.log('[AutoRefresh] Windsurf 已禁用');
          }

          if (config.kiro_auto_refresh_minutes > 0) {
            console.log(`[AutoRefresh] Kiro 已启用: 每 ${config.kiro_auto_refresh_minutes} 分钟`);
            const kiroMs = config.kiro_auto_refresh_minutes * 60 * 1000;

            kiroIntervalRef.current = window.setInterval(async () => {
              if (kiroRefreshingRef.current) {
                return;
              }
              kiroRefreshingRef.current = true;

              try {
                console.log('[AutoRefresh] 触发 Kiro 配额刷新...');
                await refreshAllKiroTokens();
              } catch (e) {
                console.error('[AutoRefresh] Kiro 刷新失败:', e);
              } finally {
                kiroRefreshingRef.current = false;
              }
            }, kiroMs);
          } else {
            console.log('[AutoRefresh] Kiro 已禁用');
          }

          // 自动切号开启时，额外每 60 秒刷新当前账号（不影响原有配额自动刷新规则）
          if (config.auto_switch_enabled) {
            console.log('[AutoRefresh] 自动切号已启用: 每 60 秒刷新当前账号');
            autoSwitchIntervalRef.current = window.setInterval(async () => {
              if (autoSwitchRefreshingRef.current) {
                return;
              }
              autoSwitchRefreshingRef.current = true;

              try {
                await syncCurrentFromClient();
                await invoke('refresh_current_quota');
                await fetchAccounts();
                await fetchCurrentAccount();
              } catch (e) {
                console.error('[AutoRefresh] 自动切号-当前账号刷新失败:', e);
              } finally {
                autoSwitchRefreshingRef.current = false;
              }
            }, 60 * 1000);
          } else {
            console.log('[AutoRefresh] 自动切号未启用，跳过 60 秒当前账号刷新');
          }
        } catch (err) {
          console.error('[AutoRefresh] 加载配置失败:', err);
        }
      } while (setupPendingRef.current && !destroyedRef.current);
    } finally {
      setupRunningRef.current = false;
    }
  }, [
    clearAllIntervals,
    fetchAccounts,
    fetchCurrentAccount,
    refreshAllCodexQuotas,
    refreshAllGhcpTokens,
    refreshAllKiroTokens,
    refreshAllQuotas,
    refreshAllWindsurfTokens,
    syncCurrentFromClient,
  ]);

  useEffect(() => {
    destroyedRef.current = false;
    void setupAutoRefresh();

    const handleConfigUpdate = () => {
      console.log('[AutoRefresh] 检测到配置变更，重新设置定时器');
      void setupAutoRefresh();
    };

    window.addEventListener('config-updated', handleConfigUpdate);

    return () => {
      destroyedRef.current = true;
      setupPendingRef.current = false;
      clearAllIntervals();
      window.removeEventListener('config-updated', handleConfigUpdate);
    };
  }, [clearAllIntervals, setupAutoRefresh]);
}
