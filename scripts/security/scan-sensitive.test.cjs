const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");

const fixtureDir = "sidecars/cockpit-cliproxy/third_party/CLIProxyAPI/sdk/cliproxy/auth";
const redactionTest = `${fixtureDir}/conductor_selection_cooldown_test.go`;
const refreshTest = `${fixtureDir}/conductor_scheduler_refresh_test.go`;
const sampleKey = ["sk", "live-secret-key-123456"].join("-");
const samplePath = path.posix.join("/Users", "alice", "configs/auth.json");
const sampleProxy = `http://${[10, 0, 0, 1].join(".")}:8888`;

function scan(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cps-security-scan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  files = {
    "scripts/security/scan-sensitive.cjs": fs.readFileSync(
      path.join(__dirname, "scan-sensitive.cjs"),
      "utf8",
    ),
    ...files,
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return spawnSync(process.execPath, ["scripts/security/scan-sensitive.cjs"], {
    cwd: root,
    encoding: "utf8",
  });
}

test("allows audited upstream redaction and concurrent proxy fixtures", (t) => {
  const result = scan(t, {
    [redactionTest]: `input: "invalid key ${sampleKey}",\ninput: "open ${samplePath}: denied",\n`,
    [refreshTest]: `currentAuth.ProxyURL = "${sampleProxy}"\n`,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("does not exempt other secrets or runtime source in the same module", (t) => {
  const otherKey = ["sk", "different-secret-key-123456"].join("-");
  const result = scan(t, {
    [redactionTest]: `input: "invalid key ${otherKey}",\nconfigPath := "${samplePath}"\n`,
    [refreshTest]: `currentAuth.ProxyURL = "http://${[10, 0, 0, 2].join(".")}:8888"\n`,
    [`${fixtureDir}/conductor_selection_cooldown.go`]: `input: "invalid key ${sampleKey}",\n`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /openai-style-key/);
  assert.match(result.stderr, /developer-home-path/);
  assert.match(result.stderr, /rfc1918-host/);
  assert.match(result.stderr, /conductor_selection_cooldown\.go/);
  for (const secret of [sampleKey, otherKey, samplePath]) {
    assert.ok(!result.stderr.includes(secret), "scan output must redact matched values");
  }
});

test("allows audited SSRF ranges and synthetic thread fixtures", (t) => {
  const address = [10, 0, 0, 0].join(".");
  const thread = ["01900000", "0000", "7000", "8000", "000000000001"].join("-");
  const result = scan(t, {
    "sidecars/cockpit-cliproxy/image_api_download.go": `netip.MustParsePrefix("${address}/8")`,
    "src-tauri/src/modules/codex_app_injection_usage_tests.rs": `const THREAD: &str = "${thread}";`,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("fixture allowances reject other addresses and live-shaped thread IDs", (t) => {
  const address = [10, 1, 2, 3].join(".");
  const thread = ["01900000", "abcd", "7000", "8000", "123456789abc"].join("-");
  const result = scan(t, {
    "sidecars/cockpit-cliproxy/image_api_download.go": `netip.MustParsePrefix("${address}/8")`,
    "src-tauri/src/modules/codex_app_injection_usage_tests.rs": `const THREAD: &str = "${thread}";`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rfc1918-host/);
  assert.match(result.stderr, /codex-thread-id/);
  assert.ok(!result.stderr.includes(thread));
});
