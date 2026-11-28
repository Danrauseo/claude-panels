/* global Terminal, FitAddon, WebLinksAddon, Explain */

const api = window.panelsApi;
const grid = document.getElementById('grid');
const emptyState = document.getElementById('empty');
const layoutBtn = document.getElementById('layout-btn');
const statusLine = document.getElementById('statusline');
const bgHost = document.getElementById('bg-host');
const sidebar = document.getElementById('sidebar');
const sideList = document.getElementById('side-list');
const sideBtn = document.getElementById('side-btn');
const peekEl = document.getElementById('peek');
const peekBody = document.getElementById('peek-body');
const filterChip = document.getElementById('filter-chip');
const filterName = document.getElementById('filter-name');
const zoomChip = document.getElementById('zoom-chip');
const zoomName = document.getElementById('zoom-name');
const navChip = document.getElementById('nav-chip');
const stackEl = document.getElementById('stack');
const stackCards = document.getElementById('stack-cards');

let settings = null;
// Each panel: { el, head, body, ptyId, term, fit, cwd, running, sessionId, harnessName, title, picker }
const panels = [];
const byPtyId = new Map();
const pendingData = new Map(); // output that arrives before a panel knows its id
let focused = null;
let view = 'grid'; // 'grid' shows terminals, 'stack' shows one card per open harness
let filterKey = null; // when set, only terminals in this harness are shown
const reportWaiters = new Set(); // wait_for_report checks to run when a report comes in or a terminal changes
let zoomed = null; // when set, this one panel fills the window
// Moving between mentioned sessions. Each level remembers the panel you came from (the mother),
// the sessions it mentioned (its children), which child is showing, and what was showing before.
let navStack = []; // [{ mother, children, index, before }]
const mentionMap = new Map(); // panel -> the open panels its session has mentioned
// ⌘⇧↓ shows one group at once: the panel you started from and every session it mentioned.
let family = null; // { mother, members }
let restorable = []; // panels open when the app last closed, restored with ⌘R
// Background sessions run in terminals with no panel on screen. They are listed in the sidebar, and one at a
// time can be looked at in the peek drawer.
let peeked = null; // the background panel shown in the peek drawer
let sidebarOpen = false;
let backgroundCount = 0;
let busyCount = 0; // panels on screen that are running subagents, last time the sidebar was drawn
// A job is one piece of work, done by terminals that one terminal (its owner) has opened. An owner can
// have several jobs. A job's id maps to { id, owner, title, named, access: 'closed' | 'open', members,
// requests: [], wrapping, used }, where members is a Set of terminal numbers. A terminal can be in more
// than one job, for example when another job's terminal gives it work. Wrapping up a job closes only the
// terminals that no other job uses. In a closed job, other terminals need the user's permission to use a member.
const jobs = new Map();
let nextJobId = 1;

// Terminal colours for each colour scheme in Settings. "claude" uses the warm greys, cream text and orange
// of claude.ai, with a matching set of the 16 standard terminal colours.
const TERM_THEMES = {
  blue: {
    background: '#12151b',
    foreground: '#e4e7ec',
    cursor: '#9fb4ff',
    cursorAccent: '#12151b',
    selectionBackground: '#2b3a63',
  },
  claude: {
    background: '#262624',
    foreground: '#ece9e0',
    cursor: '#d97757',
    cursorAccent: '#262624',
    selectionBackground: '#5a4237',
    black: '#1f1e1d',
    red: '#e0705a',
    green: '#8db86f',
    yellow: '#e3b25e',
    blue: '#7fa3d6',
    magenta: '#c48fc4',
    cyan: '#74b5ad',
    white: '#c2c0b6',
    brightBlack: '#75726a',
    brightRed: '#f08a74',
    brightGreen: '#a6cf86',
    brightYellow: '#f0c97a',
    brightBlue: '#9dbbe6',
    brightMagenta: '#d6a8d6',
    brightCyan: '#93cbc4',
    brightWhite: '#faf9f5',
  },
};

// Claude Code puts ⎿ before each tool result. With Settings > Simple > Hide the ⎿ symbol, the app shows a
// space instead. Both take one cell, so nothing else on the screen moves.
function plainOutput(data) {
  return settings.simple?.plainSymbols ? data.replace(/\u23BF/g, ' ') : data;
}

// Output goes through the panel's term marker when Explain terms is on, so glossary terms are underlined.
function writeOutput(panel, data) {
  if (panel.marker) panel.marker.push(plainOutput(data));
  else panel.term.write(plainOutput(data));
  if (panel.friendly) drawLivePreview(panel);
}

// Fonts that come with the app, in renderer/fonts. They are free fonts under the SIL Open Font License.
const BUNDLED_FONTS = ['JetBrains Mono', 'Geist Mono', 'IBM Plex Mono'];

// Wait for the bundled fonts, so a terminal never measures its letters with a stand-in font.
function loadBundledFonts() {
  return Promise.all(BUNDLED_FONTS.flatMap((f) => [document.fonts.load(`13px "${f}"`), document.fonts.load(`bold 13px "${f}"`)])).catch(() => {});
}

// Fixed-width fonts the Font menu also offers, if they are installed on this Mac.
const MONO_FONTS = [
  'SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code', 'IBM Plex Mono', 'Source Code Pro', 'Cascadia Code',
  'Berkeley Mono', 'Geist Mono', 'Commit Mono', 'Iosevka', 'Hack', 'Roboto Mono', 'DM Mono', 'PT Mono',
  'Andale Mono', 'Courier New',
];
let installedFontList = null;

// A font is installed if text drawn in it is a different width from text in the fallback fonts.
function installedFonts() {
  if (installedFontList) return installedFontList;
  const ctx = document.createElement('canvas').getContext('2d');
  const sample = 'mmmmmmmmmmlliWW@#0O';
  const width = (font) => {
    ctx.font = `40px ${font}`;
    return ctx.measureText(sample).width;
  };
  const bases = ['monospace', 'sans-serif', 'serif'].map((b) => [b, width(b)]);
  const local = MONO_FONTS.filter((f) => !BUNDLED_FONTS.includes(f) && bases.some(([b, w]) => width(`"${f}", ${b}`) !== w));
  if (!local.includes('Menlo')) local.unshift('Menlo');
  installedFontList = [...BUNDLED_FONTS, ...local];
  return installedFontList;
}

// SF Mono comes inside Apple's Terminal app, so other apps such as this one can use it only once it is
// installed in Font Book. Menlo is on every Mac.
function termFont(name = settings?.fontFamily) {
  return `"${name || 'JetBrains Mono'}", Menlo, monospace`;
}

function termTheme() {
  return TERM_THEMES[settings?.theme === 'blue' ? 'blue' : 'claude'];
}

function applyTheme() {
  document.body.classList.toggle('theme-claude', settings.theme !== 'blue');
  for (const p of panels) if (p.term) p.term.options.theme = termTheme();
}

// ---------- Helpers ----------

function tildePath(p) {
  return settings && p.startsWith(settings.home) ? '~' + p.slice(settings.home.length) : p;
}

function expandTilde(p) {
  return p.startsWith('~') ? settings.home + p.slice(1) : p;
}

function baseName(p) {
  const parts = p.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '/';
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function timeAgo(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(ms).toLocaleDateString();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function saveSettings(changes) {
  settings = { ...settings, ...(await api.setSettings(changes)) };
}

// ---------- Keyboard list ----------

// A text box with a list under it. Arrow keys move the selection and Enter runs the selected item.
// build(query) returns entries. An entry is either { group } for a heading or an item with a run() function.
class KeyList {
  constructor(input, listEl, build) {
    this.input = input;
    this.listEl = listEl;
    this.build = build;
    this.selected = 0;
    this.items = [];
    this.message = null;
    input.addEventListener('input', () => {
      this.selected = 0;
      this.message = null;
      this.render();
    });
  }

  render() {
    const entries = this.build(this.input.value);
    this.items = entries.filter((e) => e.run);
    this.selected = Math.max(0, Math.min(this.selected, this.items.length - 1));
    this.listEl.innerHTML = '';
    for (const entry of entries) {
      if (entry.group) {
        this.listEl.append(el('div', 'group', entry.group));
        continue;
      }
      if (entry.note) {
        this.listEl.append(el('div', 'none', entry.note));
        continue;
      }
      const index = this.items.indexOf(entry);
      const row = el('div', 'item' + (entry.when ? ' two-line' : ''));
      if (entry.when) {
        const top = el('div', 'row');
        if (entry.harness) {
          const pill = el('span', 'harness', entry.harness);
          pill.style.setProperty('--hue', harnessColour(entry.harness));
          top.append(pill);
        }
        top.append(el('span', 'label', entry.label), el('span', 'when', entry.when));
        row.append(top, el('div', 'detail', entry.detail || ''));
      } else {
        row.append(el('span', 'label', entry.label), el('span', 'detail', entry.detail || ''));
      }
      row.title = entry.title || '';
      row.classList.toggle('selected', index === this.selected);
      row.addEventListener('mousemove', () => {
        if (this.selected !== index) {
          this.selected = index;
          this.highlight();
        }
      });
      row.addEventListener('click', () => entry.run());
      this.listEl.append(row);
    }
    if (this.message) this.listEl.append(el('div', 'error', this.message));
  }

  highlight() {
    this.listEl.querySelectorAll('.item').forEach((row, i) => row.classList.toggle('selected', i === this.selected));
    this.listEl.querySelectorAll('.item')[this.selected]?.scrollIntoView({ block: 'nearest' });
  }

  showMessage(text) {
    this.message = text;
    this.render();
  }

  // Returns true when the key was used.
  handleKey(e) {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      this.selected = Math.min(this.selected + 1, this.items.length - 1);
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      this.selected = Math.max(this.selected - 1, 0);
    } else if (e.key === 'Enter') {
      this.items[this.selected]?.run();
      return true;
    } else {
      return false;
    }
    this.highlight();
    return true;
  }
}

// ---------- Layout ----------

// Rows and columns for an even spread of panels.
function gridFor(count) {
  const rows = count <= 2 ? 1 : count <= 8 ? 2 : 3;
  return { cols: Math.max(1, Math.ceil(count / rows)), rows };
}

function visiblePanels() {
  if (zoomed && panels.includes(zoomed) && !zoomed.inBackground) return [zoomed];
  if (family) return family.members.filter((p) => panels.includes(p) && !p.inBackground);
  return panels.filter((p) => !p.inBackground && (!filterKey || !p.cwd || groupOf(p).key === filterKey));
}

// ⌘F makes the selected panel fill the window. Pressing it again shows the other panels again.
function toggleZoom() {
  if (view !== 'grid' || focused?.inBackground) return;
  navStack = [];
  zoomed = zoomed ? null : focused;
  applyLayout();
  setFocus(focused);
}

function applyLayout() {
  const shown = visiblePanels();
  const n = shown.length;
  const odd = n >= 3 && n % 2 === 1;
  const bottom = settings.oddLayout !== 'side';

  emptyState.hidden = panels.some((p) => !p.inBackground) || view === 'stack';
  layoutBtn.hidden = !odd || view === 'stack' || Boolean(zoomed);
  layoutBtn.title = bottom
    ? 'The last panel is at the bottom. Click to move it to the side (⌘L)'
    : 'The last panel is at the side. Click to move it to the bottom (⌘L)';

  let cols;
  let rows;
  if (odd) {
    // Lay out all but the last panel evenly, then give the last panel a full row or a full column.
    ({ cols, rows } = gridFor(n - 1));
    if (bottom) rows += 1;
    else cols += 1;
  } else {
    ({ cols, rows } = gridFor(n));
  }
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;

  for (const p of panels) {
    const i = shown.indexOf(p);
    p.el.classList.toggle('in-background', Boolean(p.inBackground));
    drawBackgroundButton(p);
    if (p.inBackground) {
      // Kept off screen or in the peek drawer, at a real size, so the terminal keeps its width.
      p.el.style.display = '';
      p.el.style.gridColumn = '';
      p.el.style.gridRow = '';
      p.head.querySelector('.num').textContent = p.number <= 9 ? `⌘${p.number}` : `${p.number}`;
      continue;
    }
    p.el.style.display = i === -1 ? 'none' : '';
    const last = odd && i === n - 1;
    p.el.style.gridColumn = last ? (bottom ? '1 / -1' : `${cols}`) : '';
    p.el.style.gridRow = last ? (bottom ? `${rows}` : '1 / -1') : '';
    // Numbers stay the same when a harness filter is on, so ⌘2 and @2 always mean the same terminal.
    p.head.querySelector('.num').textContent = p.number <= 9 ? `⌘${p.number}` : `${p.number}`;
  }

  if (zoomed && !panels.includes(zoomed)) zoomed = null;
  navStack = navStack.filter((lvl) => panels.includes(lvl.mother) && lvl.children.some((c) => panels.includes(c)));
  if (family && !panels.includes(family.mother)) family = null;
  navChip.hidden = (!navStack.length && !family) || view === 'stack';
  if (!navStack.length && family) {
    const others = family.members.filter((p) => p !== family.mother && panels.includes(p)).length;
    navChip.innerHTML = '';
    navChip.append(
      el('b', null, family.mother.name || `Panel ${family.mother.number}`),
      el('span', null, ` and ${others} mentioned session${others === 1 ? '' : 's'} `),
      el('kbd', null, '⌘↑'),
      el('span', null, ' back')
    );
  }
  if (navStack.length) {
    const top = navStack[navStack.length - 1];
    navChip.innerHTML = '';
    navChip.append(
      el('span', null, `${top.mother.name || 'Panel ' + top.mother.number} mentioned `),
      el('b', null, top.children[top.index].name || `panel ${top.children[top.index].number}`),
      el('span', null, `  ${top.index + 1} of ${top.children.length} `),
      el('kbd', null, '⌘← ⌘→'),
      el('span', null, ' switch '),
      el('kbd', null, '⌘↑'),
      el('span', null, ' back')
    );
  }
  zoomChip.hidden = !zoomed || view === 'stack' || navStack.length > 0;
  if (zoomed) zoomName.textContent = `Panel ${zoomed.number}`;
  filterChip.hidden = !filterKey || view === 'stack' || Boolean(zoomed) || Boolean(family);
  if (filterKey) filterName.textContent = groupByKey(filterKey)?.name || '';
}

async function toggleOddLayout() {
  await saveSettings({ oddLayout: settings.oddLayout === 'side' ? 'bottom' : 'side' });
  applyLayout();
}

function setFocus(panel) {
  focused = panel;
  panels.forEach((p) => p.el.classList.toggle('focused', p === panel));
  if (panel?.friendly && panel.fv) panel.fv.input.focus();
  else if (panel?.term) panel.term.focus();
  else if (panel?.picker) panel.picker.input.focus();
}

// ---------- Panels ----------

function isUnstarted(panel) {
  return panel && panel.ptyId === null && !panel.launching;
}

// Each panel keeps its number for as long as it is open, so ⌘2 and the session name "2-…" never move
// to a different terminal when another one closes. A new panel takes the lowest free number.
function freeNumber(wanted) {
  const used = new Set(panels.map((p) => p.number));
  if (Number.isInteger(wanted) && wanted > 0 && !used.has(wanted)) return wanted;
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

// The name other sessions use to reach this one, for example "2-wrap". Claude Code allows letters,
// digits, hyphens and underscores in a name you can @-mention without quotes.
function sessionName(panel) {
  const label = slug(panel.harnessName || baseName(panel.cwd || '')) || 'session';
  return `${panel.number}-${label}`.slice(0, 40);
}

// A quiet panel, opened by Claude in another terminal, leaves the view and focus as they are.
// A panel opened in the background has no place on screen and is listed in the sidebar instead.
function addPanel(wantedNumber, { quiet = false, inBackground = false } = {}) {
  if (!quiet) {
    if (view === 'stack') showGrid();
    zoomed = null;
    navStack = [];
    family = null;
  }
  const panel = { ptyId: null, term: null, fit: null, cwd: null, running: false, sessionId: null, harnessName: null };
  panel.number = freeNumber(wantedNumber);

  panel.el = el('div', 'panel');
  panel.head = el('div', 'panel-head');
  panel.head.append(
    el('span', 'num'),
    el('span', 'own-light'),
    el('span', 'harness'),
    el('span', 'code-badge'),
    el('span', 'title', 'New terminal'),
    el('span', 'path'),
    el('span', 'agents'),
    el('span', 'expert'),
    el('span', 'mentions'),
    el('span', 'status')
  );
  // Fill and close buttons show when the mouse is over the panel, or when the panel is selected.
  const actions = el('span', 'head-actions');
  const fillBtn = el('button', 'head-btn');
  fillBtn.title = 'Fill the window, or show all panels again (⌘F)';
  fillBtn.innerHTML = '<svg viewBox="0 0 16 16"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  fillBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setFocus(panel);
    toggleZoom();
  });
  const closeBtn = el('button', 'head-btn close');
  closeBtn.title = 'Close (⌘W)';
  closeBtn.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closePanel(panel);
  });
  panel.bgBtn = el('button', 'head-btn');
  panel.bgBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleBackground(panel);
  });
  fillBtn.classList.add('fill-btn');
  actions.append(panel.bgBtn, fillBtn, closeBtn);
  panel.head.append(actions);
  panel.body = el('div', 'panel-body');
  panel.el.append(panel.head, panel.body);
  panel.el.addEventListener('mousedown', () => {
    if (focused !== panel) setFocus(panel);
  });
  // Dropping files adds their paths to this terminal. Dropping a folder on a new terminal starts Claude there.
  panel.el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    panel.el.classList.add('drop-target');
  });
  panel.el.addEventListener('dragleave', (e) => {
    if (!panel.el.contains(e.relatedTarget)) panel.el.classList.remove('drop-target');
  });
  panel.el.addEventListener('drop', (e) => {
    e.preventDefault();
    panel.el.classList.remove('drop-target');
    dropFiles(panel, [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean));
  });

  // Keep panels in number order on screen.
  // Background panels are kept elsewhere, so only a panel that is in the grid can mark the place.
  const at = panels.findIndex((p) => p.number > panel.number);
  const next = panels.find((p) => p.number > panel.number && p.el.parentNode === grid);
  grid.insertBefore(panel.el, next ? next.el : null);
  if (at === -1) panels.push(panel);
  else panels.splice(at, 0, panel);
  applyLayout();
  showPicker(panel);
  if (inBackground) setBackground(panel, true);
  if (!quiet) setFocus(panel);
  return panel;
}

function closePanel(panel, { confirmed = false } = {}) {
  if (!panel) return;
  if (!confirmed && panel.running && !confirm('Close this terminal? Anything running in it, including Claude, will stop.')) return;
  if (panel.ptyId !== null) {
    api.kill(panel.ptyId);
    byPtyId.delete(panel.ptyId);
  }
  if (panel.fvSession) api.unwatchFriendly(panel.fvSession);
  if (peeked === panel) hidePeek(false);
  panel.term?.dispose();
  panel.resizeObserver?.disconnect();
  panel.el.remove();
  const i = panels.indexOf(panel);
  panels.splice(i, 1);
  if (zoomed === panel) zoomed = null;
  if (filterKey && !panels.some((p) => p.cwd && groupOf(p).key === filterKey)) filterKey = null;
  applyLayout();
  const shown = visiblePanels();
  // A job ends when its owner closes or its last member closes.
  for (const job of [...jobs.values()]) {
    if (job.owner === panel.number) endJob(job.id);
    else if (job.members.delete(panel.number) && !job.wrapping && !jobMembers(job).length) endJob(job.id);
  }
  if (focused === panel || !panels.includes(focused)) setFocus(shown.includes(panels[i]) ? panels[i] : shown[shown.length - 1] || null);
  saveWorkspace();
  drawStatusLine();
  if (view === 'stack') renderStack();
}

