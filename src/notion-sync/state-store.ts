import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  MappingState,
  MappingStateUpdate,
  SyncDirection,
  SyncMapping,
  SyncStatus,
} from './types.js';

interface StateFile {
  schemaVersion: 1;
  records: Record<string, MappingState>;
}

const ROOT_KEYS = new Set(['schemaVersion', 'records']);
const RECORD_KEYS = new Set([
  'mappingId',
  'localPath',
  'notionPageId',
  'direction',
  'baseHash',
  'lastLocalHash',
  'lastNotionEditedTime',
  'status',
]);

export class SyncStateStore {
  readonly statePath: string;

  constructor(dataDir: string) {
    this.statePath = join(dataDir, 'notion-sync', 'state.json');
  }

  async load(mapping: SyncMapping): Promise<MappingState | undefined> {
    const file = await this.readStateFile();
    if (!Object.hasOwn(file.records, mapping.id)) return undefined;
    const state = file.records[mapping.id];
    if (
      state.mappingId !== mapping.id ||
      state.localPath !== mapping.localPath ||
      state.notionPageId !== mapping.notionPageId ||
      state.direction !== mapping.direction
    )
      throw new Error(`State identity mismatch for mapping ${mapping.id}`);
    return state;
  }

  async save(mapping: SyncMapping, update: MappingStateUpdate): Promise<void> {
    const file = await this.readStateFile();
    file.records[mapping.id] = {
      mappingId: mapping.id,
      localPath: mapping.localPath,
      notionPageId: mapping.notionPageId,
      direction: mapping.direction,
      ...update,
    };
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporaryPath, this.statePath);
    await chmod(this.statePath, 0o600);
  }

  private async readStateFile(): Promise<StateFile> {
    let text: string;
    try {
      text = await readFile(this.statePath, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { schemaVersion: 1, records: Object.create(null) as Record<string, MappingState> };
      }
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error('Invalid notion sync state JSON');
    }
    return parseStateFile(value);
  }
}

function parseStateFile(value: unknown): StateFile {
  const root = requireRecord(value, 'state');
  assertExactKeys(root, ROOT_KEYS, 'state');
  if (root.schemaVersion !== 1) throw new Error('Unsupported notion sync state schema');
  const recordsRaw = requireRecord(root.records, 'state records');
  const records = Object.create(null) as Record<string, MappingState>;
  for (const [key, record] of Object.entries(recordsRaw)) {
    records[key] = parseMappingState(record, key);
    if (records[key].mappingId !== key)
      throw new Error(`State identity mismatch for mapping ${key}`);
  }
  return { schemaVersion: 1, records };
}

function parseMappingState(value: unknown, key: string): MappingState {
  const raw = requireRecord(value, `state record ${key}`);
  assertExactKeys(raw, RECORD_KEYS, `state record ${key}`);
  return {
    mappingId: stringField(raw.mappingId, 'mappingId'),
    localPath: stringField(raw.localPath, 'localPath'),
    notionPageId: stringField(raw.notionPageId, 'notionPageId'),
    direction: directionField(raw.direction),
    baseHash: stringField(raw.baseHash, 'baseHash'),
    lastLocalHash: stringField(raw.lastLocalHash, 'lastLocalHash'),
    lastNotionEditedTime: stringField(raw.lastNotionEditedTime, 'lastNotionEditedTime'),
    status: statusField(raw.status),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: Set<string>,
  label: string
): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key)))
    throw new Error(`Invalid ${label} fields`);
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid state ${label}`);
  return value;
}

function directionField(value: unknown): SyncDirection {
  if (value !== 'notion-to-local' && value !== 'local-to-notion')
    throw new Error('Invalid state direction');
  return value;
}

function statusField(value: unknown): SyncStatus {
  if (value !== 'synced' && value !== 'conflict' && value !== 'error')
    throw new Error('Invalid state status');
  return value;
}
