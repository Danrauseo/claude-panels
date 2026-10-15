// Copies the built app into /Applications, replacing any older copy.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// electron-builder writes Apple Silicon builds to dist/mac-arm64 and Intel builds to dist/mac.
const candidates = ['mac-arm64', 'mac'].map((dir) => path.join(__dirname, '..', 'dist', dir, 'Claude Panels.app'));
const built = candidates.filter((p) => fs.existsSync(p)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const target = '/Applications/Claude Panels.app';

if (!built) throw new Error('No build found in dist. Run npm run dist first.');

try {
  execFileSync('pgrep', ['-f', `${target}/Contents/MacOS/Claude Panels$`]);
  console.error('Claude Panels is open. Quit it first (your terminals come back with ⌘R), then run this again.');
  process.exit(1);
} catch {
  // pgrep found nothing, so the app is not running
}

if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
execFileSync('ditto', [built, target]);
console.log(`Installed ${target}`);
