function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSub2ApiExport(value: Record<string, unknown>): boolean {
  const accounts = value.accounts;
  if (!Array.isArray(accounts)) return false;
  return (
    "exported_at" in value ||
    "proxies" in value ||
    accounts.some(
      (account) =>
        isRecord(account) &&
        "credentials" in account &&
        "platform" in account,
    )
  );
}

function splitParsedJson(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value) || !isSub2ApiExport(value)) return [value];

  const accounts = (value.accounts as unknown[]).filter((account) => {
    if (!isRecord(account)) return false;
    return (
      String(account.platform ?? "").toLowerCase() === "openai" &&
      String(account.type ?? "").toLowerCase() === "oauth"
    );
  });
  return accounts.length > 0 ? accounts : [value];
}

export function splitCodexImportPayloads(rawContent: string): string[] {
  const trimmed = rawContent.trim();
  if (!trimmed) return [];

  try {
    return splitParsedJson(JSON.parse(trimmed)).map((item) =>
      JSON.stringify(item),
    );
  } catch {
    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length <= 1) return [trimmed];

    const parsedLines: unknown[] = [];
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as unknown;
        if (!isRecord(value)) return lines;
        parsedLines.push(value);
      } catch {
        return trimmed.startsWith("{") || trimmed.startsWith("[")
          ? [trimmed]
          : lines;
      }
    }
    return parsedLines.map((item) => JSON.stringify(item));
  }
}
