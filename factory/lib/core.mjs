// Pure logic for the factory: no I/O, no git, no GitHub. Everything here is unit tested.

export const STAGES = ['intake', 'decompose', 'design', 'spec', 'grill', 'build', 'gate', 'review', 'approve', 'needs-human', 'merged', 'rejected', 'split'];
export const TERMINAL = ['merged', 'rejected', 'split'];
export const RISKS = ['low', 'medium', 'high'];
export const SURFACES = ['ui', 'api', 'data', 'pii', 'auth', 'infra', 'deps', 'perf', 'docs', 'logic'];
export const TYPES = ['feature', 'bug', 'refactor', 'docs', 'chore', 'spike'];
export const LESSON_AGENTS = ['all', 'intake', 'design', 'spec', 'grill', 'builder', 'reviewers', 'approver'];

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
  specReview: true,
  maxSpecRounds: 2,
  models: {
    intake: 'fable',
    decompose: 'opus',
    design: 'opus',
    spec: 'opus',
    grill: 'opus',
    builder: 'opus',
    approver: 'opus',
    reviewer: { low: 'sonnet', medium: 'sonnet', high: 'opus' },
  },
  routing: {
    always: ['code', 'qa'],
    security: { minRisk: 'medium', surfaces: ['auth', 'data', 'api', 'infra', 'deps'] },
    privacy: { surfaces: ['pii', 'data'] },
    ui: { surfaces: ['ui'], reviewers: ['ux', 'ui'] },
    doubt: { minRisk: 'high' },
    architecture: { minRisk: 'high', pain: 'high', types: ['refactor'] },
    performance: { surfaces: ['perf'] },
  },
  // What kind of job it is decides how it is built. `design: 'auto'` runs the design stage when
  // the job is not low risk or is expensive to reverse.
  playbooks: {
    feature: {
      design: 'auto',
      approach: 'Build the smallest version that meets every acceptance criterion, test-first, in thin slices that each leave the project working.',
      skills: { design: ['api-and-interface-design', 'codebase-design'], spec: ['spec-driven-development', 'planning-and-task-breakdown'], builder: ['incremental-implementation', 'test-driven-development', 'source-driven-development'] },
    },
    bug: {
      design: false,
      approach: 'Reproduce it first. Write a failing test that captures the bug, find the root cause, and make the smallest fix that addresses the cause and not the symptom. The failing test stays as the regression test. Do not refactor or add features along the way.',
      skills: { spec: ['debugging-and-error-recovery'], builder: ['debugging-and-error-recovery', 'diagnosing-bugs', 'test-driven-development'] },
    },
    refactor: {
      design: 'auto',
      approach: 'Behaviour must not change. Before touching the code, make sure tests pin down what it does today, and add characterisation tests where they do not. Move in small steps that keep the tests green. No new features, no fixes to bugs you find: file those separately.',
      skills: { design: ['codebase-design', 'api-and-interface-design'], builder: ['code-simplification', 'incremental-implementation'] },
    },
    docs: {
      design: false,
      specCheck: false,
      always: ['code'],
      approach: 'Verify every statement against the code as it is now: run the commands, open the files. Write for the reader who has to act on it. Do not change behaviour.',
      skills: { builder: ['documentation-and-adrs', 'humanize-writing'] },
    },
    chore: {
      design: false,
      specCheck: false,
      approach: 'Change only what the task names. For a dependency or tool upgrade, read the changelog for breaking changes, upgrade one thing at a time, and let the full check suite prove nothing else moved.',
      skills: { builder: ['deprecation-and-migration', 'source-driven-development'] },
    },
    spike: {
      design: false,
      specCheck: false,
      autoMerge: false,
      approach: 'This is an experiment to answer a question, not production code. Build the quickest thing that answers it, say clearly what you learned and what is fake or missing, and keep it behind a flag or in its own folder. A human decides whether any of it is kept.',
      skills: { builder: ['prototype'] },
    },
  },
  memory: { maxLessonsInBrief: 12, promoteAfter: 3, sampleCleanJobs: 0.1 },
  // The ticket tracker is the human interface: a trusted person can answer a waiting job in a ticket comment.
  tracker: { commandPrefix: '/factory', trusted: ['OWNER', 'MEMBER', 'COLLABORATOR'] },
  approval: {
    autoMerge: false,
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
  skills: {
    autoInstall: true,
    installer: 'npx -y skills add',
    sources: [
      {
        source: 'addyosmani/agent-skills',
        claudePlugin: 'agent-skills@addy-agent-skills',
        skills: [
          'spec-driven-development', 'planning-and-task-breakdown', 'interview-me', 'doubt-driven-development',
          'incremental-implementation', 'test-driven-development', 'source-driven-development',
          'debugging-and-error-recovery', 'frontend-ui-engineering', 'git-workflow-and-versioning',
          'code-review-and-quality', 'code-simplification', 'security-and-hardening',
          'accessibility-engineering', 'browser-testing-with-devtools', 'shipping-and-launch',
          'api-and-interface-design', 'documentation-and-adrs', 'performance-optimization', 'deprecation-and-migration',
        ],
      },
      { source: 'mattpocock/skills', skills: ['grilling', 'software-factory'] },
    ],
  },
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
export function route({ risk, surfaces = [], type = 'feature', pain = 'low' }, cfg = DEFAULT_CONFIG) {
  const r = cfg.routing;
  const playbook = (cfg.playbooks && cfg.playbooks[type]) || {};
  const names = [...(playbook.always || r.always)];
  const riskAtLeast = RISKS.indexOf(risk) >= RISKS.indexOf(r.security.minRisk);
  if (riskAtLeast || surfaces.some((s) => r.security.surfaces.includes(s))) names.push('security');
  if (surfaces.some((s) => r.privacy.surfaces.includes(s))) names.push('privacy');
  if (surfaces.some((s) => r.ui.surfaces.includes(s))) names.push(...r.ui.reviewers);
  if (RISKS.indexOf(risk) >= RISKS.indexOf(r.doubt.minRisk)) names.push('doubt');
  const a = r.architecture;
  if (RISKS.indexOf(risk) >= RISKS.indexOf(a.minRisk) || pain === a.pain || a.types.includes(type)) names.push('architecture');
  if (surfaces.some((s) => r.performance.surfaces.includes(s))) names.push('performance');
  const model = cfg.models.reviewer[risk] || cfg.models.reviewer.medium;
  return [...new Set(names)].map((name) => ({ name, model }));
}

/** Does this job stop for a human to approve the plan before any code is written? */
export function needsPlanReview({ risk, pain }, cfg = DEFAULT_CONFIG) {
  if (cfg.planReview === 'always') return true;
  if (cfg.planReview === 'never') return false;
  return pain === 'high' || risk === 'high';
}

/**
 * The spec critic has reported. `clear` moves on, `revise` sends the gaps back to the spec
 * writer (a limited number of times), `ask` stops for answers only a human can give.
 */
export function afterGrill(job, result, cfg = DEFAULT_CONFIG) {
  if (result === 'clear') return needsPlanReview(job, cfg) && !job.planApproved ? { stage: 'needs-human', waitingFor: 'plan' } : { stage: 'build' };
  if (result === 'ask') return { stage: 'needs-human', waitingFor: 'answers' };
  if ((job.specRound || 1) >= cfg.maxSpecRounds) return { stage: 'needs-human', waitingFor: 'answers', exhausted: true };
  return { stage: 'spec', specRound: (job.specRound || 1) + 1 };
}

/** Which configured skills are not installed, grouped by the source that provides them. */
export function missingSkills(sources, present) {
  const have = new Set(present);
  return sources
    .map((s) => ({ source: s.source, skills: s.skills.filter((n) => !have.has(n)) }))
    .filter((s) => s.skills.length);
}

const SAFE_SOURCE = /^[A-Za-z0-9._@:/-]+$/;
const SAFE_SKILL = /^[A-Za-z0-9._-]+$/;

/** The shell command that installs skills into the project, where every harness and teammate finds them. */
export function installCommand(installer, source, skills) {
  if (!SAFE_SOURCE.test(source)) throw new Error(`Unsafe skill source: ${source}`);
  for (const s of skills) if (!SAFE_SKILL.test(s)) throw new Error(`Unsafe skill name: ${s}`);
  return `${installer} ${source} --skill ${skills.join(' ')} -a claude-code --copy -y`;
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

/** A stable yes/no for "is this one in the sample", so the same job always gets the same answer. */
export function sampled(id, rate) {
  return rate > 0 && hashFraction(String(id)) < rate;
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
  if (job.plan && job.plan.autoMerge === false) reasons.push(`A ${job.type} is never merged without a human`);
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

// ---------------------------------------------------------------- planning a job

/**
 * Turns intake's classification into the job's whole plan: which stages run, who reviews,
 * how the work should be approached, and which skills fit. Decided once, in code.
 */
export function planJob({ type, risk, pain, surfaces = [] }, cfg = DEFAULT_CONFIG) {
  const pb = cfg.playbooks[type] || cfg.playbooks.feature;
  const design = pb.design === 'auto' ? pain === 'high' || risk !== 'low' : Boolean(pb.design);
  const specCheck = Boolean(cfg.specReview) && pb.specCheck !== false;
  const reviewers = route({ type, risk, pain, surfaces }, cfg);
  const planReview = needsPlanReview({ risk, pain }, cfg);
  const stages = ['intake', ...(design ? ['design'] : []), 'spec', ...(specCheck ? ['spec check'] : []), ...(planReview ? ['human plan review'] : []), 'build', 'gate', `review (${reviewers.map((r) => r.name).join(', ')})`, 'approve'];
  return { design, specCheck, planReview, reviewers, autoMerge: pb.autoMerge !== false, approach: pb.approach, skills: pb.skills || {}, stages };
}

// ---------------------------------------------------------------- memory

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Adds a lesson, or strengthens the existing one if this is the same lesson again. */
export function addLesson(lessons, { text, agents = ['all'], types = [], surfaces = [], job }, now = new Date().toISOString()) {
  const clean = String(text || '').trim().replace(/\s+/g, ' ');
  if (clean.length < 15) throw new Error('A lesson needs a full sentence saying what to do differently.');
  if (clean.length > 400) throw new Error('A lesson must be under 400 characters. Agents read every one that applies.');
  const bad = [...agents.filter((a) => !LESSON_AGENTS.includes(a)), ...types.filter((t) => !TYPES.includes(t)), ...surfaces.filter((s) => !SURFACES.includes(s))];
  if (bad.length) throw new Error(`Unknown tag(s): ${bad.join(', ')}`);
  const existing = lessons.find((l) => norm(l.text) === norm(clean));
  if (existing) return { lessons: markSeen(lessons, existing.id, job, now).lessons, lesson: existing, duplicate: true };
  const id = `L${lessons.reduce((m, l) => Math.max(m, Number(String(l.id).slice(1)) || 0), 0) + 1}`;
  const lesson = { id, text: clean, agents, types, surfaces, jobs: job ? [job] : [], seen: 1, createdAt: now, updatedAt: now };
  return { lessons: [...lessons, lesson], lesson, duplicate: false };
}

/** The same mistake happened again even though this lesson existed. */
export function markSeen(lessons, id, job, now = new Date().toISOString()) {
  if (!lessons.some((l) => l.id === id)) throw new Error(`No lesson ${id}`);
  return { lessons: lessons.map((l) => (l.id !== id ? l : { ...l, seen: l.seen + 1, jobs: job && !l.jobs.includes(job) ? [...l.jobs, job] : l.jobs, updatedAt: now })) };
}

/** The lessons that apply to one job: matching its type and surfaces, most-repeated first. */
export function selectLessons(lessons, { type, surfaces = [] }, limit = 12) {
  return lessons
    .filter((l) => (!l.types.length || !type || l.types.includes(type)) && (!l.surfaces.length || l.surfaces.some((s) => surfaces.includes(s))))
    .sort((a, b) => b.seen - a.seen || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

/** Lessons that keep recurring have stopped working as advice and should become a check. */
export function lessonsToPromote(lessons, cfg = DEFAULT_CONFIG) {
  return lessons.filter((l) => l.seen >= cfg.memory.promoteAfter);
}

const AGENT_LABEL = { all: 'Everyone', intake: 'Intake', design: 'Design', spec: 'Spec writer', grill: 'Spec check', builder: 'Builder', reviewers: 'Reviewers', approver: 'Approver' };

function lessonLines(lessons) {
  const out = [];
  for (const agent of LESSON_AGENTS) {
    const mine = lessons.filter((l) => l.agents.includes(agent));
    if (!mine.length) continue;
    out.push(`**${AGENT_LABEL[agent]}**`, ...mine.map((l) => `- ${l.text}${l.seen > 1 ? ` (this has gone wrong ${l.seen} times)` : ''} [${l.id}]`), '');
  }
  return out;
}

/** The one page every agent reads first: what kind of job this is, how to approach it, what was learned before. */
export function renderBrief(job, lessons, cfg = DEFAULT_CONFIG) {
  const plan = job.plan;
  const lines = [`# Job brief: ${job.title}`, '', 'Generated by the factory from the intake decision and the factory\'s memory. Read it before anything else.', ''];
  if (plan) {
    lines.push(`- **Kind of job:** ${job.type}`, `- **Risk:** ${job.risk} | **Cost of reversing the design:** ${job.pain} | **Touches:** ${job.surfaces.join(', ') || 'nothing flagged'}`, `- **Pipeline:** ${plan.stages.join(' → ')}`, '', '## How to approach this kind of job', '', plan.approach, '');
    const skills = Object.entries(plan.skills);
    if (skills.length) lines.push('## Skills that fit this job', '', 'Load the ones for your stage if your harness has them, in addition to the ones in your own instructions.', '', ...skills.map(([agent, list]) => `- **${agent}:** ${list.map((s) => `\`${s}\``).join(', ')}`), '');
  } else lines.push('This job has not been through intake yet.', '');
  const picked = selectLessons(lessons, { type: job.type, surfaces: job.surfaces }, cfg.memory.maxLessonsInBrief);
  lines.push('## Lessons from earlier jobs', '');
  if (!picked.length) lines.push('None recorded yet that apply here.');
  else lines.push('Each of these is a mistake this factory already made on this codebase. Do not repeat it. Read the ones for your stage and the ones for everyone.', '', ...lessonLines(picked));
  return lines.join('\n').trimEnd() + '\n';
}

/** The human-readable view of the factory's memory. Generated; the source is lessons.json. */
export function renderLessons(lessons, cfg = DEFAULT_CONFIG) {
  const lines = ['# Factory lessons', '', 'What this factory has learned from its own mistakes on this codebase. Generated from `factory/memory/lessons.json`; change it with `node factory/bin/job.mjs lesson`, not by hand.', ''];
  if (!lessons.length) lines.push('Nothing recorded yet.');
  const promote = lessonsToPromote(lessons, cfg);
  if (promote.length) lines.push('## Keeps happening: turn these into checks', '', ...promote.map((l) => `- ${l.text} (${l.seen} times) [${l.id}]`), '');
  if (lessons.length) lines.push('## All lessons', '', ...lessonLines([...lessons].sort((a, b) => b.seen - a.seen)));
  return lines.join('\n').trimEnd() + '\n';
}

// ---------------------------------------------------------------- pull request description

// Every pull request the factory opens reads the same way, in this order.
export const PR_SECTIONS = ['## Summary', '### What', '### Why', '### How', '## Component diagram', '## Sequence diagram', '## Tests'];

const DIAGRAM_CLASSES = {
  added: 'fill:#d1f5d9,stroke:#1a7f37,stroke-width:2px,color:#0b3d1a',
  changed: 'fill:#fff1c2,stroke:#9a6700,stroke-width:2px,color:#4d3300',
  unchanged: 'fill:#eaeef2,stroke:#8c959f,color:#24292f',
};
const DIAGRAM_LEGEND = '**Legend:** green = newly added, amber = changed, grey = not changed.';

function sectionBody(text, heading) {
  const start = text.indexOf(heading);
  if (start < 0) return '';
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n##+ /);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

const mermaidBlocks = (body) => [...body.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);

/** What is wrong with a pull request description, as a list the builder can fix. Empty means valid. */
export function validatePrDescription(text) {
  const t = String(text || '').replace(/\r\n/g, '\n');
  const problems = [];
  let at = -1;
  for (const h of PR_SECTIONS) {
    const i = t.search(new RegExp(`^${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'));
    if (i < 0) { problems.push(`Missing the "${h}" heading.`); continue; }
    if (i < at) problems.push(`"${h}" is out of order. The order is: ${PR_SECTIONS.join(', ')}.`);
    at = Math.max(at, i);
  }
  if (problems.length) return problems;
  for (const h of ['### What', '### Why', '### How', '## Tests']) {
    if (sectionBody(t, h).replace(/[^A-Za-z]/g, '').length < 20) problems.push(`"${h}" is empty. Write it in plain words.`);
  }
  const comp = mermaidBlocks(sectionBody(t, '## Component diagram'))[0];
  if (!comp) problems.push('"## Component diagram" needs a mermaid code block.');
  else {
    if (!/^\s*(flowchart|graph)\b/m.test(comp)) problems.push('The component diagram must be a mermaid flowchart.');
    if (!/:::(added|changed)\b/.test(comp)) problems.push('The component diagram marks nothing as added or changed. Tag each component with :::added, :::changed or :::unchanged.');
    if (!/:::unchanged\b/.test(comp)) problems.push('The component diagram shows no unchanged component. Include the existing parts the change connects to, tagged :::unchanged, so a reader sees where it fits.');
  }
  const seq = mermaidBlocks(sectionBody(t, '## Sequence diagram'))[0];
  if (!seq) problems.push('"## Sequence diagram" needs a mermaid code block.');
  else if (!/^\s*sequenceDiagram\b/m.test(seq)) problems.push('The sequence diagram must be a mermaid sequenceDiagram.');
  return problems;
}

/** Gives every component diagram the same colours and legend, whatever the builder wrote. */
export function finishPrDescription(text) {
  const t = String(text || '').replace(/\r\n/g, '\n').trim();
  const start = t.indexOf('## Component diagram');
  const end = t.indexOf('## Sequence diagram');
  if (start < 0 || end < start) return t;
  const section = t.slice(start, end)
    .replace(/```mermaid\n([\s\S]*?)```/, (_, body) => {
      const kept = body.split('\n').filter((l) => !/^\s*classDef\s+(added|changed|unchanged)\b/.test(l)).join('\n').trimEnd();
      const defs = Object.entries(DIAGRAM_CLASSES).map(([k, v]) => `  classDef ${k} ${v}`).join('\n');
      return `\`\`\`mermaid\n${kept}\n${defs}\n\`\`\`\n\n${DIAGRAM_LEGEND}`;
    })
    .replace(new RegExp(`(\\n\\n${DIAGRAM_LEGEND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})+`, 'g'), `\n\n${DIAGRAM_LEGEND}`);
  return `${t.slice(0, start)}${section.trimEnd()}\n\n${t.slice(end)}`;
}

// ---------------------------------------------------------------- tickets, dependencies and the tracker

/** Ticket numbers this ticket waits on, from "Depends on #12, #13" or "Blocked by #7" lines. */
export function parseDependencies(body) {
  const out = new Set();
  for (const m of String(body || '').matchAll(/(?:depends on|blocked by)[:\s]+((?:#\d+(?:\s*(?:,|and|&)\s*)?)+)/gi)) {
    for (const n of m[1].matchAll(/#(\d+)/g)) out.add(Number(n[1]));
  }
  return [...out];
}

/** What a human asked for in a ticket comment, or null if the comment is not addressed to the factory. */
export function parseTrackerCommand(body, prefix = '/factory') {
  const text = String(body || '').trim();
  if (!text.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const rest = text.slice(prefix.length).trim();
  const word = (rest.split(/\s+/)[0] || '').toLowerCase().replace(/[^a-z]/g, '');
  const after = rest.slice(rest.split(/\s+/)[0].length).trim();
  if (['approve', 'approved', 'lgtm', 'go'].includes(word) && !after) return { action: 'approve', text: '' };
  if (['reject', 'drop', 'close'].includes(word)) return { action: 'reject', text: after };
  if (!rest) return null;
  return { action: 'feedback', text: rest };
}

/**
 * Checks the tickets a decompose run proposes, and puts them in an order where every ticket
 * comes after the ones it depends on.
 */
export function validateTickets(tickets) {
  const problems = [];
  if (!Array.isArray(tickets)) return { problems: ['tickets.json must be a JSON array of tickets.'], order: [] };
  if (tickets.length < 2) problems.push('A split needs at least two tickets. If the work fits in one, do not split it.');
  if (tickets.length > 12) problems.push('More than twelve tickets. Split into fewer, larger pieces, or split the request itself first.');
  const keys = new Set();
  for (const [i, t] of tickets.entries()) {
    const where = `Ticket ${i + 1}`;
    if (!t || typeof t !== 'object') { problems.push(`${where} is not an object.`); continue; }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(t.key || '')) problems.push(`${where}: "key" must be a short lowercase name such as "api" or "settings-page".`);
    else if (keys.has(t.key)) problems.push(`${where}: key "${t.key}" is used twice.`);
    else keys.add(t.key);
    if (String(t.title || '').trim().length < 5) problems.push(`${where}: needs a title.`);
    if (String(t.body || '').trim().length < 40) problems.push(`${where}: the body must say what to build and how to tell it is done.`);
    if (!Array.isArray(t.dependsOn)) problems.push(`${where}: "dependsOn" must be an array of keys (empty if none).`);
  }
  if (problems.length) return { problems, order: [] };
  for (const t of tickets) for (const d of t.dependsOn) {
    if (!keys.has(d)) problems.push(`"${t.key}" depends on "${d}", which is not one of the tickets.`);
    if (d === t.key) problems.push(`"${t.key}" depends on itself.`);
  }
  if (problems.length) return { problems, order: [] };
  const order = [];
  const left = new Map(tickets.map((t) => [t.key, new Set(t.dependsOn)]));
  while (left.size) {
    const ready = [...left].filter(([, deps]) => [...deps].every((d) => order.includes(d))).map(([k]) => k);
    if (!ready.length) return { problems: [`These tickets depend on each other in a circle: ${[...left.keys()].join(', ')}.`], order: [] };
    for (const k of ready) { order.push(k); left.delete(k); }
  }
  return { problems: [], order };
}
