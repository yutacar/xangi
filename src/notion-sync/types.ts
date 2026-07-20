export type SyncDirection = 'notion-to-local' | 'local-to-notion';
export type SyncAction = 'noop' | 'pull' | 'push' | 'conflict';
export type SyncStatus = 'synced' | 'conflict' | 'error';

export interface SyncMapping {
  id: string;
  direction: SyncDirection;
  localPath: string;
  notionPageId: string;
}

export interface SyncManifest {
  version: 1;
  mappings: SyncMapping[];
}

export interface MappingState {
  mappingId: string;
  localPath: string;
  notionPageId: string;
  direction: SyncDirection;
  baseHash: string;
  lastLocalHash: string;
  lastNotionEditedTime: string;
  status: SyncStatus;
}

export interface MappingStateUpdate {
  baseHash: string;
  lastLocalHash: string;
  lastNotionEditedTime: string;
  status: SyncStatus;
}

export interface DocumentSnapshot {
  markdown: string;
  hash: string;
  editedTime: string;
}

export interface WorkspacePort {
  read(relativePath: string): Promise<DocumentSnapshot | undefined>;
  backup(relativePath: string, markdown: string): Promise<void>;
  write(relativePath: string, markdown: string): Promise<DocumentSnapshot>;
}

export interface NotionPort {
  read(pageId: string): Promise<DocumentSnapshot | undefined>;
  write(pageId: string, markdown: string): Promise<DocumentSnapshot>;
}

export interface WorkspaceMirrorNotionPort {
  createPage(parentPageId: string, title: string, markdown: string): Promise<string>;
  write(pageId: string, markdown: string): Promise<DocumentSnapshot>;
}

export interface SyncStatePort {
  load(mapping: SyncMapping): Promise<MappingState | undefined>;
  save(mapping: SyncMapping, update: MappingStateUpdate): Promise<void>;
}
