#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid arguments');
    parsed[key.slice(2)] = value;
  }
  for (const key of [
    'version',
    'platform',
    'arch',
    'artifact',
    'asset-url',
    'private-key',
    'manifest-output',
    'public-key-output',
  ]) {
    if (!parsed[key]) throw new Error(`missing --${key}`);
  }
  return parsed;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  );
}

function validateHttps(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use HTTPS`);
}

const args = parseArgs(process.argv.slice(2));
if (!SEMVER.test(args.version))
  throw new Error('--version must be valid SemVer without a v prefix');
if (!['darwin', 'linux'].includes(args.platform)) {
  throw new Error('--platform must be darwin or linux');
}
if (!['arm64', 'x64'].includes(args.arch)) throw new Error('--arch must be arm64 or x64');
validateHttps(args['asset-url'], '--asset-url');

const artifact = await readFile(resolve(args.artifact));
const privateKey = createPrivateKey(await readFile(resolve(args['private-key']), 'utf8'));
if (privateKey.asymmetricKeyType !== 'ed25519') {
  throw new Error('--private-key must contain an Ed25519 private key');
}
const publicKey = createPublicKey(privateKey);
const unsigned = {
  schemaVersion: 1,
  version: args.version,
  platform: args.platform,
  arch: args.arch,
  asset: {
    url: args['asset-url'],
    size: artifact.byteLength,
    sha256: createHash('sha256').update(artifact).digest('hex'),
  },
};
const signature = sign(null, Buffer.from(JSON.stringify(canonical(unsigned))), privateKey).toString(
  'base64'
);

const manifestOutput = resolve(args['manifest-output']);
const publicKeyOutput = resolve(args['public-key-output']);
await writeFile(manifestOutput, `${JSON.stringify({ ...unsigned, signature }, null, 2)}\n`, {
  mode: 0o644,
});
await writeFile(
  publicKeyOutput,
  `${publicKey.export({ type: 'spki', format: 'pem' }).trimEnd()}\n`,
  { mode: 0o644 }
);
await chmod(manifestOutput, 0o644);
await chmod(publicKeyOutput, 0o644);
console.log(manifestOutput);
