#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const osModule = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT_DIR = path.join(ROOT, 'platform-packages', 'bootstrap');
const DEFAULT_METADATA_DIR = path.join(ROOT, '.tmp', 'platform-bootstrap', 'metadata');
const DEFAULT_DIST_DIR = path.join(ROOT, '.tmp', 'platform-bootstrap', 'dist');
const BASE_INDEX_PATH = path.join(ROOT, 'platform-packages', 'index.json');
const BOOTSTRAP_DOWNLOAD_BASE_URL = 'https://bootstrap.local';
const WINDOWS_VCVARS64_PATH =
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  console.log(`Usage:
  node scripts/prepare-platform-bootstrap.cjs --index-url <url> --targets <os/arch,...> [options]
  node scripts/prepare-platform-bootstrap.cjs --from-source --targets <os/arch,...> [options]

Options:
  --index-file <path>       Use a local platform package index instead of --index-url.
  --from-source             Build bootstrap packages from current platform-packages/<id> source.
  --output-dir <path>       Output bootstrap dir. Defaults to platform-packages/bootstrap.
  --platforms <list>        Comma list of platform package ids. Defaults to all packages.
  --targets <list>          Comma list, for example macos/aarch64,macos/x86_64.
  --no-build-ui             Reuse existing platform-packages/<id>/ui output in --from-source mode.
  --build-adapters          Force rebuilding sidecar adapters in --from-source mode.
`);
}

function parseArgs(argv) {
  const args = {
    outputDir: DEFAULT_OUTPUT_DIR,
    metadataDir: DEFAULT_METADATA_DIR,
    sourceDistDir: DEFAULT_DIST_DIR,
    buildUi: true,
    buildAdapters: false,
    fromSource: false,
    platforms: [],
    targets: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--from-source') {
      args.fromSource = true;
      continue;
    }
    if (arg === '--no-build-ui') {
      args.buildUi = false;
      continue;
    }
    if (arg === '--build-adapters') {
      args.buildAdapters = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) fail(`Missing value for ${arg}`);
    index += 1;
    if (arg === '--index-url') args.indexUrl = next;
    else if (arg === '--index-file') args.indexFile = path.resolve(ROOT, next);
    else if (arg === '--output-dir') args.outputDir = path.resolve(ROOT, next);
    else if (arg === '--metadata-dir') args.metadataDir = path.resolve(ROOT, next);
    else if (arg === '--source-dist-dir') args.sourceDistDir = path.resolve(ROOT, next);
    else if (arg === '--platforms') args.platforms = parsePlatformIds(next);
    else if (arg === '--targets') args.targets = parseTargets(next);
    else fail(`Unknown argument: ${arg}`);
  }
  if (args.fromSource && (args.indexUrl || args.indexFile)) {
    fail('--from-source cannot be combined with --index-url or --index-file');
  }
  if (!args.fromSource && !args.indexUrl && !args.indexFile) {
    fail('Missing --index-url, --index-file or --from-source');
  }
  if (args.targets.length === 0) fail('Missing --targets <os/arch,...>');
  return args;
}

function parsePlatformIds(value) {
  const seen = new Set();
  const ids = [];
  for (const id of String(value || '').split(',').map((item) => item.trim()).filter(Boolean)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) fail(`Invalid platform package id: ${id}`);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function parseTargets(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [os, arch] = item.split('/');
      if (!os || !arch) fail(`Invalid target: ${item}`);
      return { os, arch, key: `${os}/${arch}` };
    });
}

function normalizeCurrentOs() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'linux') return 'linux';
  fail(`Unsupported OS: ${process.platform}`);
}

function normalizeCurrentArch() {
  if (process.arch === 'arm64') return 'aarch64';
  if (process.arch === 'x64') return 'x86_64';
  fail(`Unsupported arch: ${process.arch}`);
}

function defaultCurrentTarget() {
  return `${normalizeCurrentOs()}/${normalizeCurrentArch()}`;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`${label}: failed to read JSON: ${error.message}`);
  }
}

