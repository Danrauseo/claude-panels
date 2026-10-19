// A small MCP tool server that each Claude session in Claude Panels starts with. It lets Claude:
// - list the open terminals
// - find expert sessions for a task, from the CVs the app keeps for past and present sessions
// - search or read another session's conversation, which costs almost nothing
// - ask an expert session a question, checking with the user first when that would be costly
// Claude Code talks to it over stdin and stdout, one JSON-RPC message per line.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { findSessionFile, readTranscript, searchTranscript, formatTranscript } = require('../lib/transcript');

const REGISTRY = process.env.CLAUDE_PANELS_REGISTRY; // the terminals open in the app
const CVS = process.env.CLAUDE_PANELS_CVS; // the CVs the app keeps for sessions
const SELF = Number(process.env.CLAUDE_PANELS_SELF) || null;
const CLAUDE = (process.env.CLAUDE_PANELS_CLAUDE || 'claude').split(' ')[0];
const INLINE_LIMIT = 30000; // longer conversations are saved to a file for Claude to read
const CHEAP_TOKENS = 40000; // a conversation smaller than this is cheap to ask at any time
const WARM_MINUTES = 60; // a conversation used this recently is likely still in Claude's cache

const SESSION_ARG = {
  type: 'string',
  description: 'Which session: a terminal number or name such as "2" or "2-wrap", or a session id from find_expert.',
};

