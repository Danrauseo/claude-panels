// The status line Claude Code shows at the bottom of each session in Simple mode. Claude Code runs this
// script and sends it details of the session as JSON. It prints one plain line: the folder, the model,
// and how to stop Claude.
const path = require('path');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  let data = {};
  try {
    data = JSON.parse(input);
  } catch {}
  const dir = data.workspace?.current_dir || data.cwd || '';
  const parts = [];
  if (dir) parts.push(`Folder: ${path.basename(dir)}`);
  if (data.model?.display_name) parts.push(`Model: ${data.model.display_name}`);
  parts.push('Press Esc to stop Claude');
  process.stdout.write(`\x1b[2m${parts.join('   ·   ')}\x1b[0m\n`);
});
