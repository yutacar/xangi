#!/usr/bin/env node
import { createHash, createPublicKey, verify } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXACT_KEYS = ['arch', 'asset', 'platform', 'schemaVersion', 'signature', 'version'];
const ASSET_KEYS = ['sha256', 'size', 'url'];
const SHA256 = /^[a-f0-9]{64}$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SAFE_SUBSTITUTION = /^[A-Za-z0-9._~:/?&=%+\-]+$/;

function usage() {
  console.error(
    'Usage: build-installer.mjs --manifest FILE --artifact FILE --public-key FILE --manifest-url HTTPS_URL --installer-url HTTPS_URL --output FILE'
  );
}

function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid arguments');
    result[key.slice(2)] = value;
  }
  for (const key of [
    'manifest',
    'artifact',
    'public-key',
    'manifest-url',
    'installer-url',
    'output',
  ]) {
    if (!result[key]) throw new Error(`missing --${key}`);
  }
  return result;
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

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function httpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== 'https:' || !SAFE_SUBSTITUTION.test(value)) {
    throw new Error(`${label} must be a substitution-safe HTTPS URL`);
  }
  return value;
}

function validateManifest(manifest) {
  if (!exactKeys(manifest, EXACT_KEYS) || !exactKeys(manifest.asset, ASSET_KEYS))
    throw new Error('manifest schema mismatch');
  if (manifest.schemaVersion !== 1 || !['darwin', 'linux'].includes(manifest.platform)) {
    throw new Error('installer requires a darwin or linux schema v1 manifest');
  }
  if (!['arm64', 'x64'].includes(manifest.arch) || !SEMVER.test(manifest.version))
    throw new Error('invalid release identity');
  httpsUrl(manifest.asset.url, 'asset URL');
  if (
    !Number.isSafeInteger(manifest.asset.size) ||
    manifest.asset.size < 0 ||
    !SHA256.test(manifest.asset.sha256)
  )
    throw new Error('invalid asset integrity metadata');
  if (
    typeof manifest.signature !== 'string' ||
    Buffer.from(manifest.signature, 'base64').byteLength !== 64
  )
    throw new Error('invalid Ed25519 signature');
}

const parsed = args(process.argv.slice(2));
const manifestBytes = await readFile(resolve(parsed.manifest));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
validateManifest(manifest);
httpsUrl(parsed['manifest-url'], 'manifest URL');
httpsUrl(parsed['installer-url'], 'installer URL');

const { signature, ...unsigned } = manifest;
const publicKey = createPublicKey(await readFile(resolve(parsed['public-key']), 'utf8'));
if (
  publicKey.asymmetricKeyType !== 'ed25519' ||
  !verify(
    null,
    Buffer.from(JSON.stringify(canonical(unsigned))),
    publicKey,
    Buffer.from(signature, 'base64')
  )
) {
  throw new Error('manifest Ed25519 signature verification failed');
}

const artifact = await readFile(resolve(parsed.artifact));
const artifactHash = createHash('sha256').update(artifact).digest('hex');
if (artifact.byteLength !== manifest.asset.size || artifactHash !== manifest.asset.sha256) {
  throw new Error('artifact does not match the signed manifest');
}
const replacements = {
  MANIFEST_URL: parsed['manifest-url'],
  MANIFEST_SHA256: createHash('sha256').update(manifestBytes).digest('hex'),
  ASSET_URL: manifest.asset.url,
  ASSET_SHA256: manifest.asset.sha256,
  ASSET_SIZE: String(manifest.asset.size),
  RELEASE_VERSION: manifest.version,
  RELEASE_PLATFORM: manifest.platform,
  RELEASE_ARCH: manifest.arch,
  ARCHIVE_ROOT: `xangi-${manifest.version}-${manifest.platform}-${manifest.arch}`,
  PUBLIC_KEY_PEM: publicKey.export({ type: 'spki', format: 'pem' }).trimEnd(),
};
let installer = await readFile(resolve(HERE, 'install.sh'), 'utf8');
for (const [key, value] of Object.entries(replacements))
  installer = installer.replaceAll(`@${key}@`, value);
if (/@[A-Z_]+@/.test(installer)) throw new Error('installer template contains an unresolved token');

const output = resolve(parsed.output);
await writeFile(output, installer, { mode: 0o755 });
await chmod(output, 0o755);
const installerHash = createHash('sha256').update(installer).digest('hex');
const command = `tmp=\"$(mktemp)\" && curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 -o \"$tmp\" '${parsed['installer-url']}' && actual=\"$(if command -v shasum >/dev/null 2>&1; then shasum -a 256 \"$tmp\" | awk '{print $1}'; else sha256sum \"$tmp\" | awk '{print $1}'; fi)\" && [ \"$actual\" = '${installerHash}' ] && bash \"$tmp\"; status=$?; rm -f \"$tmp\"; exit $status`;
await writeFile(`${output}.command`, `${command}\n`, { mode: 0o644 });
console.log(output);
