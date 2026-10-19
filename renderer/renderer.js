/* global Terminal, FitAddon, WebLinksAddon */

const api = window.panelsApi;
const grid = document.getElementById('grid');
const emptyState = document.getElementById('empty');
const layoutBtn = document.getElementById('layout-btn');
const layoutLabel = document.getElementById('layout-label');
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
let zoomed = null; // when set, this one panel fills the window
// Moving between mentioned sessions. Each level remembers the panel you came from (the mother),
// the sessions it mentioned (its children), which child is showing, and what was showing before.
let navStack = []; // [{ mother, children, index, before }]
const mentionMap = new Map(); // panel -> the open panels its session has mentioned
// ⌘⇧↓ shows one group at once: the panel you started from and every session it mentioned.
let family = null; // { mother, members }
let restorable = []; // panels open when the app last closed, restored with ⌘R

const TERM_THEME = {
  background: '#14171c',
  foreground: '#e2e5ea',
  cursor: '#8fa8dc',
  cursorAccent: '#14171c',
  selectionBackground: '#22396b',
};

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
  if (zoomed && panels.includes(zoomed)) return [zoomed];
  if (family) return family.members.filter((p) => panels.includes(p));
  return panels.filter((p) => !filterKey || !p.cwd || groupOf(p).key === filterKey);
}

// ⌘F makes the selected panel fill the window. Pressing it again shows the other panels again.
function toggleZoom() {
  if (view !== 'grid') return;
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

  emptyState.hidden = panels.length > 0 || view === 'stack';
  layoutBtn.hidden = !odd || view === 'stack' || Boolean(zoomed);
  layoutLabel.textContent = bottom ? 'Last panel: bottom' : 'Last panel: side';

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
    p.el.style.display = i === -1 ? 'none' : '';
    const last = odd && i === n - 1;
    p.el.style.gridColumn = last ? (bottom ? '1 / -1' : `${cols}`) : '';
    p.el.style.gridRow = last ? (bottom ? `${rows}` : '1 / -1') : '';
    // Numbers stay the same when a harness filter is on, so ⌘2 and @2 always mean the same terminal.
    p.head.querySelector('.num').textContent = `${p.number}`;
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
  if (panel?.term) panel.term.focus();
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

function addPanel(wantedNumber) {
  if (view === 'stack') showGrid();
  zoomed = null;
  navStack = [];
  family = null;
  const panel = { ptyId: null, term: null, fit: null, cwd: null, running: false, sessionId: null, harnessName: null };
  panel.number = freeNumber(wantedNumber);

  panel.el = el('div', 'panel');
  panel.head = el('div', 'panel-head');
  panel.head.append(
    el('span', 'num'),
    el('span', 'own-light'),
    el('span', 'title', 'New terminal'),
    el('span', 'path'),
    el('span', 'mentions'),
    el('span', 'status')
  );
  const closeBtn = el('button', 'close', '×');
  closeBtn.title = 'Close (⌘W)';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closePanel(panel);
  });
  panel.head.append(closeBtn);
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
  const at = panels.findIndex((p) => p.number > panel.number);
  if (at === -1) {
    panels.push(panel);
    grid.append(panel.el);
  } else {
    grid.insertBefore(panel.el, panels[at].el);
    panels.splice(at, 0, panel);
  }
  applyLayout();
  showPicker(panel);
  setFocus(panel);
  return panel;
}

