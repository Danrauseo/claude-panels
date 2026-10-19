// Builds Claude Panels for this Mac's chip and signs it.
//
// The signing certificate is chosen in this order:
//   1. the CLAUDE_PANELS_SIGNING_IDENTITY environment variable
//   2. the name written in build/signing-identity.local (this file is not committed)
//   3. a "Claude Panels Signing" certificate, which `npm run create-cert` makes
//   4. otherwise an ad-hoc signature, which works on this Mac but has no certificate behind it
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const DEFAULT_NAME = 'Claude Panels Signing';
const localFile = path.join(__dirname, 'signing-identity.local');

function installedIdentities() {
  try {
    return execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

function chooseIdentity() {
  const identities = installedIdentities();
  const has = (name) => identities.includes(`"${name}"`);
  const wanted = [
    process.env.CLAUDE_PANELS_SIGNING_IDENTITY,
    fs.existsSync(localFile) ? fs.readFileSync(localFile, 'utf8').trim() : null,
    DEFAULT_NAME,
  ].filter(Boolean);
  for (const name of wanted) {
    if (has(name)) return name;
    if (name !== DEFAULT_NAME) console.warn(`Signing certificate "${name}" was not found in the keychain.`);
  }
  return '-'; // ad-hoc
}

const identity = chooseIdentity();
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
console.log(
  identity === '-'
    ? 'No signing certificate found, so the app gets an ad-hoc signature. Run `npm run create-cert` to make one.'
    : `Signing with the "${identity}" certificate.`
);
console.log(`Building for ${arch === 'arm64' ? 'Apple Silicon' : 'Intel'} Macs.`);

// Record where this copy was built from, so the app can check that folder for updates.
const root = path.join(__dirname, '..');
let commit = '';
try {
  commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  // not a git folder, so the app will not offer updates
}

const args = [
  'electron-builder',
  '--mac',
  'dir',
  `--${arch}`,
  `-c.mac.identity=${identity}`,
  `-c.extraMetadata.sourceDir=${root}`,
  `-c.extraMetadata.builtCommit=${commit}`,
];
// An ad-hoc signature cannot carry a timestamp from Apple's server.
if (identity === '-') args.push('-c.mac.timestamp=none');

const result = spawnSync('npx', args, { stdio: 'inherit', cwd: root });
process.exit(result.status ?? 1);
