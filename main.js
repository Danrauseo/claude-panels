const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const http = require('http');
const { describeTool, resultText } = require('./lib/transcript');

// A separate settings folder can be set for testing, so a test copy never touches the installed app's settings.
if (process.env.CLAUDE_PANELS_PROFILE) app.setPath('userData', process.env.CLAUDE_PANELS_PROFILE);

// ---------- Settings ----------

const DEFAULT_PROMPTS = {
  open:
    'You are running inside Claude Panels, a plain terminal app with no code editor or file viewer. ' +
    'Whenever you create a file for the user (a document, report, page, spreadsheet, image, script or similar, ' +
    'but not temporary or scratch files), open it for them straight away by running `open "<absolute path>"`. ' +
    'Also give the full path in your reply.',
  link:
    'You are running inside Claude Panels, a plain terminal app with no code editor or file viewer. ' +
    'Do not open files yourself. Whenever you create or change a file for the user, end your reply with a ' +
    'short list of those files, each written as a full local link in the form file:///absolute/path/to/file ' +
    '(write any spaces in the path as %20) so the user can click it and open it when it suits them.',
};

const DEFAULT_SETTINGS = {
  fileMode: 'link', // 'open' | 'link' | 'off'
  prompts: { ...DEFAULT_PROMPTS },
  claudeCommand: 'claude',
  fontSize: 13,
  oddLayout: 'bottom', // where the last panel goes when an odd number are open: 'bottom' | 'side'
  workspace: [], // the open panels, saved so they can be restored with ⌘R
  harnesses: [], // [{ name, path }] started with /name
  recentLocations: [], // [path]
  autoTitles: true, // ask Haiku for a short title for each open session
  autoCVs: true, // keep a short CV for each session, so sessions can find experts for a task
  classicDisplay: false, // start Claude with its classic display, which keeps the whole conversation in the terminal
  titles: {}, // sessionId -> { title, basedOn, at }
};

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    if (saved.threeLayout && !saved.oddLayout) saved.oddLayout = saved.threeLayout === 'columns' ? 'side' : 'bottom';
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      prompts: { ...DEFAULT_PROMPTS, ...(saved.prompts || {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS, prompts: { ...DEFAULT_PROMPTS } };
  }
}

let settings;

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

function rememberRecent(dir) {
  settings.recentLocations = [dir, ...settings.recentLocations.filter((d) => d !== dir)].slice(0, 10);
  saveSettings();
}

// ---------- Terminals ----------

const terminals = new Map(); // id -> pty process
let nextId = 1;
let win;

// Apps opened from the Dock do not always get $SHELL, so read the user's shell from their account.
const userShell = os.userInfo().shell || process.env.SHELL || '/bin/zsh';

// Drop markers left by any Claude session that launched this app, so each panel starts as a fresh,
// top-level session. The login shell reloads the user's own profile, so their settings come back.
function cleanEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== 'CLAUDECODE' && !key.startsWith('CLAUDE_CODE_'))
  );
}

