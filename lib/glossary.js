// The glossary behind "Explain terms". Claude adds plain-language explanations of the words that structure
// a codebase (its own names for its parts, programming ideas, syntax, ways of working) with the panels
// add_terms tool, and the app underlines those words in the terminal and explains them on hover.
//
// Two files, each written by one process only, so they never overwrite each other's changes:
// - glossary.json: the terms, per folder. Written by the panels tool server when Claude adds terms.
// - codex.json: what the user has learned, per folder and term. Written by the app.
const fs = require('fs');
const path = require('path');

const KINDS = ['part', 'idea', 'syntax', 'process'];
const MAX_TERMS_PER_FOLDER = 400;

// Terms are matched without regard to case, so they are stored under a lower-case key.
const termKey = (term) => String(term || '').trim().toLowerCase();

// A glossary belongs to a repository, so a session started in a subfolder still finds it. Outside a
// repository it belongs to the folder itself.
function glossaryKey(dir) {
  let at = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(at, '.git'))) return at;
    const up = path.dirname(at);
    if (up === at) return path.resolve(dir);
    at = up;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Writes to a temporary file first and then moves it into place, so a reader never sees half a file.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const loadGlossary = (file) => {
  const g = readJson(file, {});
  return { folders: g.folders && typeof g.folders === 'object' ? g.folders : {} };
};

function clean(text, max) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Adds terms to a folder's glossary. A term that is already there is kept as it is unless replace is set,
// so an explanation the user has started learning does not change under them.
function addTerms(file, key, terms, { replace = false } = {}) {
  const glossary = loadGlossary(file);
  const folder = (glossary.folders[key] = glossary.folders[key] || { terms: {} });
  const added = [];
  const kept = [];
  const skipped = [];
  for (const t of Array.isArray(terms) ? terms : []) {
    const term = clean(t?.term, 60);
    const short = clean(t?.short, 160);
    const explanation = clean(t?.explanation, 900);
    if (term.length < 2 || !short || !explanation || !/[A-Za-z]/.test(term)) {
      skipped.push(term || '(blank)');
      continue;
    }
    const k = termKey(term);
    if (folder.terms[k] && !replace) {
      kept.push(folder.terms[k].term);
      continue;
    }
    if (!folder.terms[k] && Object.keys(folder.terms).length >= MAX_TERMS_PER_FOLDER) {
      skipped.push(term);
      continue;
    }
    const aliases = (Array.isArray(t.aliases) ? t.aliases : [])
      .map((a) => clean(a, 60))
      .filter((a) => a.length >= 2 && termKey(a) !== k)
      .slice(0, 5);
    folder.terms[k] = {
      term,
      kind: KINDS.includes(t.kind) ? t.kind : 'idea',
      short,
      explanation,
      ...(aliases.length ? { aliases } : {}),
      added: folder.terms[k]?.added || Date.now(),
      ...(folder.terms[k] ? { updated: Date.now() } : {}),
    };
    added.push(term);
  }
  if (added.length) writeJson(file, glossary);
  return { added, kept, skipped };
}

function termNames(file, key) {
  const folder = loadGlossary(file).folders[key];
  return folder ? Object.values(folder.terms).map((t) => t.term) : [];
}

module.exports = { KINDS, termKey, glossaryKey, readJson, writeJson, loadGlossary, addTerms, termNames };
