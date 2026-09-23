const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { verifySignature, verifyDirectory } = require('./verify_updater_signatures.cjs');

const encode = (text) => Buffer.from(text).toString('base64');
// Interoperability vectors from minisign-verify's MIT-licensed tests:
// https://github.com/jedisct1/rust-minisign-verify/blob/0.2.5/src/lib.rs
const publicKey = encode('untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n');
const signature = encode('untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n');
const legacySignature = encode('untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==\n');

test('accepts Minisign prehashed and legacy signatures', () => {
  verifySignature(Buffer.from('test'), signature, publicKey);
  verifySignature(Buffer.from('test'), legacySignature, publicKey);
});

test('rejects changed artifact bytes', () => {
  assert.throws(() => verifySignature(Buffer.from('Test'), signature, publicKey), /artifact signature/);
});

test('rejects a changed public key even when the key ID is unchanged', () => {
  const lines = Buffer.from(publicKey, 'base64').toString().trim().split('\n');
  const key = Buffer.from(lines[1], 'base64');
  key[30] ^= 1;
  lines[1] = key.toString('base64');
  assert.throws(() => verifySignature(Buffer.from('test'), signature, encode(lines.join('\n'))), /artifact signature/);
});

test('rejects a changed trusted comment', () => {
  const modified = encode(Buffer.from(signature, 'base64').toString().replace('file:test', 'file:other'));
  assert.throws(() => verifySignature(Buffer.from('test'), modified, publicKey), /trusted comment/);
});

test('rejects malformed encoding', () => {
  assert.throws(() => verifySignature(Buffer.from('test'), `${signature}!`, publicKey), /base64/);
  assert.throws(() => verifySignature(Buffer.from('test'), encode('invalid'), publicKey), /format/);
});

test('directory verification fails on missing or mismatched artifacts and empty input', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-signatures-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => verifyDirectory(dir, publicKey), /No updater signatures/);
  fs.writeFileSync(path.join(dir, 'test.sig'), signature);
  assert.throws(() => verifyDirectory(dir, publicKey), /test:.*ENOENT/);
  fs.writeFileSync(path.join(dir, 'test'), 'Test');
  assert.throws(() => verifyDirectory(dir, publicKey), /test:.*artifact signature/);
  fs.writeFileSync(path.join(dir, 'test'), 'test');
  assert.equal(verifyDirectory(dir, publicKey), 1);
});

test('configured CPS key authenticates an independently published release signature', () => {
  // v1.3.59 Apple Silicon signature: the global signature authenticates the
  // detached data signature and comment without storing a 50 MB app in tests.
  const config = require('../../src-tauri/tauri.conf.json');
  const keyBytes = Buffer.from(Buffer.from(config.plugins.updater.pubkey, 'base64').toString().trim().split('\n')[1], 'base64');
  const key = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), keyBytes.subarray(10)]),
    format: 'der', type: 'spki',
  });
  const dataSignature = Buffer.from('RUSstoQQvxRIHvU9H8f3IHhXrZH5jFPKrqvSk+QFPJnHc3UQA0WMKQyM8OlT4pNKkZJ7CPyycT8ED7o3hZ45uH1P4OfeeULIFw8=', 'base64');
  const comment = Buffer.from('timestamp:1790156746\tfile:CPS.app.tar.gz');
  assert.equal(crypto.verify(null, Buffer.concat([dataSignature.subarray(10), comment]), key,
    Buffer.from('NAO4vRFsxQhbvdfozG+Ybx5t2VuDbPyU3uTShpYzlL/fN/zS05c+1ouQt4tcFDAArQsRlSdgDdBWji8eaBMICg==', 'base64')), true);
});