// Each terminal's Claude gets a small tool server for searching and reading other terminals'
// conversations. Inside the packaged app the server's files sit outside the app archive.
const registryFile = () => path.join(app.getPath('userData'), 'panels.json');
const cvsFile = () => path.join(app.getPath('userData'), 'cvs.json');
const mcpScript = path.join(__dirname, 'mcp', 'panels-mcp.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

// The list of open terminals that the tool server reads.
function writeRegistry(workspace) {
  fs.mkdirSync(path.dirname(registryFile()), { recursive: true });
  fs.writeFileSync(registryFile(), JSON.stringify({ updated: Date.now(), panels: workspace || [] }, null, 2));
}

function panelsPrompt(number, name) {
  let text =
    `You are running in Claude Panels as terminal ${number}, and your session name is ${name}. ` +
    'The other terminals in the app run other Claude sessions, each named by its number and harness, for example 2-wrap. ' +
    'When the user mentions one of them with @ (such as @2-wrap, or just @2), choose the best way to use it:\n' +
    '- To ask that session a question or tell it something, send it a message with SendMessage. ' +
    'It answers from what it knows, but it has to take a turn to do so.\n' +
    "- To find specific details in that session's conversation without interrupting it, use the panels search_session tool.\n" +
    '- When the user wants all of that context, use the panels read_session tool.\n' +
    'Use the panels list_panels tool if you are not sure which terminal the user means.\n\n' +
    'You can also open a new terminal with the panels open_terminal tool. It starts a new Claude session in the ' +
    'harness or folder you choose and gives it your task, and that session reports back to you with SendMessage. ' +
    'Use it when part of the work belongs in a different harness or folder, or when a separate piece of work can ' +
    'run alongside yours. Do not use it for small tasks you can do yourself. Call list_harnesses first to choose ' +
    'where it should run, and tell the user which terminal you opened and why.\n\n' +
    'The user often works in another terminal while you work, and the app shows your AskUserQuestion questions ' +
    'there as a card they can answer with one click. Plain questions in your replies do not appear there. So ' +
    'whenever you need the user to approve something, confirm a step or choose between options before you carry ' +
    'on, ask with the AskUserQuestion tool instead of ending your reply with a question. This includes every ' +
    'confirmation that this folder\'s instructions require. Put the recommended choice first, and keep each ' +
    "choice's label short. Questions that only need a free-text answer can still go in your reply.";
  if (settings.autoCVs !== false) {
    text +=
      '\n\nThe app keeps a short CV for past and present sessions. When you start a substantial new task, call the ' +
      'panels find_expert tool once with a sentence describing it. If it finds an expert session, use it cheapest ' +
      'first and stop when you have what you need: its CV, then the files it names (they may have changed since), ' +
      'then search_session for reasoning and details, and only then ask it, with SendMessage if it is open or ' +
      'ask_expert if it is closed. Asking a large session that has not been used recently is costly, so check with ' +
      'the user first when find_expert or ask_expert says so. Skip find_expert for small or quick tasks.';
  }
  return text;
}

function startTerminal({ cwd, cols, rows, resumeId, name, number, firstMessage }) {
  // New sessions get an id chosen here, so the app knows which saved session each panel is running.
  const sessionId = resumeId || crypto.randomUUID();
  if (!fs.existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);

  // The name goes in through an environment variable, so a name chosen with /rename can contain spaces.
  if (!/^[^\n\r"]{1,80}$/.test(name || '')) throw new Error('Not a valid session name');
  const filePrompt = settings.fileMode === 'off' ? '' : settings.prompts[settings.fileMode] || '';
  const prompt = [panelsPrompt(number, name), filePrompt].filter(Boolean).join('\n\n');

  const mcpConfig = {
    mcpServers: {
      panels: {
        type: 'stdio',
        command: process.execPath,
        args: [mcpScript],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          CLAUDE_PANELS_REGISTRY: registryFile(),
          CLAUDE_PANELS_SELF: String(number),
          CLAUDE_PANELS_CVS: cvsFile(),
          CLAUDE_PANELS_CLAUDE: settings.claudeCommand || 'claude',
          ...(control ? { CLAUDE_PANELS_CONTROL: control.url, CLAUDE_PANELS_TOKEN: control.token } : {}),
        },
      },
    },
  };

  // Long values go in through environment variables so they do not have to be quoted on the command line.
  let claudeLine = settings.claudeCommand || 'claude';
  claudeLine += ' --name "$CLAUDE_PANELS_NAME"';
  claudeLine += ' --mcp-config "$CLAUDE_PANELS_MCP" --allowedTools mcp__panels';
  claudeLine += ' --append-system-prompt "$CLAUDE_PANELS_PROMPT"';
  if (resumeId) {
    if (!/^[\w-]+$/.test(resumeId)) throw new Error('Not a valid session id');
    claudeLine += ` --resume ${resumeId}`;
  } else {
    claudeLine += ` --session-id ${sessionId}`;
    // A terminal opened by another terminal starts with that terminal's task as its first message.
    if (firstMessage) claudeLine += ' "$CLAUDE_PANELS_FIRST"';
  }

  // Run Claude first. When Claude exits, leave the user in a normal shell in the same folder.
  const script = `${claudeLine}; exec "${userShell}" -l -i`;

  const env = {
    ...cleanEnv(),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'ClaudePanels',
    LANG: process.env.LANG || 'en_GB.UTF-8',
    // The classic display keeps the whole conversation in the terminal, so normal drag-and-copy works.
    ...(settings.classicDisplay ? { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' } : {}),
    CLAUDE_PANELS_PROMPT: prompt,
    CLAUDE_PANELS_NAME: name,
    CLAUDE_PANELS_MCP: JSON.stringify(mcpConfig),
    ...(firstMessage && !resumeId ? { CLAUDE_PANELS_FIRST: String(firstMessage).slice(0, 8000) } : {}),
  };

  const proc = pty.spawn(userShell, ['-l', '-i', '-c', script], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd,
    env,
  });

  const id = nextId++;
  terminals.set(id, proc);
  proc.onData((data) => win && !win.isDestroyed() && win.webContents.send('pty:data', id, data));
  proc.onExit(({ exitCode }) => {
    terminals.delete(id);
    if (win && !win.isDestroyed()) win.webContents.send('pty:exit', id, exitCode);
  });

  rememberRecent(cwd);
  return { id, sessionId };
}

ipcMain.handle('pty:start', (_e, opts) => startTerminal(opts));

// ---------- Terminals that Claude opens ----------

// Claude in one terminal can open a new terminal for a task through the panels tool server. The tool
// server reaches the app through a small web server that only listens on this Mac and needs a secret
// that only the app's own terminals are given. Limits stop terminals from opening terminals without end.
const MAX_PANELS = 12; // no new terminals once this many are open
const MAX_OPENS = 4; // at most this many opened by Claude ...
const OPEN_WINDOW_MS = 10 * 60 * 1000; // ... in any ten minutes
let control = null; // { url, token } once the server is listening
const openTimes = [];
const openWaiting = new Map(); // request id -> resolve function

function openPanelsList() {
  try {
    return JSON.parse(fs.readFileSync(registryFile(), 'utf8')).panels || [];
  } catch {
    return [];
  }
}

function placesForClaude() {
  const open = openPanelsList();
  return {
    harnesses: settings.harnesses.map((h) => ({ name: h.name, folder: h.path })),
    openTerminals: open.map((p) => ({ number: p.number, name: p.name, folder: p.cwd })),
    recentFolders: settings.recentLocations.filter((d) => fs.existsSync(d)),
  };
}

async function openForClaude({ from, task, harness, folder }) {
  task = String(task || '').trim();
  if (!task) throw new Error('Give the new terminal a task.');
  if (task.length > 6000) throw new Error('The task is too long. Keep it under 6,000 characters.');
  const open = openPanelsList();
  const requester = open.find((p) => p.number === Number(from));
  if (!requester) throw new Error('Only a terminal that is open in Claude Panels can open another terminal.');
  if (requester.openedBy) {
    throw new Error(
      `This terminal was opened by terminal ${requester.openedBy}, so it cannot open more terminals. ` +
        'Ask the user, or tell the terminal that opened you, instead.'
    );
  }
  if (open.length >= MAX_PANELS) throw new Error(`${open.length} terminals are already open, which is the most allowed.`);
  while (openTimes.length && Date.now() - openTimes[0] > OPEN_WINDOW_MS) openTimes.shift();
  if (openTimes.length >= MAX_OPENS) {
    throw new Error(`${MAX_OPENS} terminals were opened in the last ten minutes, which is the most allowed. Ask the user first.`);
  }

  // Work out the folder from a saved harness name or a folder path.
  let dir = null;
  let harnessName = null;
  if (harness) {
    const want = String(harness).replace(/^\//, '').toLowerCase();
    const h = settings.harnesses.find((x) => x.name.toLowerCase() === want);
    if (h) {
      dir = h.path;
      harnessName = h.name;
    } else if (!folder) {
      throw new Error(`There is no harness called "${harness}". Call list_harnesses to see the harnesses and folders.`);
    }
  }
  if (!dir) {
    if (!folder) throw new Error('Choose a harness or a folder. Call list_harnesses to see them.');
    dir = path.resolve(String(folder).replace(/^~(?=$|\/)/, os.homedir()));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`That folder does not exist: ${dir}`);
  }
  if (!win || win.isDestroyed()) throw new Error('The Claude Panels window is not open.');

  openTimes.push(Date.now());
  const id = crypto.randomUUID();
  const result = await new Promise((resolve) => {
    openWaiting.set(id, resolve);
    win.webContents.send('panels:open-request', id, { from: requester.number, folder: dir, harnessName, task });
    setTimeout(() => resolve({ error: 'The app did not open the terminal in time.' }), 30000);
  });
  openWaiting.delete(id);
  if (result.error) throw new Error(result.error);
  return result;
}

ipcMain.on('panels:open-result', (_e, id, result) => openWaiting.get(id)?.(result || {}));

function startControlServer() {
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer(async (req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return reply(403, { error: 'Not allowed.' });
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 20000) return reply(413, { error: 'The request is too long.' });
    }
    try {
      const args = body ? JSON.parse(body) : {};
      if (req.url === '/places') return reply(200, placesForClaude());
      if (req.url === '/open') return reply(200, await openForClaude(args));
      reply(404, { error: 'Unknown request.' });
    } catch (err) {
      reply(400, { error: err.message });
    }
  });
  server.listen(0, '127.0.0.1', () => {
    control = { url: `http://127.0.0.1:${server.address().port}`, token };
  });
}
ipcMain.on('pty:write', (_e, id, data) => terminals.get(id)?.write(data));
ipcMain.on('pty:resize', (_e, id, cols, rows) => {
  try {
    terminals.get(id)?.resize(Math.max(cols, 2), Math.max(rows, 2));
  } catch {}
});
ipcMain.on('pty:kill', (_e, id) => {
  terminals.get(id)?.kill();
  terminals.delete(id);
});

// ---------- Past Claude sessions ----------

// Claude Code saves each session as a .jsonl file under ~/.claude/projects/<folder>/.
// Some files are tens of megabytes, so only the start and the end of each file are read.
// The start holds the folder and the first message. The end holds the latest title and prompt.
const CHUNK = 128 * 1024;
const sessionCache = new Map(); // file path -> { key, info }
const sessionFiles = new Map(); // session id -> file path

function readChunk(fd, start, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, start);
  return buf.toString('utf8', 0, n);
}

