// The deterministic checks a build must pass before any reviewer agent spends tokens on it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sh } from './env.mjs';

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** Commands that make a fresh worktree runnable (installing dependencies). */
export function detectSetup(dir) {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return ['pnpm install --frozen-lockfile'];
  if (existsSync(join(dir, 'yarn.lock'))) return ['yarn install --frozen-lockfile'];
  if (existsSync(join(dir, 'package-lock.json'))) return ['npm ci'];
  if (existsSync(join(dir, 'package.json'))) {
    const pkg = readJson(join(dir, 'package.json')) || {};
    const hasDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
    return hasDeps ? ['npm install'] : [];
  }
  return [];
}

/** Used only when factory.config.json has no `checks`. Configure them explicitly for anything real. */
export function detectChecks(dir) {
  const checks = [];
  const pkg = readJson(join(dir, 'package.json'));
  if (pkg) {
    const runner = existsSync(join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(dir, 'yarn.lock')) ? 'yarn' : 'npm';
    for (const name of ['lint', 'typecheck', 'test', 'build']) {
      if (pkg.scripts && pkg.scripts[name]) checks.push({ name, cmd: `${runner} run ${name}` });
    }
  }
  if (existsSync(join(dir, 'pyproject.toml')) || existsSync(join(dir, 'pytest.ini'))) checks.push({ name: 'pytest', cmd: 'python -m pytest -q' });
  if (existsSync(join(dir, 'go.mod'))) checks.push({ name: 'go vet', cmd: 'go vet ./...' }, { name: 'go test', cmd: 'go test ./...' });
  if (existsSync(join(dir, 'Cargo.toml'))) checks.push({ name: 'cargo test', cmd: 'cargo test' });
  return checks;
}

export function resolveChecks(dir, cfg) {
  return cfg.checks && cfg.checks.length ? cfg.checks : detectChecks(dir);
}

export function runChecks(dir, cfg) {
  const checks = resolveChecks(dir, cfg);
  const results = checks.map((c) => {
    const r = sh(c.cmd, dir);
    return { name: c.name, cmd: c.cmd, pass: r.code === 0, code: r.code, ms: r.ms, out: r.out };
  });
  return { results, pass: results.every((r) => r.pass), none: checks.length === 0 };
}

export function tail(text, lines = 120) {
  const all = String(text || '').trimEnd().split(/\r?\n/);
  return (all.length > lines ? ['… (truncated)', ...all.slice(-lines)] : all).join('\n');
}
