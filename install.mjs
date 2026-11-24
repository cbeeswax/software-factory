#!/usr/bin/env node
// Installs the factory into another project.
//   node install.mjs <path-to-your-project> [--no-labels] [--no-hook] [--no-skills]
// Sets the project up for both Claude Code and GitHub Copilot.
// Safe to run again to upgrade: it never overwrites your factory.config.json or LESSONS.md.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const target = resolve(args.find((a) => !a.startsWith('--')) || '');
const flags = new Set(args.filter((a) => a.startsWith('--')));

if (!args.find((a) => !a.startsWith('--'))) { console.error('Usage: node install.mjs <path-to-your-project> [--no-labels] [--no-hook] [--no-skills]'); process.exit(1); }
if (!existsSync(join(target, '.git'))) { console.error(`${target} is not the root of a git repository.`); process.exit(1); }
if (target === src) { console.error('That is the factory repository itself.'); process.exit(1); }

const done = [];
const copy = (rel) => { cpSync(join(src, rel), join(target, rel), { recursive: true }); done.push(rel); };

copy('.claude/skills/factory');
mkdirSync(join(target, '.claude/agents'), { recursive: true });
for (const f of readdirSync(join(src, '.claude/agents')).filter((n) => n.startsWith('factory-'))) copy(`.claude/agents/${f}`);
mkdirSync(join(target, '.github/agents'), { recursive: true });
for (const f of readdirSync(join(src, '.github/agents')).filter((n) => n.startsWith('factory-'))) copy(`.github/agents/${f}`);
for (const rel of ['factory/bin', 'factory/lib', 'factory/dashboard', 'factory/REVIEW_CONTRACT.md']) copy(rel);

// Files the project owns once installed: create them, never overwrite them.
if (!existsSync(join(target, 'factory/factory.config.json'))) {
  const cfg = JSON.parse(readFileSync(join(src, 'factory/factory.config.json'), 'utf8'));
  cfg.checks = [];
  cfg.slop.ignorePaths = [];
  writeFileSync(join(target, 'factory/factory.config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
  done.push('factory/factory.config.json (new)');
}
if (!existsSync(join(target, 'factory/memory/lessons.json'))) { mkdirSync(join(target, 'factory/memory'), { recursive: true }); writeFileSync(join(target, 'factory/memory/lessons.json'), '[]\n'); copy('factory/LESSONS.md'); done.push('factory/memory/lessons.json (new)'); }
mkdirSync(join(target, 'factory/inbox'), { recursive: true });
if (!existsSync(join(target, 'factory/inbox/README.md'))) copy('factory/inbox/README.md');

const ignore = join(target, '.gitignore');
const current = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
const wanted = ['factory/jobs/', 'factory/inbox/done/', 'factory/retro-proposals.md', '.factory/'].filter((l) => !current.split(/\r?\n/).includes(l));
if (wanted.length) { writeFileSync(ignore, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${current ? '\n' : ''}# Software factory\n${wanted.join('\n')}\n`); done.push('.gitignore'); }

if (!flags.has('--no-hook')) {
  const file = join(target, '.claude/settings.json');
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const command = 'node "$CLAUDE_PROJECT_DIR/factory/bin/guard.mjs"';
  settings.hooks ??= {};
  settings.hooks.PreToolUse ??= [];
  if (!JSON.stringify(settings.hooks.PreToolUse).includes('factory/bin/guard.mjs')) {
    settings.hooks.PreToolUse.push({ matcher: 'Write|Edit', hooks: [{ type: 'command', command }] });
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
    done.push('.claude/settings.json (secret guard hook)');
  }
}

const section = `
## Software factory

This project has a software factory in \`factory/\`, run with the \`/factory\` skill.

- \`/factory run\` processes open GitHub issues labelled \`factory\`. \`/factory <description>\` builds one feature without an issue.
- \`node factory/bin/job.mjs\` is the only writer of job state. Never edit \`factory/jobs/*/job.json\`.
- Do not change \`factory/\` or \`.claude/agents/factory-*.md\` as part of feature work. Changes to the factory are reviewed by a human.
- Checks the factory enforces are in \`factory/factory.config.json\`. Run them with \`node factory/bin/checks.mjs\`.
- The stage agents live in \`.claude/agents/factory-*.md\`. The copies in \`.github/agents\` are generated from them.
`;
// CLAUDE.md is read by Claude Code; AGENTS.md by Copilot and most other agents. Both get the section.
for (const name of ['CLAUDE.md', 'AGENTS.md']) {
  const doc = join(target, name);
  const docText = existsSync(doc) ? readFileSync(doc, 'utf8') : '';
  if (!docText.includes('## Software factory')) { writeFileSync(doc, `${docText.trimEnd()}\n${section}`.trimStart()); done.push(name); }
}

let labels = 'skipped';
if (!flags.has('--no-labels')) {
  try {
    for (const [name, color, desc] of [['factory', '1D76DB', 'Queued for the software factory'], ['factory:triage', 'BFD4F2', 'Filed by the factory collector; a human decides whether to build it']]) {
      execFileSync('gh', ['label', 'create', name, '--color', color, '--description', desc, '--force'], { cwd: target, stdio: 'ignore' });
    }
    labels = 'created';
  } catch { labels = 'could not create them (is gh logged in, and does the project have a GitHub remote?)'; }
}

let skills = 'skipped';
if (!flags.has('--no-skills')) {
  try {
    const r = JSON.parse(execFileSync(process.execPath, [join(target, 'factory/bin/skills.mjs'), 'ensure'], { cwd: target, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: target } }));
    skills = r.installed.length ? `installed ${r.installed.flatMap((i) => i.skills).length} into .claude/skills` : 'all present';
  } catch (e) {
    skills = 'some could not be installed; run `node factory/bin/skills.mjs ensure` in the project to see why';
  }
}

console.log(`Installed the software factory into ${target}

Wrote:
${done.map((d) => `  ${d}`).join('\n')}
GitHub labels: ${labels}
Agent skills: ${skills}

Next:
  1. Open factory/factory.config.json and set "checks" to the commands that prove a build is good
     (lint, typecheck, tests, build). With none set, the factory guesses from package.json and similar.
  2. Commit the new files.
  3. Add the "factory" label to an issue, start Claude Code or GitHub Copilot in the project, and type: /factory run
`);