function messageText(entry) {
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.find((c) => c.type === 'text')?.text;
  return undefined;
}

function readSessionInfo(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = readChunk(fd, 0, Math.min(size, CHUNK));
    const tail = size > CHUNK ? readChunk(fd, size - CHUNK, CHUNK) : head;
    const info = {};

    for (const line of head.split('\n')) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!info.cwd && entry.cwd) info.cwd = entry.cwd;
      if (!info.firstPrompt && entry.type === 'user' && !entry.isMeta && !entry.isSidechain) {
        const text = messageText(entry)?.trim();
        if (text && !text.startsWith('<')) info.firstPrompt = text.slice(0, 300);
      }
      if (info.cwd && info.firstPrompt) break;
    }

    const tailLines = tail.split('\n');
    if (size > CHUNK) tailLines.shift(); // the first line is cut off part way through
    for (const line of tailLines) {
      if (!/"(custom-title|ai-title|last-prompt)"|"cwd"/.test(line)) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type === 'custom-title') info.customTitle = entry.customTitle;
      if (entry.type === 'ai-title') info.aiTitle = entry.aiTitle;
      if (entry.type === 'last-prompt') info.lastPrompt = entry.lastPrompt?.slice(0, 300);
      if (!info.cwd && entry.cwd) info.cwd = entry.cwd;
    }
    return info;
  } finally {
    fs.closeSync(fd);
  }
}