// ---------- New terminal picker with slash commands ----------

function harnessEntries(panel, filter) {
  return settings.harnesses
    .map((h) => ({ ...h, slug: slug(h.name) }))
    .filter((h) => !filter || h.slug.includes(filter) || h.path.toLowerCase().includes(filter))
    .map((h) => ({
      label: '/' + h.slug,
      detail: tildePath(h.path),
      title: h.path,
      run: () => launch(panel, h.path, { title: h.name, harnessName: h.name }),
    }));
}

function commandEntries(panel, typed, arg) {
  const commands = [
    { cmd: 'browse', label: '/browse', detail: 'Choose a folder (⌘O)', run: () => browse(panel) },
    { cmd: 'home', label: '/home', detail: 'Start in your home folder', run: () => launch(panel, settings.home) },
    {
      cmd: 'add',
      label: '/add ' + (arg || 'name'),
      detail: 'Choose a folder and save it as a harness',
      run: () => addHarnessFromPicker(panel, arg),
    },
  ];
  return commands.filter((c) => c.cmd.startsWith(typed));
}

function buildPickerEntries(panel, query) {
  const q = query.trim();
  const entries = [];
  const savedPaths = new Set(settings.harnesses.map((h) => h.path));
  const recent = settings.recentLocations.filter((p) => !savedPaths.has(p));
  const recentEntry = (dir) => ({
    label: baseName(dir),
    detail: tildePath(dir),
    title: dir,
    run: () => launch(panel, dir),
  });

  const looksLikePath = q.startsWith('~') || (q.startsWith('/') && q.indexOf('/', 1) !== -1);

  if (looksLikePath) {
    entries.push({ label: 'Start here', detail: q, run: () => launch(panel, expandTilde(q)) });
    return entries;
  }

  if (q.startsWith('/')) {
    const [typed, ...rest] = q.slice(1).split(/\s+/);
    const cmd = typed.toLowerCase();
    const arg = rest.join(' ');
    const harnesses = cmd === 'add' ? [] : harnessEntries(panel, cmd);
    const commands = commandEntries(panel, cmd, arg);
    if (harnesses.length) entries.push({ group: 'Harnesses' }, ...harnesses);
    if (commands.length) entries.push({ group: 'Commands' }, ...commands);
    if (!entries.length) entries.push({ note: `No harness called /${typed}. Type /add ${typed} to create one.` });
    return entries;
  }

  if (!q) {
    const harnesses = harnessEntries(panel);
    if (harnesses.length) entries.push({ group: 'Harnesses' }, ...harnesses);
    if (recent.length) entries.push({ group: 'Recent folders' }, ...recent.slice(0, 6).map(recentEntry));
    entries.push({ group: 'Commands' }, ...commandEntries(panel, ''));
    return entries;
  }

  const filter = q.toLowerCase();
  const harnesses = harnessEntries(panel, filter);
  const recents = recent.filter((p) => p.toLowerCase().includes(filter)).map(recentEntry);
  if (harnesses.length) entries.push({ group: 'Harnesses' }, ...harnesses);
  if (recents.length) entries.push({ group: 'Recent folders' }, ...recents);
  if (!entries.length) entries.push({ note: 'Nothing matches. Type / to see harnesses and commands.' });
  return entries;
}

function showPicker(panel) {
  panel.body.innerHTML = '';
  const picker = el('div', 'picker');
  const inner = el('div', 'picker-inner');
  const input = el('input', 'cmd-input');
  input.placeholder = 'Type / for a harness, or paste a folder path';
  input.spellcheck = false;
  const list = el('div', 'list');
  const hints = el('div', 'hints');
  hints.innerHTML = '<kbd>↑</kbd><kbd>↓</kbd> choose &nbsp; <kbd>↵</kbd> start Claude &nbsp; <kbd>⌘O</kbd> browse &nbsp; <kbd>esc</kbd> close';
  inner.append(input, list, hints);
  picker.append(inner);
  panel.body.append(picker);

  const keyList = new KeyList(input, list, (q) => buildPickerEntries(panel, q));
  input.addEventListener('keydown', (e) => {
    if (keyList.handleKey(e)) e.preventDefault();
    else if (e.key === 'Escape') closePanel(panel);
  });
  panel.picker = { input, keyList };
  keyList.render();
}

function refreshPickers() {
  panels.filter((p) => p.picker).forEach((p) => p.picker.keyList.render());
}

async function browse(panel) {
  const dir = await api.chooseFolder();
  if (dir) launch(panel, dir);
  else panel.picker?.input.focus();
}

async function addHarnessFromPicker(panel, name) {
  if (!name || !slug(name)) {
    panel.picker.keyList.showMessage('Type a name after /add, for example /add notes');
    return;
  }
  const dir = await api.chooseFolder();
  if (!dir) return panel.picker?.input.focus();
  await addHarness(name, dir);
  launch(panel, dir, { title: slug(name), harnessName: slug(name) });
}

async function addHarness(name, dir) {
  const old = settings.harnesses.find((h) => slug(h.name) === slug(name));
  const others = settings.harnesses.filter((h) => h !== old);
  // Adding a harness again with the same name keeps its options and changes its folder.
  const { name: _n, path: _p, ...options } = old || {};
  await saveSettings({ harnesses: [...others, { ...options, name: slug(name), path: dir }] });
}

// ---------- Session search (⌘K) ----------

const searchDialog = document.getElementById('search-dialog');
const searchInput = document.getElementById('search-input');
let sessions = null;
let cvs = {}; // session id -> { summary, cv }, written in the background by the app

function buildSearchEntries(query) {
  if (!sessions) return [{ note: 'Loading sessions…' }];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matchesAll = (text) => words.every((w) => text.toLowerCase().includes(w));

  // Open terminals come first. Choosing one takes you to it.
  const openPanels = panels.filter(
    (p) => p.cwd && matchesAll(`${p.number} ${p.name || ''} ${p.about || ''} ${p.title || ''} ${p.harnessName || ''} ${p.cwd}`)
  );
  const openIds = new Set(panels.map((p) => p.sessionId).filter(Boolean));
  const entries = [];
  if (openPanels.length) {
    entries.push({ group: 'Open terminals' });
    for (const p of openPanels) {
      entries.push({
        label: `${p.number} · ${p.about || p.title}`,
        harness: p.harnessName || baseName(p.cwd),
        when: p.running ? 'open' : 'ended',
        detail: tildePath(p.cwd),
        title: p.cwd,
        run: () => {
          searchDialog.close();
          if (view === 'stack') showGrid();
          showPanel(p);
        },
      });
    }
  }

  const matches = sessions.filter(
    (s) =>
      !openIds.has(s.id) &&
      matchesAll(`${displayTitle(s)} ${s.title} ${s.firstPrompt} ${s.lastPrompt} ${s.cwd} ${cvs[s.id]?.cv || ''}`)
  );
  if (matches.length) entries.push({ group: 'Past sessions' });
  if (!entries.length) return [{ note: 'No terminals or sessions match.' }];
  return entries.concat(matches.slice(0, 150).map((s) => ({
    label: displayTitle(s),
    harness: harnessLabelFor(s.cwd),
    when: timeAgo(s.updated),
    detail:
      (cvs[s.id]?.summary ? `${cvs[s.id].summary}  ·  ` : '') +
      tildePath(s.cwd) +
      (s.folderExists ? '' : '  (folder no longer exists)'),
    title: cvs[s.id]?.cv || `${s.cwd}\nSession ${s.id}`,
    run: () => resumeSession(s),
  })));
}

const searchList = new KeyList(searchInput, document.getElementById('search-list'), buildSearchEntries);
searchInput.addEventListener('keydown', (e) => {
  if (searchList.handleKey(e)) e.preventDefault();
});
searchDialog.addEventListener('close', () => setFocus(focused));

async function openSearch() {
  if (searchDialog.open) return searchDialog.close();
  searchInput.value = '';
  searchList.selected = 0;
  searchList.message = null;
  searchList.render();
  searchDialog.showModal();
  [sessions, cvs] = await Promise.all([api.listSessions(), api.getCVs()]);
  searchList.render();
}

function resumeSession(session) {
  if (!session.folderExists) {
    searchList.showMessage(`Can't resume this session because its folder no longer exists: ${session.cwd}`);
    return;
  }
  searchDialog.close();
  if (view === 'stack') showGrid();
  const open = panels.find((p) => p.sessionId === session.id && p.running);
  if (open) return showPanel(open);
  const panel = isUnstarted(focused) ? focused : addPanel();
  launch(panel, session.cwd, { resumeId: session.id, title: session.title, name: session.customTitle });
}

// ---------- Terminal ----------

function openLinkTarget(target) {
  api.openFile(target).then((result) => {
    if (result) console.warn(result);
  });
}

// Claude breaks long lines itself, so a long path can run over several rows. A row that fills the
// full width and ends in a non-space character is treated as carrying on into the next row, with the
// next row's leading indent removed. Returns the joined text and the screen cell for each character.
function readLogicalLine(term, row) {
  const buffer = term.buffer.active;
  const text = (y) => buffer.getLine(y)?.translateToString(true) ?? '';
  const carriesOn = (y) => {
    const t = text(y);
    return t.length >= term.cols && /\S$/.test(t) && y + 1 < buffer.length;
  };

  let first = row;
  while (first > 0 && carriesOn(first - 1)) first--;

  let joined = '';
  const cells = [];
  for (let y = first; ; y++) {
    const t = text(y);
    const startX = y === first ? 0 : t.search(/\S|$/);
    for (let x = startX; x < t.length; x++) {
      joined += t[x];
      cells.push({ x: x + 1, y: y + 1 });
    }
    if (!carriesOn(y)) break;
  }
  return { joined, cells };
}

// Makes file:// links and absolute file paths in Claude's output clickable.
function registerFileLinks(term) {
  const pattern =
    /(file:\/\/\/[^\s'"`<>)\]]+|(?<![\w/.])(?:~\/|\/)(?:[\w.\-@%+]+\/)*[\w\-@%+][\w.\-@%+]*\.[A-Za-z0-9]{1,8})/g;
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const { joined, cells } = readLogicalLine(term, y - 1);
      const links = [];
      for (const match of joined.matchAll(pattern)) {
        const value = match[0].replace(/[.,:;]+$/, '');
        const start = cells[match.index];
        const end = cells[match.index + value.length - 1];
        if (y < start.y || y > end.y) continue;
        links.push({
          range: { start, end },
          text: value,
          activate: () => openLinkTarget(value),
        });
      }
      callback(links.length ? links : undefined);
    },
  });
}

// ---------- Friendly view ----------

// A plainer way to look at a session, for people who find the terminal daunting. It shows the same live
// session as a readable conversation, built from the file Claude Code saves it in: what you asked, what
// Claude said, and one plain line for each thing Claude did, such as "Reading a file" or "Running a
// command". The terminal keeps running underneath, out of sight, so ⌘E always shows it again, and
// approvals and questions still come from it as cards. It is turned on for each harness in Settings.

const baseOf = (p) => String(p || '').split('/').filter(Boolean).pop() || '';
const humanise = (name) =>
  String(name || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();

// One plain line for a tool call: what Claude is doing now, a short detail, and how to count it once done.
function friendlyStep(name, input = {}) {
  const host = () => {
    try {
      return new URL(input.url).hostname;
    } catch {
      return '';
    }
  };
  if (name === 'Read') return { now: 'Reading a file', detail: baseOf(input.file_path), count: ['read', 'file', 'files'] };
  if (name === 'Edit' || name === 'MultiEdit') return { now: 'Changing a file', detail: baseOf(input.file_path), count: ['changed', 'file', 'files'] };
  if (name === 'Write') return { now: 'Writing a file', detail: baseOf(input.file_path), count: ['wrote', 'file', 'files'] };
  if (name === 'NotebookEdit') return { now: 'Changing a notebook', detail: baseOf(input.file_path), count: ['changed', 'notebook', 'notebooks'] };
  if (name === 'Bash') return { now: 'Running a command', detail: input.description || input.command, count: ['ran', 'command', 'commands'] };
  if (name === 'Grep') return { now: 'Searching the files', detail: input.pattern ? `for "${input.pattern}"` : '', count: ['searched'] };
  if (name === 'Glob') return { now: 'Looking for files', detail: input.pattern, count: ['searched'] };
  if (name === 'WebFetch') return { now: 'Reading a web page', detail: host(), count: ['read', 'web page', 'web pages'] };
  if (name === 'WebSearch') return { now: 'Searching the web', detail: input.query, count: ['searched the web'] };
  if (name === 'Task' || name === 'Agent') return { now: 'Asking a helper', detail: input.description, count: ['asked', 'helper', 'helpers'] };
  if (name === 'TodoWrite') {
    const todos = input.todos || [];
    const done = todos.filter((t) => t.status === 'completed').length;
    return { now: 'Updating its plan', detail: todos.length ? `${done} of ${todos.length} steps done` : '', count: ['updated its plan'] };
  }
  if (name === 'AskUserQuestion') return { now: 'Asking you a question', detail: input.question, count: ['asked you a question'] };
  if (name === 'Skill') return { now: 'Using a skill', detail: input.skill, count: ['used a skill'] };
  if (name === 'ToolSearch') return { now: 'Getting a tool ready', detail: '', count: null };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    if (mcp[1] === 'panels') return { now: 'Working with your other terminals', detail: humanise(mcp[2]), count: ['worked with your other terminals'] };
    const service = mcp[1].replace(/_/g, ' ');
    return { now: `Using ${service}`, detail: humanise(mcp[2]), count: [`used ${service}`] };
  }
  return { now: `Using ${humanise(name)}`, detail: '', count: [`used ${humanise(name)}`] };
}

// "Read 3 files, changed 1 file and ran 2 commands", from the steps in a finished group.
function friendlySummary(steps) {
  const tally = new Map();
  for (const s of steps) {
    if (!s.count) continue;
    const key = s.count.join('|');
    tally.set(key, { count: s.count, n: (tally.get(key)?.n || 0) + 1 });
  }
  const parts = [...tally.values()].map(({ count: [verb, one, many], n }) => {
    if (!one) return n > 1 && verb === 'searched' ? `searched ${n} times` : verb;
    return n === 1 ? `${verb} a ${one}` : `${verb} ${n} ${many}`;
  });
  if (!parts.length) return 'Got ready';
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  return text[0].toUpperCase() + text.slice(1);
}

