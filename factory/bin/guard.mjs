#!/usr/bin/env node
// Claude Code PreToolUse hook for Write and Edit: refuses to write anything that looks like a
// credential. Exit code 2 blocks the tool call and shows stderr to the agent.
// The gate runs the same scan on the final diff, so this is the early warning, not the only check.
import { scanSecrets } from '../lib/core.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  const t = (input && input.tool_input) || {};
  const text = [t.content, t.new_string, ...(Array.isArray(t.edits) ? t.edits.map((e) => e.new_string) : [])].filter((x) => typeof x === 'string').join('\n');
  const hits = scanSecrets(text);
  if (!hits.length) process.exit(0);
  console.error(`Blocked by the factory guard: this write looks like it contains a credential (${[...new Set(hits.map((h) => h.rule))].join(', ')}). Read secrets from environment variables instead of writing them into files.`);
  process.exit(2);
});
