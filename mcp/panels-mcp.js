// A small MCP tool server that each Claude session in Claude Panels starts with.
// It lets Claude search or read the saved conversation of another terminal in the app.
// Claude Code talks to it over stdin and stdout, one JSON-RPC message per line.
//
// The app keeps a list of its open terminals in the file named by CLAUDE_PANELS_REGISTRY.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findSessionFile, readTranscript, searchTranscript, formatTranscript } = require('../lib/transcript');

const REGISTRY = process.env.CLAUDE_PANELS_REGISTRY;
const SELF = Number(process.env.CLAUDE_PANELS_SELF) || null;
const INLINE_LIMIT = 30000; // longer conversations are saved to a file for Claude to read

const SESSION_ARG = {
  type: 'string',
  description: 'Which terminal, by number or session name, for example "2", "@2" or "2-wrap".',
};

const TOOLS = [
  {
    name: 'list_panels',
    description:
      'List the terminals open in Claude Panels: number, session name, harness, folder and title. ' +
      'Use it to work out which terminal the user means.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_session',
    description:
      "Search another Claude Panels terminal's conversation and return the parts that mention the words. " +
      'Use it when the user mentions a session (such as @2-wrap) and you need specific details from it. ' +
      'It does not interrupt or change that session.',
    inputSchema: {
      type: 'object',
      properties: { session: SESSION_ARG, query: { type: 'string', description: 'Words to look for.' } },
      required: ['session', 'query'],
    },
  },
  {
    name: 'read_session',
    description:
      "Read the whole of another Claude Panels terminal's conversation. Use it only when the user wants " +
      'all of that context, because it can be long. It does not interrupt or change that session.',
    inputSchema: { type: 'object', properties: { session: SESSION_ARG }, required: ['session'] },
  },
];

function loadPanels() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).panels || [];
  } catch {
    return [];
  }
}

function describePanel(p) {
  const self = p.number === SELF ? ' (this terminal)' : '';
  return `${p.number}. @${p.name}${self}: ${p.title || ''} in ${p.cwd}`;
}

// Finds a terminal from "2", "@2", "2-wrap" or a harness name such as "wrap".
function resolve(arg) {
  const panels = loadPanels();
  const wanted = String(arg || '').trim().replace(/^@/, '').replace(/^"|"$/g, '').toLowerCase();
  const byNumber = wanted.match(/^(\d+)(-|$)/);
  const panel = byNumber
    ? panels.find((p) => p.number === Number(byNumber[1]))
    : panels.find((p) => p.name.toLowerCase() === wanted) ||
      panels.find((p) => (p.harnessName || '').toLowerCase() === wanted) ||
      panels.find((p) => p.name.toLowerCase().includes(wanted));
  if (!panel) {
    const list = panels.map(describePanel).join('\n') || 'No terminals are open.';
    return { error: `There is no terminal matching "${arg}". Open terminals:\n${list}` };
  }
  const file = findSessionFile(panel.sessionId);
  if (!file) return { error: `Terminal ${panel.number} (@${panel.name}) has no saved conversation yet.` };
  return { panel, file };
}

function callTool(name, args) {
  if (name === 'list_panels') {
    return loadPanels().map(describePanel).join('\n') || 'No terminals are open.';
  }

  const found = resolve(args.session);
  if (found.error) throw new Error(found.error);
  const { panel, file } = found;
  const label = `terminal ${panel.number} (@${panel.name}, "${panel.title || ''}")`;
  const messages = readTranscript(file);

  if (name === 'search_session') {
    const r = searchTranscript(messages, args.query || '');
    if (!r.count) return `Nothing in ${label} mentions "${args.query}".`;
    const shown = r.shown < r.count ? `, showing the latest ${r.shown}` : '';
    return `Parts of ${label} that mention "${args.query}" (${r.count} matches${shown}):\n\n${r.text}`;
  }

  if (name === 'read_session') {
    const text = formatTranscript(messages, `Conversation from ${label}`);
    if (text.length <= INLINE_LIMIT) return text;
    const dir = path.join(os.tmpdir(), 'claude-panels');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `terminal-${panel.number}-${panel.sessionId.slice(0, 8)}.md`);
    fs.writeFileSync(out, text);
    return (
      `The conversation from ${label} is long (${messages.length} messages, ${text.length} characters), ` +
      `so it was saved to ${out}. Read that file in full with the Read tool.`
    );
  }

  throw new Error(`Unknown tool: ${name}`);
}

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // a notification, nothing to answer
  try {
    if (method === 'initialize') {
      return send({
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'panels', version: '1.0.0' },
        },
      });
    }
    if (method === 'ping') return send({ id, result: {} });
    if (method === 'tools/list') return send({ id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      try {
        const text = callTool(params.name, params.arguments || {});
        return send({ id, result: { content: [{ type: 'text', text }] } });
      } catch (err) {
        return send({ id, result: { content: [{ type: 'text', text: err.message }], isError: true } });
      }
    }
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (err) {
    send({ id, error: { code: -32603, message: err.message } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // ignore lines that are not JSON
    }
  }
});
process.stdin.on('end', () => process.exit(0));
