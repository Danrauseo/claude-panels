// Ranks the CVs the app keeps for sessions against a task, so a session can find an expert.
// Used by the panels tool server (find_expert) and by the app, which suggests an expert after
// your first message in a new terminal.
const os = require('os');
const path = require('path');

const STOP = new Set(
  ('the and for with that this from into have will what when your about there their them then than were been ' +
    "some more also just make made need want please could would should can its it's our out use using new add " +
    'work task file files code').split(' ')
);

// An expert counts as local if it worked in this folder, or if its CV says it knows this folder.
function isLocal(cwd, cv, here) {
  if (!cwd || !here) return false;
  const tildeHere = here.startsWith(os.homedir()) ? '~' + here.slice(os.homedir().length) : here;
  return (
    cwd === here ||
    here.startsWith(cwd + path.sep) ||
    cwd.startsWith(here + path.sep) ||
    (cv || '').includes(here) ||
    (cv || '').includes(tildeHere)
  );
}

// Returns matches with a score from 0 to about 1.25, best first.
function rankExperts({ task, here, cvs, excludeIds = [], everywhere = false }) {
  const words = [...new Set((String(task).toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || []).filter((w) => !STOP.has(w)))];
  const skip = new Set(excludeIds.filter(Boolean));
  const scored = [];
  for (const [id, e] of Object.entries(cvs || {})) {
    if (!e.cv || skip.has(id) || !e.cwd) continue;
    const local = isLocal(e.cwd, e.cv, here);
    if (!everywhere && !local) continue;
    const text = `${e.title || ''} ${e.cv} ${e.cwd}`.toLowerCase();
    const hits = words.filter((w) => text.includes(w));
    let score = words.length ? hits.length / words.length : 0;
    if (local) score += 0.25;
    if (hits.length < 2 && !(local && hits.length >= 1)) continue;
    scored.push({ id, e, score, hits: hits.length });
  }
  return scored.sort((a, b) => b.score - a.score || b.e.updated - a.e.updated);
}

module.exports = { rankExperts, isLocal };
