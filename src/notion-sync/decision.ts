import type { SyncAction, SyncDirection } from './types.js';

export interface SyncDecisionInput {
  direction: SyncDirection;
  baseHash?: string;
  localHash?: string;
  notionHash?: string;
}

export function decideSync(input: SyncDecisionInput): SyncAction {
  const { baseHash, localHash, notionHash } = input;
  if (baseHash === undefined) {
    if (localHash !== undefined && notionHash !== undefined)
      return localHash === notionHash ? 'noop' : 'conflict';
    if (input.direction === 'notion-to-local' && notionHash !== undefined) return 'pull';
    if (input.direction === 'local-to-notion' && localHash !== undefined) return 'push';
    return 'noop';
  }

  const destinationHash = input.direction === 'notion-to-local' ? localHash : notionHash;
  const sourceHash = input.direction === 'notion-to-local' ? notionHash : localHash;
  if (destinationHash !== baseHash) return 'conflict';
  if (sourceHash === undefined || sourceHash === baseHash) return 'noop';
  return input.direction === 'notion-to-local' ? 'pull' : 'push';
}
