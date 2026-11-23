// A Claude Code PreToolUse hook that runs before SendMessage in a terminal Claude Panels started.
// It asks the app whether this terminal may message the target session. The target may be part of a
// closed job, and then the app asks the user. When the user says no, the hook tells Claude why.
// If the app cannot be reached, the message goes as normal.
const CONTROL = process.env.CLAUDE_PANELS_CONTROL;
const TOKEN = process.env.CLAUDE_PANELS_TOKEN;
const SELF = Number(process.env.CLAUDE_PANELS_SELF);

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    return;
  }
  const to = event.tool_input?.to;
  if (!CONTROL || !TOKEN || !SELF || !to) return;
  let answer;
  try {
    const res = await fetch(CONTROL + '/gate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: SELF, to: String(to), tool: 'SendMessage' }),
      signal: AbortSignal.timeout(290000),
    });
    answer = await res.json();
  } catch {
    return;
  }
  if (answer?.decision !== 'deny') return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: answer.reason || 'Claude Panels did not allow this message.',
      },
    })
  );
}

main();
