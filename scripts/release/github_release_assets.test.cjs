const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { releaseAssets, assetPath, downloadAsset, uploadAsset } = require('./github_release_assets.cjs');

test('finds drafts in paginated releases and lists fresh assets by ID', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return calls.length === 1
      ? JSON.stringify([[{ id: 41, tag_name: 'v1.2.2' }], [{ id: 42, tag_name: 'v1.2.3', draft: true, assets: [] }]])
      : JSON.stringify([[{ id: 1, name: 'latest.json' }], [{ id: 2, name: 'app.dmg' }]]);
  };
  const result = releaseAssets('owner/repo', 'v1.2.3', run);
  assert.equal(result.assets.length, 2);
  assert.equal(result.release.draft, true);
  assert.deepEqual(calls[0], ['api', '--paginate', '--slurp', 'repos/owner/repo/releases?per_page=100']);
  assert.deepEqual(calls[1], ['api', '--paginate', '--slurp', 'repos/owner/repo/releases/42/assets?per_page=100']);
});

test('replaces only the named asset using its ID despite an empty tag asset list', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-assets-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'latest.json');
  fs.writeFileSync(file, '{}');
  const calls = [];
  uploadAsset('owner/repo', 'v1.2.3', file, (args) => {
    calls.push(args);
    if (calls.length === 1) return JSON.stringify([[{ id: 42, tag_name: 'v1.2.3', assets: [] }]]);
    if (calls.length === 2) return JSON.stringify([[{ id: 7, name: 'latest.json' }, { id: 8, name: 'app.dmg' }]]);
    return '';
  });
  assert.deepEqual(calls.slice(2), [
    ['api', '--method', 'DELETE', 'repos/owner/repo/releases/assets/7'],
    ['release', 'upload', 'v1.2.3', file, '--repo', 'owner/repo'],
  ]);
});

test('does not list assets when the requested release is absent', () => {
  let calls = 0;
  assert.throws(() => releaseAssets('owner/repo', 'v1.2.3', () => {
    calls += 1;
    return JSON.stringify([[{ id: 41, tag_name: 'v1.2.2' }]]);
  }), /Release not found: v1.2.3/);
  assert.equal(calls, 1);
});

test('does not touch remote assets when the replacement is missing', () => {
  assert.throws(() => uploadAsset('owner/repo', 'v1.2.3', '/missing-release-file', () => {
    assert.fail('No remote call should happen');
  }), /ENOENT/);
});

test('rejects asset filenames that escape the download directory', () => {
  for (const name of ['../latest.json', '..\\latest.json', '.', '..', '']) {
    assert.throws(() => assetPath('/tmp/releases', name), /Unsafe/);
  }
  assert.equal(assetPath('/tmp/releases', 'latest.json'), path.join('/tmp/releases', 'latest.json'));
});

test('downloads draft assets by authenticated ID and verifies bytes', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-assets-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const content = Buffer.from([0, 255, 1, 128]);
  const asset = { id: 7, name: 'app.zip', size: content.length,
    digest: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}` };
  const file = path.join(directory, asset.name);
  const download = (command, args, options) => {
    assert.equal(command, 'gh');
    assert.deepEqual(args, ['api', 'repos/owner/repo/releases/assets/7', '--header', 'Accept: application/octet-stream']);
    fs.writeSync(options.stdio[1], content);
  };
  await downloadAsset('owner/repo', asset, file, download);
  assert.deepEqual(fs.readFileSync(file), content);
  await assert.rejects(downloadAsset('owner/repo', { ...asset, size: 99 }, file, download), /checksum mismatch/);
  assert.equal(fs.existsSync(file), false);
  await assert.rejects(downloadAsset('owner/repo', { ...asset, digest: 'sha256:wrong' }, file, download), /checksum mismatch/);
  assert.equal(fs.existsSync(file), false);
});
