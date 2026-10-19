// Publishes a new version of Claude Panels as a GitHub release. Copies of the app installed from
// this repository see the release and offer to update to it.
//
//   npm run release              next patch version, for example 0.1.0 -> 0.1.1
//   npm run release -- minor     next minor version, for example 0.1.4 -> 0.2.0
//   npm run release -- major     next major version, for example 0.9.0 -> 1.0.0
//   npm run release -- current   release the version already in package.json
//
// Add --notes path/to/notes.md to write your own release notes. Otherwise the notes list the
// changes since the last release. Needs the GitHub CLI (gh) signed in to the repository's owner.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts }).trim();
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const args = process.argv.slice(2);
const kind = args.find((a) => ['patch', 'minor', 'major', 'current'].includes(a)) || 'patch';
const notesIndex = args.indexOf('--notes');
const notesFile = notesIndex !== -1 ? args[notesIndex + 1] : null;

if (run('git', ['status', '--porcelain'])) fail('Commit or put away your changes first, so the release matches what is committed.');
run('git', ['fetch', '--quiet', '--tags']);
if (Number(run('git', ['rev-list', '--count', 'HEAD..@{u}']))) fail('This copy is behind GitHub. Run git pull first.');

if (kind !== 'current') run('npm', ['version', kind, '--no-git-tag-version'], { stdio: 'pipe' });
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const tag = `v${version}`;
if (run('git', ['tag', '--list', tag])) fail(`${tag} has already been released. Choose patch, minor or major.`);

if (kind !== 'current') {
  run('git', ['add', 'package.json', 'package-lock.json']);
  run('git', ['commit', '--quiet', '-m', `Release ${tag}`]);
}

// Release notes: your own file, or the changes since the last release.
let notes;
if (notesFile) {
  notes = fs.readFileSync(path.resolve(notesFile), 'utf8');
} else {
  let previous = '';
  try {
    previous = run('git', ['describe', '--tags', '--abbrev=0', 'HEAD^']);
  } catch {
    // first release
  }
  const range = previous ? [`${previous}..HEAD`] : [];
  const changes = run('git', ['log', '--format=%s', ...range])
    .split('\n')
    .filter((line) => line && !/^Release v/.test(line))
    .map((line) => `- ${line}`);
  notes = `## Changes\n\n${changes.join('\n') || '- Small fixes'}\n`;
}
notes += '\nTo update, click **Update** in Claude Panels, or choose Claude Panels > Check for Updates.\n';

run('git', ['tag', '-a', tag, '-m', `Claude Panels ${tag}`]);
run('git', ['push', '--quiet', 'origin', 'HEAD', tag], { stdio: 'inherit' });

const notesPath = path.join(os.tmpdir(), `claude-panels-${tag}.md`);
fs.writeFileSync(notesPath, notes);
const url = run('gh', ['release', 'create', tag, '--title', `Claude Panels ${tag}`, '--notes-file', notesPath, '--latest']);
console.log(`Released ${tag}: ${url}`);
