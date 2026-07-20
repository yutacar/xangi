import { describe, expect, it } from 'vitest';
import { decideSync } from '../src/notion-sync/decision.js';

describe('decideSync', () => {
  it.each([
    [{ direction: 'notion-to-local', notionHash: 'a' }, 'pull'],
    [{ direction: 'local-to-notion', localHash: 'a' }, 'push'],
    [{ direction: 'notion-to-local', localHash: 'a', notionHash: 'a' }, 'noop'],
    [{ direction: 'notion-to-local', localHash: 'a', notionHash: 'b' }, 'conflict'],
  ] as const)('classifies bootstrap %#', (input, expected) => {
    expect(decideSync(input)).toBe(expected);
  });

  it.each([
    [{ direction: 'notion-to-local', baseHash: 'a', localHash: 'a', notionHash: 'b' }, 'pull'],
    [{ direction: 'local-to-notion', baseHash: 'a', localHash: 'b', notionHash: 'a' }, 'push'],
    [{ direction: 'notion-to-local', baseHash: 'a', localHash: 'a', notionHash: 'a' }, 'noop'],
    [{ direction: 'local-to-notion', baseHash: 'a', localHash: 'a', notionHash: 'a' }, 'noop'],
    [{ direction: 'notion-to-local', baseHash: 'a', localHash: 'local-edit', notionHash: 'a' }, 'conflict'],
    [{ direction: 'notion-to-local', baseHash: 'a', localHash: 'local-edit', notionHash: 'notion-edit' }, 'conflict'],
    [{ direction: 'local-to-notion', baseHash: 'a', localHash: 'a', notionHash: 'notion-edit' }, 'conflict'],
  ] as const)('classifies subsequent sync %#', (input, expected) => {
    expect(decideSync(input)).toBe(expected);
  });
});
