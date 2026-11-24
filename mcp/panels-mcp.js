// A small MCP tool server that each Claude session in Claude Panels starts with. It lets Claude:
// - list the open terminals
// - find expert sessions for a task, from the CVs the app keeps for past and present sessions
// - search or read another session's conversation, which costs almost nothing
// - ask an expert session a question, checking with the user first when that would be costly
// - open a new terminal in a harness and start a Claude session there with a task
// Claude Code talks to it over stdin and stdout, one JSON-RPC message per line.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { findSessionFile, readTranscript, searchTranscript, formatTranscript } = require('../lib/transcript');
const { rankExperts } = require('../lib/experts');

const REGISTRY = process.env.CLAUDE_PANELS_REGISTRY; // the terminals open in the app
const CVS = process.env.CLAUDE_PANELS_CVS; // the CVs the app keeps for sessions
const SELF = Number(process.env.CLAUDE_PANELS_SELF) || null;
const CONTROL = process.env.CLAUDE_PANELS_CONTROL; // the app's local address for opening terminals
const TOKEN = process.env.CLAUDE_PANELS_TOKEN;
const CLAUDE = (process.env.CLAUDE_PANELS_CLAUDE || 'claude').split(' ')[0];
const ADVISOR = process.env.CLAUDE_PANELS_ADVISOR || ''; // the model for ask_advisor, when the app runs the advisor
const OWN_SESSION = process.env.CLAUDE_PANELS_SESSION || ''; // this terminal's own Claude session id
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
  {
    name: 'list_harnesses',
    description:
      "List where a new terminal can run: the user's saved harnesses, the folders the open terminals are using, " +
      'and recently used folders. Call it before open_terminal.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'open_terminal',
    description:
      'Open a new terminal in Claude Panels and start a new Claude session in it, in the harness or folder you ' +
      'choose, with your task as its first message. The new session is told which terminal opened it, and it ' +
      'reports back to you with SendMessage when it has finished. Use it when part of the work belongs in a ' +
      'different harness or folder, or when a separate piece of work can run alongside yours. Do not use it for ' +
      'small tasks you can do yourself. A terminal opened this way cannot open more terminals, and the app limits ' +
      'how many can be opened. Tell the user which terminal you opened and why.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'The full task for the new session, with all the context it needs, because it cannot see your conversation.',
        },
        harness: { type: 'string', description: 'The name of a saved harness from list_harnesses.' },
        folder: { type: 'string', description: 'A folder path, if the work does not belong to a saved harness.' },
        background: {
          type: 'boolean',
          description:
            "Run the new session in the background, where it is listed in the app's sidebar instead of taking a " +
            'panel on screen. The user can still look at it and answer its questions. Defaults to true. Set it to ' +
            'false only when the user will want to watch the new session or type into it.',
        },
        wait: {
          type: 'boolean',
          description:
            'Set to true if you will collect this terminal\'s report with wait_for_report, as a tool result, ' +
            'instead of getting it as a message. Use it to run several terminals at the same time and carry on ' +
            'when they have all finished. Defaults to false.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'wait_for_report',
    description:
      'Wait for the terminals you opened with wait set to true to finish, and get their reports back as the ' +
      'result. It returns when every one of them has reported, or has ended or closed without reporting, or ' +
      'when the time runs out. If the time runs out it says which are still working, and you can call it ' +
      'again. A terminal that needs the user stays waiting until the user answers it in the app.',
    inputSchema: {
      type: 'object',
      properties: {
        terminals: {
          type: 'array',
          items: { type: 'number' },
          description: 'The numbers of the terminals to wait for. Leave it out to wait for every terminal you opened with wait set to true.',
        },
        minutes: { type: 'number', description: 'The longest to wait, in minutes. Defaults to 30. The most is 120.' },
      },
    },
  },
  {
    name: 'report_back',
    description:
      'Hand in your report to the terminal that opened you, when it opened you with wait set to true and is ' +
      'waiting for your report. Your first message says whether to use this or SendMessage.',
    inputSchema: {
      type: 'object',
      properties: { report: { type: 'string', description: 'A short report of what you did and what you found.' } },
      required: ['report'],
    },
  },
  {
    name: 'set_job',
    description:
      'Name the job made up of the terminals you open, and set who else may use them. The app groups the ' +
      'terminals you open into one job, shown in its sidebar under your terminal. A closed job (the default) ' +
      'means another terminal must get the user\'s permission before it messages or reads one of your ' +
      'terminals. An open job lets any terminal use them. Call it before or after open_terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short name for the job, for example "Sefton pilot evaluation".' },
        access: { type: 'string', enum: ['closed', 'open'], description: 'Who may use the terminals in the job.' },
      },
    },
  },
  {
    name: 'wrap_up_job',
    description:
      'Close every terminal in your job once they have all finished and reported back to you. Their ' +
      'conversations are kept, so the user can resume any of them later. It does nothing while a terminal ' +
      'in the job is still working or waiting for the user. Tell the user what the job produced first.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// The app runs the advisor itself when Claude Code has none, for example on Google Vertex. It works like
// Claude's advisor tool: a stronger model reads this whole conversation, with no tools, and gives advice.
const ADVISOR_TOOL = {
  name: 'ask_advisor',
  description:
    `Ask your advisor, a stronger model (${ADVISOR}), for guidance. It reads this whole conversation, including ` +
    'your tool results, and replies with short advice on your approach, your next steps and anything you have ' +
    'missed. It cannot use tools or see anything outside this conversation. Call it before substantive work, ' +
    'when you are stuck or thinking of changing approach, and before you say a task is finished.',
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'Optional. A specific question for the advisor. Without one, it reviews the work so far.',
      },
    },
  },
};
if (ADVISOR) TOOLS.push(ADVISOR_TOOL);

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

