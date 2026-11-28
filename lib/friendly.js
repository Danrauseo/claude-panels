// Turns lines of a saved Claude Code session into the few things the friendly view shows: what the user
// asked, what Claude said, each tool Claude used, and whether it finished. Used by the app.

function friendlyItems(entry) {
  if (entry.isSidechain || entry.isMeta || (entry.type !== 'user' && entry.type !== 'assistant')) return [];
  const content = entry.message?.content;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const items = [];
  // A summary written when the conversation was compacted is not something the user said.
  if (entry.isCompactSummary) return [{ kind: 'note', text: 'Claude summarised the earlier conversation to make room.' }];
  for (const b of blocks) {
    if (b.type === 'text' && b.text?.trim()) {
      const text = b.text.trim();
      // Errors from Claude Code itself, such as an expired login, are not Claude's reply.
      if (entry.isApiErrorMessage) {
        items.push({ kind: 'error', text: text.slice(0, 2000) });
        continue;
      }
      if (entry.type === 'user' && text.startsWith('<')) {
        // A slash command you typed, and what it printed. Tool results and reminders are left out.
        const command = /<command-name>([^<]+)<\/command-name>/.exec(text);
        const args = /<command-args>([^<]*)<\/command-args>/.exec(text);
        if (command) items.push({ kind: 'user', text: `${command[1].trim()} ${args?.[1] || ''}`.trim() });
        const output = /<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/.exec(text);
        // eslint-disable-next-line no-control-regex
        const plain = output?.[1].replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (plain) items.push({ kind: 'note', text: plain.slice(0, 4000) });
        continue;
      }
      if (entry.type === 'user' && /^\[Request interrupted by user/.test(text)) {
        items.push({ kind: 'note', text: 'You stopped Claude.' });
        continue;
      }
      items.push({ kind: entry.type === 'user' ? 'user' : 'text', text: text.slice(0, 20000) });
    } else if (b.type === 'tool_use') {
      const input = {};
      for (const [k, v] of Object.entries(b.input || {})) {
        if (['file_path', 'path', 'command', 'description', 'pattern', 'url', 'query', 'prompt', 'skill', 'subagent_type'].includes(k)) {
          input[k] = String(v).slice(0, 400);
        }
      }
      if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) {
        input.todos = b.input.todos.slice(0, 30).map((t) => ({ content: String(t.content || '').slice(0, 200), status: t.status }));
      }
      if (b.name === 'AskUserQuestion' && Array.isArray(b.input?.questions)) {
        input.question = String(b.input.questions[0]?.question || '').slice(0, 400);
      }
      items.push({ kind: 'tool', id: b.id, name: b.name, input });
    } else if (b.type === 'tool_result') {
      items.push({ kind: 'result', id: b.tool_use_id, error: Boolean(b.is_error) });
    }
  }
  return items;
}

function friendlyItemsFromLines(lines) {
  const items = [];
  for (const line of lines) {
    if (!/"type":"(user|assistant)"/.test(line)) continue;
    try {
      items.push(...friendlyItems(JSON.parse(line)));
    } catch {}
  }
  return items;
}

module.exports = { friendlyItems, friendlyItemsFromLines };
