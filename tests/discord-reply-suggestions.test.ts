import { describe, expect, it } from 'vitest';
import {
  appendReplySuggestionInstruction,
  extractReplySuggestions,
  fallbackReplySuggestions,
  formatNumberedSuggestions,
  resolveReplySuggestionSkipPermissions,
  sanitizeReplySuggestionOutput,
  stripReplySuggestionMarkup,
} from '../src/reply-suggestions.js';

describe('Discord reply suggestions', () => {
  it('adds a machine-readable generation instruction', () => {
    const prompt = appendReplySuggestionInstruction('質問', 3);
    expect(prompt).toContain('<xangi_reply_suggestions>');
    expect(prompt).toContain('3件');
  });

  it('extracts suggestions and removes the private block', () => {
    const output =
      '回答です。\n<xangi_reply_suggestions>["詳しく教えて","進めて","別案は？"]</xangi_reply_suggestions>';
    expect(extractReplySuggestions(output)).toEqual({
      text: '回答です。',
      suggestions: ['詳しく教えて', '進めて', '別案は？'],
    });
  });

  it('hides malformed blocks and provides a deterministic fallback', () => {
    const output = '回答\n<xangi_reply_suggestions>broken</xangi_reply_suggestions>';
    expect(extractReplySuggestions(output)).toEqual({ text: '回答', suggestions: [] });
    expect(fallbackReplySuggestions()).toHaveLength(3);
  });

  it('removes stale suggestion markup even when suggestions are disabled', () => {
    const output =
      '回答です。\n<xangi_reply_suggestions>["古い候補1","古い候補2"]</xangi_reply_suggestions>';
    expect(sanitizeReplySuggestionOutput(output, false)).toEqual({
      text: '回答です。',
      suggestions: [],
    });
  });

  it('hides a stale partial tag before it reaches streaming output', () => {
    expect(stripReplySuggestionMarkup('回答です。\n<xangi_reply_suggestions>["途中')).toBe(
      '回答です。'
    );
  });

  it('keeps body text that merely mentions the marker prefix in prose', () => {
    // 実際に途中切れを起こした本文パターン。マーカー名を引用しただけで以降が消えていた。
    const output = "切り取り基準を `indexOf('<xangi_reply')` に広げた副作用。この後の文も残る。";
    expect(stripReplySuggestionMarkup(output)).toBe(output);
  });

  it('keeps a fully-quoted opener tag when normal prose follows it', () => {
    const output = '`<xangi_reply_suggestions>` について説明する。この後の文も残る。';
    expect(stripReplySuggestionMarkup(output)).toBe(output);
  });

  it('hides a completed block that sits at the very end', () => {
    expect(
      stripReplySuggestionMarkup(
        '回答です。\n<xangi_reply_suggestions>["a"]</xangi_reply_suggestions>'
      )
    ).toBe('回答です。');
  });

  it('hides a trailing opener fragment during streaming', () => {
    expect(stripReplySuggestionMarkup('回答です。\n<xangi_reply_sugg')).toBe('回答です。');
  });

  it('appends numbered suggestions to the visible response', () => {
    expect(formatNumberedSuggestions(['はい', 'いいえ'])).toBe('1. はい\n2. いいえ');
  });

  it('inherits the configured permission mode for suggestion turns', () => {
    expect(resolveReplySuggestionSkipPermissions(true)).toBe(true);
    expect(resolveReplySuggestionSkipPermissions(false)).toBe(false);
    expect(resolveReplySuggestionSkipPermissions(undefined)).toBe(false);
  });
});
