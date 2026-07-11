/**
 * replyInThread で新規スレッドを作成できた場合、以降の会話コンテキスト（セッション・
 * イベント・UI・ランナー呼び出し）のキーをそのスレッドIDにする。作成できなかった場合
 * （既にスレッド内 / DM / 作成不可）は受信チャンネルIDをそのまま使う。
 *
 * これがないと、親チャンネルで受けた発言から自動作成したスレッド内の続き発言が
 * 別セッション扱いになり、同じ会話を継続できない。
 */
export function resolveConversationChannelId(
  receivedChannelId: string,
  createdThreadId?: string
): string {
  return createdThreadId ?? receivedChannelId;
}

export function resolveDiscordSettingsChannelId(
  receivedChannelId: string,
  channel: {
    isThread?: () => boolean;
    parentId?: string | null;
  }
): string {
  if (typeof channel.isThread === 'function' && channel.isThread() && channel.parentId) {
    return channel.parentId;
  }
  return receivedChannelId;
}

export function getDiscordChannelTopic(channel: {
  topic?: string | null;
  isThread?: () => boolean;
  parent?: unknown;
}): string | null {
  if (typeof channel.topic === 'string' && channel.topic.length > 0) {
    return channel.topic;
  }
  const parent =
    channel.parent && typeof channel.parent === 'object'
      ? (channel.parent as { topic?: unknown })
      : null;
  if (
    typeof channel.isThread === 'function' &&
    channel.isThread() &&
    typeof parent?.topic === 'string' &&
    parent.topic.length > 0
  ) {
    return parent.topic;
  }
  return null;
}

export function buildDiscordChannelContextLine(params: {
  channelName: string | null;
  conversationChannelId: string;
  createdThreadName?: string | null;
}): string | null {
  const { channelName, conversationChannelId, createdThreadName } = params;
  if (!channelName) return null;
  if (createdThreadName) {
    return `[チャンネル: #${channelName} / thread: ${createdThreadName} (ID: ${conversationChannelId})]`;
  }
  return `[チャンネル: #${channelName} (ID: ${conversationChannelId})]`;
}
