// Reads Claude Code's saved session files (~/.claude/projects/<folder>/<session id>.jsonl).
// Used by the app for the stack view and by the panels tool server for search and read.
const fs = require('fs');
const os = require('os');
const path = require('path');

function describeTool(block) {
  const input = block.input || {};
  let detail =
    input.command || input.description || input.file_path || input.pattern || input.url || input.query || input.prompt || '';
  if (input.file_path && !input.command) detail = path.basename(input.file_path);
  detail = String(detail).split('\n')[0].slice(0, 140);
  return detail ? `${block.name}: ${detail}` : block.name;
}

function resultText(block) {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return block.content.map((c) => c.text || '').join(' ');
  return '';
}

function clip(text, max) {
  return text.length > max ? text.slice(0, max) + ' […]' : text;
}

// Finds a session's file by its id.
function findSessionFile(sessionId) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!sessionId || !/^[\w-]+$/.test(sessionId) || !fs.existsSync(root)) return null;
  for (const dir of fs.readdirSync(root)) {
    const file = path.join(root, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// Turns a saved session into a plain list of messages: what the user said, what Claude said,
// and short notes of the tools Claude ran and what came back.
function readTranscript(file) {
  const messages = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!/"type":"(user|assistant)"/.test(line)) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.isSidechain || entry.isMeta) continue;
    const content = entry.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text && !b.text.trimStart().startsWith('<')) {
        messages.push({ role: entry.type === 'user' ? 'User' : 'Claude', text: b.text.trim() });
      } else if (b.type === 'tool_use') {
        messages.push({ role: 'Claude ran', text: describeTool(b) });
      } else if (b.type === 'tool_result') {
        const out = resultText(b).trim();
        if (out) messages.push({ role: 'Result', text: clip(out, 3000) });
      }
    }
  }
  return messages;
}

// Returns the parts of a conversation that mention every word searched for, or any of them
// when nothing mentions all of them. Newest matches are kept when there are too many.
function searchTranscript(messages, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { count: 0, text: '' };
  let hits = messages.filter((m) => words.every((w) => m.text.toLowerCase().includes(w)));
  if (!hits.length) hits = messages.filter((m) => words.some((w) => m.text.toLowerCase().includes(w)));

  const excerpts = [];
  let total = 0;
  for (const m of hits.slice(-15).reverse()) {
    const lower = m.text.toLowerCase();
    const at = Math.max(0, lower.indexOf(words.find((w) => lower.includes(w))));
    const start = Math.max(0, at - 600);
    let piece = m.text.slice(start, at + 900);
    if (start > 0) piece = '…' + piece;
    if (at + 900 < m.text.length) piece += '…';
    if (total + piece.length > 12000) break;
    total += piece.length;
    excerpts.unshift(`[${m.role}] ${piece}`);
  }
  return { count: hits.length, shown: excerpts.length, text: excerpts.join('\n\n') };
}

function formatTranscript(messages, heading) {
  return `# ${heading}\n\n` + messages.map((m) => `## ${m.role}\n\n${m.text}`).join('\n\n') + '\n';
}

module.exports = {
  describeTool,
  resultText,
  clip,
  findSessionFile,
  readTranscript,
  searchTranscript,
  formatTranscript,
};
