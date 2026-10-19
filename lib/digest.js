// Boils a saved Claude Code session down to the facts its CV is written from: what the user
// asked for, what Claude said at the end of its turns, which files it changed and read, which
// commands and tools it used, how often it was compacted and how large the conversation is.
const fs = require('fs');
const path = require('path');

const clip = (text, max) => (text.length > max ? text.slice(0, max) + '…' : text);

function userText(entry) {
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return '';
}

function digestSession(file) {
  const d = {
    promptCount: 0,
    firstPrompts: [],
    lastPrompts: [],
    replies: [],
    changed: new Map(), // file path -> number of edits
    read: new Set(),
    commands: [],
    tools: new Set(),
    compactions: 0,
    contextTokens: 0,
    cwd: null,
    firstAt: null,
    lastAt: null,
  };

  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.isSidechain) continue;
    if (entry.cwd && !d.cwd) d.cwd = entry.cwd;
    if (entry.timestamp) {
      d.firstAt = d.firstAt || entry.timestamp;
      d.lastAt = entry.timestamp;
    }

    if (entry.type === 'system' && entry.subtype === 'compact_boundary') d.compactions++;
    if (entry.type === 'custom-title') d.customTitle = entry.customTitle;
    if (entry.type === 'ai-title') d.aiTitle = entry.aiTitle;

    if (entry.type === 'user' && !entry.isMeta) {
      const text = userText(entry).trim();
      // Skip tool results, system reminders and slash command wrappers: only count real requests.
      if (!text || text.startsWith('<')) continue;
      d.promptCount++;
      if (d.firstPrompts.length < 3) d.firstPrompts.push(clip(text, 500));
      d.lastPrompts.push(clip(text, 400));
      if (d.lastPrompts.length > 12) d.lastPrompts.shift();
    }

    if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      const u = entry.message.usage;
      if (u) d.contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      for (const c of entry.message.content) {
        if (c.type === 'text' && c.text?.trim()) {
          d.replies.push(clip(c.text.trim(), 500));
          if (d.replies.length > 8) d.replies.shift();
        } else if (c.type === 'tool_use') {
          const input = c.input || {};
          if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name) && input.file_path) {
            d.changed.set(input.file_path, (d.changed.get(input.file_path) || 0) + 1);
          } else if (c.name === 'Read' && input.file_path && d.read.size < 60) {
            d.read.add(input.file_path);
          } else if (c.name === 'Bash' && input.command) {
            d.commands.push(clip(String(input.command).split('\n')[0], 160));
            if (d.commands.length > 15) d.commands.shift();
          }
          if (c.name.startsWith('mcp__') || c.name === 'Skill') d.tools.add(c.name === 'Skill' ? `Skill: ${input.skill || input.name || ''}` : c.name);
        }
      }
    }
  }
  return d;
}

// The text Haiku reads to write the CV. Kept to a few thousand words at most.
function digestText(d, { title, cwd }) {
  const short = (p) => (d.cwd && p.startsWith(d.cwd + path.sep) ? p.slice(d.cwd.length + 1) : p);
  const changed = [...d.changed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([p, n]) => `${short(p)} (${n})`);
  const lines = [
    `Folder: ${cwd || d.cwd}`,
    title ? `Title: ${title}` : '',
    `Active from ${d.firstAt || '?'} to ${d.lastAt || '?'}, ${d.promptCount} requests from the user, compacted ${d.compactions} times.`,
    '',
    'First requests:',
    ...d.firstPrompts.map((p) => `- ${p}`),
    '',
    'Latest requests:',
    ...d.lastPrompts.filter((p) => !d.firstPrompts.includes(p)).map((p) => `- ${p}`),
    '',
    "Claude's latest replies:",
    ...d.replies.map((r) => `- ${r}`),
    '',
    `Files changed (edits): ${changed.join(', ') || 'none'}`,
    `Files read: ${[...d.read].slice(0, 30).map(short).join(', ') || 'none'}`,
    `Recent commands: ${d.commands.join(' | ') || 'none'}`,
    `Other tools: ${[...d.tools].join(', ') || 'none'}`,
  ];
  return clip(lines.filter((l) => l !== undefined).join('\n'), 14000);
}

module.exports = { digestSession, digestText };
