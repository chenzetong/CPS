const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const SELF = "scripts/security/scan-sensitive.cjs";
const MAX_TEXT_SIZE = 2 * 1024 * 1024;

const rules = [
  ["private-key", /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["openai-style-key", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ["slack-token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g],
  ["local-user-path", /\/(?:Users\/naigou|home\/chenj)(?:\/|\b)/g],
  ["private-host", /\b10\.11\.23\.172\b/g],
  ["diagnostic-thread-id", /\b019f61c9-5619-7000-a926-6704f37a3c5a\b/g],
];

const tracked = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: ROOT },
)
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
const findings = [];

function isAllowedFixture(relativePath, rule, text, match) {
  const lineStart = text.lastIndexOf("\n", match.index) + 1;
  const lineEnd = text.indexOf("\n", match.index);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);

  if (
    rule === "google-api-key" &&
    [
      "crates/cockpit-core/src/modules/windsurf_oauth.rs",
      "src-tauri/src/modules/windsurf_oauth.rs",
    ].includes(relativePath) &&
    line.includes("const FIREBASE_API_KEY: &str")
  ) {
    return true;
  }

  if (
    rule === "github-token" &&
    relativePath === "sidecars/cockpit-cliproxy/cdk/CLIProxyAPI/.env.example" &&
    line.includes("GITSTORE_GIT_TOKEN=") &&
    /your|example|placeholder/i.test(match[0])
  ) {
    return true;
  }

  if (
    rule === "openai-style-key" &&
    relativePath === "src-tauri/src/modules/codex_account.rs" &&
    line.includes("let api_key =") &&
    text.slice(Math.max(0, lineStart - 500), lineStart).includes(
      "api_key_upsert_without_sync_preference_preserves_instance_model_catalog",
    )
  ) {
    return true;
  }

  return false;
}

for (const relativePath of tracked) {
  if (relativePath === SELF) continue;
  const filePath = path.join(ROOT, relativePath);
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_TEXT_SIZE) continue;
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) continue;
  const text = buffer.toString("utf8");
  for (const [rule, pattern] of rules) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (isAllowedFixture(relativePath, rule, text, match)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      findings.push(`${relativePath}:${line} [${rule}]`);
    }
  }
}

if (findings.length > 0) {
  console.error("Sensitive-content scan failed (matched values are intentionally redacted):");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Sensitive-content scan passed for ${tracked.length} tracked files.`);
