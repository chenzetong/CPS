import { invoke } from '@tauri-apps/api/core';

export interface LatestLogSnapshot {
  log_dir_path: string;
  log_file_path: string;
  log_file_name: string;
  content: string;
  line_limit: number;
  file_size: number;
  modified_at_ms: number | null;
}

export async function getLatestLogSnapshot(lineLimit?: number): Promise<LatestLogSnapshot> {
  return await invoke('logs_get_latest_snapshot', { lineLimit });
}

export async function openLogDirectory(): Promise<void> {
  return await invoke('logs_open_log_directory');
}
