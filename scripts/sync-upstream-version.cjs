const fs = require("node:fs");
const path = require("node:path");

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceRequired(text, pattern, replacement, label) {
  if (!pattern.test(text)) {
    throw new Error(`Could not find ${label}`);
  }
  return text.replace(pattern, replacement);
}

function syncUpstreamVersion(rootDir, version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid upstream version: ${version}`);
  }

  const packagePath = path.join(rootDir, "package.json");
  const packageLockPath = path.join(rootDir, "package-lock.json");
  const tauriConfigPath = path.join(rootDir, "src-tauri", "tauri.conf.json");
  const cargoTomlPath = path.join(rootDir, "src-tauri", "Cargo.toml");
  const cargoLockPath = path.join(rootDir, "Cargo.lock");

  const packageJson = readJson(packagePath);
  packageJson.version = version;
  writeJson(packagePath, packageJson);

  const packageLock = readJson(packageLockPath);
  packageLock.version = version;
  if (packageLock.packages?.[""]) {
    packageLock.packages[""].version = version;
  }
  writeJson(packageLockPath, packageLock);

  const tauriConfig = readJson(tauriConfigPath);
  tauriConfig.version = version;
  writeJson(tauriConfigPath, tauriConfig);

  const cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
  fs.writeFileSync(
    cargoTomlPath,
    replaceRequired(
      cargoToml,
      /(\[package\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/m,
      `$1${version}$2`,
      "[package] version in src-tauri/Cargo.toml",
    ),
  );

  const cargoLock = fs.readFileSync(cargoLockPath, "utf8");
  fs.writeFileSync(
    cargoLockPath,
    replaceRequired(
      cargoLock,
      /(\[\[package\]\]\r?\nname = "cockpit-tools"\r?\nversion = ")[^"]+("\s*$)/m,
      `$1${version}$2`,
      "cockpit-tools package version in Cargo.lock",
    ),
  );

  return version;
}

if (require.main === module) {
  const version = process.argv[2];
  const rootIndex = process.argv.indexOf("--root");
  const rootDir = rootIndex >= 0 ? path.resolve(process.argv[rootIndex + 1]) : process.cwd();
  if (!version || (rootIndex >= 0 && !process.argv[rootIndex + 1])) {
    console.error("Usage: node scripts/sync-upstream-version.cjs <version> [--root <path>]");
    process.exit(2);
  }
  syncUpstreamVersion(rootDir, version);
  console.log(`Aligned CPS version with upstream: ${version}`);
}

module.exports = { syncUpstreamVersion };
