const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function releaseAssets(repo, tag, run = gh) {
  const release = JSON.parse(run(['api', `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`]));
  // The tag endpoint can return a stale embedded assets array. Always list by ID.
  const assets = JSON.parse(run([
    'api', '--paginate', '--slurp', `repos/${repo}/releases/${release.id}/assets?per_page=100`,
  ])).flat();
  return { release, assets };
}

function assetPath(directory, name) {
  if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) {
    throw new Error(`Unsafe release asset filename: ${name}`);
  }
  return path.join(directory, name);
}

async function downloadAssets(repo, tag, directory) {
  const { assets } = releaseAssets(repo, tag);
  if (!assets.length) throw new Error(`No release assets found for ${tag}`);
  fs.mkdirSync(directory, { recursive: true });
  for (const asset of assets) {
    const destination = assetPath(directory, asset.name);
    execFileSync('curl', [
      '--fail', '--location', '--silent', '--show-error', '--retry', '3',
      '--max-time', '180', '--output', destination, asset.browser_download_url,
    ], { stdio: 'inherit' });
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(destination)) hash.update(chunk);
    if (fs.statSync(destination).size !== asset.size ||
        asset.digest !== `sha256:${hash.digest('hex')}`) {
      fs.unlinkSync(destination);
      throw new Error(`Release asset checksum mismatch: ${asset.name}`);
    }
  }
  console.log(`Downloaded and verified ${assets.length} assets for ${tag}`);
}

function uploadAsset(repo, tag, file, run = gh) {
  // Check the replacement before deleting the existing asset.
  fs.accessSync(file, fs.constants.R_OK);
  const { assets } = releaseAssets(repo, tag, run);
  const existing = assets.find((asset) => asset.name === path.basename(file));
  if (existing) run(['api', '--method', 'DELETE', `repos/${repo}/releases/assets/${existing.id}`]);
  run(['release', 'upload', tag, file, '--repo', repo]);
}

if (require.main === module) {
  const [command, repo, tag, ...files] = process.argv.slice(2);
  Promise.resolve().then(async () => {
    if (!repo || !tag || !files.length || !['download', 'upload'].includes(command)) {
      throw new Error('Usage: github_release_assets.cjs download|upload <repo> <tag> <directory|files...>');
    }
    if (command === 'download') await downloadAssets(repo, tag, files[0]);
    else for (const file of files) uploadAsset(repo, tag, file);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { releaseAssets, assetPath, uploadAsset };