async function readRemoteJson(url) {
  const response = await fetch(url, {
    headers: {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'User-Agent': 'Cockpit-Tools-Bootstrap',
    },
  });
  if (!response.ok) fail(`Failed to download index: HTTP ${response.status} ${url}`);
  return await response.json();
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    env: process.env,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${command} ${commandArgs.join(' ')} exited with ${result.status ?? 1}`);
  }
}

function quoteCmdArg(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function runCargo(commandArgs) {
  if (process.platform !== 'win32' || !fs.existsSync(WINDOWS_VCVARS64_PATH)) {
    run('cargo', commandArgs);
    return;
  }

  const scriptPath = path.join(
    osModule.tmpdir(),
    `cockpit-platform-bootstrap-cargo-${process.pid}-${Date.now()}.cmd`,
  );
  const scriptBody = [
    '@echo off',
    `call ${quoteCmdArg(WINDOWS_VCVARS64_PATH)}`,
    'if errorlevel 1 exit /b %errorlevel%',
    `cargo ${commandArgs.map(quoteCmdArg).join(' ')}`,
    'exit /b %errorlevel%',
  ].join('\r\n');
  fs.writeFileSync(scriptPath, `${scriptBody}\r\n`, 'utf8');
  try {
    run('cmd.exe', ['/d', '/c', scriptPath]);
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
}

function rustTargetFor(os, arch) {
  if (os === 'macos') return `${arch}-apple-darwin`;
  if (os === 'windows') return `${arch}-pc-windows-msvc`;
  if (os === 'linux') return `${arch}-unknown-linux-gnu`;
  fail(`Unsupported Rust target: ${os}/${arch}`);
}

function goTargetFor(os, arch) {
  const goOs = os === 'macos' ? 'darwin' : os;
  const goArch = arch === 'aarch64' ? 'arm64' : 'amd64';
  return { goOs, goArch };
}

function adapterEntryForOs(adapter, os) {
  if (!adapter) return null;
  if (os === 'macos') return adapter.macosEntry || adapter.entry;
  if (os === 'windows') return adapter.windowsEntry || adapter.entry;
  if (os === 'linux') return adapter.linuxEntry || adapter.entry;
  return adapter.entry;
}

function expectedAdapterCrateName(platformId) {
  if (platformId === 'claude_manager') return 'cockpit-claude-adapter';
  return `cockpit-${platformId.replace(/_/g, '-')}-adapter`;
}

function selectPackages(index, requestedPlatformIds) {
  const packages = index.packages || [];
  if (requestedPlatformIds.length === 0) return packages;
  const byId = new Map(packages.map((pkg) => [pkg.id, pkg]));
  return requestedPlatformIds.map((platformId) => {
    const pkg = byId.get(platformId);
    if (!pkg) fail(`Unknown platform package: ${platformId}`);
    return pkg;
  });
}

function readManifest(platformId) {
  return readJson(path.join(ROOT, 'platform-packages', platformId, 'manifest.json'), `${platformId} manifest`);
}

function platformNeedsAdapterBuild(platformId, manifest, target, forceBuild) {
  if (manifest.installKind !== 'sidecarAdapter') return false;
  if (forceBuild) return true;
  const entry = adapterEntryForOs(manifest.adapter, target.os);
  if (!entry) return true;
  return !fs.existsSync(path.join(ROOT, 'platform-packages', platformId, entry));
}

function adapterBinDirForTarget(target) {
  const rustTarget = rustTargetFor(target.os, target.arch);
  const hostTarget = rustTargetFor(normalizeCurrentOs(), normalizeCurrentArch());
  if (rustTarget === hostTarget) {
    return path.join(ROOT, 'target', 'release');
  }
  return path.join(ROOT, 'target', rustTarget, 'release');
}

function buildAdapter(platformId, target) {
  const crate = expectedAdapterCrateName(platformId);
  const rustTarget = rustTargetFor(target.os, target.arch);
  const hostTarget = rustTargetFor(normalizeCurrentOs(), normalizeCurrentArch());
  const args = ['build', '--release', '-p', crate];
  if (rustTarget !== hostTarget) {
    args.push('--target', rustTarget);
  }
  console.log(`[platform-bootstrap] building adapter ${crate} for ${target.key}`);
  runCargo(args);
}

function ensureCodexHelper(target) {
  const rustTarget = rustTargetFor(target.os, target.arch);
  const extension = target.os === 'windows' ? '.exe' : '';
  const output = path.join(
    ROOT,
    'sidecars',
    'cockpit-cliproxy',
    'bin',
    `cockpit-cliproxy-${rustTarget}${extension}`,
  );
  if (fs.existsSync(output)) return;

  const { goOs, goArch } = goTargetFor(target.os, target.arch);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  console.log(`[platform-bootstrap] building Codex helper -> ${path.relative(ROOT, output)}`);
  run('go', [
    'build',
    '-trimpath',
    '-ldflags',
    '-s -w',
    '-o',
    output,
    '.',
  ], {
    cwd: path.join(ROOT, 'sidecars', 'cockpit-cliproxy'),
    env: {
      ...process.env,
      GOOS: goOs,
      GOARCH: goArch,
      CGO_ENABLED: '0',
    },
  });
}

function buildBootstrapFromSource(args) {
  const baseIndex = readJson(BASE_INDEX_PATH, 'platform package index');
  const selectedPackages = selectPackages(baseIndex, args.platforms);
  const selectedIds = selectedPackages.map((pkg) => pkg.id);
  const outputIndexPath = path.join(args.outputDir, 'index.json');
  const outputDistDir = path.join(args.outputDir, 'dist');
  fs.rmSync(args.outputDir, { recursive: true, force: true });
  fs.rmSync(args.metadataDir, { recursive: true, force: true });
  fs.rmSync(args.sourceDistDir, { recursive: true, force: true });
  fs.mkdirSync(outputDistDir, { recursive: true });
  fs.mkdirSync(args.metadataDir, { recursive: true });
  fs.mkdirSync(args.sourceDistDir, { recursive: true });

  const manifestsById = new Map(selectedIds.map((platformId) => [platformId, readManifest(platformId)]));
  for (const pkg of selectedPackages) {
    if (args.buildUi) {
      run(process.execPath, ['scripts/build-platform-ui.cjs', pkg.id]);
    }
  }

  const builtAdapters = new Set();
  for (const pkg of selectedPackages) {
    const manifest = manifestsById.get(pkg.id);
    for (const target of args.targets) {
      const adapterKey = `${pkg.id}:${target.key}`;
      const needsAdapterBuild = platformNeedsAdapterBuild(pkg.id, manifest, target, args.buildAdapters);
      if (needsAdapterBuild && !builtAdapters.has(adapterKey)) {
        buildAdapter(pkg.id, target);
        builtAdapters.add(adapterKey);
      }
      if (pkg.id === 'codex') {
        ensureCodexHelper(target);
      }

      const zipName = `${pkg.id}-${manifest.version}-${target.os}-${target.arch}.zip`;
      const metadataOut = path.join(args.metadataDir, `${pkg.id}-${manifest.version}-${target.os}-${target.arch}.json`);
      const packageArgs = [
        'scripts/package-platform-package.cjs',
        '--platform',
        pkg.id,
        '--os',
        target.os,
        '--arch',
        target.arch,
        '--filename-template',
        'os-arch',
        '--dist-dir',
        args.sourceDistDir,
        '--metadata-out',
        metadataOut,
        '--download-url',
        `${BOOTSTRAP_DOWNLOAD_BASE_URL}/${zipName}`,
      ];
      if (manifest.installKind === 'sidecarAdapter' && needsAdapterBuild) {
        packageArgs.push('--adapter-bin-dir', adapterBinDirForTarget(target));
      }
      run(process.execPath, packageArgs);
    }
  }

  const mergedIndexPath = path.join(args.metadataDir, 'index.json');
  run(process.execPath, [
    'scripts/build-platform-package-index.cjs',
    '--metadata-dir',
    args.metadataDir,
    '--base-index',
    BASE_INDEX_PATH,
    '--output',
    mergedIndexPath,
    '--download-base-url',
    BOOTSTRAP_DOWNLOAD_BASE_URL,
    '--platforms',
    selectedIds.join(','),
    '--require-os-arch',
    args.targets.map((target) => target.key).join(','),
    '--verify-zip-dir',
    args.sourceDistDir,
  ]);

  for (const fileName of fs.readdirSync(args.sourceDistDir)) {
    if (!fileName.endsWith('.zip')) continue;
    fs.copyFileSync(path.join(args.sourceDistDir, fileName), path.join(outputDistDir, fileName));
  }
  const mergedIndex = readJson(mergedIndexPath, 'generated bootstrap index');
  const selectedSet = new Set(selectedIds);
  const outputIndex = {
    ...mergedIndex,
    version: mergedIndex.version || 'bootstrap',
    packages: (mergedIndex.packages || []).filter((pkg) => selectedSet.has(pkg.id)),
  };
  fs.writeFileSync(outputIndexPath, `${JSON.stringify(outputIndex, null, 2)}\n`);
  console.log(`Prepared bundled platform packages from source: ${selectedIds.join(', ')}`);
  console.log(`Targets: ${args.targets.map((target) => target.key).join(', ')}`);
  console.log(`Wrote ${path.relative(ROOT, outputIndexPath)}`);
}

function zipNameFromUrl(url) {
  const parsed = new URL(url);
  const name = path.basename(parsed.pathname);
  if (!name || !name.endsWith('.zip') || name.includes('/') || name.includes('\\')) {
    fail(`Invalid artifact zip name from ${url}`);
  }
  return name;
}

async function downloadArtifact(artifact, distDir) {
  const zipName = zipNameFromUrl(artifact.downloadUrl);
  const zipPath = path.join(distDir, zipName);
  const response = await fetch(artifact.downloadUrl, {
    headers: { 'User-Agent': 'Cockpit-Tools-Bootstrap' },
  });
  if (!response.ok) {
    fail(`Failed to download ${artifact.downloadUrl}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (artifact.downloadSizeBytes && bytes.length !== artifact.downloadSizeBytes) {
    fail(`${zipName}: size mismatch, expected ${artifact.downloadSizeBytes}, actual ${bytes.length}`);
  }
  const actualSha = sha256Buffer(bytes);
  if (actualSha !== artifact.sha256) {
    fail(`${zipName}: sha256 mismatch, expected ${artifact.sha256}, actual ${actualSha}`);
  }
  fs.writeFileSync(zipPath, bytes);
  return {
    ...artifact,
    downloadUrl: `https://bootstrap.local/${zipName}`,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 && process.env.COCKPIT_PLATFORM_BOOTSTRAP_DEFAULT_TARGET === 'current') {
    argv.push('--from-source', '--targets', defaultCurrentTarget());
  }
  const args = parseArgs(argv);
  if (args.fromSource) {
    buildBootstrapFromSource(args);
    return;
  }
  const sourceIndex = args.indexFile
    ? readJson(args.indexFile, args.indexFile)
    : await readRemoteJson(args.indexUrl);
  const targetKeys = new Set(args.targets.map((target) => target.key));
  const distDir = path.join(args.outputDir, 'dist');
  fs.mkdirSync(args.outputDir, { recursive: true });
  fs.rmSync(path.join(args.outputDir, 'index.json'), { force: true });
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  const packages = [];
  for (const pkg of sourceIndex.packages || []) {
    const artifacts = [];
    for (const target of args.targets) {
      const artifact = (pkg.artifacts || []).find(
        (item) => item.os === target.os && item.arch === target.arch,
      );
      if (!artifact) {
        fail(`${pkg.id}: missing artifact for ${target.key}`);
      }
      artifacts.push(await downloadArtifact(artifact, distDir));
    }
    const uniqueArtifacts = artifacts.filter((artifact, index, list) => (
      list.findIndex((item) => `${item.os}/${item.arch}` === `${artifact.os}/${artifact.arch}`) === index
    ));
    const primary = uniqueArtifacts.find((artifact) => targetKeys.has(`${artifact.os}/${artifact.arch}`))
      || uniqueArtifacts[0];
    packages.push({
      ...pkg,
      artifacts: uniqueArtifacts,
      downloadUrl: primary.downloadUrl,
      downloadSizeBytes: primary.downloadSizeBytes,
      sha256: primary.sha256,
    });
  }

  const outputIndex = {
    ...sourceIndex,
    version: sourceIndex.version || 'bootstrap',
    packages,
  };
  const outputIndexPath = path.join(args.outputDir, 'index.json');
  fs.writeFileSync(outputIndexPath, `${JSON.stringify(outputIndex, null, 2)}\n`);
  console.log(`Prepared platform bootstrap for targets: ${[...targetKeys].join(', ')}`);
  console.log(`Wrote ${path.relative(ROOT, outputIndexPath)}`);
}

main().catch((error) => fail(error?.message || String(error)));
