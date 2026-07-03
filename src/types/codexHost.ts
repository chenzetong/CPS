export type CodexHostAppSpeed = 'standard' | 'fast';

export type CodexHostProviderWireApi = 'responses' | 'chat_completions';

export interface CodexHostQuickConfig {
  context_window_1m: boolean;
  auto_compact_token_limit: number;
  detected_model_context_window?: number;
  detected_auto_compact_token_limit?: number;
}

export interface CodexHostQuota {
  hourly_percentage: number;
  hourly_reset_time?: number;
  hourly_window_minutes?: number;
  hourly_window_present?: boolean;
  weekly_percentage: number;
  weekly_reset_time?: number;
  weekly_window_minutes?: number;
  weekly_window_present?: boolean;
  reset_credits_available?: number;
  reset_credits_next_expires_at?: number;
}

export interface CodexHostAccount {
  id: string;
  email: string;
  auth_mode?: string;
  openai_api_key?: string;
  api_base_url?: string;
  api_provider_id?: string;
  api_provider_name?: string;
  api_wire_api?: CodexHostProviderWireApi | null;
  account_name?: string;
  account_note?: string;
  plan_type?: string;
  subscription_active_until?: string;
  app_speed?: CodexHostAppSpeed;
  quota?: CodexHostQuota;
  tags?: string[];
  created_at: number;
  last_used: number;
}

export function isCodexHostApiKeyAccount(account: CodexHostAccount): boolean {
  return account.auth_mode === 'api_key' || Boolean(account.openai_api_key);
}

export function isCodexHostChatCompletionsApiKeyAccount(account: CodexHostAccount): boolean {
  return isCodexHostApiKeyAccount(account) && account.api_wire_api === 'chat_completions';
}

function normalizeCodexHostApiBaseUrl(rawValue?: string | null): string {
  const trimmed = (rawValue || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return '';
  }
}

export function isCodexHostNewApiAccount(account: CodexHostAccount): boolean {
  return (
    isCodexHostApiKeyAccount(account)
    && (
      normalizeCodexHostApiBaseUrl(account.api_base_url) ===
        normalizeCodexHostApiBaseUrl('https://chongcodex.cn/v1')
      || (account.api_provider_name || '').trim().toLowerCase() === 'new api'
    )
  );
}
