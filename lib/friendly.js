// Turns lines of a saved Claude Code session into the few things the friendly view shows: what the user
// asked, what Claude said, each tool Claude used, and whether it finished. Used by the app.

function friendlyItems(entry) {
  if (entry.isSidechain || entry.isMeta || (entry.type !== 'user' && entry.type !== 'assistant')) return [];
  const content = entry.message?.content;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const items = [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text?.trim()) {
      const text = b.text.trim();
      // Tool results, reminders and slash command wrappers start with a tag. They are not the user's words.
      if (entry.type === 'user' && text.startsWith('<')) continue;
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