function listSessions() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) return [];
  const sessions = [];
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const dirPath = path.join(root, dir.name);
    for (const name of fs.readdirSync(dirPath)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dirPath, name);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      const key = `${stat.size}:${stat.mtimeMs}`;
      let cached = sessionCache.get(file);
      if (!cached || cached.key !== key) {
        try { cached = { key, info: readSessionInfo(file, stat.size) }; } catch { continue; }
        sessionCache.set(file, cached);
      }
      const { info } = cached;
      const id = name.slice(0, -'.jsonl'.length);
      sessionFiles.set(id, file);
      // The app names each session after its panel, such as "2-wrap". That name replaces Claude's own
      // title, so prefer Claude's descriptive title over a panel name when listing sessions.
      const panelName = /^\d+-[\w-]+$/.test(info.customTitle || '');
      const title = (panelName ? null : info.customTitle) || info.aiTitle || info.lastPrompt || info.firstPrompt || info.customTitle;
      if (!info.cwd || !title) continue; // empty sessions that never got a message
      sessions.push({
        id,
        cwd: info.cwd,
        title: title.replace(/\s+/g, ' ').trim(),
        customTitle: info.customTitle || null,
        aiTitle: info.aiTitle || null,
        firstPrompt: info.firstPrompt || '',
        lastPrompt: info.lastPrompt || '',
        updated: stat.mtimeMs,
        created: stat.birthtimeMs,
        folderExists: fs.existsSync(info.cwd),
      });
    }
  }
  return sessions.sort((a, b) => b.updated - a.updated);
}

ipcMain.handle('sessions:list', () => listSessions());

