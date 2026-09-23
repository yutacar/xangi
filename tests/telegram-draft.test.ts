import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Api } from 'grammy';
import {
  isUnsupportedTelegramDraftError,
  nextTelegramDraftId,
  TelegramDraftPreview,
} from '../src/telegram-draft.js';

afterEach(() => {
  vi.useRealTimers();
});

function preview(
  sendMessageDraft = vi.fn().mockResolvedValue(true),
  threadId?: number,
  current = () => true,
  onFailure = vi.fn()
) {
  const draft = new TelegramDraftPreview(
    { sendMessageDraft } as unknown as Pick<Api, 'sendMessageDraft'>,
    123,
    threadId,
    current,
    onFailure
  );
  return { draft, sendMessageDraft, onFailure };
}

describe('TelegramDraftPreview', () => {
  it('keeps one nonzero ID per turn, throttles updates, and refreshes before expiry', async () => {
    vi.useFakeTimers();
    const { draft, sendMessageDraft } = preview(undefined, 9);
    draft.start();
    await vi.waitFor(() => expect(sendMessageDraft).toHaveBeenCalledTimes(1));
    expect(sendMessageDraft.mock.calls[0]).toMatchObject([
      123,
      draft.draftId,
      '考え中...',
      { message_thread_id: 9 },
    ]);
    await draft.update('partial');
    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await draft.update('partial');
    expect(sendMessageDraft).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sendMessageDraft).toHaveBeenCalledTimes(3);
    expect(sendMessageDraft.mock.calls.every((call) => call[1] === draft.draftId)).toBe(true);
    draft.stop();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(sendMessageDraft).toHaveBeenCalledTimes(3);
  });

  it('uses distinct nonzero IDs, omits absent topics, and stops on generation change', async () => {
    vi.useFakeTimers();
    let current = true;
    const first = preview(undefined, undefined, () => current);
    const second = preview();
    expect(first.draft.draftId).not.toBe(second.draft.draftId);
    expect(nextTelegramDraftId()).toBeGreaterThan(0);
    first.draft.start();
    await vi.waitFor(() => expect(first.sendMessageDraft).toHaveBeenCalledTimes(1));
    expect(first.sendMessageDraft.mock.calls[0][3]).toBeUndefined();
    current = false;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(first.sendMessageDraft).toHaveBeenCalledTimes(1);
    first.draft.stop();
  });

  it('stops draft updates after a failure without throwing into the agent run', async () => {
    vi.useFakeTimers();
    const sendMessageDraft = vi.fn().mockRejectedValue(new Error('network timeout'));
    const { draft, onFailure } = preview(sendMessageDraft);
    draft.start();
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(21_000);
    await expect(draft.update('answer')).resolves.toBeUndefined();
    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
    draft.stop();
  });

  it('recognizes only definite unsupported API responses', () => {
    expect(
      isUnsupportedTelegramDraftError({
        error_code: 400,
        description: 'Bad Request: method not found',
      })
    ).toBe(true);
    expect(
      isUnsupportedTelegramDraftError({ error_code: 500, description: 'method not found' })
    ).toBe(false);
    expect(isUnsupportedTelegramDraftError(new Error('ETIMEDOUT'))).toBe(false);
  });
});
