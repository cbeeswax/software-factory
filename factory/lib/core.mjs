// Pure logic for the factory: no I/O, no git, no GitHub. Everything here is unit tested.

export const STAGES = ['intake', 'spec', 'build', 'gate', 'review', 'approve', 'needs-human', 'merged', 'rejected'];
export const TERMINAL = ['merged', 'rejected'];
export const RISKS = ['low', 'medium', 'high'];
export const SURFACES = ['ui', 'api', 'data', 'auth', 'infra', 'deps', 'docs', 'logic'];

export const DEFAULT_CONFIG = {
  label: 'factory',
  baseBranch: null,
  concurrency: 3,
  maxRounds: 3,
  maxGateFailures: 5,
  worktreeDir: '.factory/worktrees',
  comments: true,
  setup: null,
  checks: [],
  planReview: 'high-pain',
  models: {
    intake: 'fable',
    spec: 'opus',
    builder: 'opus',
    approver: 'opus',
    reviewer: { low: 'sonnet', medium: 'sonnet', high: 'opus' },
  },
  routing: {
    always: ['code', 'qa'],
    security: { minRisk: 'medium', surfaces: ['auth', 'data', 'api', 'infra', 'deps'] },
    ui: { surfaces: ['ui'], reviewers: ['ux', 'ui'] },
  },
  approval: {
    autoMerge: true,
    mergeMethod: 'squash',
    auditRate: 0.2,
    escalateRisk: ['high'],
    escalatePaths: ['**/migrations/**', '**/billing/**', '**/auth/**', '.github/**', 'factory/**', '.claude/**'],
  },
  slop: {
    mode: 'fail',
    maxDiffLines: 800,
    maxNewFileLines: 500,
    ignorePaths: [],
    generated: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '**/*.lock', '**/*.snap', '**/dist/**', '**/*.min.*'],
    testPaths: ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**', '**/test_*.py', '**/*_test.go'],
  },
  collect: { label: 'factory:triage', autoQueue: false, maxPerRun: 5, sources: [] },
  pricing: {},
  dashboard: { port: 4317 },
};

export function mergeConfig(base, over) {
  if (over === undefined) return base;
  if (Array.isArray(base) || Array.isArray(over)) return over;
  if (base && over && typeof base === 'object' && typeof over === 'object') {
    const out = { ...base };
    for (const k of Object.keys(over)) out[k] = k in base ? mergeConfig(base[k], over[k]) : over[k];
    return out;
  }
  return over;
}

export function slugify(title, max = 40) {
  const s = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (s.slice(0, max).replace(/-+$/, '')) || 'job';
}

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path, globs = []) {
  const p = path.replace(/\\/g, '/');
  return globs.some((g) => globToRegExp(g).test(p));
}

/** Which reviewers a job gets, and on which model. Decided once, at intake, from risk and surfaces. */
export function route({ risk, surfaces = [] }, cfg = DEFAULT_CONFIG) {
  const r = cfg.routing;
  const names = [...r.always];
  const riskAtLeast = RISKS.indexOf(risk) >= RISKS.indexOf(r.security.minRisk);
  if (riskAtLeast || surfaces.some((s) => r.security.surfaces.includes(s))) names.push('security');
  if (surfaces.some((s) => r.ui.surfaces.includes(s))) names.push(...r.ui.reviewers);
  const model = cfg.models.reviewer[risk] || cfg.models.reviewer.medium;
  return [...new Set(names)].map((name) => ({ name, model }));
}

/** Does this job stop for a human to approve the plan before any code is written? */
export function needsPlanReview({ risk, pain }, cfg = DEFAULT_CONFIG) {
  if (cfg.planReview === 'always') return true;
  if (cfg.planReview === 'never') return false;
  return pain === 'high' || risk === 'high';
}

/** Once every reviewer in the round has reported: where does the job go? */
export function afterReviews(job, cfg = DEFAULT_CONFIG) {
  const round = job.round;
  const verdicts = (job.verdicts && job.verdicts[round]) || {};
  const pending = job.reviewers.map((r) => r.name).filter((n) => !verdicts[n]);
  if (pending.length) return { done: false, pending };
  const failed = job.reviewers.map((r) => r.name).filter((n) => verdicts[n].verdict === 'fail');
  if (!failed.length) return { done: true, stage: 'approve', failed };
  if (round >= cfg.maxRounds) {
    return { done: true, stage: 'needs-human', failed, reason: `Still failing review after ${round} rounds: ${failed.join(', ')}` };
  }
  return { done: true, stage: 'build', failed, round: round + 1 };
}

function hashFraction(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * The approver agent recommends; this decides. An agent can always escalate, but it can only
 * merge when every deterministic rule also allows it.
 */
export function decideApproval({ job, recommendation, files = [] }, cfg = DEFAULT_CONFIG) {
  const a = cfg.approval;
  const reasons = [];
  if (recommendation !== 'merge') reasons.push('Approver agent escalated');
  if (!a.autoMerge) reasons.push('Auto-merge is turned off');
  if (a.escalateRisk.includes(job.risk)) reasons.push(`Risk is ${job.risk}`);
  const touched = files.filter((f) => matchesAny(f, a.escalatePaths));
  if (touched.length) reasons.push(`Touches protected paths: ${touched.slice(0, 5).join(', ')}`);
  if (!reasons.length && a.auditRate > 0 && hashFraction(job.id) < a.auditRate) {
    reasons.push(`Spot-check audit (${Math.round(a.auditRate * 100)}% of auto-mergeable jobs get a human look)`);
  }
  return { merge: reasons.length === 0, reasons };
}

const PLACEHOLDER = /example|changeme|change_me|placeholder|your[-_ ]?|xxxx|\*\*\*\*|<[^>]+>|\$\{|process\.env|os\.environ|dummy|redacted|test[-_]?(key|secret|token|password)/i;

const SECRET_RULES = [
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['stripe-live-key', /\b[sr]k_live_[A-Za-z0-9]{16,}/],
  ['generic-credential', /(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i],
];

/** Finds likely secrets. Never returns the secret itself, only the rule and line number. */
export function scanSecrets(text) {
  const hits = [];
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    for (const [rule, re] of SECRET_RULES) {
      const m = line.match(re);
      if (!m) continue;
      if (rule === 'generic-credential' && PLACEHOLDER.test(m[0])) continue;
      hits.push({ rule, line: i + 1 });
      break;
    }
  });
  return hits;
}

// Ways an agent gets to green by lowering the bar instead of meeting it.
const SUPPRESSION_RULES = [
  ['lint-suppression', /eslint-disable|biome-ignore|#\s*noqa|#\s*pylint:\s*disable|\/\/\s*nolint/],
  ['type-suppression', /@ts-ignore|@ts-nocheck|#\s*type:\s*ignore/],
  ['skipped-test', /\b(?:it|test|describe)\.skip\(|\bx(?:it|describe)\(|@pytest\.mark\.skip|@unittest\.skip|\bt\.Skip\(|@Disabled\b|@Ignore\b/],
  ['focused-test', /\b(?:it|test|describe)\.only\(|\bf(?:it|describe)\(/],
];

/** Splits a unified diff into per-file added lines. */
export function parseDiff(diff) {
  const files = [];
  let cur = null;
  let newLine = 0;
  let inHeader = false;
  for (const line of String(diff || '').split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) { cur = null; inHeader = true; continue; }
    if (inHeader && line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      cur = p === '/dev/null' ? null : { path: p.replace(/^b\//, ''), added: [], removed: 0, isNew: false };
      if (cur) files.push(cur);
      continue;
    }
    if (inHeader && !line.startsWith('@@')) continue;
    if (!cur) continue;
    if (line.startsWith('@@')) {
      inHeader = false;
      const m = line.match(/\+(\d+)/);
      newLine = m ? Number(m[1]) : 1;
      if (/^@@ -0,0 /.test(line)) cur.isNew = true;
      continue;
    }
    if (line.startsWith('+')) { cur.added.push({ n: newLine, text: line.slice(1) }); newLine++; }
    else if (line.startsWith('-')) cur.removed++;
    else if (!line.startsWith('\\')) newLine++;
  }
  return files;
}

/**
 * The deterministic slop and secrets gate. `nameStatus` is `git diff --name-status` output.
 * Returns findings; `blocking` is true when the gate must fail.
 */
export function scanDiff(diff, nameStatus = '', cfg = DEFAULT_CONFIG) {
  const s = cfg.slop;
  const findings = [];
  const files = parseDiff(diff);
  let added = 0;
  let removed = 0;
  for (const f of files) {
    const generated = matchesAny(f.path, s.generated);
    if (!generated) { added += f.added.length; removed += f.removed; }
    for (const hit of scanSecrets(f.added.map((l) => l.text).join('\n'))) {
      findings.push({ kind: 'secret', rule: hit.rule, file: f.path, line: f.added[hit.line - 1].n, blocking: true });
    }
    if (generated || matchesAny(f.path, s.ignorePaths)) continue;
    for (const l of f.added) {
      for (const [rule, re] of SUPPRESSION_RULES) {
        if (re.test(l.text)) { findings.push({ kind: 'slop', rule, file: f.path, line: l.n, blocking: s.mode === 'fail' }); break; }
      }
    }
    if (f.isNew && f.added.length > s.maxNewFileLines && !matchesAny(f.path, s.testPaths)) {
      findings.push({ kind: 'slop', rule: 'oversized-new-file', file: f.path, detail: `${f.added.length} lines (limit ${s.maxNewFileLines})`, blocking: s.mode === 'fail' });
    }
  }
  for (const row of String(nameStatus || '').split(/\r?\n/)) {
    const [status, path] = row.split('\t');
    if (status === 'D' && path && matchesAny(path, s.testPaths) && !matchesAny(path, s.ignorePaths)) {
      findings.push({ kind: 'slop', rule: 'deleted-test-file', file: path, blocking: s.mode === 'fail' });
    }
  }
  if (added + removed > s.maxDiffLines) {
    findings.push({ kind: 'slop', rule: 'diff-too-large', detail: `${added + removed} changed lines (limit ${s.maxDiffLines}). Split the work or cut scope.`, blocking: s.mode === 'fail' });
  }
  return { findings, blocking: findings.some((f) => f.blocking), stats: { files: files.length, added, removed } };
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Time spent in each stage, from the job's history of transitions. */
export function stageDurations(job, now = Date.now()) {
  const out = {};
  const h = job.history || [];
  for (let i = 0; i < h.length; i++) {
    const end = i + 1 < h.length ? Date.parse(h[i + 1].at) : (TERMINAL.includes(h[i].stage) ? Date.parse(h[i].at) : now);
    out[h[i].stage] = (out[h[i].stage] || 0) + Math.max(0, end - Date.parse(h[i].at));
  }
  return out;
}

export function usageTotals(job, pricing = {}) {
  let tokens = 0;
  let cost = 0;
  let priced = false;
  for (const u of job.usage || []) {
    tokens += u.tokens || 0;
    const rate = pricing[u.model];
    if (typeof rate === 'number') { cost += ((u.tokens || 0) / 1e6) * rate; priced = true; }
  }
  return { tokens, cost: priced ? cost : null };
}

/** Aggregate numbers across jobs: the raw material for a factory retro. */
export function computeStats(jobs) {
  const stats = { jobs: jobs.length, byStage: {}, merged: 0, rejected: 0, autoMerged: 0, humanMerged: 0, reworkRounds: 0, gateFailures: 0, reviewerFails: {}, blockedReasons: {}, avgStageMs: {} };
  const sums = {};
  const counts = {};
  for (const j of jobs) {
    stats.byStage[j.stage] = (stats.byStage[j.stage] || 0) + 1;
    if (j.stage === 'merged') { stats.merged++; if (j.mergedBy === 'human') stats.humanMerged++; else stats.autoMerged++; }
    if (j.stage === 'rejected') stats.rejected++;
    stats.reworkRounds += Math.max(0, (j.round || 1) - 1);
    stats.gateFailures += j.gateFailures || 0;
    for (const round of Object.values(j.verdicts || {})) {
      for (const [name, v] of Object.entries(round)) if (v.verdict === 'fail') stats.reviewerFails[name] = (stats.reviewerFails[name] || 0) + 1;
    }
    for (const h of j.history || []) if (h.stage === 'needs-human' && h.note) stats.blockedReasons[h.note] = (stats.blockedReasons[h.note] || 0) + 1;
    for (const [stage, ms] of Object.entries(stageDurations(j))) { sums[stage] = (sums[stage] || 0) + ms; counts[stage] = (counts[stage] || 0) + 1; }
  }
  for (const s of Object.keys(sums)) stats.avgStageMs[s] = Math.round(sums[s] / counts[s]);
  return stats;
}
