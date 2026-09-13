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

test("unsigned CI builds disable updater artifact signing", () => {
  const root = path.resolve(__dirname, "..", "..");
  const signedConfig = JSON.parse(
    fs.readFileSync(path.join(root, "src-tauri", "tauri.ci.conf.json"), "utf8"),
  );
  const unsignedConfig = JSON.parse(
    fs.readFileSync(path.join(root, "src-tauri", "tauri.unsigned.conf.json"), "utf8"),
  );
  const workflow = fs.readFileSync(
    path.join(root, ".github", "workflows", "build-matrix.yml"),
    "utf8",
  );

  assert.equal(signedConfig.bundle.createUpdaterArtifacts, true);
  assert.equal(unsignedConfig.bundle.createUpdaterArtifacts, false);
  assert.match(
    workflow,
    /Build app \(Unsigned CI\)[\s\S]*?--config src-tauri\/tauri\.unsigned\.conf\.json/,
  );
});