const TOOLS = [
  {
    name: 'find_expert',
    description:
      'Find past or present Claude sessions that already know about a task, from short CVs of what each session ' +
      'has worked on. Use it when starting a substantial new task. Returns up to three experts with their CVs, ' +
      'whether they are open, and whether asking them directly would be cheap or costly.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'A sentence describing the task you are about to do.' },
        everywhere: {
          type: 'boolean',
          description: 'Search sessions in every folder, not only this folder. Use only if this folder has no expert.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'search_session',
    description:
      "Search another session's conversation and return the parts that mention the words. Costs almost nothing " +
      'and does not interrupt or change that session. Prefer this to asking an expert.',
    inputSchema: {
      type: 'object',
      properties: { session: SESSION_ARG, query: { type: 'string', description: 'Words to look for.' } },
      required: ['session', 'query'],
    },
  },
  {
    name: 'read_session',
    description:
      "Read the whole of another session's conversation. Use it only when the user wants all of that context, " +
      'because it can be long. It does not interrupt or change that session.',
    inputSchema: { type: 'object', properties: { session: SESSION_ARG }, required: ['session'] },
  },
  {
    name: 'ask_expert',
    description:
      'Ask an expert session a question that needs its whole history, such as why a choice was made or what was ' +
      'already tried. It answers from a temporary copy of its conversation, so the original is left unchanged. ' +
      'If the expert is large and has not been used recently, this tool does not ask yet and tells you to check ' +
      'with the user first. Then call it again with confirmed set to true.',
    inputSchema: {
      type: 'object',
      properties: {
        session: SESSION_ARG,
        question: { type: 'string', description: 'The question, with enough context to answer it on its own.' },
        confirmed: { type: 'boolean', description: 'Set to true only after the user agreed to the cost.' },
      },
      required: ['session', 'question'],
    },
  },
  {
    name: 'list_panels',
    description:
      'List the terminals open in Claude Panels: number, session name, folder and title. ' +
      'Use it to work out which terminal the user means.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const loadPanels = () => readJson(REGISTRY, {}).panels || [];
const loadCVs = () => readJson(CVS, {}).sessions || {};

function describePanel(p) {
  const self = p.number === SELF ? ' (this terminal)' : '';
  return `${p.number}. @${p.name}${self}: ${p.title || ''} in ${p.cwd}`;
}

function ago(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

// Finds a session file whose name starts with a short id from find_expert.
function fileByIdPrefix(prefix) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  for (const dir of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(root, dir));
    } catch {
      continue;
    }
    const name = names.find((n) => n.startsWith(prefix) && n.endsWith('.jsonl'));
    if (name) return path.join(root, dir, name);
  }
  return null;
}

// Works out which session is meant: an open terminal by number or name, or any session by id.
function resolve(arg) {
  const panels = loadPanels();
  const wanted = String(arg || '').trim().replace(/^@/, '').replace(/^"|"$/g, '');
  const lower = wanted.toLowerCase();

  if (/^[0-9a-f]{8}(-[0-9a-f-]+)?$/.test(lower)) {
    const file = fileByIdPrefix(lower);
    if (!file) return { error: `There is no saved session with the id ${wanted}.` };
    const id = path.basename(file, '.jsonl');
    const panel = panels.find((p) => p.sessionId === id);
    return { id, file, panel, label: panel ? `terminal ${panel.number} (@${panel.name})` : `session ${id.slice(0, 8)}` };
  }

  const byNumber = lower.match(/^(\d+)(-|$)/);
  const panel = byNumber
    ? panels.find((p) => p.number === Number(byNumber[1]))
    : panels.find((p) => p.name.toLowerCase() === lower) ||
      panels.find((p) => (p.harnessName || '').toLowerCase() === lower) ||
      panels.find((p) => p.name.toLowerCase().includes(lower));
  if (!panel) {
    const list = panels.map(describePanel).join('\n') || 'No terminals are open.';
    return { error: `There is no terminal matching "${arg}". Open terminals:\n${list}` };
  }
  const file = findSessionFile(panel.sessionId);
  if (!file) return { error: `Terminal ${panel.number} (@${panel.name}) has no saved conversation yet.` };
  return { id: panel.sessionId, file, panel, label: `terminal ${panel.number} (@${panel.name}, "${panel.title || ''}")` };
}

// How costly it would be to ask this session directly right now.
function costOf(id, file) {
  const cv = loadCVs()[id] || {};
  const lastUsed = fs.statSync(file).mtimeMs;
  const tokens = cv.contextTokens || 0;
  const warm = Date.now() - lastUsed < WARM_MINUTES * 60000;
  const cheap = warm || (tokens > 0 && tokens < CHEAP_TOKENS);
  const size = tokens ? `about ${Math.round(tokens / 1000)},000 tokens` : 'of unknown size';
  const note = cheap
    ? `Cheap to ask now (${warm ? 'used ' + ago(lastUsed) : 'small conversation'}).`
    : `Costly to ask now: its conversation is ${size} and it was last used ${ago(lastUsed)}, so it is no longer ` +
      "in Claude's cache and asking it means reading all of that at full price.";
  return { cheap, note, lastUsed, size };
}

const STOP = new Set(
  ('the and for with that this from into have will what when your about there their them then than were been ' +
    "some more also just make made need want please could would should can its it's our out use using new add " +
    'work task file files code').split(' ')
);

function findExpert(task, everywhere) {
  const words = [...new Set((String(task).toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || []).filter((w) => !STOP.has(w)))];
  const here = process.cwd();
  const panels = loadPanels();
  const selfId = panels.find((p) => p.number === SELF)?.sessionId;
  const tildeHere = here.startsWith(os.homedir()) ? '~' + here.slice(os.homedir().length) : here;
  // An expert counts as local if it worked in this folder, or if its CV says it knows this folder.
  const sameFolder = (cwd, cv = '') =>
    cwd === here || here.startsWith(cwd + path.sep) || cwd.startsWith(here + path.sep) || cv.includes(here) || cv.includes(tildeHere);
  const openIds = new Map(panels.map((p) => [p.sessionId, p]));

  const scored = [];
  for (const [id, e] of Object.entries(loadCVs())) {
    if (!e.cv || id === selfId || !e.cwd) continue;
    const local = sameFolder(e.cwd, e.cv);
    if (!everywhere && !local) continue;
    const text = `${e.title || ''} ${e.cv} ${e.cwd}`.toLowerCase();
    const hits = words.filter((w) => text.includes(w));
    let score = words.length ? hits.length / words.length : 0;
    if (local) score += 0.25;
    if (hits.length < 2 && !(local && hits.length >= 1)) continue;
    scored.push({ id, e, score, open: openIds.get(id) });
  }
  scored.sort((a, b) => b.score - a.score || b.e.updated - a.e.updated);
  const best = scored.filter((s) => s.score >= 0.3).slice(0, 3);

  if (!best.length) {
    return everywhere
      ? 'No expert sessions match this task. Work on it directly.'
      : 'No expert sessions in this folder match this task. If the task relates to work done in another folder, ' +
          'you can call find_expert again with everywhere set to true. Otherwise work on it directly.';
  }

  const parts = best.map(({ id, e, open }, i) => {
    const file = e.file && fs.existsSync(e.file) ? e.file : fileByIdPrefix(id);
    const cost = file ? costOf(id, file) : { note: '' };
    const where = open ? `open in terminal ${open.number} as @${open.name}` : 'closed';
    return (
      `${i + 1}. Session ${id.slice(0, 8)}${e.title ? ` "${e.title}"` : ''}, in ${e.cwd}, ${where}, ` +
      `last used ${file ? ago(cost.lastUsed) : 'unknown'}, ${e.requests} requests.\n` +
      `   ${cost.note}\n   CV:\n` +
      e.cv.split('\n').map((l) => `   ${l}`).join('\n')
    );
  });
  return (
    `Experts for this task:\n\n${parts.join('\n\n')}\n\n` +
    'Use an expert in this order, cheapest first, and stop as soon as you have what you need:\n' +
    '1. Use its CV above.\n' +
    '2. Read the files it names, to see how they are now. They may have changed since.\n' +
    '3. Search its conversation with search_session for the reasoning and details the files do not show.\n' +
    '4. Only if you still need its judgement, such as why something was chosen or what was already tried, ' +
    'ask it. If it is open in a terminal, message it with SendMessage. If it is closed, use ask_expert. ' +
    'If it is costly to ask now, check with the user first.'
  );
}

function strippedEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_') && k !== 'ELECTRON_RUN_AS_NODE')
  );
}

