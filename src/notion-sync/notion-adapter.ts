import { createHash } from 'node:crypto';
import type { DocumentSnapshot, NotionPort, WorkspaceMirrorNotionPort } from './types.js';

const NOTION_API_VERSION = '2026-03-11';
const DEFAULT_API_BASE_URL = 'https://api.notion.com';
const DEFAULT_MINIMUM_INTERVAL_MS = 500;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_KEYS = new Set(['object', 'id', 'markdown', 'truncated', 'unknown_block_ids']);

type Fetch = typeof fetch;

export interface NotionMarkdownAdapterOptions {
  token: string;
  fetch?: Fetch;
  apiBaseUrl?: string;
  minimumIntervalMs?: number;
  maxRetries?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface PageMarkdownResponse {
  id: string;
  markdown: string;
}

/**
 * A narrow Notion port for the 2026-03-11 page Markdown API.
 *
 * Requests are serialized so that concurrent sync mappings cannot bypass the
 * client-side rate limit. Error details deliberately exclude request headers,
 * response bodies, page IDs, and the integration token.
 */
export class NotionMarkdownAdapter implements NotionPort, WorkspaceMirrorNotionPort {
  readonly #token: string;
  private readonly fetchImpl: Fetch;
  private readonly apiBaseUrl: string;
  private readonly minimumIntervalMs: number;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private lastRequestStartedAt: number | undefined;

  constructor(options: NotionMarkdownAdapterOptions) {
    if (options.token.trim() === '') throw new Error('Notion integration token is required');
    if (options.minimumIntervalMs !== undefined && options.minimumIntervalMs < 0) {
      throw new Error('Notion request interval must be non-negative');
    }
    if (
      options.maxRetries !== undefined &&
      (!Number.isInteger(options.maxRetries) || options.maxRetries < 0)
    ) {
      throw new Error('Notion retry count must be a non-negative integer');
    }
    if (
      options.requestTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)
    ) {
      throw new Error('Notion request timeout must be a positive integer');
    }

    this.#token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, '');
    this.minimumIntervalMs = options.minimumIntervalMs ?? DEFAULT_MINIMUM_INTERVAL_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async read(pageId: string): Promise<DocumentSnapshot | undefined> {
    requirePageId(pageId);
    return this.enqueue(async () => {
      const response = await this.requestWithRetry(
        `/v1/pages/${encodeURIComponent(pageId)}/markdown`,
        { method: 'GET' }
      );
      if (response.status === 404) return undefined;
      await assertSuccessful(response);
      return toSnapshot(await parsePageMarkdownResponse(response, pageId), response);
    });
  }

  async write(pageId: string, markdown: string): Promise<DocumentSnapshot> {
    requirePageId(pageId);
    return this.enqueue(async () => {
      const response = await this.requestWithRetry(
        `/v1/pages/${encodeURIComponent(pageId)}/markdown`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            type: 'replace_content',
            replace_content: { new_str: markdown },
          }),
        }
      );
      await assertSuccessful(response);
      return toSnapshot(await parsePageMarkdownResponse(response, pageId), response);
    });
  }

  async createPage(parentPageId: string, title: string, markdown: string): Promise<string> {
    requirePageId(parentPageId);
    if (title.trim() === '') throw new Error('Notion page title is required');
    return this.enqueue(async () => {
      const response = await this.requestWithRetry('/v1/pages', {
        method: 'POST',
        body: JSON.stringify({
          parent: { page_id: parentPageId },
          properties: {
            title: {
              type: 'title',
              title: [{ type: 'text', text: { content: title } }],
            },
          },
          ...(markdown === '' ? {} : { markdown }),
        }),
      });
      await assertSuccessful(response);
      return parseCreatedPageId(response);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async requestWithRetry(
    path: string,
    init: { method: 'GET' | 'PATCH' | 'POST'; body?: string }
  ): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      await this.waitForRequestSlot();
      let response: Response;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
          method: init.method,
          headers: {
            Authorization: `Bearer ${this.#token}`,
            'Notion-Version': NOTION_API_VERSION,
            ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: init.body,
          signal: controller.signal,
        });
      } catch {
        throw new Error('Notion API request failed');
      } finally {
        clearTimeout(timeout);
      }

      if (response.status !== 429 || attempt >= this.maxRetries) return response;
      await this.sleep(retryAfterMilliseconds(response.headers.get('retry-after'), this.now()));
    }
  }

  private async waitForRequestSlot(): Promise<void> {
    if (this.lastRequestStartedAt !== undefined) {
      const remaining = this.minimumIntervalMs - (this.now() - this.lastRequestStartedAt);
      if (remaining > 0) await this.sleep(remaining);
    }
    this.lastRequestStartedAt = this.now();
  }
}

async function parseCreatedPageId(response: Response): Promise<string> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error('Notion API returned an invalid page response');
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).object !== 'page' ||
    typeof (value as Record<string, unknown>).id !== 'string' ||
    (value as Record<string, unknown>).id === ''
  ) {
    throw new Error('Notion API returned an invalid page response');
  }
  return (value as Record<string, string>).id;
}

function requirePageId(pageId: string): void {
  if (pageId.trim() === '') throw new Error('Notion page ID is required');
}

async function assertSuccessful(response: Response): Promise<void> {
  if (!response.ok) throw new Error(`Notion API request failed with status ${response.status}`);
}

async function parsePageMarkdownResponse(
  response: Response,
  expectedPageId: string
): Promise<PageMarkdownResponse> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error('Notion API returned an invalid Markdown response');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Notion API returned an invalid Markdown response');
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== RESPONSE_KEYS.size || keys.some((key) => !RESPONSE_KEYS.has(key))) {
    throw new Error('Notion API returned an invalid Markdown response');
  }
  if (
    record.object !== 'page_markdown' ||
    typeof record.id !== 'string' ||
    record.id === '' ||
    typeof record.markdown !== 'string' ||
    typeof record.truncated !== 'boolean' ||
    !Array.isArray(record.unknown_block_ids) ||
    record.unknown_block_ids.some((id) => typeof id !== 'string' || id === '')
  ) {
    throw new Error('Notion API returned an invalid Markdown response');
  }
  if (record.truncated || record.unknown_block_ids.length > 0) {
    throw new Error('Notion API returned truncated Markdown content');
  }
  if (normalizePageId(record.id) !== normalizePageId(expectedPageId)) {
    throw new Error('Notion API returned a mismatched page ID');
  }
  return { id: record.id, markdown: record.markdown };
}

function normalizePageId(pageId: string): string {
  return pageId.replaceAll('-', '').toLowerCase();
}

function toSnapshot(page: PageMarkdownResponse, response: Response): DocumentSnapshot {
  return {
    markdown: page.markdown,
    hash: createHash('sha256').update(page.markdown, 'utf8').digest('hex'),
    editedTime: response.headers.get('last-modified') ?? response.headers.get('date') ?? '',
  };
}

function retryAfterMilliseconds(value: string | null, now: number): number {
  if (value === null) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return 1_000;
  return Math.max(0, date - now);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export { NOTION_API_VERSION };
