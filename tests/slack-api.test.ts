import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { slackApi } from '../src/cli/slack-api.js';

const originalFetch = globalThis.fetch;
const originalToken = process.env.SLACK_BOT_TOKEN;
const originalChannel = process.env.XANGI_CHANNEL_ID;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('slackApi', () => {
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    delete process.env.XANGI_CHANNEL_ID;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.SLACK_BOT_TOKEN;
    } else {
      process.env.SLACK_BOT_TOKEN = originalToken;
    }
    if (originalChannel === undefined) {
      delete process.env.XANGI_CHANNEL_ID;
    } else {
      process.env.XANGI_CHANNEL_ID = originalChannel;
    }
    vi.restoreAllMocks();
  });

  it('slack_send posts JSON to chat.postMessage', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, channel: 'C123', ts: '1.0001' }));
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await slackApi('slack_send', {
      channel: 'C123',
      message: 'hello',
      'thread-ts': '1.0000',
    });

    expect(result).toContain('ts: 1.0001');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://slack.com/api/chat.postMessage');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer xoxb-test-token',
      'Content-Type': 'application/json; charset=utf-8',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      channel: 'C123',
      text: 'hello',
      thread_ts: '1.0000',
    });
  });

  it('slack_send can resolve current channel from context', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, ts: '2.0001' }));
    globalThis.fetch = fetchMock as typeof fetch;

    await slackApi('slack_send', { message: 'hello' }, { channelId: 'CCTX' });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({ channel: 'CCTX' });
  });

  it('slack_channels lists conversations with default types', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        channels: [
          { id: 'C1', name: 'general', is_private: false },
          { id: 'G1', name: 'private-dev', is_private: true },
        ],
      })
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await slackApi('slack_channels', {});

    expect(result).toContain('#general (C1, public)');
    expect(result).toContain('#private-dev (G1, private)');
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/api/conversations.list');
    expect(parsed.searchParams.get('types')).toBe('public_channel,private_channel');
    expect(parsed.searchParams.get('limit')).toBe('100');
  });

  it('slack_search filters conversations.history messages', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        messages: [
          { ts: '1719876543.000100', user: 'U1', text: 'PR ready' },
          { ts: '1719876544.000100', user: 'U2', text: 'other' },
        ],
      })
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await slackApi('slack_search', { channel: 'C123', keyword: 'pr' });

    expect(result).toContain('PR ready');
    expect(result).not.toContain('other');
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/api/conversations.history');
    expect(parsed.searchParams.get('channel')).toBe('C123');
    expect(parsed.searchParams.get('limit')).toBe('15');
  });

  it('slack_edit accepts message-id alias for ts', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    globalThis.fetch = fetchMock as typeof fetch;

    await slackApi('slack_edit', {
      channel: 'C123',
      'message-id': '1719876543.000100',
      content: 'updated',
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      channel: 'C123',
      ts: '1719876543.000100',
      text: 'updated',
    });
  });

  it('slack_delete calls chat.delete', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await slackApi('slack_delete', {
      channel: 'C123',
      'message-ts': '1719876543.000100',
    });

    expect(result).toContain('削除しました');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://slack.com/api/chat.delete');
    expect(JSON.parse(String(init?.body))).toEqual({
      channel: 'C123',
      ts: '1719876543.000100',
    });
  });

  it('throws ValidationError when channel is missing outside context', async () => {
    await expect(slackApi('slack_send', { message: 'hello' })).rejects.toThrow(
      'channel が未指定'
    );
  });

  it('throws Slack API errors', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: false, error: 'missing_scope' }));

    await expect(slackApi('slack_channels', {})).rejects.toThrow('missing_scope');
  });
});
