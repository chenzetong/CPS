const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

function normalizeCurrentOs() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'linux') return 'linux';
  throw new Error(`Unsupported OS: ${process.platform}`);
}

function normalizeCurrentArch() {
  if (process.arch === 'arm64') return 'aarch64';
  if (process.arch === 'x64') return 'x86_64';
  throw new Error(`Unsupported arch: ${process.arch}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(typeof result.status === 'number' ? result.status : 1);
  }
}

function runFinal(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(typeof result.status === 'number' ? result.status : 1);
}

function shouldPreparePlatformBootstrap(tauriArgs) {
  if (!tauriArgs.includes('build')) return false;
  const value = String(process.env.COCKPIT_PREPARE_PLATFORM_BOOTSTRAP || '1').trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'no';
}

function prepareBundledPlatformBootstrap(tauriArgs) {
  if (!shouldPreparePlatformBootstrap(tauriArgs)) return;

  const args = [
    'scripts/prepare-platform-bootstrap.cjs',
    '--from-source',
    '--targets',
    `${normalizeCurrentOs()}/${normalizeCurrentArch()}`,
  ];
  const platforms = String(process.env.COCKPIT_BUNDLED_PLATFORM_PACKAGES || '').trim();
  if (platforms) {
    args.push('--platforms', platforms);
  }
  run(process.execPath, args);
}

function runTauriDirect() {
  const tauriArgs = process.argv.slice(2);
  run('npm.cmd', ['run', 'sync-version'], { shell: process.platform === 'win32' });
  prepareBundledPlatformBootstrap(tauriArgs);
  runFinal('npx.cmd', ['tauri', ...tauriArgs], { shell: process.platform === 'win32' });
}

const tauriArgs = process.argv.slice(2);

if (process.platform !== 'win32') {
  run('npm', ['run', 'sync-version']);
  prepareBundledPlatformBootstrap(tauriArgs);
  runFinal('npx', ['tauri', ...tauriArgs]);
}

const vcvars64Path = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat';
const goBinPath = 'C:\\Program Files\\Go\\bin';

if (!fs.existsSync(vcvars64Path)) {
  console.warn('vcvars64.bat not found, falling back to the existing shell environment.');
  runTauriDirect();
}

const tempScriptPath = path.join(os.tmpdir(), `cockpit-tools-tauri-${process.pid}.cmd`);
const tauriCliPath = path.join(repoRoot, 'node_modules', '.bin', 'tauri.cmd');

if (!fs.existsSync(tauriCliPath)) {
  console.warn('Local tauri CLI not found, falling back to the existing shell environment.');
  runTauriDirect();
}

const quotedArgs = tauriArgs.map((arg) => {
  if (/[\s"]/u.test(arg)) {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return arg;
});
const scriptBody = [
  '@echo off',
  `set "PATH=${goBinPath};%PATH%"`,
  `call "${vcvars64Path}"`,
  'if errorlevel 1 exit /b %errorlevel%',
  'call npm.cmd run sync-version',
  'if errorlevel 1 exit /b %errorlevel%',
  `call "${tauriCliPath}" ${quotedArgs.join(' ')}`.trim(),
].join('\r\n');

fs.writeFileSync(tempScriptPath, scriptBody);

try {
  prepareBundledPlatformBootstrap(tauriArgs);
  runFinal('cmd.exe', ['/d', '/c', tempScriptPath]);
} finally {
  fs.rmSync(tempScriptPath, { force: true });
}