// A small part of Markdown, enough for Claude's replies: paragraphs, headings, lists, bold, inline code,
// code blocks and tables. Everything is escaped first, so nothing in a reply can run as code.
function friendlyMarkdown(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a data-href="$2">$1</a>');
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      out.push(`<pre>${esc(code.join('\n'))}</pre>`);
    } else if (/^\s*\|/.test(line)) {
      const rows = [line];
      while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) rows.push(lines[++i]);
      out.push(`<pre>${esc(rows.join('\n'))}</pre>`);
    } else if (/^#{1,6}\s/.test(line)) {
      out.push(`<div class="fv-h">${inline(line.replace(/^#+\s*/, ''))}</div>`);
    } else if (/^\s*([-*•]|\d+\.)\s+/.test(line)) {
      const items = [line];
      while (i + 1 < lines.length && /^\s*([-*•]|\d+\.)\s+/.test(lines[i + 1])) items.push(lines[++i]);
      const tag = /^\s*\d+\./.test(line) ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it.replace(/^\s*([-*•]|\d+\.)\s+/, ''))}</li>`).join('')}</${tag}>`);
    } else if (line.trim()) {
      const para = [line];
      while (i + 1 < lines.length && lines[i + 1].trim() && !/^(```|#{1,6}\s|\s*([-*•|]|\d+\.)\s)/.test(lines[i + 1])) para.push(lines[++i]);
      out.push(`<p>${inline(para.join(' '))}</p>`);
    }
  }
  return out.join('');
}

// Underlines glossary terms in a reply when Explain terms is on, using the same tooltips as the terminal.
function friendlyTerms(panel, root) {
  const key = panel.glossaryKey;
  const matcher = key && matcherFor(key);
  if (!matcher) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('pre, code, .fv-term') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const found = Explain.findTerms(node.textContent, matcher);
    if (!found.length) continue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const f of found) {
      frag.append(node.textContent.slice(at, f.start));
      const span = el('span', `fv-term ${termProgress(key, f.key)}`, f.text);
      span.addEventListener('mouseenter', (e) => tipHover(key, f.key, e));
      span.addEventListener('mouseleave', () => tipLeave());
      frag.append(span);
      at = f.end;
    }
    frag.append(node.textContent.slice(at));
    node.replaceWith(frag);
  }
}

function buildFriendly(panel) {
  const view = el('div', 'friendly');
  const log = el('div', 'fv-log');
  // Shown where Claude's reply will appear, while you wait for it: three pulsing dots, and the reply as
  // the terminal draws it, until the saved conversation catches up.
  const working = el('div', 'fv-working');
  const dots = el('span', 'fv-dots');
  dots.append(el('i'), el('i'), el('i'));
  const preview = el('div', 'fv-preview');
  working.append(dots, preview);
  working.hidden = true;
  const compose = el('div', 'fv-compose');
  const input = el('textarea');
  input.rows = 1;
  input.placeholder = 'Tell Claude what you need';
  const send = el('button', 'btn primary', 'Send');
  send.type = 'button';
  const stop = el('button', 'btn', 'Stop');
  stop.type = 'button';
  stop.title = 'Stop Claude, the same as pressing Esc in the terminal';
  stop.hidden = true;
  const toTerminal = el('button', 'link-btn', 'Show the terminal ⌘E');
  toTerminal.type = 'button';
  compose.append(input, stop, send);
  const foot = el('div', 'fv-foot');
  foot.append(toTerminal);
  const screen = el('div', 'fv-screen');
  screen.hidden = true;
  view.append(log, screen, compose, foot);

  const submit = () => {
    const text = input.value.replace(/\s+$/, '');
    if (!text || !panel.running) return;
    // A message with several lines goes in as a paste, so its new lines do not send it early. Return is
    // sent a moment later, so Claude Code takes it as pressing Return rather than part of the text.
    api.write(panel.ptyId, text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
    setTimeout(() => api.write(panel.ptyId, '\r'), 80);
    input.value = '';
    input.style.height = '';
    panel.fv.stick = true;
    panel.fv.awaiting = true;
    drawFriendlyWorking(panel);
    log.scrollTop = log.scrollHeight;
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && panel.lightState === 'working') {
      api.write(panel.ptyId, '\x1b');
    }
  });
  input.addEventListener('input', () => {
    input.style.height = '';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  });
  send.addEventListener('click', submit);
  stop.addEventListener('click', () => api.write(panel.ptyId, '\x1b'));
  toTerminal.addEventListener('click', () => setFriendly(panel, false));
  log.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-href]');
    if (a) return openLinkTarget(a.dataset.href);
    const head = e.target.closest('.fv-activity-head');
    if (head) head.parentElement.classList.toggle('open');
  });
  // Follow new messages, unless you have scrolled up to read something earlier.
  log.addEventListener('scroll', () => {
    panel.fv.stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  });

  panel.fv = { view, log, working, preview, screen, input, stop, steps: new Map(), group: null, stick: true, awaiting: false };
  panel.body.append(view);
}

function friendlyGroupHead(group) {
  const running = group.steps.filter((s) => !s.done);
  group.head.innerHTML = '';
  if (running.length) {
    const s = running.at(-1);
    group.head.append(el('span', 'fv-pulse', s.now));
    if (s.detail) group.head.append(el('span', 'fv-detail', s.detail));
  } else {
    group.head.append(el('span', 'fv-chevron', '›'), el('span', null, friendlySummary(group.steps)));
    if (group.steps.some((s) => s.error)) group.head.append(el('span', 'fv-detail', 'one step did not work, so Claude tried another way'));
  }
}

function addFriendlyItems(panel, items) {
  const fv = panel.fv;
  for (const item of items) {
    if (item.kind === 'text' || item.kind === 'note' || item.kind === 'error') {
      fv.awaiting = false;
      fv.preview.textContent = '';
    }
    if (item.kind === 'note' || item.kind === 'error') {
      fv.group = null;
      fv.log.append(el('div', `fv-note ${item.kind}`, item.text));
    } else if (item.kind === 'user' || item.kind === 'text') {
      fv.group = null;
      const node = el('div', item.kind === 'user' ? 'fv-user' : 'fv-text');
      if (item.kind === 'user') node.textContent = item.text;
      else {
        node.innerHTML = friendlyMarkdown(item.text);
        friendlyTerms(panel, node);
      }
      fv.log.append(node);
    } else if (item.kind === 'tool') {
      if (!fv.group) {
        const box = el('div', 'fv-activity');
        fv.group = { box, head: el('div', 'fv-activity-head'), list: el('div', 'fv-steps'), steps: [] };
        box.append(fv.group.head, fv.group.list);
        fv.log.append(box);
      }
      const step = { ...friendlyStep(item.name, item.input), done: false, group: fv.group };
      const row = el('div', 'fv-step');
      row.append(el('span', null, step.now));
      if (step.detail) row.append(el('span', 'fv-detail', step.detail));
      row.title = item.input.command || item.input.file_path || item.input.url || '';
      fv.group.list.append(row);
      fv.group.steps.push(step);
      fv.steps.set(item.id, step);
      friendlyGroupHead(fv.group);
    } else if (item.kind === 'result') {
      const step = fv.steps.get(item.id);
      if (!step) continue;
      step.done = true;
      step.error = item.error;
      fv.steps.delete(item.id);
      friendlyGroupHead(step.group);
    }
  }
  // Keep only the latest part of a very long conversation on the page.
  while (fv.log.childElementCount > 600) fv.log.firstElementChild.remove();
  drawFriendlyWorking(panel);
  if (fv.stick) fv.log.scrollTop = fv.log.scrollHeight;
}

// "Working" shows while Claude is busy and no step is running, for example while it writes a reply.
function drawFriendlyWorking(panel) {
  const fv = panel.fv;
  if (!fv) return;
  const busy = panel.running && (panel.lightState === 'working' || fv.awaiting);
  const stepRunning = fv.steps.size > 0;
  fv.working.hidden = !busy || stepRunning;
  fv.stop.hidden = !busy;
  // Always the last thing in the conversation, where the reply will appear.
  if (fv.log.lastElementChild !== fv.working) fv.log.append(fv.working);
}

// Claude Code saves a reply once it is written, but draws it in the terminal as it goes. While you wait,
// the friendly view shows the reply as drawn so far, faintly, read from the bottom of the screen: the
// lines after Claude Code's last ⏺ mark, if that mark starts text rather than a tool call. It is checked
// at most four times a second, and only while Claude is working.
function readLivePreview(panel) {
  const b = panel.term.buffer.active;
  const rows = [];
  for (let y = 0; y < panel.term.rows; y++) rows.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
  let start = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (/^\s*⏺\s/.test(rows[i])) {
      start = i;
      break;
    }
  }
  if (start < 0 || /^\s*⏺\s+[\w.:-]+(\s[\w.:-]+)?\(/.test(rows[start])) return '';
  const lines = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    if (i > start && (/^\s*[─━╭╰]{8,}/.test(r) || /^\s*[⏺✻✶✳✢·*]\s/.test(r) || /^\S/.test(r))) break;
    lines.push(r.replace(/^\s*⏺\s/, '').replace(/^ {2}/, ''));
  }
  // The terminal breaks lines at its width. Join them back into paragraphs, keeping list items apart.
  let text = '';
  for (const line of lines) {
    const t = line.trim();
    if (!t) text += '\n\n';
    else if (!text || text.endsWith('\n') || /^([-*•]|\d+\.)\s/.test(t)) text += (text && !text.endsWith('\n') ? '\n' : '') + t;
    else text += ' ' + t;
  }
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function drawLivePreview(panel) {
  const fv = panel.fv;
  if (!fv || fv.previewTimer) return;
  fv.previewTimer = setTimeout(() => {
    fv.previewTimer = null;
    const busy = panel.lightState === 'working' || fv.awaiting;
    const text = busy && fv.steps.size === 0 ? readLivePreview(panel) : '';
    // Once the saved conversation has the reply, the preview has done its job.
    const last = [...fv.log.querySelectorAll('.fv-text')].at(-1)?.textContent.replace(/\s+/g, ' ') || '';
    const flat = text.replace(/\s+/g, ' ').slice(0, 60);
    fv.preview.textContent = flat && last.includes(flat) ? '' : text;
    if (fv.stick) fv.log.scrollTop = fv.log.scrollHeight;
  }, 250);
}

// Some things only ever appear on the terminal's screen, never in the saved conversation: signing in,
// "press Enter to continue", menus such as /model, and other screens of Claude Code's own. When the
// terminal is showing something other than its usual input box, and it is not a question the approval
// cards already handle, the friendly view shows the bottom of the screen as plain text with the keys
// it is likely to need, and a way to open the terminal itself.
function readOtherScreen(p) {
  if (!p.term || !p.running) return null;
  const b = p.term.buffer.active;
  const rows = [];
  for (let y = 0; y < p.term.rows; y++) rows.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
  const filled = rows.filter((r) => r.trim());
  if (!filled.length) return null;
  // Claude Code's input box: a line starting with > or ❯ near the bottom. A numbered choice is not it.
  const promptRow = /^\s*[│┃]?\s*[>❯›](?!\s*\d+\.)(\s|$)/;
  if (filled.slice(-10).some((r) => promptRow.test(r))) return null;

  // Join rows that carry on into the next one, so a long link stays whole, and drop lines that are
  // only borders.
  const lines = [];
  let carry = '';
  for (const r of rows.slice(-Math.min(rows.length, 30))) {
    const text = carry + r.trim();
    if (r.length >= p.term.cols && /\S$/.test(r)) {
      carry = text;
      continue;
    }
    carry = '';
    const plain = text.replace(/^[│┃╭╮╰╯─━\s]+|[│┃╭╮╰╯─━\s]+$/g, '');
    if (plain) lines.push(plain);
  }
  if (carry) lines.push(carry);
  const shown = lines.slice(-12);
  return shown.length ? { lines: shown, key: shown.join('\n') } : null;
}

function drawFriendlyScreen(panel, screen) {
  const fv = panel.fv;
  if (!fv) return;
  // A screen has to stay for two checks in a row, so a passing moment, such as Claude Code starting,
  // does not flash a card.
  if (!screen || screen.key !== fv.pendingScreen) {
    fv.pendingScreen = screen?.key || null;
    if (!screen) {
      fv.screen.hidden = true;
      fv.screenKey = null;
    }
    return;
  }
  if (fv.screenKey === screen.key) return;
  fv.screenKey = screen.key;

  const text = screen.lines.join('\n');
  const title = /press enter|enter to continue|press any key/i.test(text)
    ? 'Claude Code is waiting for you to continue'
    : /log ?in|sign ?in|authenticat|api key|oauth/i.test(text)
      ? 'Claude needs you to sign in'
      : /trust/i.test(text) && /folder|files/i.test(text)
        ? 'Claude Code is asking whether to trust this folder'
        : 'The terminal needs you';
  const keys = (label, seq, primary) => {
    const b = el('button', primary ? 'btn primary' : 'btn', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      api.write(panel.ptyId, seq);
      fv.input.focus();
    });
    return b;
  };
  fv.screen.innerHTML = '';
  fv.screen.append(el('div', 'fv-screen-title', title));
  fv.screen.append(el('pre', 'fv-screen-text', text));
  const actions = el('div', 'fv-screen-actions');
  for (const url of new Set(text.match(/https?:\/\/[^\s'"<>]+/g) || [])) {
    const open = el('button', 'btn primary', 'Open the link');
    open.type = 'button';
    open.title = url;
    open.addEventListener('click', () => openLinkTarget(url));
    actions.append(open);
  }
  const hasLink = actions.childElementCount > 0;
  actions.append(
    keys(/press enter|enter to continue/i.test(text) ? 'Continue' : 'Enter', '\r', !hasLink),
    keys('↑', '\x1b[A'),
    keys('↓', '\x1b[B'),
    keys('Back (Esc)', '\x1b')
  );
  const term = el('button', 'link-btn', 'Open the terminal');
  term.type = 'button';
  term.addEventListener('click', () => setFriendly(panel, false));
  actions.append(term);
  fv.screen.append(actions);
  fv.screen.append(el('div', 'fv-screen-hint', 'If it asks you to paste a code, paste it in the box below and press Return.'));
  fv.screen.lastChild.hidden = !/code/i.test(text);
  fv.screen.hidden = false;
}

function setFriendly(panel, on) {
  if (!panel?.term || Boolean(panel.friendly) === on) return;
  panel.friendly = on;
  const host = panel.body.querySelector('.term-host');
  if (on) {
    if (!panel.fv) buildFriendly(panel);
    panel.fv.view.hidden = false;
    // Hidden, the terminal stops drawing but keeps reading Claude Code's output, so approvals still work.
    host.style.display = 'none';
    watchFriendly(panel);
    if (focused === panel) panel.fv.input.focus();
  } else {
    if (panel.fv) panel.fv.view.hidden = true;
    host.style.display = '';
    if (panel.fvSession) api.unwatchFriendly(panel.fvSession);
    panel.fvSession = null;
    panel.fit.fit();
    if (focused === panel) panel.term.focus();
  }
  panel.el.classList.toggle('friendly-on', on);
  scanApprovals();
}

function watchFriendly(panel) {
  if (!panel.friendly || !panel.sessionId || panel.fvSession === panel.sessionId) return;
  if (panel.fvSession) api.unwatchFriendly(panel.fvSession);
  panel.fvSession = panel.sessionId;
  api.watchFriendly(panel.sessionId);
}

api.onFriendlyItems((sessionId, items, first) => {
  const panel = panels.find((p) => p.fvSession === sessionId);
  if (!panel?.fv) return;
  if (first) {
    panel.fv.log.innerHTML = '';
    panel.fv.steps.clear();
    panel.fv.group = null;
  }
  addFriendlyItems(panel, items);
});

// ---------- Explain terms ----------

// With the Explain box ticked on a harness, Claude adds the words that structure the work to a glossary
// for that folder. The app underlines those words as they appear and explains one when the mouse is held
// over it, like a tooltip in a strategy game. The underline fades as the user learns the word: bright while
// it is new, dimmer once they have looked at it, faint once it is familiar, and gone once they know it.
// The tooltip shrinks in the same way, from the full explanation to a one-line reminder.
let glossaryData = { glossary: { folders: {} }, codex: { folders: {} } };
const matchers = new Map(); // glossary key -> matcher
const FAMILIAR_AFTER = 3; // looks at a term before the tooltip shows the one-line reminder first
const KIND_LABELS = { part: 'Part of this work', idea: 'Idea', syntax: 'Syntax', process: 'Way of working' };

async function loadGlossary() {
  glossaryData = await api.getGlossary();
  matchers.clear();
  for (const p of panels) if (p.marker) p.marker.matcher = matcherFor(p.glossaryKey);
  if (settingsDialog.open && settingsPage === 'glossary') renderCodex();
}

function matcherFor(key) {
  if (!matchers.has(key)) matchers.set(key, Explain.buildMatcher(glossaryData.glossary.folders[key]?.terms));
  return matchers.get(key);
}

function termProgress(key, term) {
  const c = glossaryData.codex.folders[key]?.[term];
  if (c?.known) return 'known';
  if ((c?.seen || 0) >= FAMILIAR_AFTER) return 'familiar';
  return c?.seen ? 'seen' : 'new';
}

// The underline for a term: a dotted line in the accent colour that fades as the term is learned.
function underlineFor(key, term) {
  const blue = settings.theme === 'blue';
  const colour = {
    new: blue ? '127;157;255' : '217;119;87',
    seen: blue ? '96;112;160' : '150;96;78',
    familiar: blue ? '74;80;96' : '100;90;84',
  }[termProgress(key, term)];
  return colour ? `\x1b[4:4m\x1b[58;2;${colour}m` : '';
}

function setUpExplain(panel, key) {
  panel.glossaryKey = key;
  panel.marker = new Explain.OutputMarker((d) => panel.term.write(d));
  panel.marker.matcher = matcherFor(key);
  panel.marker.styleFor = (term) => underlineFor(key, term);
  const badge = panel.head.querySelector('.code-badge');
  badge.textContent = [badge.textContent, 'Explain'].filter(Boolean).join(' · ');
  badge.title = [badge.title, 'Words Claude adds to the glossary are underlined. Hold the mouse over one to see what it means.']
    .filter(Boolean)
    .join('\n');
  // Terms are found again on the screen when the mouse moves, so a term written before it joined the
  // glossary, or split across two pieces of output, still gets its tooltip.
  panel.term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = panel.term.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';
      const found = Explain.findTerms(line, matcherFor(key));
      callback(
        found.length
          ? found.map((f) => ({
              range: { start: { x: f.start + 1, y }, end: { x: f.end, y } },
              text: f.text,
              decorations: { underline: false, pointerCursor: false },
              activate: (e) => showTip(key, f.key, e.clientX, e.clientY),
              hover: (e) => tipHover(key, f.key, e),
              leave: () => tipLeave(),
            }))
          : undefined
      );
    },
  });
}

const tip = el('div', 'term-tip');
tip.hidden = true;
document.body.append(tip);
let tipTimer = null;
let tipShown = null; // { key, term }
const lastSeen = new Map(); // "key term" -> when a look was last counted

function tipHover(key, term, e) {
  clearTimeout(tipTimer);
  if (tipShown?.key === key && tipShown?.term === term && !tip.hidden) return;
  const { clientX, clientY } = e;
  tipTimer = setTimeout(() => showTip(key, term, clientX, clientY), 350);
}

function tipLeave() {
  clearTimeout(tipTimer);
  tipTimer = setTimeout(hideTip, 300);
}

function hideTip() {
  tip.hidden = true;
  tipShown = null;
}

tip.addEventListener('mouseenter', () => clearTimeout(tipTimer));
tip.addEventListener('mouseleave', tipLeave);
document.addEventListener('keydown', (e) => e.key === 'Escape' && !tip.hidden && hideTip(), true);

function showTip(key, term, x, y, { more = false } = {}) {
  const entry = glossaryData.glossary.folders[key]?.terms?.[term];
  if (!entry) return;
  clearTimeout(tipTimer);
  tipShown = { key, term };
  const progress = termProgress(key, term);
  const full = more || progress === 'new' || progress === 'seen';

  tip.innerHTML = '';
  const head = el('div', 'tip-head');
  head.append(el('span', 'tip-term', entry.term), el('span', 'tip-kind', KIND_LABELS[entry.kind] || ''));
  tip.append(head);
  tip.append(el('div', 'tip-short', entry.short));
  if (full) tip.append(el('div', 'tip-body', entry.explanation));

  const seen = glossaryData.codex.folders[key]?.[term]?.seen || 0;
  const foot = el('div', 'tip-foot');
  const label = {
    new: 'New to you',
    seen: `Looked at ${seen} time${seen === 1 ? '' : 's'}`,
    familiar: 'Getting familiar',
    known: 'You know this',
  }[progress];
  foot.append(el('span', `tip-progress ${progress}`, label));
  if (!full) {
    const moreBtn = el('button', 'link-btn', 'Explain again');
    moreBtn.addEventListener('click', () => showTip(key, term, x, y, { more: true }));
    foot.append(moreBtn);
  }
  const knowBtn = el('button', 'link-btn', progress === 'known' ? 'Not sure any more' : 'I know this');
  knowBtn.addEventListener('click', async () => {
    glossaryData.codex = await api.updateCodex(key, term, { known: progress !== 'known' });
    showTip(key, term, x, y);
  });
  foot.append(knowBtn);
  tip.append(foot);

  // Keep the tooltip inside the window, below the word, or above it if there is no room.
  tip.hidden = false;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  tip.style.left = `${Math.max(8, Math.min(x + 12, window.innerWidth - w - 8))}px`;
  tip.style.top = `${y + 20 + h > window.innerHeight - 8 ? Math.max(8, y - h - 12) : y + 20}px`;

  // Count a look at most once a minute for each term, so moving the mouse about does not count as learning.
  const id = `${key} ${term}`;
  if (Date.now() - (lastSeen.get(id) || 0) > 60000) {
    lastSeen.set(id, Date.now());
    api.updateCodex(key, term, { seen: true }).then((codex) => (glossaryData.codex = codex));
  }
}

api.onGlossaryChanged(loadGlossary);

async function launch(panel, dir, { resumeId = null, title = null, harnessName = null, name = null, firstMessage = null } = {}) {
  if (panel.launching || panel.ptyId !== null) return;
  if (!(await api.folderExists(dir))) {
    panel.picker?.keyList.showMessage(`That folder does not exist: ${dir}`);
    return;
  }
  panel.launching = true;
  panel.picker = null;
  panel.cwd = dir;
  panel.harnessName = harnessName;
  panel.title = title || baseName(dir);
  setHarnessPill(panel);
  panel.head.querySelector('.title').textContent = panel.title === (harnessName || baseName(dir)) ? '' : panel.title;
  panel.head.querySelector('.path').textContent = tildePath(dir);
  panel.head.querySelector('.path').title = dir;
  panel.body.innerHTML = '';

  const host = el('div', 'term-host');
  panel.body.append(host);

  const term = new Terminal({
    fontFamily: termFont(),
    lineHeight: settings.lineHeight || 1,
    letterSpacing: settings.letterSpacing || 0,
    fontSize: settings.fontSize,
    theme: termTheme(),
    cursorBlink: true,
    allowProposedApi: true,
    macOptionIsMeta: true,
    // Holding Option while dragging selects text in the terminal itself, even while Claude Code is
    // using the mouse, so ⌘C copies exactly what you selected.
    macOptionClickForcesSelection: true,
    scrollback: 10000,
    linkHandler: { activate: (_e, uri) => openLinkTarget(uri), allowNonHttpProtocols: true },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => openLinkTarget(uri)));
  term.open(host);
  keepDragsFlowing(term, host);
  registerFileLinks(term);
  fit.fit();

  term.attachCustomKeyEventHandler((e) => {
    // Shift+Enter adds a new line in Claude instead of sending the message.
    if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey && !e.metaKey) {
      if (panel.ptyId !== null) api.write(panel.ptyId, '\x1b\r');
      return false;
    }
    // Leave app shortcuts such as ⌘N, ⌘K and ⌘W to the app menu.
    if (e.metaKey && !['c', 'v', 'a'].includes(e.key)) return false;

    // While the Panels @ list is open, the arrow keys, Enter, Tab and Esc work the list. Pressing Enter
    // also sends a keypress event after the list has closed, so that is dropped too. Otherwise it would
    // send the message.
    if (panel.mentionList && e.type === 'keydown' && mentionListKey(panel, e)) {
      e.preventDefault();
      panel.dropKeypress = true;
      return false;
    }
    if (panel.dropKeypress) {
      if (e.type === 'keypress') return (panel.dropKeypress = false);
      if (e.type === 'keydown') panel.dropKeypress = false;
    }

    return true;
  });

  panel.term = term;
  panel.fit = fit;

  try {
    // Keep a name the user chose with /rename. Otherwise name the session after its panel.
    panel.name = name && !/^\d+-[\w-]+$/.test(name) ? name : sessionName(panel);
    // A new session uses its harness's Code Mode setting. A resumed one keeps what it started with.
    // The model and advisor come from the harness, or else from the defaults in Settings.
    const harness = harnessFor(harnessName, dir);
    const started = await api.startTerminal({
      cwd: dir,
      cols: term.cols,
      rows: term.rows,
      resumeId,
      name: panel.name,
      number: panel.number,
      firstMessage,
      codeMode: Boolean(harness?.codeMode),
      model: harness?.model || settings.defaultModel || '',
      advisor: harness?.advisor || settings.defaultAdvisor || '',
      explain: Boolean(harness?.explain),
    });
    panel.friendlyAtStart = Boolean(harness?.friendly);
    panel.ptyId = started.id;
    panel.sessionId = started.sessionId;
    panel.codeMode = Boolean(started.codeMode);
    const badge = panel.head.querySelector('.code-badge');
    badge.textContent = panel.codeMode ? 'Code Mode' : '';
    badge.title = panel.codeMode ? 'This session runs in Claude Code\'s experimental Code Mode' : '';
    if (started.glossaryKey) setUpExplain(panel, started.glossaryKey);
    panel.startedAt = Date.now();
  } catch (err) {
    term.write(`\r\nCould not start the terminal: ${err.message}\r\n`);
    panel.launching = false;
    return;
  }
  panel.launching = false;
  panel.running = true;
  byPtyId.set(panel.ptyId, panel);
  if (pendingData.has(panel.ptyId)) {
    writeOutput(panel, pendingData.get(panel.ptyId));
    pendingData.delete(panel.ptyId);
  }

  term.onData((data) => {
    if (!panel.running) return;
    api.write(panel.ptyId, data);
    trackTyping(panel, data);
  });
  term.onResize(({ cols, rows }) => panel.ptyId !== null && api.resize(panel.ptyId, cols, rows));

  panel.resizeObserver = new ResizeObserver(() => {
    if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
  });
  panel.resizeObserver.observe(host);

  // If a harness filter is on and this terminal is in a different harness, show everything again.
  if (filterKey && groupOf(panel).key !== filterKey) filterKey = null;
  applyLayout();
  if (panel.friendlyAtStart) setFriendly(panel, true);

  // This folder is now a recent one, so refresh the lists in any other new panels.
  settings = { ...settings, ...(await api.getSettings()) };
  refreshPickers();
  saveWorkspace();
  if (focused === panel) term.focus();
}

api.onData((id, data) => {
  const panel = byPtyId.get(id);
  if (panel) writeOutput(panel, data);
  else pendingData.set(id, (pendingData.get(id) || '') + data);
});

api.onExit((id) => {
  const panel = byPtyId.get(id);
  if (!panel) return;
  panel.running = false;
  panel.head.querySelector('.status').textContent = 'ended';
  panel.term.write('\r\n\x1b[2m[This session has ended. Press ⌘W to close the panel.]\x1b[0m\r\n');
});

// ---------- Mouse drags for Claude Code ----------

// Claude Code's full-screen display selects text itself, so it needs every mouse movement while you
// drag. When you first click, Claude Code re-sends its mouse settings, briefly switching drag reporting
// off and on. The terminal library then stops passing on the rest of that drag, so Claude Code selects
// less than you dragged over. While the button is held, pass the movement on here as well. The terminal
// library drops a repeat of the same position, so nothing is sent twice. Holding Option still makes a
// normal terminal selection instead.
function keepDragsFlowing(term, host) {
  let dragging = false;
  host.addEventListener(
    'mousedown',
    (e) => {
      dragging = e.button === 0 && !e.altKey && term._core.coreMouseService.areMouseEventsActive;
    },
    true
  );
  document.addEventListener('mousemove', (e) => {
    if (!dragging || !(e.buttons & 1)) return;
    const mouse = term._core.coreMouseService;
    if (!mouse.areMouseEventsActive) return;
    // Positions outside the panel are clamped to its edge, so dragging past the top or bottom keeps
    // telling Claude Code to scroll and extend the selection.
    const pos = term._core._mouseService.getMouseReportCoords(e, term._core.screenElement);
    if (!pos) return;
    mouse.triggerMouseEvent({
      col: pos.col,
      row: pos.row,
      x: pos.x,
      y: pos.y,
      button: 0, // left button
      action: 32, // movement
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shift: e.shiftKey,
    });
  });
  document.addEventListener('mouseup', () => {
    dragging = false;
  });
}

// ---------- Copying Claude's last reply (⌘⇧C) ----------

async function copyLastReply() {
  const panel = focused;
  if (!panel?.sessionId) return;
  // Make sure the panel is on the session it is showing now, in case /clear or /resume moved it.
  sessions = await api.listSessions();
  followNewSessions();
  const r = await api.copyReply(panel.sessionId);
  flashNote(panel, r.error || `Copied Claude's last reply (${r.lines} line${r.lines === 1 ? '' : 's'})`);
}

// ---------- Adding files (⌘U) ----------

function quotePath(p) {
  return /[\s"'()&$`\\!*?;<>|]/.test(p) ? `"${p.replace(/(["\\$`])/g, '\\$1')}"` : p;
}

async function addFilesToTerminal() {
  const panel = focused;
  if (!panel?.term || view !== 'grid') return;
  const files = await api.pickFiles(panel.cwd);
  // Pasting (rather than typing) lets Claude treat image paths as attached images.
  if (files.length) panel.term.paste(files.map(quotePath).join(' ') + ' ');
  panel.term.focus();
}

// ---------- Dropping files (drag and drop) ----------

async function dropFiles(panel, paths) {
  if (!paths.length) return;
  setFocus(panel);
  if (isUnstarted(panel)) {
    if (paths.length === 1 && (await api.isDir(paths[0]))) return launch(panel, paths[0]);
    panel.picker?.keyList.showMessage('Drop a folder here to start Claude in it.');
    return;
  }
  if (panel.term && panel.running) {
    panel.term.paste(paths.map(quotePath).join(' ') + ' ');
    panel.term.focus();
  }
}

// Without this, dropping a file outside a panel would open it in the app window.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---------- Updates ----------

const updateBtn = document.getElementById('update-btn');
let updateInfo = null;

function showUpdate(info) {
  updateInfo = info;
  updateBtn.hidden = false;
  updateBtn.disabled = false;
  updateBtn.textContent = `Update to v${info.version}`;
  updateBtn.title = `${info.name}${info.notes ? '\n\n' + info.notes : ''}`;
}

async function runUpdate() {
  if (!updateInfo || updateBtn.disabled) return;
  const notes = updateInfo.notes ? `\n\n${updateInfo.notes.split('\n').slice(0, 14).join('\n')}` : '';
  const ok = confirm(
    `Update Claude Panels from v${updateInfo.current} to v${updateInfo.version}?${notes}\n\n` +
      'The app downloads the new version, rebuilds itself and restarts. This takes a few minutes. ' +
      'Your terminals come back by themselves afterwards.'
  );
  if (!ok) return;
  updateBtn.disabled = true;
  saveWorkspace();
  const result = await api.runUpdate(currentWorkspace(), updateInfo.tag);
  if (result?.error) {
    alert(`The update did not finish.\n\n${result.error}`);
    showUpdate(updateInfo);
  }
}

// Claude Panels menu > Check for Updates…
async function checkUpdateNow() {
  const info = await api.checkUpdate();
  if (info) {
    showUpdate(info);
    runUpdate();
  } else {
    alert(
      `No newer release of Claude Panels was found. You have v${settings.appVersion}.\n\n` +
        'If you are offline, the app checks again when you next open it and every six hours.'
    );
  }
}

api.onUpdateAvailable(showUpdate);
// Each update step shows a short label, with a spinner while it runs, and a short detail on hover.
api.onUpdateProgress((progress) => {
  const { label, detail = '', busy = true } = typeof progress === 'string' ? { label: progress } : progress;
  updateBtn.hidden = false;
  updateBtn.textContent = '';
  if (busy) updateBtn.append(el('span', 'update-spinner'));
  updateBtn.append(document.createTextNode(label));
  updateBtn.title = detail;
});
updateBtn.addEventListener('click', runUpdate);

// ---------- Harness groups ----------

// Which harness a terminal belongs to. Terminals started outside a saved harness are grouped by folder.
function groupOf(panel) {
  let harness = panel.harnessName && settings.harnesses.find((h) => slug(h.name) === slug(panel.harnessName));
  if (!harness) {
    harness = settings.harnesses
      .filter((h) => panel.cwd === h.path || panel.cwd.startsWith(h.path + '/'))
      .sort((a, b) => b.path.length - a.path.length)[0];
  }
  if (harness) return { key: harness.path, name: '/' + slug(harness.name), path: harness.path };
  return { key: panel.cwd, name: baseName(panel.cwd), path: panel.cwd };
}

// The saved harness for a session: the one it was started in, or else the one its folder is in.
function harnessFor(harnessName, cwd) {
  const named = harnessName && settings.harnesses.find((h) => slug(h.name) === slug(harnessName));
  if (named || !cwd) return named || null;
  return (
    settings.harnesses
      .filter((h) => cwd === h.path || cwd.startsWith(h.path + '/'))
      .sort((a, b) => b.path.length - a.path.length)[0] || null
  );
}

// The harness name shown for a past session: the saved harness its folder is in, or else the folder's name.
function harnessLabelFor(cwd) {
  if (!cwd) return '';
  const g = groupOf({ cwd });
  return g.name.replace(/^\//, '');
}

function openGroups() {
  const groups = [];
  for (const p of panels) {
    if (!p.cwd) continue;
    const g = groupOf(p);
    let group = groups.find((x) => x.key === g.key);
    if (!group) groups.push((group = { ...g, panels: [] }));
    group.panels.push(p);
  }
  return groups;
}

function groupByKey(key) {
  return openGroups().find((g) => g.key === key);
}

function showPanel(panel) {
  if (panel.inBackground) return showPeek(panel);
  if (peeked) hidePeek(false);
  navStack = [];
  if (family && !family.members.includes(panel)) family = null;
  if (zoomed) zoomed = panel; // in full-window mode, ⌘1 to ⌘9 switch which panel fills the window
  if (filterKey && panel.cwd && groupOf(panel).key !== filterKey) filterKey = null;
  applyLayout();
  setFocus(panel);
}

// ---------- Background sessions, the sidebar and the peek drawer ----------

const ICON_TO_BACKGROUND =
  '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 2.5v11" stroke="currentColor" stroke-width="1.4"/><path d="M4.8 8h3.2M6.6 6.4 8.2 8 6.6 9.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_TO_GRID =
  '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 10.5l5-5M6.5 5.5h4v4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function drawBackgroundButton(p) {
  if (!p.bgBtn) return;
  p.bgBtn.hidden = !p.cwd;
  const state = p.inBackground ? 'grid' : 'background';
  if (p.bgBtn.dataset.state === state) return;
  p.bgBtn.dataset.state = state;
  p.bgBtn.innerHTML = p.inBackground ? ICON_TO_GRID : ICON_TO_BACKGROUND;
  p.bgBtn.title = p.inBackground ? 'Open as a panel (⌘B)' : 'Move to the background, so it keeps working without a panel (⌘B)';
}

function toggleBackground(panel) {
  if (!panel?.cwd) return;
  setBackground(panel, !panel.inBackground, { focus: panel.inBackground });
}

// Moves a panel between the grid and the background. Its terminal keeps running either way.
function setBackground(panel, on, { focus = false } = {}) {
  if (on) {
    if (zoomed === panel) zoomed = null;
    panel.inBackground = true;
    if (peeked !== panel) bgHost.append(panel.el);
    if (focused === panel && peeked !== panel) {
      const shown = visiblePanels();
      setFocus(shown[shown.length - 1] || null);
    }
  } else {
    if (peeked === panel) hidePeek(false);
    panel.inBackground = false;
    if (view === 'stack') showGrid();
    const after = panels.find((p) => p.number > panel.number && !p.inBackground && p.el.parentNode === grid);
    grid.insertBefore(panel.el, after ? after.el : null);
    if (filterKey && panel.cwd && groupOf(panel).key !== filterKey) filterKey = null;
    family = null;
  }
  applyLayout();
  drawStatusLine();
  if (panel.cwd) saveWorkspace();
  if (focus) setFocus(panel);
}

function showPeek(panel) {
  if (!panel.inBackground) return showPanel(panel);
  if (peeked && peeked !== panel) hidePeek(false);
  if (view === 'stack') showGrid();
  peeked = panel;
  peekBody.append(panel.el);
  document.getElementById('peek-label').textContent = `Running in the background${panel.openedBy ? `, opened by terminal ${panel.openedBy}` : ''}`;
  peekEl.hidden = false;
  requestAnimationFrame(() => peekEl.classList.add('open'));
  setFocus(panel);
  drawSidebar();
}

function hidePeek(refocus = true) {
  const panel = peeked;
  if (!panel) return;
  peeked = null;
  peekEl.classList.remove('open');
  peekEl.hidden = true;
  if (panel.inBackground) bgHost.append(panel.el);
  if (refocus || focused === panel) {
    const shown = visiblePanels();
    setFocus(shown[shown.length - 1] || null);
  }
  drawSidebar();
}

function toggleSidebar(open = !sidebarOpen) {
  sidebarOpen = open;
  drawSidebar();
}

// The sidebar draws the background sessions as a tree. A panel that opened sessions is at the top of its
// branch, the sessions it opened hang under it, and each session's working subagents hang under that session.
// New rows grow out of their parent's row, and finished rows move back up into it before they go.
const TREE_INDENT = 18;
const TREE_ROW = { coord: 32, session: 46, agent: 28 }; // row heights (a job card is measured instead)
const TREE_MARK = { coord: 16, session: 14, agent: 14, job: 17 }; // where the mark sits inside each row
const TREE_GAP = 2;
const treeRows = new Map(); // key -> { el, elbow, node, y, drawn }
let sidebarHideTimer = null;

function sessionState(p) {
  if (!p.running) return ['off', 'Ended'];
  if (p.needsApproval) return ['asking', 'Needs your approval'];
  if (p.lightState === 'working') return ['working', 'Working'];
  if (p.lightState === 'idle') return p.report ? ['idle', 'Reported back'] : ['idle', 'Waiting for you'];
  return ['', 'Starting'];
}

// Every row of the tree in order, each with its depth and the key of its parent row.
function treeNodes() {
  const nodes = [];
  const byNumber = (a, b) => a.number - b.number;
  // A row for a terminal, with its subagents under it. A terminal in two jobs is listed under each,
  // so its key starts with the job's key.
  const addPanel = (p, depth, parent, kind, prefix = '') => {
    const key = prefix + 'p' + p.number;
    nodes.push({ key, kind, depth, parent, panel: p });
    for (const a of p.agents || []) {
      nodes.push({ key: `${prefix}a${p.number}:${a.id || a.description}`, kind: 'agent', depth: depth + 1, parent: key, agent: a, panel: p });
    }
    return key;
  };

  // Each job with members gets a card, listed in place of its owner's row.
  const cards = [...jobs.values()].filter((j) => panels.some((p) => p.number === j.owner && p.cwd) && jobMembers(j).length);
  const inJob = new Set(cards.flatMap((j) => jobMembers(j).map((p) => p.number)));
  const cardsOf = (n) => cards.filter((j) => j.owner === n).sort((a, b) => a.id - b.id);

  // Background sessions that are in no job are listed under the terminal that opened them, if it is listed.
  const loose = panels.filter((p) => p.cwd && p.inBackground && !inJob.has(p.number));
  const openers = new Set(loose.map((p) => p.openedBy).filter((n) => n && panels.some((o) => o.number === n && o.cwd && !inJob.has(n))));
  const roots = panels
    .filter(
      (p) =>
        p.cwd &&
        !inJob.has(p.number) &&
        (cardsOf(p.number).length || openers.has(p.number) || (p.inBackground && !openers.has(p.openedBy)) || (p.agents || []).length)
    )
    .sort(byNumber);

  for (const p of roots) {
    const own = cardsOf(p.number);
    const looseChildren = loose.filter((c) => c.openedBy === p.number && c !== p).sort(byNumber);
    if (!own.length) {
      const key = addPanel(p, 0, null, p.inBackground ? 'session' : 'coord');
      for (const c of looseChildren) addPanel(c, 1, key, 'session');
      continue;
    }
    own.forEach((job, i) => {
      const key = 'j' + job.id;
      nodes.push({ key, kind: 'job', depth: 0, parent: null, panel: p, job });
      // The owner's own subagents and loose sessions go under its first job.
      if (i === 0) {
        for (const a of p.agents || []) {
          nodes.push({ key: `a${p.number}:${a.id || a.description}`, kind: 'agent', depth: 1, parent: key, agent: a, panel: p });
        }
        for (const c of looseChildren) addPanel(c, 1, key, 'session');
      }
      for (const m of jobMembers(job).sort(byNumber)) addPanel(m, 1, key, 'session', key + ':');
    });
  }
  return nodes;
}

function treeRowContent(node) {
  const p = node.panel;
  const label = p.harnessName || baseName(p.cwd || '');
  const pill = () => {
    const x = el('span', 'harness', label);
    x.style.setProperty('--hue', harnessColour(label));
    return x;
  };
  const parts = [];
  if (node.kind === 'agent') {
    const mins = Math.max(0, Math.floor((Date.now() - node.agent.since) / 60000));
    parts.push(el('span', 'tree-mark working'), el('span', 'tree-title', node.agent.description), el('span', 'tree-time', `${mins}m`));
    return { parts, sig: `a|${node.agent.description}|${mins}` };
  }
  if (node.kind === 'job') return jobRowContent(node, label);
  if (node.kind === 'coord') {
    const mark = el('span', 'tree-mark coord');
    mark.style.setProperty('--hue', harnessColour(label));
    parts.push(mark, el('span', 'side-num', p.number <= 9 ? `⌘${p.number}` : String(p.number)), el('span', 'tree-title strong', label), el('span', 'tree-sub', p.title && p.title !== label ? p.title : ''));
    return { parts, sig: `c|${p.number}|${label}|${p.title}` };
  }
  const [state, words] = sessionState(p);
  const top = el('span', 'side-top');
  top.append(el('span', `tree-mark ${state}`), el('span', 'tree-title', p.title || p.name || `Terminal ${p.number}`));
  const bottom = el('span', 'side-bottom');
  bottom.append(el('span', 'side-num', p.number <= 9 ? `⌘${p.number}` : String(p.number)), pill());
  // A session listed under a job that another job also uses says so.
  const inJob = node.parent && node.parent.startsWith('j') ? jobs.get(Number(node.parent.slice(1))) : null;
  const others = inJob ? jobsWith(p.number).filter((j) => j !== inJob).map((j) => `"${j.title}"`) : [];
  if (others.length) {
    const tag = el('span', 'tree-shared', 'Shared');
    tag.title = `Also in ${others.join(' and ')}. Wrapping up one job leaves it open while another job uses it.`;
    bottom.append(tag);
  }
  bottom.append(el('span', 'side-state', words));
  parts.push(top, bottom);
  return { parts, sig: `s|${p.number}|${p.title}|${label}|${state}|${words}|${others.join(',')}`, state };
}

function drawSidebar() {
  const bg = panels.filter((p) => p.inBackground && p.cwd);
  // Show the list when the first background session appears. When the last one closes, let its row
  // move back up first, then hide the list.
  // Panels on screen that are running subagents are listed too, so the list also opens when one starts them.
  const busy = panels.filter((p) => p.cwd && !p.inBackground && (p.agents || []).length);
  const agentCount = panels.reduce((n, p) => n + (p.cwd ? (p.agents || []).length : 0), 0);
  if (bg.length > backgroundCount || busy.length > busyCount) sidebarOpen = true;
  if (bg.length || busy.length) clearTimeout(sidebarHideTimer);
  else if (backgroundCount || busyCount) sidebarHideTimer = setTimeout(() => toggleSidebar(false), 650);
  backgroundCount = bg.length;
  busyCount = busy.length;
  sideBtn.hidden = bg.length + busy.length === 0;
  document.getElementById('side-count').textContent = String(bg.length + agentCount);
  sideBtn.classList.toggle('on', sidebarOpen);
  sidebar.hidden = !sidebarOpen;
  if (sidebar.hidden) return;

  const nodes = treeNodes();
  const keys = new Set(nodes.map((n) => n.key));
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const oldY = new Map([...treeRows].map(([k, r]) => [k, r.y]));

  // First draw every row's content, so a job card can be measured: its height depends on its questions.
  const fresh = new Set();
  for (const n of nodes) {
    let row = treeRows.get(n.key);
    if (!row || row.leaving) {
      row?.el.remove();
      const elx = el('div', 'tree-row ' + n.kind);
      elx.tabIndex = 0;
      elx.setAttribute('role', 'button');
      elx.dataset.key = n.key;
      elx.dataset.number = String(n.panel.number);
      elx.style.opacity = '0';
      row = { el: elx, elbow: n.parent ? el('span', 'tree-elbow') : null, drawn: '' };
      treeRows.set(n.key, row);
      sideList.append(elx);
      fresh.add(n.key);
    }
    row.node = n;
    const { parts, sig, state } = treeRowContent(n);
    if (row.drawn !== sig) {
      row.drawn = sig;
      row.el.innerHTML = '';
      if (row.elbow) row.el.append(row.elbow);
      row.el.append(...parts);
    }
    row.el.className = 'tree-row ' + n.kind;
    row.el.style.paddingLeft = n.depth * TREE_INDENT + 8 + 'px';
    row.el.classList.toggle('selected', n.panel === peeked && n.kind === 'session');
    row.el.classList.toggle('asking', state === 'asking');
    row.el.title =
      n.kind === 'agent'
        ? `A subagent of ${n.panel.title || n.panel.name}: ${n.agent.description}`
        : n.kind === 'coord' || n.kind === 'job'
          ? `Terminal ${n.panel.number}. Click to go to it.`
          : `${n.panel.title || n.panel.name}. Click to look at it.`;
    if (n.kind === 'job') {
      row.el.style.height = 'auto';
      n.h = Math.ceil(row.el.offsetHeight);
    } else {
      n.h = TREE_ROW[n.kind];
    }
    row.el.style.height = n.h + 'px';
  }

  let y = 0;
  for (const n of nodes) {
    n.y = y;
    y += n.h + TREE_GAP + (n.kind === 'job' ? 4 : 0);
  }

  // Rows that have gone move up into their parent's row and fade, then are removed.
  for (const [key, row] of treeRows) {
    if (keys.has(key) || row.leaving) continue;
    row.leaving = true;
    const parent = byKey.get(row.node.parent) || treeRows.get(row.node.parent)?.node;
    row.el.style.transform = `translate(${parent ? parent.depth * TREE_INDENT : 0}px, ${parent ? parent.y : row.y}px)`;
    row.el.style.opacity = '0';
    if (row.elbow) row.elbow.style.height = '0px';
    setTimeout(() => {
      row.el.remove();
      if (treeRows.get(key) === row) treeRows.delete(key);
    }, 480);
  }

  for (const n of nodes) {
    const row = treeRows.get(n.key);
    row.y = n.y;
    if (row.elbow) {
      // The line starts under the parent's mark, or under the whole card for a job.
      const parent = byKey.get(n.parent);
      const top = !parent ? n.y : parent.kind === 'job' ? parent.y + parent.h + 1 : parent.y + TREE_MARK[parent.kind] + 6;
      row.elbow.dataset.height = String(Math.max(0, n.y + TREE_MARK[n.kind] - top));
      row.elbow.style.top = TREE_MARK[n.kind] + 'px';
      row.elbow.style.left = (n.depth - 1) * TREE_INDENT + 13 + 'px';
      row.elbow.style.width = TREE_INDENT - 6 + 'px';
    }
    if (fresh.has(n.key)) {
      // A new row starts at its parent's place and moves out to its own.
      const parent = n.parent && byKey.get(n.parent);
      const from = parent ? (oldY.has(n.parent) ? oldY.get(n.parent) : parent.y) : n.y;
      row.el.style.transform = `translate(${parent ? parent.depth * TREE_INDENT : n.depth * TREE_INDENT}px, ${from}px)`;
      requestAnimationFrame(() => requestAnimationFrame(() => placeRow(row)));
    } else {
      placeRow(row);
    }
  }
  sideList.style.setProperty('--tree-height', y + 'px');
}

function placeRow(row) {
  if (row.leaving) return;
  row.el.style.transform = `translate(0px, ${row.y}px)`;
  row.el.style.opacity = '1';
  if (row.elbow) row.elbow.style.height = row.elbow.dataset.height + 'px';
}

// ---------- Jobs ----------

const LOCK_CLOSED =
  '<svg viewBox="0 0 12 12"><rect x="2" y="5.5" width="8" height="5.5" rx="1.2" fill="currentColor"/><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
const LOCK_OPEN =
  '<svg viewBox="0 0 12 12"><rect x="2" y="5.5" width="8" height="5.5" rx="1.2" fill="currentColor"/><path d="M4 5.5V4a2 2 0 0 1 3.9-.6" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';

function newJob(owner, title) {
  const job = {
    id: nextJobId++,
    owner: owner.number,
    title: (title && String(title).trim().slice(0, 80)) || owner.title || owner.harnessName || baseName(owner.cwd || '') || `Terminal ${owner.number}`,
    named: Boolean(title && String(title).trim()),
    access: 'closed',
    members: new Set(),
    requests: [],
    wrapping: false,
    used: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

// The open terminals in a job, not counting its owner.
function jobMembers(job) {
  return panels.filter((p) => p.cwd && job.members.has(p.number) && p.number !== job.owner);
}

function jobsOwnedBy(number) {
  return [...jobs.values()].filter((j) => j.owner === number).sort((a, b) => b.used - a.used);
}

function jobsWith(number) {
  return [...jobs.values()].filter((j) => j.members.has(number)).sort((a, b) => a.id - b.id);
}

function sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

// The job an owner means: the one with this name, or, with no name, the one it used last.
function findJob(owner, name) {
  const own = jobsOwnedBy(owner);
  return name ? own.find((j) => sameName(j.title, name)) || null : own[0] || null;
}

// The job a new terminal from this owner joins. A new name starts a new job. With no name, the job used
// last, or a new one.
function jobForOpen(owner, name) {
  const job = findJob(owner.number, name) || newJob(owner, name);
  job.used = Date.now();
  return job;
}

// Members that another job also uses. Wrap up leaves them open.
function sharedMembers(job) {
  return jobMembers(job).filter((p) => jobsWith(p.number).some((o) => o !== job));
}

function jobProgress(job) {
  const members = jobMembers(job);
  const shared = new Set(sharedMembers(job));
  const isWorking = (p) => p.running && p.lightState === 'working' && !p.needsApproval;
  const isAsking = (p) => p.running && p.needsApproval;
  const working = members.filter(isWorking).length;
  const asking = members.filter(isAsking).length + job.requests.length;
  // Wrap up is ready when the terminals it would close have finished. Shared ones stay open, so they do not count.
  const toClose = members.filter((p) => !shared.has(p));
  const busy = toClose.filter(isWorking).length + toClose.filter(isAsking).length + job.requests.length;
  const text = job.wrapping
    ? 'Wrapping up'
    : asking
      ? `${asking} need${asking === 1 ? 's' : ''} you`
      : working
        ? `${working} working`
        : 'All finished';
  return { members, shared: shared.size, working, asking, busy, text, ready: !job.wrapping && members.length > 0 && busy === 0 };
}

function endJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  for (const r of job.requests) r.resolve({ decision: 'deny', reason: 'The job has ended.' });
  jobs.delete(id);
  saveWorkspace();
}

function jobRowContent(node, label) {
  const job = node.job;
  const owner = job.owner;
  const progress = jobProgress(job);
  const parts = [];

  // First line: the job's name, and whether it is closed or open.
  const top = el('span', 'job-top');
  const mark = el('span', 'tree-mark coord');
  mark.style.setProperty('--hue', harnessColour(label));
  const access = el('span', 'job-access');
  access.dataset.action = 'access';
  access.dataset.job = String(job.id);
  access.title =
    job.access === 'closed'
      ? 'Closed: other terminals need your permission to use this job. Click to open it.'
      : 'Open: any terminal can use this job. Click to close it.';
  access.innerHTML = (job.access === 'closed' ? LOCK_CLOSED : LOCK_OPEN) + (job.access === 'closed' ? 'Closed' : 'Open');
  top.append(mark, el('span', 'job-title', job.title), access);

  // Second line: how it is going, who owns it, and Wrap up.
  const meta = el('span', 'job-meta');
  const about = el('span', 'job-about');
  // The status goes first, so it still shows when the line is too long.
  about.append(el('span', progress.asking ? 'job-needs' : null, progress.text), el('span', null, '  ·  '), el('span', 'side-num', owner <= 9 ? `⌘${owner}` : String(owner)), el('span', null, ` ${label}`));
  const wrap = el('span', 'btn job-btn' + (progress.ready ? ' ready' : ''), job.wrapping ? 'Wrapping up…' : 'Wrap up');
  wrap.dataset.action = 'wrap';
  wrap.dataset.job = String(job.id);
  const keep = progress.shared ? ` ${progress.shared === 1 ? 'One session is' : `${progress.shared} sessions are`} also in another job, so ${progress.shared === 1 ? 'it stays' : 'they stay'} open.` : '';
  wrap.title = (progress.ready ? 'Close the sessions in this job. ' : 'Close the sessions in this job, even the busy ones. ') + 'Their conversations are kept.' + keep;
  meta.append(about, wrap);
  parts.push(top, meta);

  // A question for each terminal that wants to use the closed job.
  for (const r of job.requests) {
    const box = el('span', 'job-request');
    const who = `⌘${r.from.number} ${r.from.harnessName || baseName(r.from.cwd || '')}`;
    box.append(el('span', 'job-request-text', `${who} wants to ${r.tool === 'SendMessage' ? 'message' : 'read'} ${r.target.title || r.target.name}.`));
    const buttons = el('span', 'job-request-buttons');
    for (const [action, text] of [['allow', 'Allow'], ['deny', 'Deny']]) {
      const b = el('span', 'btn job-btn' + (action === 'allow' ? ' primary' : ''), text);
      b.dataset.action = action;
      b.dataset.job = String(job.id);
      b.dataset.request = r.id;
      if (action === 'allow' && r.tool === 'SendMessage') b.title = `${r.target.title || r.target.name} also joins the job of ⌘${r.from.number}, so wrapping up either job leaves it open while the other still uses it.`;
      buttons.append(b);
    }
    box.append(buttons);
    parts.push(box);
  }
  const sig = `j|${job.title}|${job.access}|${progress.text}|${progress.ready}|${progress.shared}|${job.wrapping}|${label}|${job.requests.map((r) => r.id).join(',')}`;
  return { parts, sig, state: '' };
}

function jobAction(id, action, requestId) {
  const job = jobs.get(id);
  if (!job) return;
  if (action === 'access') {
    job.access = job.access === 'closed' ? 'open' : 'closed';
    saveWorkspace();
  } else if (action === 'wrap') {
    wrapUpJob(job).catch((err) => showNotice('Could not wrap up the job', err.message));
  } else if (action === 'allow' || action === 'deny') {
    const r = job.requests.find((x) => x.id === requestId);
    if (r) r.resolve(action === 'allow' ? { decision: 'allow' } : { decision: 'deny', reason: r.denyReason });
  }
  drawStatusLine();
}

// Which open panel a SendMessage target or a session argument means: "3", "3-wrap", "@3-wrap [45bf02]" or a name.
function panelForTarget(target) {
  const clean = String(target || '').trim().replace(/^@/, '').replace(/\s*\[[0-9a-f]+\]$/, '');
  const m = clean.match(/^(\d+)(-|$)/);
  if (m) return panels.find((p) => p.number === Number(m[1]) && p.cwd) || null;
  return panels.find((p) => p.cwd && p.name === clean) || null;
}

// When a terminal gives work to a terminal in someone else's job, that terminal joins the sender's job
// too: the sender's own job used last, or the job the sender is part of. A sender with no job gets one
// only when the user allowed it, so the work shows in the sidebar.
function joinSenderJob(sender, target, { create }) {
  let job = jobsOwnedBy(sender.number)[0] || jobsWith(sender.number)[0] || null;
  if (!job && create) job = newJob(sender);
  if (!job || job.members.has(target.number) || job.owner === target.number) return;
  job.members.add(target.number);
  job.used = Date.now();
  saveWorkspace();
}

// Before one terminal messages or reads another, the app checks whether the other is in a closed job.
// A job's owner and members may always use it. Anyone else needs the user's permission, which the
// job's card in the sidebar asks for. A message also adds the terminal to the sender's job.
function gateRequest({ from, to, tool }) {
  const target = panelForTarget(to);
  const sender = panels.find((p) => p.number === Number(from));
  if (!target || !sender || sender === target) return { decision: 'allow' };
  const its = jobsWith(target.number);
  if (!its.length || its.some((j) => j.owner === sender.number || j.members.has(sender.number))) return { decision: 'allow' };
  const message = tool === 'SendMessage';
  const job = its.find((j) => j.access === 'closed');
  if (!job) {
    if (message) joinSenderJob(sender, target, { create: false });
    drawStatusLine();
    return { decision: 'allow' };
  }
  return new Promise((resolve) => {
    const request = {
      id: Math.random().toString(36).slice(2),
      from: sender,
      target,
      tool,
      denyReason:
        `The user did not allow terminal ${sender.number} to use ${target.name}. It is part of "${job.title}", a ` +
        `closed job owned by terminal ${job.owner}. Ask terminal ${job.owner} instead, or ask the user.`,
    };
    const timer = setTimeout(() => request.resolve({ decision: 'deny', reason: 'Nobody answered the request in time.' }), 270000);
    request.resolve = (answer) => {
      clearTimeout(timer);
      job.requests = job.requests.filter((r) => r !== request);
      if (answer.decision === 'allow' && message && panels.includes(sender) && panels.includes(target)) joinSenderJob(sender, target, { create: true });
      drawStatusLine();
      resolve(answer);
    };
    job.requests.push(request);
    toggleSidebar(true);
    drawStatusLine();
  });
}

function describeJobs(owner) {
  return jobsOwnedBy(owner)
    .filter((j) => jobMembers(j).length)
    .map((j) => `"${j.title}"`)
    .join(', ');
}

// set_job: name a job, set who may use it, and add terminals this one opened to it.
function setJobFromClaude({ from, title, access, add }) {
  const owner = panels.find((p) => p.number === Number(from));
  if (!owner) throw new Error(`Terminal ${from} is not open.`);
  if (owner.openedBy) throw new Error(`This terminal was opened by terminal ${owner.openedBy}, so it cannot have a job of its own.`);
  title = String(title || '').trim().slice(0, 80);
  let job = findJob(owner.number, title);
  if (!job && title) {
    // A job that was made without a name takes the first name Claude gives, instead of a new job starting.
    const last = findJob(owner.number);
    const adding = Array.isArray(add) && add.length;
    if (last && !last.named && !adding) {
      job = last;
      job.title = title;
    } else {
      job = newJob(owner, title);
    }
  }
  if (!job) job = newJob(owner);
  if (title) job.named = true;
  if (access === 'open' || access === 'closed') job.access = access;
  const added = [];
  for (const n of Array.isArray(add) ? add : []) {
    const p = panels.find((x) => x.number === Number(n) && x.cwd);
    if (!p) throw new Error(`Terminal ${n} is not open.`);
    if (p === owner) continue;
    if (!jobsOwnedBy(owner.number).some((j) => j.members.has(p.number))) {
      throw new Error(`Terminal ${n} is not in any of your jobs. You can only add terminals you opened.`);
    }
    job.members.add(p.number);
    added.push(p.number);
  }
  job.used = Date.now();
  saveWorkspace();
  drawStatusLine();
  return { title: job.title, access: job.access, members: jobMembers(job).length, added };
}

// wrap_up_job: the job is named, or is the only one with terminals in it.
function jobToWrapUp(from, name) {
  const owner = Number(from);
  if (name) {
    const job = findJob(owner, name);
    if (!job) throw new Error(`You have no job called "${name}". Your jobs are ${describeJobs(owner) || 'none'}.`);
    return job;
  }
  const busy = jobsOwnedBy(owner).filter((j) => jobMembers(j).length);
  if (!busy.length) throw new Error('This terminal has no job to wrap up.');
  if (busy.length > 1) throw new Error(`You have ${busy.length} jobs: ${describeJobs(owner)}. Say which one to wrap up.`);
  return busy[0];
}

// Wrapping up closes the job's sessions one at a time from the bottom of the tree upwards, so each branch
// moves back into its card. A session that another job also uses stays open and only leaves this job.
// The owner's panel stays open. Conversations are kept, so ⌘K can resume them.
async function wrapUpJob(job, { byClaude = false } = {}) {
  if (job.wrapping) throw new Error('The job is already being wrapped up.');
  const progress = jobProgress(job);
  if (!progress.ready) {
    const words = `sessions that are still working or waiting for the user`;
    if (byClaude) throw new Error(`Not wrapped up, because "${job.title}" has ${words}. Wait until they have finished.`);
    if (!confirm(`"${job.title}" has ${words}. Wrap it up anyway? Those sessions will stop, but their conversations are kept.`)) return { title: job.title, closed: 0, kept: [] };
  }
  job.wrapping = true;
  toggleSidebar(true);
  drawStatusLine();
  const order = jobMembers(job).sort((a, b) => b.number - a.number);
  let closed = 0;
  const kept = [];
  for (const p of order) {
    if (!panels.includes(p)) continue;
    // Checked now, not at the start, in case another job finished wrapping up in the meantime.
    const other = jobsWith(p.number).find((o) => o !== job);
    if (other) {
      job.members.delete(p.number);
      kept.push({ number: p.number, name: p.title || p.name, job: other.title });
      drawStatusLine();
    } else {
      closePanel(p, { confirmed: true });
      closed++;
    }
    await new Promise((r) => setTimeout(r, 420));
  }
  job.wrapping = false;
  endJob(job.id);
  drawStatusLine();
  const keptText = kept.map((k) => ` Kept ⌘${k.number} open because "${k.job}" also uses it.`).join('');
  showNotice(`Wrapped up "${job.title}"`, `Closed ${closed} session${closed === 1 ? '' : 's'}. Their conversations are kept, so ⌘K can find and resume them.${keptText}`);
  return { title: job.title, closed, kept };
}

// ---------- Stack view (⌘S) ----------

let stackTimer = null;
let stackGroups = [];

function showGrid() {
  view = 'grid';
  clearInterval(stackTimer);
  stackEl.hidden = true;
  grid.hidden = false;
  applyLayout();
  const shown = visiblePanels();
  setFocus(shown.includes(focused) ? focused : shown[0] || null);
}

function showStack() {
  view = 'stack';
  grid.hidden = true;
  stackEl.hidden = false;
  applyLayout();
  renderStack();
  clearInterval(stackTimer);
  stackTimer = setInterval(renderStack, 1500);
}

// ⌘S opens the stack view. From the stack view or a filtered view it goes back to all terminals.
function toggleStack() {
  navStack = [];
  family = null;
  if (view === 'stack' || filterKey) {
    filterKey = null;
    showGrid();
  } else {
    showStack();
  }
}

function openGroup(key, panel) {
  filterKey = key;
  zoomed = null;
  family = null;
  showGrid();
  if (panel) setFocus(panel);
}

// A terminal can move between sessions: /clear starts a new one in the same folder, and Claude's
// /resume can go back to an earlier one. The app remembers every session a terminal has been on,
// adds new ones started in its folder since it opened, and treats the most recently active as current.
function followNewSessions() {
  const others = (p) => new Set(panels.filter((x) => x !== p).flatMap((x) => [...(x.knownIds || [x.sessionId])]));
  for (const p of panels) {
    if (!p.running || !p.startedAt || !p.sessionId) continue;
    p.knownIds = p.knownIds || new Set([p.sessionId]);
    const taken = others(p);
    for (const s of sessions) {
      if (s.cwd === p.cwd && s.created >= p.startedAt && !taken.has(s.id)) p.knownIds.add(s.id);
    }
    const current = sessions
      .filter((s) => p.knownIds.has(s.id))
      .sort((a, b) => b.updated - a.updated)[0];
    if (current && current.id !== p.sessionId) {
      p.sessionId = current.id;
      watchFriendly(p);
      saveWorkspace();
    }
  }
}

let stackRefreshing = false;
async function renderStack() {
  if (stackRefreshing || view !== 'stack') return;
  stackRefreshing = true;
  try {
    [sessions, cvs] = await Promise.all([api.listSessions(), api.getCVs()]);
    followNewSessions();
    const runningIds = panels.filter((p) => p.running && p.sessionId).map((p) => p.sessionId);
    const activity = await api.sessionActivity(runningIds);
    if (view === 'stack') drawStack(activity);
  } finally {
    stackRefreshing = false;
  }
}

function sessionLine(text, when, running, activityText, busy, onClick, tooltip = '') {
  const row = el('div', 'sess' + (running ? ' running' : ''));
  row.title = tooltip;
  row.append(el('span', 'dot'), el('span', 'label', text), el('span', 'when', when));
  if (activityText) row.append(el('span', 'activity' + (busy ? ' busy' : ''), activityText));
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return row;
}

function drawStack(activity) {
  stackGroups = openGroups();
  stackCards.innerHTML = '';
  if (!stackGroups.length) {
    stackCards.append(el('div', 'stack-empty', 'No harnesses are open. Press ⌘N to start a terminal.'));
    return;
  }
  stackGroups.forEach((group, i) => {
    const card = el('div', 'card');
    const head = el('div', 'card-head');
    const open = group.panels.length;
    head.append(
      el('span', 'num', i < 9 ? `⌘${i + 1}` : ''),
      el('span', 'name', group.name),
      el('span', 'path', tildePath(group.path)),
      el('span', 'count', `${open} open`)
    );
    card.append(head);
    card.addEventListener('click', () => openGroup(group.key));

    // Running sessions first, then the most recent others, up to three lines in total.
    const inGroup = sessions.filter((s) => s.cwd === group.path || s.cwd.startsWith(group.path + '/'));
    const lines = [];
    for (const p of group.panels.filter((x) => x.running)) {
      const s = inGroup.find((x) => x.id === p.sessionId);
      const act = activity[p.sessionId] || {};
      let text = 'Waiting for you';
      if (act.pending) text = `Running ${act.pending}`;
      else if (act.working) text = 'Thinking…';
      if (act.agents?.length) text += `  ·  ${act.agents.length} subagent${act.agents.length === 1 ? '' : 's'} working`;
      if (act.background?.length) text += `  ·  in the background: ${act.background.join(', ')}`;
      lines.push(
        sessionLine((s && displayTitle(s)) || p.title || 'New session', s ? timeAgo(s.updated) : 'now', true, text,
          Boolean(act.pending || act.working || act.background?.length), () => openGroup(group.key, p))
      );
    }
    const runningIds = new Set(group.panels.map((p) => p.sessionId));
    for (const s of inGroup.filter((x) => !runningIds.has(x.id)).slice(0, Math.max(0, 3 - lines.length))) {
      lines.push(sessionLine(displayTitle(s), timeAgo(s.updated), false, '', false, () => resumeSession(s), cvs[s.id]?.cv));
    }
    if (!lines.length) card.append(el('div', 'none', 'No saved sessions yet.'));
    card.append(...lines);
    stackCards.append(card);
  });
}

// ---------- Saving and restoring open terminals (⌘R) ----------

function saveWorkspace() {
  saveSettings({ workspace: currentWorkspace() });
}

function currentWorkspace() {
  return panels
    .filter((p) => p.cwd && p.ptyId !== null)
    .map((p) => ({
      number: p.number,
      name: p.name,
      cwd: p.cwd,
      sessionId: p.sessionId,
      title: p.title,
      harnessName: p.harnessName,
      openedBy: p.openedBy || null,
      reportMode: p.reportMode || null,
      report: p.report || null,
      background: Boolean(p.inBackground),
      jobs: jobsOwnedBy(p.number).map((j) => ({ title: j.title, named: j.named, access: j.access, members: [...j.members] })),
    }));
}

function updateRestoreHint() {
  const n = restorable.length;
  document.getElementById('restore-key').hidden = n === 0;
  const text = document.getElementById('restore-text');
  text.hidden = n === 0;
  text.textContent = `Resume the ${n === 1 ? 'terminal' : `${n} terminals`} you had open last time`;
}

async function restoreWorkspace() {
  if (!restorable.length) return;
  const items = restorable;
  restorable = [];
  updateRestoreHint();
  if (view === 'stack') showGrid();
  const known = new Set((await api.listSessions()).map((s) => s.id));
  // Jobs first, so the sidebar groups each terminal as it opens. Workspaces saved before there could be
  // several jobs have one job per owner, made up of the terminals it opened.
  for (const item of items) {
    const saved = item.jobs || (item.job ? [{ ...item.job, members: items.filter((x) => x.openedBy === item.number).map((x) => x.number) }] : []);
    for (const j of saved) {
      const job = newJob({ number: item.number, title: item.title, harnessName: item.harnessName, cwd: item.cwd }, j.title);
      job.named = Boolean(j.named);
      job.access = j.access === 'open' ? 'open' : 'closed';
      job.members = new Set((j.members || []).map(Number));
    }
  }
  for (const item of items) {
    if (!(await api.folderExists(item.cwd))) continue;
    const panel =
      !item.background && isUnstarted(focused) && focused.number === item.number
        ? focused
        : addPanel(item.number, { quiet: Boolean(item.background), inBackground: Boolean(item.background) });
    panel.openedBy = item.openedBy || null;
    panel.reportMode = item.reportMode || null;
    panel.report = item.report || null;
    // A session that never got a message has no saved file, so start a fresh one in that folder instead.
    const resumeId = item.sessionId && known.has(item.sessionId) ? item.sessionId : null;
    await launch(panel, item.cwd, { resumeId, title: item.title, harnessName: item.harnessName, name: resumeId ? item.name : null });
  }
  // Forget terminals that could not be opened again, so a new terminal with the same number does not join.
  for (const job of [...jobs.values()]) {
    for (const n of job.members) if (!panels.some((p) => p.number === n && p.cwd)) job.members.delete(n);
    if (!panels.some((p) => p.number === job.owner && p.cwd)) endJob(job.id);
  }
  drawStatusLine();
}

// ---------- Mentioned sessions (⌘↓ ⌘← ⌘→ ⌘↑) ----------

// The open panel a mention points at: an exact session name such as "2-wrap" first, then the number.
function panelForRef(ref) {
  return (
    (ref.name && panels.find((p) => p.name === ref.name)) ||
    (ref.number != null && panels.find((p) => p.number === ref.number && p.cwd)) ||
    null
  );
}

function flashNote(panel, text) {
  const status = panel.head.querySelector('.status');
  status.textContent = text;
  clearTimeout(panel.noteTimer);
  panel.noteTimer = setTimeout(() => {
    status.textContent = panel.running || !panel.cwd ? '' : 'ended';
  }, 3000);
}

// ⌘↓: show the first session this panel mentioned, full window. The panel you start from is the mother.
function enterMentions(from = focused) {
  if (view !== 'grid' || !from) return;
  const children = (mentionMap.get(from) || []).filter((c) => panels.includes(c));
  if (!children.length) return flashNote(from, 'No other terminal mentioned yet');
  navStack.push({ mother: from, children, index: 0, before: zoomed });
  showMention();
}

function showMention() {
  const top = navStack[navStack.length - 1];
  zoomed = top.children[top.index];
  applyLayout();
  setFocus(zoomed);
}

// ⌘⇧↓: show the panel you started from and every session it mentioned, side by side.
// Pressing it again goes back to all terminals. Inside ⌘↓, it widens to the whole group.
function enterFamily() {
  if (view !== 'grid') return;
  const mother = navStack.length ? navStack[0].mother : focused;
  if (!mother) return;
  if (family && family.mother === mother && !navStack.length) return leaveFamily();
  const children = (mentionMap.get(mother) || []).filter((c) => panels.includes(c));
  if (!children.length) return flashNote(mother, 'No other terminal mentioned yet');
  family = { mother, members: [mother, ...children].sort((a, b) => a.number - b.number) };
  navStack = [];
  zoomed = null;
  applyLayout();
  setFocus(mother);
}

// ⌘↑ from the group: back to all terminals.
function leaveFamily() {
  if (!family) return;
  const mother = family.mother;
  family = null;
  zoomed = null;
  applyLayout();
  setFocus(mother);
}

// ⌘← and ⌘→: move between the mentioned sessions.
function moveMention(step) {
  const top = navStack[navStack.length - 1];
  if (!top) return;
  top.index = (top.index + step + top.children.length) % top.children.length;
  showMention();
}

// ⌘↑: go back to the mother panel, and to whatever was showing before.
function leaveMentions() {
  const top = navStack.pop();
  if (!top) return;
  zoomed = top.before && panels.includes(top.before) ? top.before : null;
  applyLayout();
  setFocus(top.mother);
}

// Every two seconds, work out which terminals each session has mentioned and whether those are
// working (green) or waiting (orange), and show them in the panel's top bar.
let mentionsRefreshing = false;
async function refreshMentions() {
  if (mentionsRefreshing || view !== 'grid') return;
  const started = panels.filter((p) => p.sessionId && p.cwd);
  if (!started.length) return drawStatusLine();
  mentionsRefreshing = true;
  try {
    const refs = await api.sessionMentions(started.map((p) => p.sessionId));
    mentionMap.clear();
    for (const p of started) {
      const children = [];
      for (const ref of refs[p.sessionId] || []) {
        const child = panelForRef(ref);
        if (child && child !== p && !children.includes(child)) children.push(child);
      }
      mentionMap.set(p, children.sort((a, b) => a.number - b.number));
    }
    if (family) {
      const children = (mentionMap.get(family.mother) || []).filter((c) => panels.includes(c));
      const members = [family.mother, ...children].sort((a, b) => a.number - b.number);
      if (members.length !== family.members.length || members.some((m, i) => m !== family.members[i])) {
        family.members = members;
        applyLayout();
      }
    }
    const ids = started.filter((p) => p.running).map((p) => p.sessionId);
    const activity = ids.length ? await api.sessionActivity(ids) : {};
    for (const p of panels) {
      drawMentions(p, mentionMap.get(p) || [], activity);
      drawOwnLight(p, activity[p.sessionId] || {});
      p.agents = activity[p.sessionId]?.agents || [];
      drawAgents(p, p.agents);
    }
    drawStatusLine();
  } finally {
    mentionsRefreshing = false;
  }
}

// Each panel's own light: green while Claude is working, orange when it is waiting for you.
function drawOwnLight(panel, act) {
  const light = panel.head.querySelector('.own-light');
  const state = !panel.cwd ? '' : !panel.running ? 'off' : act.pending || act.working ? 'working' : 'idle';
  light.className = `own-light ${state}`;
  panel.lightState = state;
  drawFriendlyWorking(panel);
  light.title = { working: 'Claude is working', idle: 'Claude is waiting for you', off: 'This session has ended', '': '' }[state];
}

// The line at the bottom of the window counts the terminals, how many are working, and how many need you.
function drawStatusLine() {
  drawSidebar();
  // A terminal that ends or closes can no longer report, so anyone waiting for it should hear.
  if (reportWaiters.size) wakeReportWaiters();
  const open = panels.filter((p) => p.cwd);
  statusLine.innerHTML = '';
  if (!open.length) return;
  const count = (state) => open.filter((p) => p.running && p.lightState === state && !p.needsApproval).length;
  const asking = open.filter((p) => p.running && p.needsApproval).length + [...jobs.values()].reduce((n, j) => n + j.requests.length, 0);
  const item = (text, cls) => {
    const span = el('span', 'status-item' + (cls ? ' ' + cls : ''));
    if (cls) span.append(el('span', 'status-dot'));
    span.append(el('span', null, text));
    statusLine.append(span);
  };
  item(open.length === 1 ? '1 terminal' : `${open.length} terminals`);
  const working = count('working');
  if (working > 0) item(`${working} working`, 'working');
  const waiting = count('idle');
  if (waiting > 0) item(`${waiting} waiting for you`, 'idle');
  if (asking > 0) item(asking === 1 ? '1 needs your approval' : `${asking} need your approval`, 'asking');
  const hidden = open.filter((p) => p.inBackground).length;
  if (hidden > 0) item(`${hidden} in the background`);
  const hint = el('span', 'status-hint');
  hint.innerHTML = '<kbd>⌘/</kbd> shortcuts';
  statusLine.append(hint);
}

function drawMentions(panel, children, activity) {
  const box = panel.head.querySelector('.mentions');
  box.innerHTML = '';
  children.forEach((child, i) => {
    const act = activity[child.sessionId] || {};
    const state = !child.running ? 'off' : act.pending || act.working ? 'working' : 'idle';
    const words = { working: 'working', idle: 'waiting', off: 'ended' }[state];
    const badge = el('button', `mention ${state}`);
    badge.append(el('span', 'light'), el('span', null, `↗ ${child.name || child.number}`));
    badge.title = `${child.name || 'Panel ' + child.number} is ${words}${act.pending ? ': ' + act.pending : ''}. ⌘↓ shows the mentioned sessions.`;
    badge.addEventListener('mousedown', (e) => e.stopPropagation());
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      setFocus(panel);
      enterMentions(panel);
      if (navStack.length && i > 0) moveMention(i);
    });
    box.append(badge);
  });
}

setInterval(refreshMentions, 2000);

// ---------- Shortcuts window (⌘/ or ⌘?) ----------

const shortcutsDialog = document.getElementById('shortcuts-dialog');
let shortcutsToggledAt = 0;

function toggleShortcuts() {
  // ⌘/ comes from the menu and ⌘? from the keyboard. Ignore a second toggle straight after the first.
  if (Date.now() - shortcutsToggledAt < 250) return;
  shortcutsToggledAt = Date.now();
  if (shortcutsDialog.open) shortcutsDialog.close();
  else shortcutsDialog.showModal();
}
shortcutsDialog.addEventListener('close', () => setFocus(focused));
// Clicking outside the list closes it.
shortcutsDialog.addEventListener('click', (e) => {
  if (e.target === shortcutsDialog) shortcutsDialog.close();
});

// ---------- Which harness a panel is in ----------

// Each harness gets its own colour, worked out from its name, so terminals in the same harness match.
function harnessColour(label) {
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function setHarnessPill(panel) {
  const pill = panel.head.querySelector('.harness');
  if (!panel.cwd) return (pill.textContent = '');
  const label = panel.harnessName || baseName(panel.cwd);
  if (pill.textContent === label) return;
  const hue = harnessColour(label);
  pill.textContent = label;
  pill.title = `Harness: ${label}\n${panel.cwd}`;
  pill.style.setProperty('--hue', hue);
}

// ---------- Subagents ----------

function drawAgents(panel, agents) {
  const box = panel.head.querySelector('.agents');
  if (!agents.length) {
    box.textContent = '';
    box.title = '';
    return;
  }
  const mins = (since) => Math.max(0, Math.round((Date.now() - since) / 60000));
  box.textContent = `${agents.length} subagent${agents.length === 1 ? '' : 's'}`;
  box.title =
    'Subagents working:\n' + agents.map((a) => `• ${a.description} (${mins(a.since)} min)`).join('\n');
}

// ---------- The Panels @ list ----------

// Claude Code's own @ list mixes in files and connectors, so other terminals are hard to find. When you
// type @ at the start of a word, Panels shows the other open terminals. Arrow keys and Enter (or a click)
// fill in the name. Typing narrows the list. Esc closes it, and so does anything that looks like a file
// path, so Claude's own file mentions still work.
function trackTyping(panel, data) {
  if (panel.mentionList) {
    if (data === '\x7f') {
      if (!panel.mentionFilter) return closeMentionList(panel);
      panel.mentionFilter = panel.mentionFilter.slice(0, -1);
      return drawMentionList(panel);
    }
    if (/^[\x20-\x7e]+$/.test(data) && !/[\s/.~]/.test(data)) {
      panel.mentionFilter += data;
      return drawMentionList(panel);
    }
    closeMentionList(panel);
  }
  if (data === '@' && panel.atWordStart !== false) {
    panel.mentionFilter = '';
    openMentionList(panel);
  }
  // Remember whether the next character starts a word.
  if (data === '\r' || data === '\x15' || data === '\x03' || data === ' ') panel.atWordStart = true;
  else if (/^[\x21-\x7e]$/.test(data)) panel.atWordStart = false;
}

function mentionCandidates(panel) {
  const q = (panel.mentionFilter || '').toLowerCase();
  return panels
    .filter((p) => p !== panel && p.cwd)
    .filter(
      (p) =>
        !q ||
        String(p.number).startsWith(q) ||
        (p.name || '').toLowerCase().includes(q) ||
        (p.harnessName || baseName(p.cwd)).toLowerCase().includes(q) ||
        (p.about || '').toLowerCase().includes(q)
    );
}

function openMentionList(panel) {
  if (!panels.some((p) => p !== panel && p.cwd)) return; // no other terminals to mention
  panel.mentionList = el('div', 'mention-list');
  panel.mentionIndex = 0;
  panel.body.append(panel.mentionList);
  drawMentionList(panel);
}

function closeMentionList(panel) {
  panel.mentionList?.remove();
  panel.mentionList = null;
}

function drawMentionList(panel) {
  const list = panel.mentionList;
  if (!list) return;
  const items = mentionCandidates(panel);
  if (!items.length) return closeMentionList(panel);
  panel.mentionIndex = Math.min(panel.mentionIndex, items.length - 1);
  list.innerHTML = '';
  list.append(el('div', 'mention-list-head', 'Terminals · ↑↓ ↵ to pick · esc'));
  items.slice(0, 8).forEach((p, i) => {
    const row = el('div', 'mention-row' + (i === panel.mentionIndex ? ' selected' : ''));
    const light = el('span', 'own-light ' + (p.head.querySelector('.own-light').className.split(' ')[1] || ''));
    const pill = el('span', 'harness', p.harnessName || baseName(p.cwd));
    pill.style.setProperty('--hue', harnessColour(p.harnessName || baseName(p.cwd)));
    row.append(el('span', 'num', String(p.number)), light, pill, el('span', 'about', p.about || p.name));
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pickMention(panel, p);
    });
    list.append(row);
  });
}

function mentionListKey(panel, e) {
  const items = mentionCandidates(panel);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const n = Math.min(items.length, 8);
    panel.mentionIndex = (panel.mentionIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    drawMentionList(panel);
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    if (items[panel.mentionIndex]) pickMention(panel, items[panel.mentionIndex]);
    return true;
  }
  if (e.key === 'Escape') {
    closeMentionList(panel);
    return true;
  }
  return false;
}

// Replace what you typed after @ with the terminal's full session name.
function pickMention(panel, target) {
  const name = /\s/.test(target.name) ? `"${target.name}"` : target.name;
  api.write(panel.ptyId, '\x7f'.repeat((panel.mentionFilter || '').length) + name + ' ');
  panel.atWordStart = true;
  closeMentionList(panel);
  panel.term.focus();
}

// ---------- Suggesting an expert ----------

// After your first message in a new terminal, the app checks the CVs itself. If one session is a strong
// match, a small label appears in the top bar. Clicking it adds a line to your message pointing Claude
// at that expert. The × hides it.
async function maybeSuggestExpert(panel, s) {
  if (panel.expertChecked || settings.autoCVs === false || !s?.firstPrompt) return;
  if (!panel.startedAt || s.created < panel.startedAt - 5000) return; // only new sessions, not resumed ones
  panel.expertChecked = true;
  const openIds = panels.map((p) => p.sessionId).filter(Boolean);
  const found = await api.suggestExpert({ sessionId: s.id, cwd: panel.cwd, text: s.firstPrompt, openIds });
  if (!found) return;
  const box = panel.head.querySelector('.expert');
  const label = found.title || found.summary.replace(/^Expert (in|on)\s+/i, '') || found.id.slice(0, 8);
  box.innerHTML = '';
  const use = el('button', 'expert-use', `Expert: ${label.length > 40 ? label.slice(0, 40) + '…' : label}`);
  use.title = `${found.summary}\n\nClick to point Claude at this expert session (${found.id.slice(0, 8)}).`;
  use.addEventListener('mousedown', (e) => e.stopPropagation());
  use.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.term.paste(
      `Use expert session ${found.id.slice(0, 8)} ("${label}") for context: start with its CV and the files it names, then search its conversation if you need more. `
    );
    box.innerHTML = '';
    panel.term.focus();
  });
  const dismiss = el('button', 'expert-x', '×');
  dismiss.title = 'Hide this suggestion';
  dismiss.addEventListener('click', (e) => {
    e.stopPropagation();
    box.innerHTML = '';
  });
  box.append(use, dismiss);
}

// ---------- Approving from the panel you are in ----------

// When another terminal stops to ask for your approval, the request appears as a small card in the
// terminal you are working in, with the same choices. Clicking a choice answers it in that terminal,
// exactly as if you had pressed that number there. Nothing is ever approved without your click.
// Reads an approval or question prompt from the bottom of a terminal's screen. Every Claude Code prompt
// ends with a line that says "Esc to cancel", for example "Esc to cancel · Tab to amend" on a
// permission prompt, or "Enter to select · ↑/↓ to navigate · Esc to cancel" when Claude asks you a
// question. Above that line are the numbered choices, some with a description under them, and above
// those is the question.
function readApproval(p) {
  if (!p.term || !p.running) return null;
  const b = p.term.buffer.active;
  const rows = [];
  for (let y = 0; y < p.term.rows; y++) rows.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');

  // The footer has to be among the last few lines with text, so an old prompt further up is ignored.
  // A new session in a tall terminal can have many empty lines below the prompt.
  const filled = rows.map((r, i) => (r.trim() ? i : -1)).filter((i) => i >= 0);
  const footer = filled.slice(-6).reverse().find((i) => /Esc to cancel/i.test(rows[i])) ?? -1;
  if (footer < 0) return null;

  // A choice can start with the selection mark, or with ↑ or ↓ when the list scrolls in a small terminal.
  const option = /^\s*(?:[❯↑↓]\s*)?(\d+)\.\s+(.+?)\s*$/;
  const rule = /^\s*[─╌]{10,}/;
  const options = [];
  let i = footer - 1;
  for (; i >= 0; i--) {
    const m = rows[i].match(option);
    if (m) {
      options.unshift({ n: m[1], label: m[2] });
      continue;
    }
    if (!rows[i].trim() || rule.test(rows[i])) continue;
    // A line indented under a choice is that choice's description, or the rest of a long choice.
    if (options.length && /^\s{3,}\S/.test(rows[i])) continue;
    break;
  }
  if (!options.length) return null;

  // The question is the block of lines just above the choices. It can run over several lines and does not
  // always end with a question mark. In a small terminal its first lines may be cut off.
  const question = [];
  for (; i >= 0 && rows[i].trim() && !rule.test(rows[i]); i--) {
    // Long questions are drawn with a border down the side, which is not part of the text.
    question.unshift(rows[i].replace(/[│┃]/g, ' ').trim().replace(/\s+/g, ' '));
  }
  // The details sit between the line across the panel and the question.
  const details = [];
  for (let j = i - 1; j >= 0 && !/^─{10,}/.test(rows[j].trim()); j--) {
    const t = rows[j].trim();
    if (t && !/^╌{5,}/.test(t) && !/^Tip:/.test(t)) details.unshift(t);
  }
  return {
    question: question.join(' '),
    options,
    details: details.slice(-4),
    key: question.join(' ') + details.join('|') + options.map((o) => o.label).join('|'),
  };
}

const approvalCards = new Map(); // panel -> { key, card }

function scanApprovals() {
  for (const p of panels) {
    const asking = readApproval(p);
    p.needsApproval = Boolean(asking);
    if (p.friendly) drawFriendlyScreen(p, asking ? null : readOtherScreen(p));
    const onScreen = visiblePanels().includes(p) || p === peeked;
    // In the friendly view the terminal is hidden, so its own questions show as a card too.
    const req = p === focused && onScreen && !p.friendly ? null : asking;
    const shown = approvalCards.get(p);
    if (!req) {
      if (shown) {
        shown.card.remove();
        approvalCards.delete(p);
      }
      continue;
    }
    if (shown?.key === req.key && shown.card.isConnected && shown.host === focused) continue;
    shown?.card.remove();
    const card = buildApprovalCard(p, req);
    const host = focused && (focused !== p || p.friendly) ? focused.body : document.body;
    host.append(card);
    approvalCards.set(p, { key: req.key, card, host: focused });
  }
  // Stack the cards so several requests do not overlap.
  let offset = 0;
  for (const { card } of approvalCards.values()) {
    card.style.bottom = `${64 + offset}px`;
    offset += card.offsetHeight + 8;
  }
  drawStatusLine();
}

function buildApprovalCard(p, req) {
  const card = el('div', 'approval-card');
  const head = el('div', 'approval-head');
  const pill = el('span', 'harness', p.harnessName || baseName(p.cwd));
  pill.style.setProperty('--hue', harnessColour(p.harnessName || baseName(p.cwd)));
  head.append(el('span', 'num', String(p.number)), pill, el('span', null, req.options.length > 0 && /^Do you want/i.test(req.question) ? 'needs your approval' : 'is asking you'));
  const go = el('button', 'link-btn', 'Go to it');
  go.addEventListener('click', () => {
    showPanel(p);
    setFriendly(p, false);
  });
  head.append(go);
  card.append(head);
  for (const d of req.details) card.append(el('div', 'approval-detail', d));
  // The usual "Do you want to proceed?" adds nothing, so only other questions are shown.
  if (!/^Do you want to proceed\?$/i.test(req.question)) {
    const q = el('div', 'approval-question', req.question);
    q.title = req.question;
    card.append(q);
  }
  const choices = el('div', 'approval-choices');
  for (const o of req.options) {
    const short = o.label.split(' · ')[0];
    const b = el('button', 'btn approval-choice', `${o.n}. ${short.length > 38 ? short.slice(0, 38) + '…' : short}`);
    if (String(o.n) === '1') b.classList.add('primary');
    b.title = o.label;
    // Choices that need you to type, such as "Type something", take you to that terminal.
    const needsTyping = /^(Type something|Chat about this)/i.test(o.label);
    b.addEventListener('click', () => {
      api.write(p.ptyId, o.n); // the same as pressing that number in that terminal
      card.remove();
      approvalCards.delete(p);
      if (needsTyping) {
        showPanel(p);
        setFriendly(p, false);
      } else setFocus(focused);
    });
    choices.append(b);
  }
  card.append(choices);
  // A small terminal can scroll some choices out of sight, which leaves gaps in the numbers.
  const hidden = req.options.some((o, i) => Number(o.n) !== (i ? Number(req.options[i - 1].n) + 1 : 1));
  if (hidden) card.append(el('div', 'approval-more', 'Some choices are hidden because the terminal is small. Click Go to it to see them all.'));
  return card;
}

setInterval(scanApprovals, 1000);

// ---------- Settings dialog ----------

const settingsDialog = document.getElementById('settings-dialog');
const form = document.getElementById('settings-form');
const promptField = document.getElementById('prompt-field');
const promptText = document.getElementById('prompt-text');
const harnessList = document.getElementById('harness-list');
const harnessName = document.getElementById('harness-name');
let draftPrompts = {};

function currentMode() {
  return form.querySelector('input[name="fileMode"]:checked').value;
}

function showPromptFor(mode) {
  promptField.hidden = mode === 'off';
  promptText.value = draftPrompts[mode] || '';
}

// The choices for the model and the advisor. The advisors "run by the app" use the app's ask_advisor tool,
// for places where Claude Code has no advisor of its own, such as Google Vertex.
const MODEL_CHOICES = [['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
const ADVISOR_CHOICES = [
  ['off', 'Off'],
  ['opus', 'Opus'],
  ['fable', 'Fable'],
  { group: 'Run by the app, for Vertex', items: [['app:opus', 'Opus (app)'], ['app:fable', 'Fable (app)'], ['app:sonnet', 'Sonnet (app)']] },
];

function fillSelect(select, firstLabel, choices, value) {
  select.innerHTML = '';
  const option = (v, label) => {
    const o = el('option', null, label);
    o.value = v;
    return o;
  };
  select.append(option('', firstLabel));
  const known = [];
  for (const c of choices) {
    if (Array.isArray(c)) {
      select.append(option(...c));
      known.push(c[0]);
    } else {
      const group = document.createElement('optgroup');
      group.label = c.group;
      c.items.forEach((i) => group.append(option(...i)));
      known.push(...c.items.map((i) => i[0]));
      select.append(group);
    }
  }
  // Keep a value set by hand in the settings file, even if it is not one of the choices.
  if (value && !known.includes(value)) select.append(option(value, value));
  select.value = value || '';
}

// The harness table: a Default row, then one row per harness. Every change is saved straight away.
function renderHarnessList() {
  harnessList.innerHTML = '';
  const head = el('div', 'harness-row head');
  for (const t of ['Harness', 'Model', 'Advisor', 'Code Mode', 'Explain', 'Friendly', '']) head.append(el('span', null, t));
  harnessList.append(head);

  const select = (firstLabel, choices, value, save) => {
    const s = el('select');
    fillSelect(s, firstLabel, choices, value);
    s.addEventListener('change', () => save(s.value));
    return s;
  };
  const saveHarness = async (h, changes) => {
    const changed = { ...h, ...changes };
    for (const k of Object.keys(changes)) if (!changes[k]) delete changed[k];
    await saveSettings({ harnesses: settings.harnesses.map((x) => (x === h ? changed : x)) });
    renderHarnessList();
  };

  // The Default row is used by harnesses set to Default and by folders that are not a harness.
  const def = el('div', 'harness-row default');
  const defName = el('span', 'harness-name');
  defName.append(el('span', 'label', 'Default'), el('span', 'detail', 'All other sessions'));
  defName.title = 'Used by sessions outside a harness, and by any harness setting left on Default';
  def.append(
    defName,
    select("Claude Code's", MODEL_CHOICES, settings.defaultModel, (v) => saveSettings({ defaultModel: v })),
    select("Claude Code's", ADVISOR_CHOICES, settings.defaultAdvisor, (v) => saveSettings({ defaultAdvisor: v })),
    el('span'),
    el('span'),
    el('span'),
    el('span')
  );
  harnessList.append(def);

  for (const h of settings.harnesses) {
    const row = el('div', 'harness-row');
    const name = el('span', 'harness-name');
    name.append(el('span', 'label', '/' + slug(h.name)), el('span', 'detail', tildePath(h.path)));
    name.title = h.path;
    const box = el('input');
    box.type = 'checkbox';
    box.checked = Boolean(h.codeMode);
    box.title = "Start new sessions here in Claude Code's experimental Code Mode";
    box.addEventListener('change', () => saveHarness(h, { codeMode: box.checked }));
    const code = el('span', 'harness-code');
    code.append(box);
    const explainBox = el('input');
    explainBox.type = 'checkbox';
    explainBox.checked = Boolean(h.explain);
    explainBox.title = 'Underline the words that structure this work, and explain one when you hold the mouse over it';
    explainBox.addEventListener('change', () => saveHarness(h, { explain: explainBox.checked }));
    const explain = el('span', 'harness-code');
    explain.append(explainBox);
    const friendlyBox = el('input');
    friendlyBox.type = 'checkbox';
    friendlyBox.checked = Boolean(h.friendly);
    friendlyBox.title = 'Open sessions here in the friendly view, a plainer view of the conversation. ⌘E shows the terminal';
    friendlyBox.addEventListener('change', () => saveHarness(h, { friendly: friendlyBox.checked }));
    const friendly = el('span', 'harness-code');
    friendly.append(friendlyBox);
    const remove = el('button', 'icon-x', '×');
    remove.type = 'button';
    remove.title = `Remove /${slug(h.name)}`;
    remove.addEventListener('click', async () => {
      await saveSettings({ harnesses: settings.harnesses.filter((x) => x !== h) });
      renderHarnessList();
      refreshPickers();
    });
    row.append(
      name,
      select('Default', MODEL_CHOICES, h.model, (v) => saveHarness(h, { model: v })),
      select('Default', ADVISOR_CHOICES, h.advisor, (v) => saveHarness(h, { advisor: v })),
      code,
      explain,
      friendly,
      remove
    );
    harnessList.append(row);
  }
  renderHarnessSuggestions();
}

// Recent folders that are not harnesses yet, each with a button that saves it as one.
async function renderHarnessSuggestions() {
  const box = document.getElementById('harness-suggest');
  const saved = new Set(settings.harnesses.map((h) => h.path));
  const candidates = settings.recentLocations.filter((d) => !saved.has(d) && d !== settings.home).slice(0, 6);
  const exists = await Promise.all(candidates.map((d) => api.folderExists(d)));
  const folders = candidates.filter((_, i) => exists[i]);
  box.innerHTML = '';
  box.hidden = folders.length === 0;
  if (!folders.length) return;
  box.append(el('div', 'suggest-head', 'Recent folders'));
  for (const dir of folders) {
    const row = el('div', 'suggest-row');
    const name = el('span', 'harness-name');
    name.append(el('span', 'label', '/' + harnessNameFor(dir)), el('span', 'detail', tildePath(dir)));
    name.title = dir;
    const add = el('button', 'btn small', 'Add');
    add.type = 'button';
    add.addEventListener('click', async () => {
      await addHarness(harnessNameFor(dir), dir);
      renderHarnessList();
      refreshPickers();
    });
    row.append(name, add);
    box.append(row);
  }
}

// A harness name for a folder: the folder's name, with a number added if that name is taken.
function harnessNameFor(dir) {
  const base = slug(baseName(dir)) || 'folder';
  const taken = new Set(settings.harnesses.map((h) => slug(h.name)));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return name;
}

async function addHarnessFromSettings() {
  const name = harnessName.value.trim();
  if (!slug(name)) return harnessName.focus();
  const dir = await api.chooseFolder();
  if (!dir) return;
  await addHarness(name, dir);
  harnessName.value = '';
  renderHarnessList();
  refreshPickers();
}

// Settings is split into pages. The page you used last opens again.
const settingsNav = document.getElementById('settings-nav');
let settingsPage = 'harnesses';
function showSettingsPage(name) {
  settingsPage = name;
  settingsNav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.page === name));
  form.querySelectorAll('.settings-page').forEach((s) => (s.hidden = s.dataset.page !== name));
  if (name === 'glossary') renderCodex();
}

// The Glossary page: every term Claude has explained, by folder, and how well you know each one.
function renderCodex() {
  const box = document.getElementById('codex-list');
  box.innerHTML = '';
  const folders = Object.entries(glossaryData.glossary.folders).filter(([, f]) => Object.keys(f.terms || {}).length);
  if (!folders.length) {
    box.append(el('p', 'note', 'No terms yet. Tick Explain on a harness on the Harnesses page, and Claude adds terms as it works there.'));
    return;
  }
  const order = { new: 0, seen: 1, familiar: 2, known: 3 };
  for (const [key, folder] of folders) {
    const terms = Object.entries(folder.terms).sort(
      (a, b) => order[termProgress(key, a[0])] - order[termProgress(key, b[0])] || a[1].term.localeCompare(b[1].term)
    );
    const known = terms.filter(([t]) => termProgress(key, t) === 'known').length;
    const head = el('div', 'codex-folder');
    head.append(el('span', 'label', tildePath(key)), el('span', 'detail', `${terms.length} terms, ${known} known`));
    head.title = key;
    box.append(head);
    for (const [t, entry] of terms) {
      const progress = termProgress(key, t);
      const row = el('div', 'codex-row');
      const words = el('span', 'codex-words');
      words.append(el('span', 'codex-term', entry.term), el('span', 'codex-short', entry.short));
      words.title = entry.explanation;
      const know = el('button', 'link-btn', progress === 'known' ? 'Not sure' : 'I know this');
      know.type = 'button';
      know.addEventListener('click', async () => {
        glossaryData.codex = await api.updateCodex(key, t, { known: progress !== 'known' });
        renderCodex();
      });
      const remove = el('button', 'icon-x', '×');
      remove.type = 'button';
      remove.title = `Remove "${entry.term}" from the glossary`;
      remove.addEventListener('click', async () => {
        glossaryData.glossary = await api.removeTerm(key, t);
        await api.updateCodex(key, t, { forget: true }).then((codex) => (glossaryData.codex = codex));
        matchers.delete(key);
        for (const p of panels) if (p.marker && p.glossaryKey === key) p.marker.matcher = matcherFor(key);
        renderCodex();
      });
      row.append(words, el('span', `tip-progress ${progress}`, { new: 'New', seen: 'Seen', familiar: 'Familiar', known: 'Known' }[progress]), know, remove);
      box.append(row);
    }
  }
}
settingsNav.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-page]');
  if (b) showSettingsPage(b.dataset.page);
});

function openSettings(page) {
  showSettingsPage(typeof page === 'string' ? page : settingsPage);
  draftPrompts = { ...settings.prompts };
  form.querySelector(`input[name="fileMode"][value="${settings.fileMode}"]`).checked = true;
  showPromptFor(settings.fileMode);
  document.getElementById('claude-command').value = settings.claudeCommand;
  document.getElementById('font-size').value = settings.fontSize;
  document.getElementById('auto-titles').checked = settings.autoTitles !== false;
  document.getElementById('auto-cvs').checked = settings.autoCVs !== false;
  document.getElementById('classic-display').checked = Boolean(settings.classicDisplay);
  for (const box of document.querySelectorAll('[data-simple]')) box.checked = Boolean(settings.simple?.[box.dataset.simple]);
  document.getElementById('simple-welcome').value = settings.simple?.welcome || '';
  document.getElementById('line-height').value = String(settings.lineHeight ?? 1.1);
  document.getElementById('letter-spacing').value = String(settings.letterSpacing ?? 0);
  document.getElementById('theme').value = settings.theme === 'blue' ? 'blue' : 'claude';
  const fontMenu = document.getElementById('font-family');
  const fonts = installedFonts();
  const current = settings.fontFamily || 'JetBrains Mono';
  fontMenu.innerHTML = '';
  for (const f of fonts.includes(current) ? fonts : [current, ...fonts]) {
    const o = el('option', null, f);
    o.value = f;
    fontMenu.append(o);
  }
  fontMenu.value = current;
  showFontPreview();
  renderHarnessList();
  settingsDialog.showModal();
}

function showFontPreview() {
  const preview = document.getElementById('font-preview');
  preview.style.fontFamily = termFont(document.getElementById('font-family').value);
}
document.getElementById('font-family').addEventListener('change', showFontPreview);

form.querySelectorAll('input[name="fileMode"]').forEach((radio) =>
  radio.addEventListener('change', () => showPromptFor(currentMode()))
);
promptText.addEventListener('input', () => {
  draftPrompts[currentMode()] = promptText.value;
});
document.getElementById('prompt-reset').addEventListener('click', () => {
  const mode = currentMode();
  draftPrompts[mode] = settings.defaultPrompts[mode];
  promptText.value = draftPrompts[mode];
});
document.getElementById('harness-add-btn').addEventListener('click', addHarnessFromSettings);
harnessName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addHarnessFromSettings();
  }
});

settingsDialog.addEventListener('close', async () => {
  setFocus(focused);
  if (settingsDialog.returnValue !== 'save') return;
  const fontSize = Math.min(24, Math.max(9, Number(document.getElementById('font-size').value) || 13));
  await saveSettings({
    fileMode: currentMode(),
    prompts: draftPrompts,
    claudeCommand: document.getElementById('claude-command').value.trim() || 'claude',
    fontSize,
    autoTitles: document.getElementById('auto-titles').checked,
    autoCVs: document.getElementById('auto-cvs').checked,
    classicDisplay: document.getElementById('classic-display').checked,
    simple: {
      ...Object.fromEntries([...document.querySelectorAll('[data-simple]')].map((box) => [box.dataset.simple, box.checked])),
      welcome: document.getElementById('simple-welcome').value.trim(),
    },
    lineHeight: Number(document.getElementById('line-height').value) || 1,
    letterSpacing: Number(document.getElementById('letter-spacing').value) || 0,
    theme: document.getElementById('theme').value,
    fontFamily: document.getElementById('font-family').value || 'JetBrains Mono',
  });
  applyTheme();
  for (const p of panels) {
    if (p.term) {
      p.term.options.fontSize = fontSize;
      p.term.options.fontFamily = termFont();
      p.term.options.lineHeight = settings.lineHeight || 1;
      p.term.options.letterSpacing = settings.letterSpacing || 0;
      p.fit.fit();
    }
  }
});

// ---------- Wiring ----------

function browseShortcut() {
  browse(isUnstarted(focused) ? focused : addPanel());
}

// Wrapped so the click or menu event is never mistaken for a panel number.
document.getElementById('new-btn').addEventListener('click', () => addPanel());
document.getElementById('search-btn').addEventListener('click', openSearch);
document.getElementById('settings-btn').addEventListener('click', openSettings);
layoutBtn.addEventListener('click', toggleOddLayout);
document.getElementById('stack-btn').addEventListener('click', toggleStack);
sideBtn.addEventListener('click', () => toggleSidebar());
sideList.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('tree-row')) {
    e.preventDefault();
    e.target.click();
  }
});
api.onAppRequest(async (id, kind, payload) => {
  try {
    if (kind === 'gate') api.appResult(id, await gateRequest(payload));
    else if (kind === 'job') api.appResult(id, setJobFromClaude(payload));
    else if (kind === 'wrap-up') api.appResult(id, await wrapUpJob(jobToWrapUp(payload.from, payload.job), { byClaude: true }));
    else if (kind === 'report') api.appResult(id, takeReport(payload));
    else if (kind === 'reports') api.appResult(id, await waitForReports(payload));
    else api.appResult(id, { error: 'Unknown request.' });
  } catch (err) {
    api.appResult(id, { error: err.message });
  }
});
document.getElementById('side-close').addEventListener('click', () => toggleSidebar(false));
document.getElementById('peek-hide').addEventListener('click', () => hidePeek());
document.getElementById('peek-open').addEventListener('click', () => peeked && setBackground(peeked, false, { focus: true }));
sideList.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]');
  if (action) return jobAction(Number(action.dataset.job), action.dataset.action, action.dataset.request);
  const row = e.target.closest('[data-number]');
  const panel = row && panels.find((p) => p.number === Number(row.dataset.number));
  if (!panel) return;
  if (!panel.inBackground) return showPanel(panel);
  if (peeked === panel) hidePeek();
  else showPeek(panel);
});
filterChip.addEventListener('click', toggleStack);
zoomChip.addEventListener('click', toggleZoom);
navChip.addEventListener('click', () => (navStack.length ? leaveMentions() : leaveFamily()));

api.onMenu('new', () => addPanel());
api.onMenu('search', openSearch);
api.onMenu('browse', browseShortcut);
api.onMenu('upload', addFilesToTerminal);
api.onMenu('shortcuts', toggleShortcuts);
api.onMenu('copy-reply', copyLastReply);
api.onMenu('check-update', checkUpdateNow);
api.onMenu('close', () => view === 'grid' && closePanel(focused));
api.onMenu('layout', toggleOddLayout);
api.onMenu('zoom', toggleZoom);
api.onMenu('sidebar', () => toggleSidebar());
api.onMenu('to-background', () => focused && toggleBackground(focused));
api.onMenu('stack', toggleStack);
api.onMenu('restore', restoreWorkspace);
api.onMenu('settings', openSettings);
api.onMenu('friendly', () => focused?.term && setFriendly(focused, !focused.friendly));

// ⌘1 to ⌘9 jump to that terminal, showing it if a filter hides it. In the stack view they open a harness.
window.addEventListener('keydown', (e) => {
  if (e.metaKey && /^[1-9]$/.test(e.key)) {
    const n = Number(e.key) - 1;
    e.preventDefault();
    if (view === 'stack') {
      if (stackGroups[n]) openGroup(stackGroups[n].key);
    } else if (panels.find((p) => p.number === n + 1)) {
      showPanel(panels.find((p) => p.number === n + 1));
    }
  } else if (e.metaKey && !e.altKey && e.key.startsWith('Arrow') && (!e.shiftKey || e.key === 'ArrowDown')) {
    const t = e.target;
    const typingInBox = (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && !t.classList.contains('xterm-helper-textarea');
    if (typingInBox || view !== 'grid' || searchDialog.open || settingsDialog.open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (e.shiftKey) enterFamily();
      else enterMentions(focused);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (navStack.length) leaveMentions();
      else if (family) leaveFamily();
    } else if (navStack.length) {
      e.preventDefault();
      moveMention(e.key === 'ArrowLeft' ? -1 : 1);
    }
  } else if (e.metaKey && (e.key === '?' || e.key === '/')) {
    e.preventDefault();
    toggleShortcuts();
  } else if (e.key === 'Escape' && view === 'stack' && !searchDialog.open && !settingsDialog.open && !shortcutsDialog.open) {
    toggleStack();
  }
});

// Every 20 seconds, check whether /clear moved any terminal onto a new session, so ⌘R and the
// search tools always point at the session each terminal is on now.
setInterval(async () => {
  if (!panels.some((p) => p.running)) return;
  sessions = await api.listSessions();
  followNewSessions();
  updateTitles();
}, 5000);

// What a session is about: a name you chose with /rename, Claude's own title, the app's Haiku title,
// or else the start of your first message.
function displayTitle(s) {
  if (!s) return '';
  if (s.customTitle && !/^\d+-[\w-]+$/.test(s.customTitle)) return s.customTitle;
  if (s.aiTitle) return s.aiTitle;
  const made = settings.titles?.[s.id]?.title;
  if (made) return made;
  const words = (s.firstPrompt || s.lastPrompt || s.title || '').split(/\s+/);
  return words.slice(0, 8).join(' ') + (words.length > 8 ? '…' : '');
}

// Ask Haiku for a title once the first message is in, and again at most every 15 minutes while
// new requests keep coming. Only for open terminals.
function maybeMakeTitle(s) {
  if (!settings.autoTitles || !s || s.aiTitle) return;
  if (s.customTitle && !/^\d+-[\w-]+$/.test(s.customTitle)) return;
  const basedOn = s.lastPrompt || s.firstPrompt;
  if (!basedOn) return;
  const made = settings.titles?.[s.id];
  if (made && (made.basedOn === basedOn || Date.now() - made.at < 15 * 60000)) return;
  const text = [s.firstPrompt, s.lastPrompt].filter((x, i, a) => x && a.indexOf(x) === i).join('\n\n');
  api.makeTitle({ sessionId: s.id, text, basedOn }).then((title) => {
    if (!title) return;
    settings.titles = { ...(settings.titles || {}), [s.id]: { title, basedOn, at: Date.now() } };
    updateTitles();
  });
}

// Each panel's top bar shows what its session is about, from Claude's own title for the session,
// or the name you gave it with /rename. A /rename name also becomes the name other sessions use.
function updateTitles() {
  let renamed = false;
  for (const p of panels) {
    const s = p.sessionId && sessions?.find((x) => x.id === p.sessionId);
    if (!s) continue;
    if (s.customTitle && !/^\d+-[\w-]+$/.test(s.customTitle) && s.customTitle !== p.name) {
      p.name = s.customTitle;
      renamed = true;
    }
    p.about = displayTitle(s);
    maybeMakeTitle(s);
    setHarnessPill(p);
    const label = p.harnessName || baseName(p.cwd);
    const text = p.about && p.about !== label ? p.about : '';
    const title = p.head.querySelector('.title');
    if (title.textContent !== text) {
      title.textContent = text;
      title.title = text;
    }
    maybeSuggestExpert(p, s);
  }
  if (renamed) saveWorkspace();
}

(async () => {
  settings = await api.getSettings();
  applyTheme();
  await loadBundledFonts();
  await loadGlossary();
  restorable = settings.workspace || [];
  updateRestoreHint();
  applyLayout();
  if (settings.restoreOnLaunch) {
    await saveSettings({ restoreOnLaunch: false });
    restoreWorkspace();
  }
})();

// ---------- Terminals opened by Claude ----------

// Claude in one terminal can ask the app, through the panels open_terminal tool, to open a new terminal
// in a harness and start Claude there with a task. The new terminal opens without taking over the view,
// and a small notice says which terminal opened it.
api.onOpenRequest(async (id, req) => {
  try {
    const from = panels.find((p) => p.number === req.from);
    if (!from) throw new Error(`Terminal ${req.from} is not open.`);
    const panel = addPanel(undefined, { quiet: true, inBackground: Boolean(req.background) });
    panel.openedBy = from.number;
    panel.reportMode = req.wait ? 'result' : 'message';
    const job = jobForOpen(from, req.job);
    job.members.add(panel.number);
    // A terminal that is waiting with wait_for_report gets the report through report_back instead of a message.
    const howToReport = req.wait
      ? `When you have finished, call the panels report_back tool with a short report. Terminal ${from.number} is ` +
        'waiting for it there, so do not send the report with SendMessage. Then tell the user here what you did.'
      : `When you have finished, send ${from.name} a short report with SendMessage, then tell the user here what you did.`;
    const firstMessage =
      `Terminal ${from.number} (${from.name}) opened this terminal and asked for help with the task below. ` +
      `${howToReport}\n\nTask from terminal ${from.number}:\n${req.task}`;
    await launch(panel, req.folder, {
      title: req.harnessName || baseName(req.folder),
      harnessName: req.harnessName,
      firstMessage,
    });
    if (panel.ptyId === null) throw new Error('The new terminal could not start Claude.');
    // A background session appears in the sidebar, so it needs no notice.
    if (!panel.inBackground) showOpenedNotice(from, panel, req.task);
    api.openResult(id, { number: panel.number, name: panel.name, folder: req.folder, job: job.title });
  } catch (err) {
    api.openResult(id, { error: err.message });
  }
});

// ---------- Reports for wait_for_report ----------

// A terminal opened with wait set to true hands in its report with report_back. The terminal that
// opened it collects reports with wait_for_report, which asks here about once a minute until they are in.

function wakeReportWaiters() {
  for (const wake of [...reportWaiters]) wake();
}

function takeReport({ from, report }) {
  const panel = panels.find((p) => p.number === Number(from) && p.cwd);
  if (!panel) throw new Error('This terminal is not open in Claude Panels.');
  if (!panel.openedBy) throw new Error('No other terminal opened this one, so there is nobody to report to.');
  const owner = panels.find((p) => p.number === panel.openedBy && p.cwd);
  if (!owner) throw new Error(`Terminal ${panel.openedBy}, which opened this one, is closed.`);
  if (panel.reportMode !== 'result') {
    throw new Error(`Terminal ${owner.number} is not waiting for a report here. Send your report to ${owner.name} with SendMessage instead.`);
  }
  const text = String(report || '').trim();
  if (!text) throw new Error('Write the report first.');
  panel.report = { text: text.slice(0, 20000), at: Date.now() };
  saveWorkspace();
  drawSidebar();
  wakeReportWaiters();
  return { to: owner.number, toName: owner.name };
}

// The state of each terminal the caller is waiting for.
function reportStates(from, numbers) {
  return numbers.map((n) => {
    const p = panels.find((x) => x.number === n && x.cwd && x.openedBy === from);
    if (!p) return { number: n, state: 'closed' };
    const base = { number: n, name: p.name };
    if (p.report) return { ...base, state: 'reported', report: p.report.text };
    if (p.reportMode !== 'result') return { ...base, state: 'by-message' };
    if (!p.running) return { ...base, state: 'ended' };
    if (p.needsApproval) return { ...base, state: 'asking' };
    return { ...base, state: p.lightState === 'idle' ? 'idle' : 'working' };
  });
}

async function waitForReports({ from, terminals, waitMs }) {
  from = Number(from);
  const owner = panels.find((p) => p.number === from && p.cwd);
  if (!owner) throw new Error('This terminal is not open in Claude Panels.');
  let numbers = (Array.isArray(terminals) ? terminals : []).map(Number).filter(Number.isFinite);
  if (!numbers.length) numbers = panels.filter((p) => p.openedBy === from && p.reportMode === 'result' && p.cwd).map((p) => p.number);
  if (!numbers.length) throw new Error('You have no terminals to wait for. Open them with open_terminal and wait set to true first.');
  const notMine = numbers.filter((n) => {
    const p = panels.find((x) => x.number === n && x.cwd);
    return p && p.openedBy !== from;
  });
  if (notMine.length) throw new Error(`You did not open terminal ${notMine.join(' or ')}, so you cannot wait for its report.`);

  // Finished means every terminal has reported, or can no longer report.
  const finished = () => reportStates(from, numbers).every((r) => ['reported', 'closed', 'ended', 'by-message'].includes(r.state));
  const limit = Math.min(Math.max(Number(waitMs) || 0, 0), 55000);
  if (!finished() && limit) {
    await new Promise((resolve) => {
      const done = () => {
        reportWaiters.delete(check);
        clearTimeout(timer);
        resolve();
      };
      const check = () => finished() && done();
      const timer = setTimeout(done, limit);
      reportWaiters.add(check);
    });
  }
  return { done: finished(), terminals: reportStates(from, numbers) };
}

// A short notice at the top right that goes away by itself.
function showNotice(title, text) {
  const box = el('div', 'opened-notice');
  const head = el('div', 'approval-head');
  head.append(el('span', null, title));
  const close = el('button', 'link-btn', '×');
  close.title = 'Dismiss';
  close.style.marginLeft = 'auto';
  close.addEventListener('click', () => box.remove());
  head.append(close);
  box.append(head, el('div', 'approval-question', text));
  document.body.append(box);
  setTimeout(() => box.remove(), 10000);
}

function showOpenedNotice(from, panel, task) {
  const box = el('div', 'opened-notice');
  const head = el('div', 'approval-head');
  const pill = (p) => {
    const label = p.harnessName || baseName(p.cwd);
    const x = el('span', 'harness', label);
    x.style.setProperty('--hue', harnessColour(label));
    return x;
  };
  head.append(el('span', 'num', String(from.number)), pill(from), el('span', null, 'opened'), el('span', 'num', String(panel.number)), pill(panel));
  const go = el('button', 'link-btn', 'Go to it');
  go.addEventListener('click', () => {
    box.remove();
    showPanel(panel);
  });
  const close = el('button', 'link-btn', '×');
  close.title = 'Dismiss';
  close.addEventListener('click', () => box.remove());
  head.append(go, close);
  const text = el('div', 'approval-question', task);
  text.title = task;
  box.append(head, text);
  document.body.append(box);
  setTimeout(() => box.remove(), 30000);
}
