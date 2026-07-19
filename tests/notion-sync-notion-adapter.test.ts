import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { NOTION_API_VERSION, NotionMarkdownAdapter } from '../src/notion-sync/notion-adapter.js';

const pageId = '3c90c3cc-0d44-4b50-8888-8dd25736052a';
const token = 'secret-token-that-must-not-leak';

function markdownResponse(markdown = '# Hello', headers?: HeadersInit, id = pageId): Response {
  return Response.json(
    {
      object: 'page_markdown',
      id,
      markdown,
      truncated: false,
      unknown_block_ids: [],
    },
    { headers }
  );
}

describe('NotionMarkdownAdapter', () => {
  it('reads Markdown with the pinned API version and returns a SHA-256 snapshot', async () => {
    const fetchFixture = vi.fn<typeof fetch>().mockResolvedValue(
      markdownResponse('# Hello', {
        'last-modified': 'Wed, 15 Jul 2026 00:00:00 GMT',
      })
    );
    const adapter = new NotionMarkdownAdapter({ token, fetch: fetchFixture, minimumIntervalMs: 0 });

    const snapshot = await adapter.read(pageId);

    expect(fetchFixture).toHaveBeenCalledOnce();
    const [url, init] = fetchFixture.mock.calls[0]!;
    expect(url).toBe(`https://api.notion.com/v1/pages/${pageId}/markdown`);
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
    expect(new Headers(init?.headers).get('Notion-Version')).toBe(NOTION_API_VERSION);
    expect(snapshot).toEqual({
      markdown: '# Hello',
      hash: createHash('sha256').update('# Hello').digest('hex'),
      editedTime: 'Wed, 15 Jul 2026 00:00:00 GMT',
    });
  });

  it('replaces the full page content using the Markdown endpoint', async () => {
    const fetchFixture = vi.fn<typeof fetch>().mockResolvedValue(markdownResponse('replacement'));
    const adapter = new NotionMarkdownAdapter({ token, fetch: fetchFixture, minimumIntervalMs: 0 });

    const snapshot = await adapter.write(pageId, 'replacement');

    const [, init] = fetchFixture.mock.calls[0]!;
    expect(init?.method).toBe('PATCH');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({
      type: 'replace_content',
      replace_content: { new_str: 'replacement' },
    });
    expect(snapshot.markdown).toBe('replacement');
  });

  it('creates a child page with a title and Markdown body', async () => {
    const fetchFixture = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ object: 'page', id: 'created-page' }));
    const adapter = new NotionMarkdownAdapter({ token, fetch: fetchFixture, minimumIntervalMs: 0 });

    await expect(adapter.createPage(pageId, 'Profile', '# Hello')).resolves.toBe('created-page');

    const [url, init] = fetchFixture.mock.calls[0]!;
    expect(url).toBe('https://api.notion.com/v1/pages');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      parent: { page_id: pageId },
      markdown: '# Hello',
    });
  });

  it('maps a missing page to undefined for reads', async () => {
    const fetchFixture = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 }));
    const adapter = new NotionMarkdownAdapter({ token, fetch: fetchFixture, minimumIntervalMs: 0 });
    await expect(adapter.read(pageId)).resolves.toBeUndefined();
  });

  it.each([
    { object: 'page', id: pageId, markdown: '# text', truncated: false, unknown_block_ids: [] },
    {
      object: 'page_markdown',
      id: pageId,
      markdown: '# text',
      truncated: false,
      unknown_block_ids: [],
      extra: true,
    },
    {
      object: 'page_markdown',
      id: pageId,
      markdown: '# partial',
      truncated: true,
      unknown_block_ids: ['block-id'],
    },
  ])('rejects malformed or incomplete successful responses', async (body) => {
    const adapter = new NotionMarkdownAdapter({
      token,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)),
      minimumIntervalMs: 0,
    });
    await expect(adapter.read(pageId)).rejects.toThrow(
      /invalid Markdown response|truncated Markdown content/
    );
  });

  it('serializes concurrent requests and keeps starts at most two per second', async () => {
    let clock = 1_000;
    const starts: number[] = [];
    const sleeps: number[] = [];
    const fetchFixture = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      starts.push(clock);
      const id = decodeURIComponent(new URL(String(input)).pathname.split('/').at(-2)!);
      return markdownResponse('# Hello', undefined, id);
    });
    const adapter = new NotionMarkdownAdapter({
      token,
      fetch: fetchFixture,
      now: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
    });

    await Promise.all([adapter.read('page-1'), adapter.read('page-2'), adapter.read('page-3')]);

    expect(starts).toEqual([1_000, 1_500, 2_000]);
    expect(sleeps).toEqual([500, 500]);
  });

  it('honors Retry-After before retrying a 429 response', async () => {
    let clock = 5_000;
    const starts: number[] = [];
    const sleeps: number[] = [];
    const fetchFixture = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        starts.push(clock);
        return new Response('', { status: 429, headers: { 'retry-after': '2' } });
      })
      .mockImplementationOnce(async () => {
        starts.push(clock);
        return markdownResponse();
      });
    const adapter = new NotionMarkdownAdapter({
      token,
      fetch: fetchFixture,
      now: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
    });

    await adapter.read(pageId);

    expect(starts).toEqual([5_000, 7_000]);
    expect(sleeps).toEqual([2_000]);
  });

  it('never exposes the token or response body through errors', async () => {
    const responseBody = `upstream diagnostic included ${token}`;
    const adapter = new NotionMarkdownAdapter({
      token,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(responseBody, { status: 401 })),
      minimumIntervalMs: 0,
    });

    let message = '';
    try {
      await adapter.read(pageId);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('status 401');
    expect(message).not.toContain(token);
    expect(message).not.toContain(responseBody);
    expect(JSON.stringify(adapter)).not.toContain(token);
  });

  it('redacts injected transport errors that may contain request secrets', async () => {
    const adapter = new NotionMarkdownAdapter({
      token,
      fetch: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error(`network failed for Bearer ${token}`)),
      minimumIntervalMs: 0,
    });
    await expect(adapter.read(pageId)).rejects.toThrow(/^Notion API request failed$/);
  });

  it('aborts a request that exceeds the configured timeout', async () => {
    const fetchFixture = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return markdownResponse();
    });
    const adapter = new NotionMarkdownAdapter({
      token,
      fetch: fetchFixture,
      minimumIntervalMs: 0,
      requestTimeoutMs: 10,
    });

    await expect(adapter.read(pageId)).rejects.toThrow(/^Notion API request failed$/);
    expect(fetchFixture.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it('rejects a successful response for a different page', async () => {
    const adapter = new NotionMarkdownAdapter({
      token,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(markdownResponse('# other', undefined, 'different-page')),
      minimumIntervalMs: 0,
    });

    await expect(adapter.read(pageId)).rejects.toThrow(/mismatched page ID/);
  });
});