// What a running session is doing now. Reads the end of its file and finds the latest tool call.
// If that call has no result yet, Claude is still running it.
// Walks the end of the session file in order and works out:
// - working: Claude is in the middle of a turn (a turn ends with a "turn_duration" entry)
// - pending: a tool call that has no result yet, so it is running now
// - background: commands Claude started in the background that have not reported back yet
function readActivity(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  let text;
  try {
    text = readChunk(fd, Math.max(0, size - 2 * CHUNK), Math.min(size, 2 * CHUNK));
  } finally {
    fs.closeSync(fd);
  }
  const lines = text.split('\n');
  if (size > 2 * CHUNK) lines.shift();

  const pending = new Map();
  const background = new Map();
  const calls = new Map();
  let working = false;
  let last = null;

  for (const line of lines) {
    if (!/"type":"(user|assistant|system)"/.test(line)) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry.message?.content;

    if (entry.type === 'system') {
      if (entry.subtype === 'turn_duration') {
        working = false;
        pending.clear();
      }
    } else if (entry.type === 'assistant' && Array.isArray(content)) {
      working = true;
      for (const c of content) {
        if (c.type !== 'tool_use') continue;
        const call = {
          text: describeTool(c),
          background: Boolean(c.input?.run_in_background),
          agent: c.name === 'Agent' || c.name === 'Task',
          description: c.input?.description || 'Subagent',
          since: entry.timestamp ? Date.parse(entry.timestamp) : Date.now(),
        };
        calls.set(c.id, call);
        pending.set(c.id, call);
        last = call.text;
      }
    } else if (entry.type === 'user') {
      if (typeof content === 'string') {
        const done = content.match(/<tool-use-id>([\w-]+)<\/tool-use-id>/);
        if (done) background.delete(done[1]);
        if (done) pending.delete(done[1]);
        else if (!content.startsWith('<')) working = true;
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'tool_result') {
            pending.delete(c.tool_use_id);
            const call = calls.get(c.tool_use_id);
            if (call && (call.background || /running in (the )?background|async agent launched/i.test(resultText(c)))) {
              background.set(c.tool_use_id, call);
            }
          } else if (c.type === 'text' && !c.text.startsWith('<')) {
            working = true;
          }
        }
      }
    }
  }
  // Subagents still working: ones Claude is waiting on, and ones it started in the background.
  const agents = [...pending.values(), ...background.values()]
    .filter((c) => c.agent)
    .map((c) => ({ description: c.description, since: c.since }));
  return {
    working,
    pending: [...pending.values()].filter((c) => !c.agent).map((c) => c.text).pop() || null,
    background: [...background.values()].filter((c) => !c.agent).map((c) => c.text),
    agents,
    last,
  };
}

// Which other terminals a session has mentioned: "@2" or "@2-wrap" typed by the user, messages
// Claude sent to another session, and the panels search and read tools. Files can be large, so
// each one is read once and then only the new part is read on later checks.
const mentionCache = new Map(); // file -> { offset, rest, refs: Map<key, { number, name }> }

function addRef(refs, number, name) {
  const key = name || String(number);
  if (!key || key === 'null') return;
  if (!refs.has(key)) refs.set(key, { number, name: name || null });
}

function scanMentions(entry, refs) {
  const content = entry.message?.content;
  if (entry.type === 'user' && !entry.isMeta) {
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text) : [];
    for (const text of texts) {
      if (!text || text.trimStart().startsWith('<')) continue;
      for (const m of text.matchAll(/(?:^|[\s(])@"?(\d+)(-[\w-]+)?/g)) addRef(refs, Number(m[1]), m[2] ? m[1] + m[2] : null);
      // A session renamed with spaces is mentioned in quotes, for example @"linear tickets".
      for (const m of text.matchAll(/(?:^|[\s(])@"([^"\n]+)"/g)) if (!/^\d/.test(m[1])) addRef(refs, null, m[1]);
    }
  } else if (entry.type === 'assistant' && Array.isArray(content)) {
    for (const c of content) {
      if (c.type !== 'tool_use') continue;
      const target = c.name === 'SendMessage' ? c.input?.to : /^mcp__panels__(search|read)_session$/.test(c.name) ? c.input?.session : null;
      // SendMessage targets look like "15-template-cli [45bf02]". Drop the short id at the end.
      const clean = String(target || '').trim().replace(/^@/, '').replace(/\s*\[[0-9a-f]+\]$/, '');
      const m = clean.match(/^(\d+)(-[\w-]+)?$/);
      if (m) addRef(refs, Number(m[1]), m[2] ? m[1] + m[2] : null);
      else if (clean && c.name === 'SendMessage' && !/^[0-9a-f]{12,}$/.test(clean)) addRef(refs, null, clean);
    }
  }
}

function readMentions(file) {
  const size = fs.statSync(file).size;
  let cached = mentionCache.get(file);
  if (!cached || size < cached.offset) cached = { offset: 0, rest: '', refs: new Map() };
  if (size > cached.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      const text = cached.rest + readChunk(fd, cached.offset, size - cached.offset);
      const lines = text.split('\n');
      cached.rest = lines.pop(); // the last line may not be finished yet
      for (const line of lines) {
        if (!/"type":"(user|assistant)"/.test(line) || !line.includes('@') && !line.includes('"tool_use"')) continue;
        try { scanMentions(JSON.parse(line), cached.refs); } catch {}
      }
    } finally {
      fs.closeSync(fd);
    }
    cached.offset = size;
    mentionCache.set(file, cached);
  }
  return [...cached.refs.values()];
}

ipcMain.handle('sessions:mentions', (_e, ids) => {
  if (ids.some((id) => !sessionFiles.has(id))) listSessions();
  const result = {};
  for (const id of ids) {
    const file = sessionFiles.get(id);
    if (!file) continue;
    try { result[id] = readMentions(file); } catch {}
  }
  return result;
});

ipcMain.handle('sessions:activity', (_e, ids) => {
  if (ids.some((id) => !sessionFiles.has(id))) listSessions();
  const result = {};
  for (const id of ids) {
    const file = sessionFiles.get(id);
    if (!file) continue;
    try { result[id] = readActivity(file); } catch {}
  }
  return result;
});

// ---------- Copying Claude's last reply (⌘⇧C) ----------

// Copies everything Claude wrote after your latest message, straight from the saved session, so the
// copy is complete however long the reply is and whatever the terminal is showing.
ipcMain.handle('reply:copy', (_e, sessionId) => {
  if (sessionId && !sessionFiles.has(sessionId)) listSessions();
  const file = sessionId && sessionFiles.get(sessionId);
  if (!file) return { error: 'This terminal has no saved conversation yet.' };
  const parts = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!/"type":"(user|assistant)"/.test(line)) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.isSidechain || entry.isMeta) continue;
    const content = entry.message?.content;
    if (entry.type === 'user') {
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('') : '';
      if (text.trim() && !text.trimStart().startsWith('<')) parts.length = 0; // a new request: start again
    } else if (Array.isArray(content)) {
      for (const c of content) if (c.type === 'text' && c.text.trim()) parts.push(c.text.trim());
    }
  }
  if (!parts.length) return { error: 'Claude has not replied yet.' };
  const text = parts.join('\n\n');
  clipboard.writeText(text);
  return { lines: text.split('\n').length, chars: text.length };
});

