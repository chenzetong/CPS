#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function decodeBase64(value) {
  const text = value.trim();
  const bytes = Buffer.from(text, 'base64');
  if (!text || bytes.toString('base64') !== text) {
    throw new Error('Invalid base64 in updater signing data');
  }
  return bytes;
}

// Tauri wraps the Minisign public key and signature text in base64.
// Match minisign-verify: verify both the artifact and the trusted comment.
function verifySignature(data, encodedSignature, encodedPublicKey) {
  const keyLines = decodeBase64(encodedPublicKey).toString('utf8').trimEnd().split(/\r?\n/);
  const lines = decodeBase64(encodedSignature).toString('utf8').trimEnd().split(/\r?\n/);
  if (keyLines.length !== 2 || lines.length !== 4 || !lines[2].startsWith('trusted comment: ')) {
    throw new Error('Invalid Minisign key or signature format');
  }
  const publicKey = decodeBase64(keyLines[1]);
  const signature = decodeBase64(lines[1]);
  const globalSignature = decodeBase64(lines[3]);
  if (publicKey.length !== 42 || publicKey.subarray(0, 2).toString() !== 'Ed' ||
      signature.length !== 74 || globalSignature.length !== 64) {
    throw new Error('Invalid Minisign key or signature size/algorithm');
  }
  if (!publicKey.subarray(2, 10).equals(signature.subarray(2, 10))) {
    throw new Error('Updater signing key ID does not match the configured public key');
  }
  const algorithm = signature.subarray(0, 2).toString();
  if (algorithm !== 'ED' && algorithm !== 'Ed') {
    throw new Error('Unsupported Minisign signature algorithm');
  }
  const key = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey.subarray(10)]),
    format: 'der',
    type: 'spki',
  });
  const message = algorithm === 'ED' ? crypto.createHash('blake2b512').update(data).digest() : data;
  if (!crypto.verify(null, message, key, signature.subarray(10))) {
    throw new Error('Updater artifact signature verification failed');
  }
  const comment = Buffer.concat([signature.subarray(10), Buffer.from(lines[2].slice(17))]);
  if (!crypto.verify(null, comment, key, globalSignature)) {
    throw new Error('Updater trusted comment signature verification failed');
  }
}

function verifyDirectory(assetsDir, encodedPublicKey) {
  const signatures = fs.readdirSync(assetsDir).filter((name) => name.endsWith('.sig')).sort();
  if (signatures.length === 0) throw new Error(`No updater signatures found in ${assetsDir}`);
  for (const name of signatures) {
    const artifact = path.join(assetsDir, name.slice(0, -4));
    try {
      verifySignature(fs.readFileSync(artifact), fs.readFileSync(`${artifact}.sig`, 'utf8'), encodedPublicKey);
    } catch (error) {
      throw new Error(`${path.basename(artifact)}: ${error.message}`);
    }
    console.log(`Verified updater signature: ${path.basename(artifact)}`);
  }
  return signatures.length;
}

if (require.main === module) {
  try {
    const assetsDir = process.argv[2];
    if (!assetsDir) throw new Error('Usage: verify_updater_signatures.cjs <assets-directory>');
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src-tauri/tauri.conf.json'), 'utf8'));
    verifyDirectory(assetsDir, config.plugins.updater.pubkey);
  } catch (error) {
    console.error(`[verify_updater_signatures] ${error.message}`);
    process.exit(1);
  }
}

module.exports = { verifySignature, verifyDirectory };
