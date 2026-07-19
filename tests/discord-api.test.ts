import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  discordApi,
  resolveHistoryChannelId,
  resolveChannelId,
  resolveLeaveUserId,
} from '../src/cli/discord-api.js';
import { ValidationError } from '../src/errors.js';

describe('resolveHistoryChannelId', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.XANGI_CHANNEL_ID;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.XANGI_CHANNEL_ID;
    } else {
      process.env.XANGI_CHANNEL_ID = savedEnv;
    }
  });

  // ─── 経路 1: bin/xangi-cmd 経由 (context が必ず付く) ─────────────────────

  it('uses context.channelId when xangi上で実行中 (bin/xangi-cmd 経由)', () => {
    // bin/xangi-cmd は XANGI_CHANNEL_ID を読んで context.channelId に詰めて
    // tool-server に POST する。tool-server は context を渡して discordApi を呼ぶ。
    process.env.XANGI_CHANNEL_ID = 'env-channel-leak'; // 親プロセスの env
    const result = resolveHistoryChannelId({}, { channelId: 'context-channel-actual' });
    expect(result).toBe('context-channel-actual');
  });

  it('does NOT fall back to env when context is provided but channelId missing', () => {
    // 「context: {}」で叩かれた場合、env が leak しないこと（誤投稿防止）
    process.env.XANGI_CHANNEL_ID = 'env-channel-leak';
    expect(() => resolveHistoryChannelId({}, {})).toThrow(ValidationError);
    expect(() => resolveHistoryChannelId({}, {})).toThrow(/channel が未指定/);
  });

  // ─── 経路 2: CLI 単体実行 (context が undefined) ────────────────────────

  it('falls back to env XANGI_CHANNEL_ID when context is undefined (CLI 単体実行)', () => {
    process.env.XANGI_CHANNEL_ID = 'cli-env-channel';
    const result = resolveHistoryChannelId({});
    expect(result).toBe('cli-env-channel');
  });

  it('throws when context is undefined and env is empty', () => {
    delete process.env.XANGI_CHANNEL_ID;
    expect(() => resolveHistoryChannelId({})).toThrow(ValidationError);
    expect(() => resolveHistoryChannelId({})).toThrow(/channel が未指定/);
  });

  // ─── 共通: --channel フラグは常に最優先 ─────────────────────────────────

  it('--channel flag takes precedence over both context and env', () => {
    process.env.XANGI_CHANNEL_ID = 'env-channel';
    const result = resolveHistoryChannelId(
      { channel: 'flag-channel' },
      { channelId: 'context-channel' }
    );
    expect(result).toBe('flag-channel');
  });

  it('--channel flag works without any context or env', () => {
    delete process.env.XANGI_CHANNEL_ID;
    const result = resolveHistoryChannelId({ channel: 'flag-only' });
    expect(result).toBe('flag-only');
  });
});

describe('resolveChannelId error label', () => {
  it('embeds the given command label in the missing-channel error', () => {
    delete process.env.XANGI_CHANNEL_ID;
    expect(() => resolveChannelId({}, {}, 'discord_thread_leave')).toThrow(
      /discord_thread_leave: channel が未指定/
    );
  });
});

describe('resolveLeaveUserId', () => {
  it('returns the --user value when provided', () => {
    expect(resolveLeaveUserId({ user: '111222333' })).toBe('111222333');
  });

  it('throws a discord_thread_leave-labelled error when --user is missing', () => {
    expect(() => resolveLeaveUserId({})).toThrow(/discord_thread_leave: user が未指定/);
    expect(() => resolveLeaveUserId({})).toThrow(ValidationError);
  });
});

describe('discord_message', () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.DISCORD_TOKEN;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.DISCORD_TOKEN;
    } else {
      process.env.DISCORD_TOKEN = originalToken;
    }
  });

  it('fetches one message and returns its content without the history 200-character truncation', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    const fullContent = '長文'.repeat(300);
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 'message-456',
          content: fullContent,
          author: { id: 'author-1', username: 'writer', discriminator: '0' },
          timestamp: '2026-07-18T21:30:00.000Z',
          attachments: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await discordApi(
      'discord_message',
      { channel: 'channel-123', 'message-id': 'message-456' },
      { channelId: 'context-channel' }
    );

    expect(result).toContain(fullContent);
    expect(result).toContain('(ID:message-456) writer:');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/channel-123/messages/message-456',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bot test-token' }),
      })
    );
  });

  it('requires --message-id before calling Discord', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      discordApi('discord_message', { channel: 'channel-123' }, { channelId: 'context-channel' })
    ).rejects.toThrow(/discord_message: message-id が未指定/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
