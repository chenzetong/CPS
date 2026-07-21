const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("Tauri updater endpoints match per-bundle release manifest names", () => {
  const configPath = path.resolve(__dirname, "..", "..", "src-tauri", "tauri.conf.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.deepEqual(config.plugins.updater.endpoints, [
    "https://github.com/chenzetong/CPS/releases/latest/download/latest-{{target}}-{{arch}}-{{bundle_type}}.json",
    "https://github.com/chenzetong/CPS/releases/latest/download/latest.json",
  ]);
});