async function askExpert(args) {
  const found = resolve(args.session);
  if (found.error) throw new Error(found.error);
  const { id, file, panel, label } = found;
  const cost = costOf(id, file);

  if (panel) {
    return (
      `${label} is open, so message it with SendMessage instead, and its live session will answer. ${cost.note}` +
      (cost.cheap ? '' : ' Check with the user before messaging it.')
    );
  }
  if (!cost.cheap && !args.confirmed) {
    return (
      `Not asked yet. ${cost.note} Ask the user whether the answer is worth that. If they agree, call ask_expert ` +
      'again with confirmed set to true. Searching its conversation with search_session costs almost nothing.'
    );
  }

  const cwd = loadCVs()[id]?.cwd || process.cwd();
  const shell = os.userInfo().shell || '/bin/zsh';
  const command =
    `${CLAUDE} -p --resume "$CP_SESSION" --fork-session --no-session-persistence --tools "" ` +
    '--append-system-prompt "$CP_SYSTEM" "$CP_QUESTION"';
  const answer = await new Promise((done) => {
    execFile(
      shell,
      ['-l', '-i', '-c', command],
      {
        cwd: fs.existsSync(cwd) ? cwd : os.homedir(),
        timeout: 300000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...strippedEnv(),
          CP_SESSION: id,
          CP_QUESTION: args.question,
          CP_SYSTEM:
            'You are being consulted as an expert by another Claude Code session, not by the user. Answer its ' +
            'question briefly and directly from what you know in this conversation. Do not ask questions back and ' +
            'do not offer to do anything, because nothing you say here is shown to the user or saved. Say so if ' +
            'you are unsure or if things may have changed since.',
        },
      },
      (err, stdout, stderr) =>
        done(stdout.trim() || `The expert did not answer. ${String(stderr || err?.message || '').slice(0, 300)}`)
    );
  });
  return `Answer from ${label}:\n\n${answer}`;
}

async function callTool(name, args) {
  if (name === 'list_panels') return loadPanels().map(describePanel).join('\n') || 'No terminals are open.';
  if (name === 'find_expert') return findExpert(args.task || '', Boolean(args.everywhere));
  if (name === 'ask_expert') return askExpert(args);

  const found = resolve(args.session);
  if (found.error) throw new Error(found.error);
  const { file, label } = found;
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
    const out = path.join(dir, `session-${found.id.slice(0, 8)}.md`);
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

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // a notification, nothing to answer
  try {
    if (method === 'initialize') {
      return send({
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'panels', version: '1.1.0' },
        },
      });
    }
    if (method === 'ping') return send({ id, result: {} });
    if (method === 'tools/list') return send({ id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      try {
        const text = await callTool(params.name, params.arguments || {});
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
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // ignore lines that are not JSON
    }
    handle(msg);
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 100));
