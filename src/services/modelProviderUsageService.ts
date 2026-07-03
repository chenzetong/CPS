import { callPlatformAdapter } from './platformAdapterService';

export type ModelProviderUsageIntegrationType = 'sub2api' | 'new_api';
export type ModelProviderUsageMode = ModelProviderUsageIntegrationType;

export interface ModelProviderModel {
  id: string;
  displayName?: string | null;
}

export interface ModelProviderModelsResult {
  models: ModelProviderModel[];
  latencyMs: number;
}

export interface ModelProviderUsageSummary {
  mode?: string | null;
  isValid?: boolean | null;
  status?: string | null;
  planName?: string | null;
  remaining?: number | null;
  balance?: number | null;
  unit?: string | null;
  quotaUnlimited?: boolean | null;
  quotaLimit?: number | null;
  quotaUsed?: number | null;
  quotaRemaining?: number | null;
  todayRequests?: number | null;
  todayTotalTokens?: number | null;
  todayCost?: number | null;
  totalRequests?: number | null;
  totalTotalTokens?: number | null;
  totalCost?: number | null;
  modelStatsCount: number;
  latencyMs: number;
  details?: Array<{
    key: string;
    label: string;
    value: string;
  }>;
}

export function buildUsageBaseUrlCandidates(baseUrl: string): string[] {
  const trimmed = baseUrl.trim();
  if (!trimmed) return [];
  const candidates = [trimmed];
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, '');
    if (
      (host === 'api.apikey.fun' || host === 'slb.apikey.fun') &&
      (path === '' || path === '/')
    ) {
      const usageUrl = `${parsed.origin}/v1`;
      if (!candidates.includes(usageUrl)) candidates.push(usageUrl);
    }
  } catch {
    // keep the original value and let the backend return the validation error
  }
  return candidates;
}

export async function queryModelProviderUsage(input: {
  baseUrl: string;
  apiKey: string;
  integrationType?: ModelProviderUsageIntegrationType | null;
}): Promise<ModelProviderUsageSummary> {
  const candidates = buildUsageBaseUrlCandidates(input.baseUrl);
  let lastError: unknown = null;
  for (const baseUrl of candidates) {
    try {
      return await callPlatformAdapter<ModelProviderUsageSummary>('codex', 'modelProviders.queryUsage', {
        baseUrl,
        apiKey: input.apiKey,
        integrationType: input.integrationType ?? null,
      });
    } catch (error) {
      lastError = error;
      if (!isModelProviderUsageUnavailableError(error)) {
        throw error;
      }
    }
  }
  throw lastError ?? new Error('PROVIDER_BASE_URL_INVALID');
}

export async function listModelProviderModels(input: {
  baseUrl: string;
  apiKey: string;
}): Promise<ModelProviderModelsResult> {
  return await callPlatformAdapter<ModelProviderModelsResult>('codex', 'modelProviders.listModels', {
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
  });
}

export function isModelProviderUsageUnavailableError(error: unknown): boolean {
  const message = String(error).replace(/^Error:\s*/, '');
  return (
    message.includes('PROVIDER_USAGE_DETECT_FAILED') ||
    message.includes('PROVIDER_USAGE_HTTP_404') ||
    message.includes('PROVIDER_USAGE_TYPE_UNSUPPORTED')
  );
}

export function resolveModelProviderUsageMode(
  summary?: ModelProviderUsageSummary,
): ModelProviderUsageMode | null {
  if (!summary) return null;
  if (summary.mode === 'new_api' || summary.mode === 'sub2api') {
    return summary.mode;
  }
  if (
    typeof summary.todayRequests === 'number' ||
    typeof summary.todayTotalTokens === 'number'
  ) {
    return 'sub2api';
  }
  const detailKeys = new Set((summary.details ?? []).map((item) => item.key));
  if (
    detailKeys.has('todayRequests') ||
    detailKeys.has('todayTokens') ||
    detailKeys.has('remaining')
  ) {
    return 'sub2api';
  }
  if (
    detailKeys.has('totalGranted') ||
    detailKeys.has('totalAvailable') ||
    detailKeys.has('expiresAt')
  ) {
    return 'new_api';
  }
  return null;
}

export function formatModelProviderUsageMoney(
  value?: number | null,
  unit?: string | null,
): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  const normalizedUnit = unit?.trim() || 'USD';
  const formatted = value.toFixed(value >= 100 ? 0 : 2);
  return normalizedUnit === 'USD' ? `$${formatted}` : `${formatted} ${normalizedUnit}`;
}

export function formatModelProviderUsageInteger(value?: number | null): string {
  const normalized =
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(
    normalized,
  );
}

export function formatModelProviderUsageTokenCount(value?: number | null): string {
  const normalized =
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  if (normalized >= 100_000_000) {
    return `${(normalized / 100_000_000)
      .toFixed(normalized >= 1_000_000_000 ? 1 : 2)
      .replace(/\.?0+$/, '')}亿`;
  }
  if (normalized >= 10_000) {
    return `${(normalized / 10_000)
      .toFixed(normalized >= 100_000 ? 1 : 2)
      .replace(/\.?0+$/, '')}万`;
  }
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(
    normalized,
  );
}