function closePanel(panel) {
  if (!panel) return;
  if (panel.running && !confirm('Close this terminal? Anything running in it, including Claude, will stop.')) return;
  if (panel.ptyId !== null) {
    api.kill(panel.ptyId);
    byPtyId.delete(panel.ptyId);
  }
  panel.term?.dispose();
  panel.resizeObserver?.disconnect();
  panel.el.remove();
  const i = panels.indexOf(panel);
  panels.splice(i, 1);
  if (zoomed === panel) zoomed = null;
  if (filterKey && !panels.some((p) => p.cwd && groupOf(p).key === filterKey)) filterKey = null;
  applyLayout();
  const shown = visiblePanels();
  setFocus(shown.includes(panels[i]) ? panels[i] : shown[shown.length - 1] || null);
  saveWorkspace();
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
  const others = settings.harnesses.filter((h) => slug(h.name) !== slug(name));
  await saveSettings({ harnesses: [...others, { name: slug(name), path: dir }] });
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
        when: p.running ? 'open' : 'ended',
        detail: `${groupOf(p).name} · ${tildePath(p.cwd)}`,
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

async function launch(panel, dir, { resumeId = null, title = null, harnessName = null, name = null } = {}) {
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
  panel.head.querySelector('.title').textContent = panel.title;
  panel.head.querySelector('.path').textContent = tildePath(dir);
  panel.head.querySelector('.path').title = dir;
  panel.body.innerHTML = '';

  const host = el('div', 'term-host');
  panel.body.append(host);

  const term = new Terminal({
    fontFamily: '"SF Mono", Menlo, Monaco, monospace',
    fontSize: settings.fontSize,
    theme: TERM_THEME,
    cursorBlink: true,
    allowProposedApi: true,
    macOptionIsMeta: true,
    scrollback: 10000,
    linkHandler: { activate: (_e, uri) => openLinkTarget(uri), allowNonHttpProtocols: true },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => openLinkTarget(uri)));
  term.open(host);
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

    return true;
  });

  panel.term = term;
  panel.fit = fit;

  try {
    // Keep a name the user chose with /rename. Otherwise name the session after its panel.
    panel.name = name && !/^\d+-[\w-]+$/.test(name) ? name : sessionName(panel);
    const started = await api.startTerminal({
      cwd: dir,
      cols: term.cols,
      rows: term.rows,
      resumeId,
      name: panel.name,
      number: panel.number,
    });
    panel.ptyId = started.id;
    panel.sessionId = started.sessionId;
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
    term.write(pendingData.get(panel.ptyId));
    pendingData.delete(panel.ptyId);
  }

  term.onData((data) => panel.running && api.write(panel.ptyId, data));
  term.onResize(({ cols, rows }) => panel.ptyId !== null && api.resize(panel.ptyId, cols, rows));

  panel.resizeObserver = new ResizeObserver(() => {
    if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
  });
  panel.resizeObserver.observe(host);

  // If a harness filter is on and this terminal is in a different harness, show everything again.
  if (filterKey && groupOf(panel).key !== filterKey) filterKey = null;
  applyLayout();

  // This folder is now a recent one, so refresh the lists in any other new panels.
  settings = { ...settings, ...(await api.getSettings()) };
  refreshPickers();
  saveWorkspace();
  if (focused === panel) term.focus();
}

api.onData((id, data) => {
  const panel = byPtyId.get(id);
  if (panel) panel.term.write(data);
  else pendingData.set(id, (pendingData.get(id) || '') + data);
});

api.onExit((id) => {
  const panel = byPtyId.get(id);
  if (!panel) return;
  panel.running = false;
  panel.head.querySelector('.status').textContent = 'ended';
  panel.term.write('\r\n\x1b[2m[This session has ended. Press ⌘W to close the panel.]\x1b[0m\r\n');
});

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
api.onUpdateProgress((text) => {
  updateBtn.hidden = false;
  updateBtn.textContent = text;
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
  navStack = [];
  if (family && !family.members.includes(panel)) family = null;
  if (zoomed) zoomed = panel; // in full-window mode, ⌘1 to ⌘9 switch which panel fills the window
  if (filterKey && panel.cwd && groupOf(panel).key !== filterKey) filterKey = null;
  applyLayout();
  setFocus(panel);
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
  for (const item of items) {
    if (!(await api.folderExists(item.cwd))) continue;
    const panel = isUnstarted(focused) && focused.number === item.number ? focused : addPanel(item.number);
    // A session that never got a message has no saved file, so start a fresh one in that folder instead.
    const resumeId = item.sessionId && known.has(item.sessionId) ? item.sessionId : null;
    await launch(panel, item.cwd, { resumeId, title: item.title, harnessName: item.harnessName, name: resumeId ? item.name : null });
  }
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
  if (!started.length) return;
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
    }
  } finally {
    mentionsRefreshing = false;
  }
}

