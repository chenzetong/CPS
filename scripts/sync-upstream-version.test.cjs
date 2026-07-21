const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { syncUpstreamVersion } = require("./sync-upstream-version.cjs");

test("aligns every packaged application version without changing CPS metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cps-version-sync-"));
  fs.mkdirSync(path.join(root, "src-tauri"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "cockpit-tools", version: "0.26.8" }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    `${JSON.stringify({ name: "cockpit-tools", version: "0.26.8", packages: { "": { name: "cockpit-tools", version: "0.26.8" } } }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, "src-tauri", "tauri.conf.json"),
    `${JSON.stringify({ productName: "CPS", version: "0.26.8", identifier: "com.chenzetong.cps" }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, "src-tauri", "Cargo.toml"),
    '[package]\nname = "cockpit-tools"\nversion = "0.26.8"\ndescription = "CPS"\n',
  );
  fs.writeFileSync(
    path.join(root, "Cargo.lock"),
    'version = 4\n\n[[package]]\nname = "cockpit-tools"\nversion = "0.26.8"\ndependencies = []\n',
  );

  syncUpstreamVersion(root, "1.3.10");

  assert.equal(readJson("package.json").version, "1.3.10");
  assert.equal(readJson("package-lock.json").packages[""].version, "1.3.10");
  assert.deepEqual(readJson("src-tauri/tauri.conf.json"), {
    productName: "CPS",
    version: "1.3.10",
    identifier: "com.chenzetong.cps",
  });
  assert.match(fs.readFileSync(path.join(root, "src-tauri", "Cargo.toml"), "utf8"), /version = "1\.3\.10"/);
  assert.match(fs.readFileSync(path.join(root, "Cargo.lock"), "utf8"), /name = "cockpit-tools"\nversion = "1\.3\.10"/);

  fs.rmSync(root, { recursive: true, force: true });

  function readJson(relativePath) {
    return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
  }
});

test("rejects non-semver upstream versions", () => {
  assert.throws(() => syncUpstreamVersion(process.cwd(), "latest"), /Invalid upstream version/);
});
