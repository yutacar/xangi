const START = '<xangi_reply_suggestions>';
const END = '</xangi_reply_suggestions>';

export function appendReplySuggestionInstruction(prompt: string, count = 3): string {
  const example = Array.from({ length: count }, (_, index) => `候補${index + 1}`);
  return `${prompt}\n\n[system-context]\n通常の回答に続けて、ユーザーが次に送りそうな短い返信候補を${count}件生成してください。出力の末尾に次の形式を厳密に付け、通常の回答本文では候補に言及しないでください。候補はユーザー視点の自然な日本語にしてください。\n${START}${JSON.stringify(example)}${END}`;
}

export function extractReplySuggestions(
  output: string,
  count = 3
): {
  text: string;
  suggestions: string[];
} {
  const pattern = new RegExp(`${START}([\\s\\S]*?)${END}`, 'g');
  let suggestions: string[] = [];
  const text = output
    .replace(pattern, (_match, raw: string) => {
      try {
        const parsed = JSON.parse(raw.trim());
        if (Array.isArray(parsed)) {
          suggestions = parsed
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim().replace(/\s+/g, ' '))
            .filter(Boolean)
            .slice(0, count);
        }
      } catch {
        // 壊れた候補ブロックはユーザーへ見せず、候補なしとして扱う。
      }
      return '';
    })
    .trimEnd();
  return { text: stripReplySuggestionMarkup(text), suggestions };
}

/** 候補機能がOFFでも内部タグを除去し、候補自体は公開しない。 */
export function sanitizeReplySuggestionOutput(
  output: string,
  enabled: boolean,
  count = 3
): {
  text: string;
  suggestions: string[];
} {
  const extracted = extractReplySuggestions(output, count);
  if (!enabled) extracted.suggestions = [];
  return extracted;
}

// 開始タグの断片を隠すときの最小一致長。これ未満（`<` 単体など）は本文として扱う。
const MARKER_PREFIX = '<xangi_';

/**
 * 末尾に張り付いた内部候補ブロックだけを表示テキストから隠す。対象は
 * (0) `<開始>…</終了>` の完全ブロック、(1) 閉じタグを伴わない未完ブロック、
 * (2) ストリーミングで途中まで打ち込まれた開始タグの前方一致断片、の 3 種。
 *
 * 以前は最初の開始タグ出現位置以降を無条件に切り捨てていたため、本文がマーカー名に
 * 言及しただけで以降が丸ごと消えていた（長さ非依存・内容依存の途中切れ）。ここでは
 * 末尾に接しているかを見て、本文中の引用は切らない。
 */
export function stripReplySuggestionMarkup(output: string): string {
  let end = output.length;
  for (;;) {
    const slice = output.slice(0, end);
    let next = end;
    const openIndex = slice.lastIndexOf(START);
    if (openIndex >= 0) {
      const closeIndex = slice.indexOf(END, openIndex);
      if (closeIndex >= 0) {
        // (0) 完全ブロック。末尾に接している（後続が空白のみ）ときだけ隠す。
        if (slice.slice(closeIndex + END.length).trim() === '') {
          next = Math.min(next, openIndex);
        }
      } else {
        // (1) 未完ブロック。開始タグ直後が本物のブロック内容（JSON 配列）か、
        //     末尾でタグのみのときだけ隠す。
        const tail = slice.slice(openIndex + START.length).trimStart();
        if (tail === '' || tail.startsWith('[')) {
          next = Math.min(next, openIndex);
        }
      }
    }
    // (2) 末尾に途中まで打ち込まれた開始タグの前方一致断片（例: 末尾が "<xangi_reply"）。
    for (let len = START.length - 1; len >= MARKER_PREFIX.length; len--) {
      if (slice.endsWith(START.slice(0, len))) {
        next = Math.min(next, end - len);
        break;
      }
    }
    if (next >= end) break;
    end = next;
  }
  return output.slice(0, end).trimEnd();
}

export function formatNumberedSuggestions(suggestions: string[]): string {
  return suggestions.map((suggestion, index) => `${index + 1}. ${suggestion}`).join('\n');
}

export function resolveReplySuggestionSkipPermissions(
  skipPermissions: boolean | undefined
): boolean {
  return skipPermissions ?? false;
}

export function fallbackReplySuggestions(count = 3): string[] {
  return [
    'もう少し詳しく教えて',
    'その方針で進めて',
    '別の案も見せて',
    '具体例を見せて',
    '注意点を教えて',
  ].slice(0, count);
}
