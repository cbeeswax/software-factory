// Everything that touches the outside world: the filesystem, git, gh, and shell commands.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, mergeConfig } from './core.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// These scripts are also checked out inside every job worktree. Whichever copy runs, state must
// land in the main checkout, so resolve the root through git's common dir.
function findRoot() {
  if (process.env.FACTORY_ROOT) return resolve(process.env.FACTORY_ROOT);
  const guess = resolve(here, '../..');
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: guess, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return resolve(dirname(common));
  } catch {
    return guess;
  }
}

export const ROOT = findRoot();
export const FACTORY_DIR = join(ROOT, 'factory');
export const JOBS_DIR = join(FACTORY_DIR, 'jobs');
export const GH_ENABLED = !process.env.FACTORY_NO_GH;
export const MEMORY_DIR = join(FACTORY_DIR, 'memory');
const LESSONS_FILE = join(MEMORY_DIR, 'lessons.json');

/** The factory's memory. Committed to the repository, so it survives clones and is shared by the team. */
export function loadLessons() {
  return existsSync(LESSONS_FILE) ? JSON.parse(readFileSync(LESSONS_FILE, 'utf8')) : [];
}

export function saveLessons(lessons, rendered) {
  mkdirSync(MEMORY_DIR, { recursive: true });
  writeFileSync(LESSONS_FILE, `${JSON.stringify(lessons, null, 2)}\n`);
  writeFileSync(join(FACTORY_DIR, 'LESSONS.md'), rendered);
}

export function loadConfig() {
  const file = join(FACTORY_DIR, 'factory.config.json');
  if (!existsSync(file)) return DEFAULT_CONFIG;
  return mergeConfig(DEFAULT_CONFIG, JSON.parse(readFileSync(file, 'utf8')));
}

export function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
}

export function gitTry(args, cwd = ROOT) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

export function gh(args, { input } = {}) {
  if (!GH_ENABLED) throw new Error('GitHub is disabled (FACTORY_NO_GH is set)');
  return execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
}

export function ghTry(args, opts) {
  if (!GH_ENABLED) return { ok: false, out: '', err: 'GitHub disabled' };
  try { return { ok: true, out: gh(args, opts), err: '' }; } catch (e) { return { ok: false, out: '', err: String(e.stderr || e.message).trim() }; }
}

export function sh(cmd, cwd) {
  const started = Date.now();
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: '1' } });
  return { code: r.status === null ? 1 : r.status, out: `${r.stdout || ''}${r.stderr || ''}`, ms: Date.now() - started };
}

export function jobDir(id) { return join(JOBS_DIR, id); }

export function listJobs() {
  if (!existsSync(JOBS_DIR)) return [];
  return readdirSync(JOBS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(JOBS_DIR, d.name, 'job.json')))
    .map((d) => JSON.parse(readFileSync(join(JOBS_DIR, d.name, 'job.json'), 'utf8')))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Accepts a full job id, or an issue number. */
export function loadJob(ref) {
  const jobs = listJobs();
  const key = String(ref || '').replace(/^#/, '');
  const job = jobs.find((j) => j.id === key) || jobs.find((j) => String(j.issue) === key) || jobs.find((j) => j.id.startsWith(`${key}-`));
  if (!job) throw new Error(`No job matches "${ref}". Run: node factory/bin/job.mjs list`);
  return job;
}

export function saveJob(job) {
  job.updatedAt = new Date().toISOString();
  const dir = jobDir(job.id);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, 'job.json.tmp');
  writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`);
  renameSync(tmp, join(dir, 'job.json'));
  return job;
}

export function writeJobFile(job, name, content) {
  mkdirSync(jobDir(job.id), { recursive: true });
  writeFileSync(join(jobDir(job.id), name), content.endsWith('\n') ? content : `${content}\n`);
}

export function jobFiles(id) {
  const dir = jobDir(id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
}
