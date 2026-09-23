const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { releaseAssets, assetPath, uploadAsset } = require('./github_release_assets.cjs');

test('lists paginated assets by release ID when tag metadata is stale', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return calls.length === 1
      ? JSON.stringify({ id: 42, assets: [] })
      : JSON.stringify([[{ id: 1, name: 'latest.json' }], [{ id: 2, name: 'app.dmg' }]]);
  };
  const result = releaseAssets('owner/repo', 'v1.2.3', run);
  assert.equal(result.assets.length, 2);
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
    if (calls.length === 1) return JSON.stringify({ id: 42, assets: [] });
    if (calls.length === 2) return JSON.stringify([[{ id: 7, name: 'latest.json' }, { id: 8, name: 'app.dmg' }]]);
    return '';
  });
  assert.deepEqual(calls.slice(2), [
    ['api', '--method', 'DELETE', 'repos/owner/repo/releases/assets/7'],
    ['release', 'upload', 'v1.2.3', file, '--repo', 'owner/repo'],
  ]);
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
