/**
 * Slack専用のxangiコマンド
 */
export const XANGI_COMMANDS_SLACK = `## Slack操作

Slackではスレッド内で会話が継続されます。
メンションまたは専用チャンネルでメッセージを送ってください。

SlackチャンネルIDはDiscord snowflakeではありません。\`xangi-cmd discord_history\` や \`discord_*\` コマンドに SlackチャンネルIDを渡さないでください。

### チャンネル履歴の取得

\`\`\`bash
xangi-cmd slack_history --count <件数>
xangi-cmd slack_history --channel <SlackチャンネルID> --count <件数>
\`\`\`

### Slack操作

\`\`\`bash
xangi-cmd slack_send --channel <SlackチャンネルID> --message "メッセージ内容"
xangi-cmd slack_send --channel <SlackチャンネルID> --thread-ts <ts> --message "スレッド返信"
xangi-cmd slack_channels --types public_channel,private_channel --limit 100
xangi-cmd slack_search --channel <SlackチャンネルID> --keyword "キーワード" --count 15
xangi-cmd slack_edit --channel <SlackチャンネルID> --message-ts <ts> --content "新しい内容"
xangi-cmd slack_delete --channel <SlackチャンネルID> --message-ts <ts>
\`\`\`

Slackのメッセージ指定にはDiscordのmessage IDではなく、Slackの \`ts\` を使います。`;