// Each panel's own light: green while Claude is working, orange when it is waiting for you.
function drawOwnLight(panel, act) {
  const light = panel.head.querySelector('.own-light');
  const state = !panel.cwd ? '' : !panel.running ? 'off' : act.pending || act.working ? 'working' : 'idle';
  light.className = `own-light ${state}`;
  light.title = { working: 'Claude is working', idle: 'Claude is waiting for you', off: 'This session has ended', '': '' }[state];
}

function drawMentions(panel, children, activity) {
  const box = panel.head.querySelector('.mentions');
  box.innerHTML = '';
  children.forEach((child, i) => {
    const act = activity[child.sessionId] || {};
    const state = !child.running ? 'off' : act.pending || act.working ? 'working' : 'idle';
    const words = { working: 'working', idle: 'waiting', off: 'ended' }[state];
    const badge = el('button', `mention ${state}`);
    badge.append(el('span', 'light'), el('span', null, child.name || `${child.number}`));
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

function renderHarnessList() {
  harnessList.innerHTML = '';
  if (!settings.harnesses.length) harnessList.append(el('small', null, 'None yet.'));
  for (const h of settings.harnesses) {
    const row = el('div', 'harness-row');
    const remove = el('button', 'link-btn', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      await saveSettings({ harnesses: settings.harnesses.filter((x) => x !== h) });
      renderHarnessList();
      refreshPickers();
    });
    row.append(el('span', 'label', '/' + slug(h.name)), el('span', 'detail', tildePath(h.path)), remove);
    harnessList.append(row);
  }
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

function openSettings() {
  draftPrompts = { ...settings.prompts };
  form.querySelector(`input[name="fileMode"][value="${settings.fileMode}"]`).checked = true;
  showPromptFor(settings.fileMode);
  document.getElementById('claude-command').value = settings.claudeCommand;
  document.getElementById('font-size').value = settings.fontSize;
  document.getElementById('auto-titles').checked = settings.autoTitles !== false;
  document.getElementById('auto-cvs').checked = settings.autoCVs !== false;
  renderHarnessList();
  settingsDialog.showModal();
}

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
  });
  for (const p of panels) {
    if (p.term) {
      p.term.options.fontSize = fontSize;
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
filterChip.addEventListener('click', toggleStack);
zoomChip.addEventListener('click', toggleZoom);
navChip.addEventListener('click', () => (navStack.length ? leaveMentions() : leaveFamily()));

api.onMenu('new', () => addPanel());
api.onMenu('search', openSearch);
api.onMenu('browse', browseShortcut);
api.onMenu('upload', addFilesToTerminal);
api.onMenu('check-update', checkUpdateNow);
api.onMenu('close', () => view === 'grid' && closePanel(focused));
api.onMenu('layout', toggleOddLayout);
api.onMenu('zoom', toggleZoom);
api.onMenu('stack', toggleStack);
api.onMenu('restore', restoreWorkspace);
api.onMenu('settings', openSettings);

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
  } else if (e.key === 'Escape' && view === 'stack' && !searchDialog.open && !settingsDialog.open) {
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
    const label = p.harnessName || baseName(p.cwd);
    const text = p.about && p.about !== label ? `${label} · ${p.about}` : label;
    const title = p.head.querySelector('.title');
    if (title.textContent !== text) {
      title.textContent = text;
      title.title = text;
    }
  }
  if (renamed) saveWorkspace();
}

(async () => {
  settings = await api.getSettings();
  restorable = settings.workspace || [];
  updateRestoreHint();
  applyLayout();
  if (settings.restoreOnLaunch) {
    await saveSettings({ restoreOnLaunch: false });
    restoreWorkspace();
  }
})();
