#!/usr/bin/env node
// Forward pressure: turns signals from production and from people into GitHub issues, so the
// factory finds its own work. Sources are configured under `collect.sources`:
//
//   { "type": "sentry", "org": "acme", "project": "web", "query": "is:unresolved", "minEvents": 5 }
//       needs SENTRY_AUTH_TOKEN in the environment; "baseUrl" is optional for self-hosted Sentry
//   { "type": "inbox", "dir": "factory/inbox" }
//       every .md file becomes an issue (first line is the title), then moves to <dir>/done
//   { "type": "command", "name": "posthog", "cmd": "node scripts/posthog-errors.mjs" }
//       any command that prints a JSON array of { "key", "title", "body" }
//   { "type": "ratchet", "name": "strict-null-checks", "listFile": "lint-exceptions.txt", "check": "npm run lint:strict" }
//       migrating to a stricter check one file at a time: each run takes the first path off the
//       exception list and files one ticket for it, and files nothing while one is still open
//
// A problem that is reported again after its ticket was closed reopens that ticket.
//
// New issues get the `collect.label` label (default factory:triage) so a human decides what the
// factory builds. Set `collect.autoQueue` to true to label them for the factory straight away.
//
//   node factory/bin/collect.mjs [--dry-run]
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, gh, ghTry, loadConfig, sh } from '../lib/env.mjs';

const cfg = loadConfig();
const dryRun = process.argv.includes('--dry-run');

async function fromSentry(src) {
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token) throw new Error('SENTRY_AUTH_TOKEN is not set');
  const base = (src.baseUrl || 'https://sentry.io').replace(/\/$/, '');
  const url = `${base}/api/0/projects/${src.org}/${src.project}/issues/?query=${encodeURIComponent(src.query || 'is:unresolved')}&statsPeriod=${src.statsPeriod || '14d'}&limit=${src.limit || 25}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sentry returned ${res.status}`);
  const issues = await res.json();
  return issues
    .filter((i) => Number(i.count) >= (src.minEvents || 1))
    .sort((a, b) => Number(b.count) - Number(a.count))
    .map((i) => ({
      key: `sentry:${i.id}`,
      title: `Fix: ${i.title}`,
      body: [`Production error reported by Sentry.`, `- **Events:** ${i.count}`, `- **Users affected:** ${i.userCount}`, `- **Level:** ${i.level}`, `- **Where:** ${i.culprit || 'unknown'}`, `- **First seen:** ${i.firstSeen}`, `- **Last seen:** ${i.lastSeen}`, `- **Link:** ${i.permalink}`].join('\n'),
    }));
}

function fromInbox(src) {
  const dir = resolve(ROOT, src.dir || 'factory/inbox');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md').map((f) => {
    const text = readFileSync(join(dir, f), 'utf8').trim();
    const [first, ...rest] = text.split(/\r?\n/);
    return { key: `inbox:${f}`, title: first.replace(/^#+\s*/, '').trim() || f, body: rest.join('\n').trim() || '(no description)', done: () => { mkdirSync(join(dir, 'done'), { recursive: true }); renameSync(join(dir, f), join(dir, 'done', f)); } };
  });
}

function fromCommand(src) {
  const r = sh(src.cmd, ROOT);
  if (r.code !== 0) throw new Error(`"${src.cmd}" exited ${r.code}`);
  const start = r.out.indexOf('[');
  return JSON.parse(r.out.slice(start)).map((i) => ({ ...i, key: `${src.name || 'command'}:${i.key}` }));
}

function fromRatchet(src) {
  const file = resolve(ROOT, src.listFile);
  if (!existsSync(file)) throw new Error(`Ratchet list not found: ${src.listFile}`);
  const paths = readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!paths.length) return [];
  // One at a time: small pull requests keep human review cheap.
  if (!dryRun && find(`ratchet:${src.name}:`, 'open')) return [];
  const path = paths[0];
  return [{
    key: `ratchet:${src.name}:${path}`,
    recurring: false,
    title: `Ratchet ${src.name}: ${path}`,
    body: [`Part of the migration to a stricter check, **${src.name}**. ${paths.length} file(s) are still on the exception list.`, '', `1. Fix \`${path}\` so it passes${src.check ? ` \`${src.check}\`` : ' the stricter check'} with no suppressions.`, `2. Remove \`${path}\` from \`${src.listFile}\`.`, '3. Change nothing else. Behaviour must stay the same.'].join('\n'),
  }];
}

const readers = { sentry: fromSentry, inbox: fromInbox, command: fromCommand, ratchet: fromRatchet };

/** The ticket already filed for this key, if any. This is what stops a source filing the same ticket twice. */
function find(key, state = 'all') {
  const r = ghTry(['issue', 'list', '--state', state, '--search', `"Factory-Source: ${key}" in:body`, '--json', 'number,state', '--limit', '1']);
  if (!r.ok) throw new Error(`Could not search existing issues: ${r.err}`);
  return JSON.parse(r.out)[0] || null;
}

const created = [];
const reopened = [];
const skipped = [];
const errors = [];
for (const src of cfg.collect.sources) {
  if (created.length >= cfg.collect.maxPerRun) break;
  try {
    if (!readers[src.type]) throw new Error(`Unknown source type "${src.type}"`);
    for (const item of await readers[src.type](src)) {
      if (created.length >= cfg.collect.maxPerRun) break;
      const existing = dryRun ? null : find(item.key);
      if (existing) {
        // The fix merged and the problem is still being reported: the ticket goes back in the queue.
        const recurring = item.recurring ?? (src.type === 'sentry' || src.type === 'command');
        if (existing.state === 'CLOSED' && recurring && src.reopen !== false) {
          gh(['issue', 'reopen', String(existing.number), '--comment', `Still being reported after this ticket was closed.\n\n${item.body}`]);
          reopened.push({ key: item.key, number: existing.number });
        } else skipped.push(item.key);
        continue;
      }
      if (dryRun) { created.push({ key: item.key, title: item.title, dryRun: true }); continue; }
      const labels = [cfg.collect.label, ...(cfg.collect.autoQueue ? [cfg.label] : [])];
      for (const l of labels) ghTry(['label', 'create', l, '--color', 'BFD4F2']);
      const url = gh(['issue', 'create', '--title', item.title, '--label', labels.join(','), '--body-file', '-'], { input: `${item.body}\n\n---\nFiled automatically by the software factory collector.\nFactory-Source: ${item.key}` }).split(/\r?\n/).pop();
      if (item.done) item.done();
      created.push({ key: item.key, title: item.title, url });
    }
  } catch (e) {
    errors.push({ source: src.type, error: String(e.message) });
  }
}

console.log(JSON.stringify({ sources: cfg.collect.sources.length, created, reopened, skipped, errors }, null, 2));
if (!cfg.collect.sources.length) console.log('No sources configured. Add them under "collect.sources" in factory/factory.config.json.');
process.exit(errors.length ? 1 : 0);