// ---------- Settings, folders and files ----------

ipcMain.handle('settings:get', () => ({
  ...settings,
  defaultPrompts: DEFAULT_PROMPTS,
  home: os.homedir(),
  appVersion: app.getVersion(),
}));
ipcMain.handle('settings:set', (_e, changes) => {
  settings = { ...settings, ...changes };
  saveSettings();
  if (changes.workspace) writeRegistry(changes.workspace);
  if (changes.autoCVs === true) setTimeout(runCVWorker, 1000);
  return settings;
});

// ⌘U: pick one or more files (or folders) to put into a terminal.
ipcMain.handle('file:pick', async (_e, fallbackDir) => {
  const start = [settings.lastUploadDir, fallbackDir, os.homedir()].find((d) => d && fs.existsSync(d));
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose files to add to the terminal',
    buttonLabel: 'Add',
    defaultPath: start,
    properties: ['openFile', 'openDirectory', 'multiSelections', 'showHiddenFiles'],
  });
  if (result.canceled || !result.filePaths.length) return [];
  settings.lastUploadDir = path.dirname(result.filePaths[0]);
  saveSettings();
  return result.filePaths;
});

ipcMain.handle('folder:choose', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose where to start Claude',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('folder:exists', (_e, dir) => fs.existsSync(dir));
ipcMain.handle('path:isDir', (_e, p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
});

ipcMain.handle('file:open', async (_e, target) => {
  if (/^https?:\/\//i.test(target)) return shell.openExternal(target);
  let filePath = target;
  if (filePath.startsWith('file://')) filePath = decodeURIComponent(new URL(filePath).pathname);
  if (filePath.startsWith('~')) filePath = path.join(os.homedir(), filePath.slice(1));
  if (!fs.existsSync(filePath)) return `Not found: ${filePath}`;
  return shell.openPath(filePath);
});

// ---------- Short titles for sessions ----------

// Claude Code does not write its own title for a session that has a name, and the app names each
// session after its panel so @2 works. So the app asks Haiku for a short title instead.
let titleBusy = false;

ipcMain.handle('title:make', async (_e, { sessionId, text, basedOn }) => {
  if (titleBusy || !settings.autoTitles) return null;
  titleBusy = true;
  try {
    const command =
      `${(settings.claudeCommand || 'claude').split(' ')[0]} -p --model haiku --no-session-persistence ` +
      `--tools "" --setting-sources "" --system-prompt "$CP_SYSTEM" "$CP_TEXT"`;
    const title = await new Promise((resolve) => {
      execFile(
        userShell,
        ['-l', '-i', '-c', command],
        {
          cwd: os.tmpdir(),
          timeout: 60000,
          env: {
            ...cleanEnv(),
            CP_SYSTEM: 'You write short titles. Reply with the title only: 3 to 6 words, no quotes, no full stop.',
            CP_TEXT: `Write a title for a work session with these requests from the user:\n\n${text.slice(0, 2000)}`,
          },
        },
        (err, stdout) => resolve(err ? null : stdout.trim().split('\n').pop().replace(/^["']|["'.]$/g, '').slice(0, 80))
      );
    });
    if (!title) return null;
    settings.titles = { ...(settings.titles || {}), [sessionId]: { title, basedOn, at: Date.now() } };
    saveSettings();
    return title;
  } finally {
    titleBusy = false;
  }
});

// ---------- Session CVs ----------

// A separate process writes the CVs, so reading large session files never slows the terminals down.
// It runs a minute after the app starts and then every ten minutes, one run at a time.
const cvWorker = path.join(__dirname, 'lib', 'cv-worker.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
let cvRun = null;

function runCVWorker() {
  if (cvRun || settings.autoCVs === false) return;
  cvRun = spawn(process.execPath, [cvWorker], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CP_CVS: cvsFile(), CP_CLAUDE: settings.claudeCommand || 'claude' },
    stdio: 'ignore',
  });
  cvRun.on('exit', () => {
    cvRun = null;
    send('cvs:changed');
  });
}

app.on('will-quit', () => cvRun?.kill());

// The CVs, for ⌘K and the stack view: session id -> { summary, cv, requests, contextTokens }.
// After your first message in a new terminal, suggest one strong expert from the same folder.
const { rankExperts } = require('./lib/experts');
ipcMain.handle('experts:suggest', (_e, { sessionId, cwd, text, openIds }) => {
  try {
    const cvs = JSON.parse(fs.readFileSync(cvsFile(), 'utf8')).sessions || {};
    const best = rankExperts({ task: text, here: cwd, cvs, excludeIds: [sessionId, ...(openIds || [])] })[0];
    if (!best || best.score < 0.6 || best.hits < 2) return null;
    return { id: best.id, title: best.e.title || null, summary: best.e.summary || '', cwd: best.e.cwd };
  } catch {
    return null;
  }
});

ipcMain.handle('cvs:get', () => {
  try {
    const sessions = JSON.parse(fs.readFileSync(cvsFile(), 'utf8')).sessions || {};
    const out = {};
    for (const [id, e] of Object.entries(sessions)) {
      if (e.cv) out[id] = { summary: e.summary, cv: e.cv, requests: e.requests, contextTokens: e.contextTokens };
    }
    return out;
  } catch {
    return {};
  }
});

// ---------- Updates ----------

// Updates come from GitHub releases. The app compares the latest release on GitHub with its own
// version. To update, it moves the folder it was built from to that release, then rebuilds,
// reinstalls and restarts itself. The build records which folder that is.
const buildInfo = (() => {
  try {
    return require('./package.json');
  } catch {
    return {};
  }
})();
const sourceDir = buildInfo.sourceDir || (app.isPackaged ? null : __dirname);

function git(args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', sourceDir, ...args], { timeout: 60000 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim())
    );
  });
}

// "owner/repo" from the folder's GitHub remote, so a fork checks its own releases.
async function githubRepo() {
  const fromUrl = (url) => (String(url || '').match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?\/?$/) || [])[1];
  try {
    const repo = fromUrl(await git(['remote', 'get-url', 'origin']));
    if (repo) return repo;
  } catch {}
  return fromUrl(buildInfo.repository?.url);
}