function findExpert(task, everywhere) {
  const panels = loadPanels();
  const selfId = panels.find((p) => p.number === SELF)?.sessionId;
  const openIds = new Map(panels.map((p) => [p.sessionId, p]));
  const scored = rankExperts({ task, here: process.cwd(), cvs: loadCVs(), excludeIds: [selfId], everywhere }).map(
    (s) => ({ ...s, open: openIds.get(s.id) })
  );
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

// The environment for a separate Claude run. It leaves out what marks this as Claude Code's own process,
// but keeps how Claude signs in (for example Google Vertex) and Code Mode, which a copied session needs.
const KEEP_CLAUDE_VARS = /^CLAUDE_CODE_(USE_|SKIP_|OAUTH_TOKEN$|EXPERIMENTAL_CODE_MODE$)/;
function strippedEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => k !== 'CLAUDECODE' && k !== 'ELECTRON_RUN_AS_NODE' && (!k.startsWith('CLAUDE_CODE_') || KEEP_CLAUDE_VARS.test(k))
    )
  );
}

// Runs the advisor, following the design of Claude's advisor tool: a separate Claude on the advisor model reads
// this session's whole conversation so far, with no tools, and writes short advice for the session. It gets
// its own instructions instead of Claude Code's usual ones, and nothing it writes is saved.
const ADVISOR_CHARS = 300000; // about 75,000 tokens of conversation at most; the start and the latest part are kept
const ADVISOR_SYSTEM =
  'You are an advisor to another Claude session. That session is doing a task on a smaller, faster model, and ' +
  'it has paused to ask you for guidance. You will see its conversation so far: what the user asked, what it ' +
  'said, the tools it ran and their results. You cannot use tools, and nothing you write is shown to the user. ' +
  'Only the session reads it. If it asked a specific question, answer that first. Then give it concise, ' +
  'concrete guidance: whether its approach is sound, what it should do next, any mistakes or risks it has ' +
  'missed, and what it should check before it calls the work finished. Do not do the work yourself, do not ' +
  'write long code, and do not address the user. Keep your guidance under 200 words.';

