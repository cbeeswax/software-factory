#!/usr/bin/env node
// The stage agents are written once, in .claude/agents (the Claude Code format). This generates
// the GitHub Copilot copies in .github/agents, which must be named *.agent.md and must not carry
// Claude-only frontmatter (model aliases and tool names differ between the two).
//
//   node factory/bin/sync-agents.mjs [--check]     --check exits 1 if the copies are out of date
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const from = join(root, '.claude', 'agents');
const to = join(root, '.github', 'agents');
const check = process.argv.includes('--check');

export function toCopilot(text) {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('Agent file has no frontmatter');
  const keep = m[1].split('\n').filter((l) => /^(name|description):/.test(l));
  return `---\n${keep.join('\n')}\n---\n<!-- Generated from .claude/agents by factory/bin/sync-agents.mjs. Edit the source, not this file. -->\n${m[2]}`;
}

const sources = readdirSync(from).filter((f) => f.startsWith('factory-') && f.endsWith('.md'));
const wanted = new Map(sources.map((f) => [f.replace(/\.md$/, '.agent.md'), toCopilot(readFileSync(join(from, f), 'utf8'))]));
const existing = existsSync(to) ? readdirSync(to).filter((f) => f.startsWith('factory-')) : [];
const stale = existing.filter((f) => !wanted.has(f));
const changed = [...wanted].filter(([f, text]) => !existsSync(join(to, f)) || readFileSync(join(to, f), 'utf8').replace(/\r\n/g, '\n') !== text).map(([f]) => f);

if (check) {
  if (changed.length || stale.length) { console.error(`Copilot agents are out of date: ${[...changed, ...stale].join(', ')}. Run: node factory/bin/sync-agents.mjs`); process.exit(1); }
  console.log(`Copilot agents are in sync (${wanted.size}).`);
} else {
  mkdirSync(to, { recursive: true });
  for (const f of stale) rmSync(join(to, f));
  for (const [f, text] of wanted) writeFileSync(join(to, f), text);
  console.log(`Wrote ${wanted.size} Copilot agents to .github/agents${stale.length ? `, removed ${stale.length}` : ''}.`);
}
