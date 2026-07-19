import { parse as parseYaml } from 'yaml';
import { assertSafeWorkspacePath } from './path-policy.js';
import type { SyncDirection, SyncManifest, SyncMapping } from './types.js';

const TOP_LEVEL_KEYS = new Set(['version', 'mappings']);
const MAPPING_KEYS = new Set(['id', 'direction', 'localPath', 'notionPageId']);

export function parseSyncManifest(input: string): SyncManifest {
  const raw: unknown = parseYaml(input);
  const root = requireRecord(raw, 'manifest');
  assertExactKeys(root, TOP_LEVEL_KEYS, 'manifest');
  if (root.version !== 1) throw new Error('Unsupported notion sync manifest version');
  if (!Array.isArray(root.mappings)) throw new Error('Manifest mappings must be an array');

  const mappings = root.mappings.map((value, index) => parseMapping(value, index));
  assertUnique(mappings, 'id');
  assertUnique(mappings, 'localPath');
  assertUnique(mappings, 'notionPageId');
  return { version: 1, mappings };
}

function parseMapping(value: unknown, index: number): SyncMapping {
  const raw = requireRecord(value, `mapping ${index}`);
  assertExactKeys(raw, MAPPING_KEYS, `mapping ${index}`);
  const id = requireNonEmptyString(raw.id, 'id');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id))
    throw new Error('Mapping id contains unsafe characters');
  const localPath = requireNonEmptyString(raw.localPath, 'localPath');
  const notionPageId = requireNonEmptyString(raw.notionPageId, 'notionPageId');
  const direction = parseDirection(raw.direction);
  assertSafeWorkspacePath(localPath, direction);
  return { id, direction, localPath, notionPageId };
}

function parseDirection(value: unknown): SyncDirection {
  if (value !== 'notion-to-local' && value !== 'local-to-notion') {
    throw new Error('Mapping direction must be notion-to-local or local-to-notion');
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: Set<string>,
  label: string
): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
}

function assertUnique(mappings: SyncMapping[], key: keyof SyncMapping): void {
  const seen = new Set<string>();
  for (const mapping of mappings) {
    const value = mapping[key];
    if (seen.has(value)) throw new Error(`Duplicate mapping ${key}: ${value}`);
    seen.add(value);
  }
}