function advisorView(file) {
  const messages = readTranscript(file);
  const whole = formatTranscript(messages, 'Conversation of the session you are advising');
  if (whole.length <= ADVISOR_CHARS) return whole;
  // Too long: keep the first message, which usually sets the task, and as much of the latest part as fits.
  const first = messages.slice(0, 1);
  const tail = [];
  let size = first.reduce((n, m) => n + m.text.length, 0) + 500;
  for (let i = messages.length - 1; i > 0; i--) {
    size += messages[i].text.length + 20;
    if (size > ADVISOR_CHARS) break;
    tail.unshift(messages[i]);
  }
  const gap = { role: 'Note', text: `${messages.length - 1 - tail.length} earlier messages are left out here.` };
  return formatTranscript([...first, gap, ...tail], 'Conversation of the session you are advising');
}

async function askAdvisor(args) {
  if (!ADVISOR) throw new Error('No advisor is set for this terminal.');
  if (!/^[\w.[\]@-]{1,80}$/.test(ADVISOR)) throw new Error('The advisor model name is not valid.');
  const file = OWN_SESSION && fileByIdPrefix(OWN_SESSION);
  if (!file) throw new Error('This conversation has not been saved yet, so the advisor cannot read it. Try again after your next step.');
  const question = String(args.question || '').trim().slice(0, 4000);
  const input =
    advisorView(file) +
    '\n\n---\n\n' +
    'The session has just called you through its ask_advisor tool. That call is the one you are answering now. ' +
    (question ? `The session asks you: ${question}` : 'The session asks you to review its work so far and advise it on what to do next.');

  // Claude runs in this terminal's folder and with the user's own settings, so it signs in the same way
  // as the session, for example through Google Vertex.
  const shell = os.userInfo().shell || '/bin/zsh';
  const command =
    `${CLAUDE} -p --model "$CP_MODEL" --system-prompt "$CP_SYSTEM" --tools "" --strict-mcp-config --no-session-persistence`;
  const advice = await new Promise((done) => {
    const child = execFile(
      shell,
      ['-l', '-i', '-c', command],
      {
        cwd: process.cwd(),
        timeout: 300000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...strippedEnv(), CP_MODEL: ADVISOR, CP_SYSTEM: ADVISOR_SYSTEM },
      },
      (err, stdout, stderr) =>
        done(stdout.trim() ? { text: stdout.trim() } : { error: String(stderr || err?.message || 'No answer.').trim().slice(0, 400) })
    );
    child.stdin.end(input);
  });
  if (advice.error) throw new Error(`The advisor did not answer. ${advice.error}`);
  return `Advice from your advisor (${ADVISOR}):\n\n${advice.text}`;
}

// Asks the app itself to do something, through its local address.
async function askApp(route, body, timeoutMs = 40000) {
  if (!CONTROL || !TOKEN) throw new Error('This terminal was started before the app could open terminals. Restart it to use this.');
  const res = await fetch(CONTROL + route, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `The app answered with an error (${res.status}).`);
  return data;
}

async function listHarnesses() {
  const d = await askApp('/places');
  const lines = [];
  lines.push('Saved harnesses:', ...(d.harnesses.length ? d.harnesses.map((h) => `- ${h.name}: ${h.folder}`) : ['- none']));
  lines.push('', 'Folders the open terminals are using:', ...d.openTerminals.map((p) => `- terminal ${p.number} (${p.name}): ${p.folder}`));
  lines.push('', 'Recently used folders:', ...d.recentFolders.map((f) => `- ${f}`));
  return lines.join('\n');
}

