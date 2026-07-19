import { decideSync } from './decision.js';
import { assertSafeWorkspacePath } from './path-policy.js';
import type {
  DocumentSnapshot,
  MappingState,
  MappingStateUpdate,
  NotionPort,
  SyncAction,
  SyncMapping,
  SyncStatePort,
  WorkspacePort,
} from './types.js';

export interface SyncResult {
  mappingId: string;
  action: SyncAction;
}

export class SyncEngine {
  constructor(
    private readonly workspace: WorkspacePort,
    private readonly notion: NotionPort,
    private readonly state: SyncStatePort
  ) {}

  async sync(mapping: SyncMapping): Promise<SyncResult> {
    assertSafeWorkspacePath(mapping.localPath, mapping.direction);
    const previous = await this.state.load(mapping);
    const [local, notion] = await Promise.all([
      this.workspace.read(mapping.localPath),
      this.notion.read(mapping.notionPageId),
    ]);
    if (mapping.direction === 'notion-to-local' && notion === undefined) {
      throw new Error('Notion source document is unavailable');
    }
    if (mapping.direction === 'local-to-notion' && local === undefined) {
      throw new Error('Local source document is unavailable');
    }
    const action = decideSync({
      direction: mapping.direction,
      baseHash: previous?.baseHash,
      localHash: local?.hash,
      notionHash: notion?.hash,
    });

    if (action === 'conflict') {
      await this.state.save(mapping, conflictState(previous, local, notion));
    } else if (action === 'pull') {
      if (notion === undefined) throw new Error('Notion source document is unavailable');
      if (local !== undefined) {
        await this.workspace.backup(mapping.localPath, local.markdown);
      }
      const written = await this.workspace.write(mapping.localPath, notion.markdown);
      assertMatchingHash(notion, written);
      await this.state.save(mapping, syncedState(notion.hash, written.hash, notion.editedTime));
    } else if (action === 'push') {
      if (local === undefined) throw new Error('Local source document is unavailable');
      const written = await this.notion.write(mapping.notionPageId, local.markdown);
      assertMatchingHash(local, written);
      await this.state.save(mapping, syncedState(local.hash, local.hash, written.editedTime));
    } else if (previous === undefined && local !== undefined && notion !== undefined) {
      await this.state.save(mapping, syncedState(local.hash, local.hash, notion.editedTime));
    } else if (
      previous?.status === 'conflict' &&
      previous.baseHash !== '' &&
      local?.hash === previous.baseHash &&
      notion?.hash === previous.baseHash
    ) {
      await this.state.save(mapping, syncedState(previous.baseHash, local.hash, notion.editedTime));
    }

    return { mappingId: mapping.id, action };
  }
}

function syncedState(
  baseHash: string,
  localHash: string,
  notionEditedTime: string
): MappingStateUpdate {
  return {
    baseHash,
    lastLocalHash: localHash,
    lastNotionEditedTime: notionEditedTime,
    status: 'synced',
  };
}

function conflictState(
  previous: MappingState | undefined,
  local: DocumentSnapshot | undefined,
  notion: DocumentSnapshot | undefined
): MappingStateUpdate {
  return {
    baseHash: previous?.baseHash ?? '',
    lastLocalHash: local?.hash ?? '',
    lastNotionEditedTime: notion?.editedTime ?? previous?.lastNotionEditedTime ?? '',
    status: 'conflict',
  };
}

function assertMatchingHash(source: DocumentSnapshot, written: DocumentSnapshot): void {
  if (source.hash !== written.hash)
    throw new Error('Synchronized document hash changed during write');
}