// True when version a is newer than version b, comparing numbers such as 0.2.10 and 0.2.9.
function isNewer(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

let updateRunning = false;

async function checkForUpdate() {
  if (!sourceDir || !fs.existsSync(path.join(sourceDir, '.git')) || updateRunning) return null;
  try {
    const repo = await githubRepo();
    if (!repo) return null;
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'claude-panels' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null; // no releases yet, or GitHub could not be reached
    const release = await res.json();
    const tag = String(release.tag_name || '');
    const version = tag.replace(/^v/, '');
    if (!/^[\w.-]+$/.test(tag) || !isNewer(version, app.getVersion())) return null;
    return {
      tag,
      version,
      current: app.getVersion(),
      name: release.name || tag,
      notes: String(release.body || '').trim().slice(0, 1500),
      url: release.html_url,
    };
  } catch {
    return null; // offline: stay quiet and try again later
  }
}

ipcMain.handle('update:check', () => checkForUpdate());

// Runs a step in the user's login shell so git, node and npm are found as they are in Terminal.
function runStep(label, command, extraEnv = {}) {
  send('update:progress', label);
  return new Promise((resolve, reject) => {
    const child = spawn(userShell, ['-l', '-c', command], { cwd: sourceDir, env: { ...cleanEnv(), ...extraEnv } });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${label} failed:\n${output.slice(-1500)}`))));
  });
}

ipcMain.handle('update:run', async (_e, workspace, tag) => {
  if (updateRunning) return { error: 'An update is already running.' };
  if (!/^[\w.-]+$/.test(tag || '')) return { error: 'No release was chosen.' };
  updateRunning = true;
  try {
    // Move the folder's branch forward to the release. This refuses to throw away local changes.
    // npm rewrites package-lock.json on some Macs, so that one file is put back first.
    await runStep(
      'Downloading the new version…',
      'git checkout -- package-lock.json 2>/dev/null; git fetch --tags --quiet && git merge --ff-only --quiet "refs/tags/$CP_TAG"',
      { CP_TAG: tag }
    );
    await runStep('Installing the parts the app needs…', 'npm install && (git checkout -- package-lock.json 2>/dev/null; true)');
    await runStep('Building and signing the app. This takes a few minutes…', 'npm run dist');

    if (!app.isPackaged) {
      send('update:progress', 'Built. A test copy does not reinstall itself.');
      return { done: true };
    }

    // Replace this app with the new build, then restart it and bring the terminals back.
    send('update:progress', 'Installing the new version…');
    const bundle = path.resolve(path.dirname(app.getPath('exe')), '..', '..');
    const builtApp = ['mac-arm64', 'mac']
      .map((dir) => path.join(sourceDir, 'dist', dir, 'Claude Panels.app'))
      .filter((p) => fs.existsSync(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (!builtApp) throw new Error('The build finished but the new app could not be found.');
    await new Promise((resolve, reject) =>
      execFile('ditto', [builtApp, bundle + '.new'], (err) => (err ? reject(err) : resolve()))
    );
    fs.rmSync(bundle, { recursive: true, force: true });
    fs.renameSync(bundle + '.new', bundle);

    settings = { ...settings, workspace: workspace || settings.workspace, restoreOnLaunch: true };
    saveSettings();
    for (const proc of terminals.values()) proc.kill();
    app.relaunch();
    app.exit(0);
    return { done: true };
  } catch (err) {
    return { error: err.message };
  } finally {
    updateRunning = false;
  }
});

// ---------- Window and menu ----------

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function buildMenu() {
  const template = [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => send('menu:check-update') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Terminal',
      submenu: [
        { label: 'New Terminal', accelerator: 'CmdOrCtrl+N', click: () => send('menu:new') },
        { label: 'Find a Past Session', accelerator: 'CmdOrCtrl+K', click: () => send('menu:search') },
        { label: 'Choose a Folder', accelerator: 'CmdOrCtrl+O', click: () => send('menu:browse') },
        { label: 'Add Files to Terminal', accelerator: 'CmdOrCtrl+U', click: () => send('menu:upload') },
        { label: 'Close Terminal', accelerator: 'CmdOrCtrl+W', click: () => send('menu:close') },
        { type: 'separator' },
        { label: 'Stack View', accelerator: 'CmdOrCtrl+S', click: () => send('menu:stack') },
        { label: 'Resume Terminals From Last Time', accelerator: 'CmdOrCtrl+R', click: () => send('menu:restore') },
        { label: 'Fill Window With Panel', accelerator: 'CmdOrCtrl+F', click: () => send('menu:zoom') },
        { label: 'Move Odd Panel to Bottom or Side', accelerator: 'CmdOrCtrl+L', click: () => send('menu:layout') },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send('menu:settings') },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { label: "Copy Claude's Last Reply", accelerator: 'CmdOrCtrl+Shift+C', click: () => send('menu:copy-reply') },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [{ role: 'togglefullscreen' }, { role: 'toggleDevTools' }],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: () => send('menu:shortcuts') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 600,
    minHeight: 400,
    backgroundColor: '#0f1115',
    titleBarStyle: 'hiddenInset',
    title: 'Claude Panels',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Links clicked inside the page open in the normal browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Ask before closing the window or quitting while sessions are still running.
  let confirmedClose = false;
  win.on('close', (e) => {
    if (confirmedClose || terminals.size === 0) return;
    e.preventDefault();
    const count = terminals.size;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Quit', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `Quit Claude Panels?`,
      detail: `${count} terminal${count === 1 ? ' is' : 's are'} still open. Quitting stops ${count === 1 ? 'it' : 'them'}, including any Claude sessions. Press ⌘R next time you open the app to resume them.`,
    });
    if (choice === 0) {
      confirmedClose = true;
      app.quit();
    }
  });

  win.on('closed', () => {
    for (const proc of terminals.values()) proc.kill();
    terminals.clear();
    win = null;
  });
}

app.whenReady().then(() => {
  settings = loadSettings();
  writeRegistry([]); // nothing is open yet
  startControlServer();
  buildMenu();
  createWindow();
  // Look for updates shortly after starting, then every six hours.
  const announce = async () => {
    const update = await checkForUpdate();
    if (update) send('update:available', update);
  };
  setTimeout(announce, 15000);
  setTimeout(runCVWorker, 60000);
  setInterval(runCVWorker, 10 * 60 * 1000);
  setInterval(announce, 6 * 60 * 60 * 1000);
  app.on('activate', () => {
    if (!win) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