async function openTerminal(args) {
  const background = args.background !== false;
  const wait = args.wait === true;
  const r = await askApp('/open', { from: SELF, task: args.task, harness: args.harness, folder: args.folder, background, wait });
  const where = background ? ' It runs in the background and is listed in the sidebar of the app.' : '';
  const how = wait
    ? `will hand in its report when it has finished. Call wait_for_report with terminal ${r.number} to get it.`
    : 'will send you a report with SendMessage when it has finished.';
  return `Opened terminal ${r.number} (${r.name}) in ${r.folder}.${where} It has started on the task and ${how} Tell the user you opened terminal ${r.number} and why.`;
}

// Asks the app about once a minute until every terminal has reported or the time runs out. Each ask
// is short, so no connection has to stay open for long.
async function waitForReport(args) {
  const minutes = Math.min(Math.max(Number(args.minutes) || 30, 1), 120);
  const until = Date.now() + minutes * 60000;
  const terminals = Array.isArray(args.terminals) ? args.terminals : [];
  let r;
  for (;;) {
    const left = until - Date.now();
    r = await askApp('/reports', { from: SELF, terminals, waitMs: Math.max(0, Math.min(50000, left)) }, 75000);
    if (r.done || Date.now() >= until) break;
  }
  const lines = [];
  const still = [];
  for (const t of r.terminals) {
    const who = t.name ? `Terminal ${t.number} (${t.name})` : `Terminal ${t.number}`;
    if (t.state === 'reported') lines.push(`Report from terminal ${t.number}${t.name ? ` (${t.name})` : ''}:\n${t.report}`);
    else if (t.state === 'closed') lines.push(`${who} is closed and did not report.`);
    else if (t.state === 'ended') lines.push(`${who} stopped without reporting.`);
    else if (t.state === 'by-message') lines.push(`${who} was not opened with wait set to true, so it reports with SendMessage instead.`);
    else {
      const doing = t.state === 'asking' ? 'is waiting for the user to approve something' : t.state === 'idle' ? 'is waiting for the user' : 'is still working';
      still.push(`${who} ${doing}.`);
    }
  }
  if (still.length) lines.push(`After ${minutes} minutes these have not reported yet. Call wait_for_report again to keep waiting.\n${still.join('\n')}`);
  return lines.join('\n\n');
}

async function callTool(name, args) {
  if (name === 'list_panels') return loadPanels().map(describePanel).join('\n') || 'No terminals are open.';
  if (name === 'list_harnesses') return listHarnesses();
  if (name === 'open_terminal') return openTerminal(args);
  if (name === 'wait_for_report') return waitForReport(args);
  if (name === 'ask_advisor') return askAdvisor(args);
  if (name === 'report_back') {
    const r = await askApp('/report', { from: SELF, report: args.report });
    return `Your report has been handed to terminal ${r.to} (${r.toName}). Now tell the user here what you did.`;
  }
  if (name === 'set_job') {
    const r = await askApp('/job', { from: SELF, title: args.title, access: args.access });
    return `Your job is "${r.title}" and it is ${r.access}. It has ${r.members} terminal${r.members === 1 ? '' : 's'} so far.`;
  }
  if (name === 'wrap_up_job') {
    const r = await askApp('/wrap-up', { from: SELF });
    return `Wrapped up "${r.title}". Closed ${r.closed} terminal${r.closed === 1 ? '' : 's'}. Their conversations are kept.`;
  }
  if (name === 'find_expert') return findExpert(args.task || '', Boolean(args.everywhere));
  if (name === 'ask_expert') return askExpert(args);

  const found = resolve(args.session);
  if (found.error) throw new Error(found.error);
  const { file, label } = found;
  // The session may be part of another terminal's closed job. Then the app asks the user first.
  if (found.panel && CONTROL && TOKEN) {
    const gate = await askApp('/gate', { from: SELF, to: String(found.panel.number), tool: name }, 290000);
    if (gate.decision === 'deny') throw new Error(gate.reason || 'Claude Panels did not allow this.');
  }
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
