#!/usr/bin/env node
// Makes sure the skills the stage agents rely on are installed, and installs the missing ones.
//
//   node factory/bin/skills.mjs check     report what is present and what is missing
//   node factory/bin/skills.mjs ensure    install whatever is missing, then report
//
// Skills are installed into the project's .claude/skills folder. Claude Code and GitHub Copilot
// both read that folder, and once committed every teammate has them too.
// The factory still works without these skills: each agent carries fallback instructions.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installCommand, missingSkills } from '../lib/core.mjs';
import { ROOT, loadConfig, sh } from '../lib/env.mjs';

const cfg = loadConfig().skills;
const mode = process.argv[2] || 'check';

const SKILL_DIRS = [
  join(ROOT, '.claude', 'skills'), join(ROOT, '.agents', 'skills'), join(ROOT, '.github', 'skills'),
  join(homedir(), '.claude', 'skills'), join(homedir(), '.agents', 'skills'), join(homedir(), '.copilot', 'skills'),
];

function present() {
  const names = cfg.sources.flatMap((s) => s.skills);
  const found = new Set(names.filter((n) => SKILL_DIRS.some((d) => existsSync(join(d, n, 'SKILL.md')))));
  // A Claude Code plugin provides all of a source's skills at once, under a "plugin:" prefix.
  const viaPlugin = cfg.sources.filter((s) => s.claudePlugin && s.skills.some((n) => !found.has(n)));
  if (viaPlugin.length) {
    const list = sh('claude plugin list', ROOT);
    if (list.code === 0) for (const s of viaPlugin) if (list.out.includes(s.claudePlugin)) s.skills.forEach((n) => found.add(n));
  }
  return [...found];
}

let missing = missingSkills(cfg.sources, present());
const installed = [];
const errors = [];

if (mode === 'ensure' && missing.length) {
  if (!cfg.autoInstall) errors.push('skills.autoInstall is off in factory/factory.config.json');
  else {
    for (const m of missing) {
      const cmd = installCommand(cfg.installer, m.source, m.skills);
      const r = sh(cmd, ROOT);
      if (r.code === 0) installed.push({ source: m.source, skills: m.skills });
      else errors.push({ source: m.source, command: cmd, exit: r.code, output: r.out.trim().split(/\r?\n/).slice(-8).join('\n') });
    }
    missing = missingSkills(cfg.sources, present());
  }
}

console.log(JSON.stringify({
  ok: missing.length === 0,
  installed,
  missing,
  errors,
  ...(missing.length && mode !== 'ensure' ? { fix: 'node factory/bin/skills.mjs ensure' } : {}),
  ...(installed.length ? { note: 'New skills were written to .claude/skills. Commit them so everyone has them, and restart your agent session so it loads them.' } : {}),
}, null, 2));
process.exit(missing.length && mode === 'ensure' ? 1 : 0);
