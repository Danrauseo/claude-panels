// Runs in the background, outside the app window, so reading large session files never slows the
// terminals down. It keeps a short CV for every Claude Code session that has had enough requests,
// written by Haiku, so other sessions can find the right expert for a task.
//
// Settings come in through environment variables:
//   CP_CVS     the CV file to read and write
//   CP_CLAUDE  the command that starts Claude (default "claude")
//   CP_LIMIT   the most CVs to write in this run (for testing), default no limit
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { digestSession, digestText } = require('./digest');

const CVS = process.env.CP_CVS;
const CLAUDE = (process.env.CP_CLAUDE || 'claude').split(' ')[0];
const LIMIT = Number(process.env.CP_LIMIT) || Infinity;
const MIN_REQUESTS = 5; // a session needs this many requests before it gets a CV
const REWRITE_AFTER = 10; // rewrite the CV after this many more requests
const DAYS = 90; // only sessions used in this many days
const shell = os.userInfo().shell || '/bin/zsh';
const AUTO_NAME = /^\d+-[\w-]+$/; // the panel names the app gives sessions, such as 2-wrap

function load() {
  try {
    return JSON.parse(fs.readFileSync(CVS, 'utf8'));
  } catch {
    return { version: 1, sessions: {} };
  }
}

function save(store) {
  fs.mkdirSync(path.dirname(CVS), { recursive: true });
  fs.writeFileSync(CVS + '.tmp', JSON.stringify(store, null, 1));
  fs.renameSync(CVS + '.tmp', CVS); // so the app never reads a half-written file
}

function sessionFiles() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const out = [];
  for (const dir of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const full = path.join(root, dir);
    let names = [];
    try {
      names = fs.readdirSync(full);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(full, name);
      try {
        const st = fs.statSync(file);
        out.push({ id: name.slice(0, -6), file, size: st.size, updated: st.mtimeMs });
      } catch {}
    }
  }
  return out;
}

const SYSTEM =
  'You write a short CV for a Claude Code session, so that other Claude sessions can decide whether this ' +
  'session is the right expert to consult about a task. Write in plain English and use only what the record ' +
  'shows. Use exactly these five labels, each on its own line, followed by a sentence or a few short items:\n' +
  'Summary: one sentence on what this session is an expert in.\n' +
  'Worked on: the main pieces of work.\n' +
  'Knows: the files, folders, systems and tools it worked with.\n' +
  'Decisions: important choices it made, with the reason if the record gives one.\n' +
  'Unfinished: anything left open, or "Nothing noted".\n' +
  'Keep it under 170 words.';

function askHaiku(text) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_') && k !== 'ELECTRON_RUN_AS_NODE')
  );
  const command =
    `${CLAUDE} -p --model haiku --no-session-persistence --tools "" --setting-sources "" ` +
    '--system-prompt "$CP_SYSTEM" "$CP_TEXT"';
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-l', '-i', '-c', command],
      { cwd: os.tmpdir(), timeout: 120000, maxBuffer: 1024 * 1024, env: { ...env, CP_SYSTEM: SYSTEM, CP_TEXT: text } },
      (err, stdout) => resolve(err ? null : stdout.trim())
    );
  });
}

async function main() {
  const store = load();
  const cutoff = Date.now() - DAYS * 86400000;
  const digests = new Map();

  // Count each session's requests. Only files that changed since the last run are read again.
  for (const f of sessionFiles()) {
    if (f.updated < cutoff) continue;
    const e = store.sessions[f.id];
    if (e && e.size === f.size) continue;
    let d;
    try {
      d = digestSession(f.file);
    } catch {
      continue;
    }
    digests.set(f.id, d);
    store.sessions[f.id] = {
      ...(e || {}),
      size: f.size,
      updated: f.updated,
      cwd: d.cwd,
      requests: d.promptCount,
      compactions: d.compactions,
      contextTokens: d.contextTokens,
      title: d.customTitle && !AUTO_NAME.test(d.customTitle) ? d.customTitle : d.aiTitle || e?.title || null,
      file: f.file,
    };
  }
  save(store);

  // Write or refresh CVs, newest sessions first.
  const due = Object.entries(store.sessions)
    .filter(([, e]) => e.cwd && fs.existsSync(e.cwd) && e.requests >= MIN_REQUESTS && e.updated >= cutoff)
    .filter(([, e]) => !e.cv || e.requests >= (e.cvRequests || 0) + REWRITE_AFTER || e.compactions > (e.cvCompactions || 0))
    .sort((a, b) => b[1].updated - a[1].updated)
    .slice(0, LIMIT);

  for (const [id, e] of due) {
    const d = digests.get(id) || (fs.existsSync(e.file) ? digestSession(e.file) : null);
    if (!d) continue;
    const cv = await askHaiku(digestText(d, { title: e.title, cwd: e.cwd }));
    if (!cv || !/Summary:/i.test(cv)) continue;
    const summary = (cv.match(/Summary:\s*(.+)/i) || [])[1]?.trim() || '';
    const fresh = load(); // the app may have changed other entries meanwhile
    fresh.sessions[id] = {
      ...(fresh.sessions[id] || e),
      cv: cv.slice(cv.search(/Summary:/i)),
      summary,
      cvWrittenAt: Date.now(),
      cvRequests: e.requests,
      cvCompactions: e.compactions,
    };
    save(fresh);
    process.stdout.write(`CV written for ${id.slice(0, 8)}: ${summary}\n`);
  }
}

main().then(() => process.exit(0), (err) => {
  process.stderr.write(String(err?.stack || err) + '\n');
  process.exit(1);
});
