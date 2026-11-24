#!/usr/bin/env node
// The deterministic spine of the factory, and the ONLY writer of factory/jobs/<id>/job.json.
// Agents never edit job state. They do their work, then the orchestrator calls a command here,
// and this script decides what stage the job is in and what happens next.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  LESSON_AGENTS, PR_SECTIONS, RISKS, SURFACES, TERMINAL, TYPES, addLesson, afterGrill, afterReviews, computeStats, decideApproval, formatDuration,
  finishPrDescription, lessonsToPromote, markSeen, planJob, validatePrDescription, renderBrief, renderLessons, scanDiff, slugify, stageDurations, usageTotals,
} from '../lib/core.mjs';
import {
  GH_ENABLED, ROOT, gh, ghTry, git, gitTry, jobDir, jobFiles, listJobs, loadConfig, loadJob, loadLessons, saveJob, saveLessons, sh, writeJobFile,
} from '../lib/env.mjs';
import { detectSetup, runChecks, tail } from '../lib/checks.mjs';

const cfg = loadConfig();
const SELF = 'node factory/bin/job.mjs';

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.flags[a.slice(2)] = argv[++i];
      else out.flags[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

function fail(msg) { console.error(`ERROR: ${msg}`); process.exit(1); }
function say(msg) { console.log(msg); }

function transition(job, stage, note) {
  if (job.stage !== stage) job.prevStage = job.stage;
  job.stage = stage;
  job.history.push({ stage, at: new Date().toISOString(), ...(note ? { note } : {}) });
  // A finished job that went wrong somewhere owes the factory a lesson.
  if (TERMINAL.includes(stage)) job.learn = (job.mistakes || []).length ? 'pending' : 'none';
}

/** Every failure along the way is kept: this is the raw material the factory learns from. */
function recordMistake(job, stage, kind, detail) {
  job.mistakes = job.mistakes || [];
  job.mistakes.push({ stage, kind, detail: String(detail || '').slice(0, 500), round: job.round, at: new Date().toISOString() });
}

function requireStage(job, ...stages) {
  if (!stages.includes(job.stage)) fail(`Job ${job.id} is in "${job.stage}", but this command needs: ${stages.join(' or ')}.\n${nextHint(job)}`);
}

function comment(job, body) {
  if (!job.issue || !cfg.comments || !GH_ENABLED) return;
  ghTry(['issue', 'comment', String(job.issue), '--body', `**Factory** (job \`${job.id}\`): ${body}`]);
}

function hasOrigin() { return gitTry(['remote', 'get-url', 'origin']).ok; }

function baseBranch() {
  if (cfg.baseBranch) return cfg.baseBranch;
  const head = gitTry(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok) return head.out.replace(/^origin\//, '');
  return git(['branch', '--show-current']) || 'main';
}

function changedFiles(job) {
  const r = gitTry(['diff', '--name-only', `${job.baseRef}...HEAD`], job.worktree);
  return r.ok ? r.out.split(/\r?\n/).filter(Boolean) : [];
}

function cleanupWorktree(job) {
  if (job.worktree && existsSync(job.worktree)) gitTry(['worktree', 'remove', '--force', job.worktree]);
  gitTry(['worktree', 'prune']);
  gitTry(['branch', '-D', job.branch]);
}

function blockJob(job, reason, waitingFor = null) {
  transition(job, 'needs-human', reason);
  job.blockedReason = reason;
  job.waitingFor = waitingFor;
  comment(job, `needs a human. ${reason}`);
}

/** What the orchestrator should do next for this job. This is what makes the factory resumable. */
function nextHint(job) {
  const dir = jobDir(job.id);
  const ctx = `Job dir: ${dir} | Worktree: ${job.worktree} | Round: ${job.round}`;
  switch (job.stage) {
    case 'intake':
      return `NEXT: delegate to agent "factory-intake" (model ${cfg.models.intake}). ${ctx}\n      then: ${SELF} intake ${job.id} --decision <accept|reject|needs-info> --risk <low|medium|high> --type <${TYPES.join('|')}> --pain <low|high> --surfaces <csv of ${SURFACES.join(',')}> --reason "<one line>"`;
    case 'design':
      return `NEXT: delegate to agent "factory-design" (model ${cfg.models.design}). ${ctx}\n      then: ${SELF} design-done ${job.id}`;
    case 'spec':
      return `NEXT: delegate to agent "factory-spec" (model ${cfg.models.spec}). ${ctx} | Spec round: ${job.specRound}\n      then: ${SELF} spec-done ${job.id}`;
    case 'grill':
      return `NEXT: delegate to agent "factory-grill" (model ${cfg.models.grill}). ${ctx} | Spec round: ${job.specRound}\n      then: ${SELF} grill ${job.id} --result <clear|revise|ask> --summary "<one line>"`;
    case 'build':
      return `NEXT: delegate to agent "factory-builder" (model ${cfg.models.builder}). ${ctx}\n      then: ${SELF} gate ${job.id}`;
    case 'gate':
      return `NEXT: ${SELF} gate ${job.id}   (a previous gate run was interrupted)`;
    case 'review': {
      const pending = afterReviews(job, cfg).pending || [];
      const list = job.reviewers.filter((r) => pending.includes(r.name)).map((r) => `"factory-reviewer-${r.name}" (model ${r.model})`).join(', ');
      return `NEXT: delegate to these reviewer agents, in parallel if your harness can: ${list}. ${ctx}\n      after each: ${SELF} verdict ${job.id} <reviewer> <pass|fail> --summary "<one line>"`;
    }
    case 'approve':
      return `NEXT: delegate to agent "factory-approver" (model ${cfg.models.approver}). ${ctx}\n      then: ${SELF} approve ${job.id} --decision <merge|escalate> --reason "<one line>"`;
    case 'needs-human':
      return `WAITING ON HUMAN (${job.waitingFor || 'guidance'}): ${job.blockedReason || 'no reason recorded'}\n      human says go:      ${SELF} approve-human ${job.id}\n      human wants changes: ${SELF} feedback ${job.id} "<what they said>"\n      human says drop it:  ${SELF} reject ${job.id} --reason "<why>"`;
    default:
      if (job.learn === 'pending') return `DONE: job is ${job.stage}, and it made ${job.mistakes.length} mistake(s) along the way.\n      NEXT: delegate to agent "factory-retro" (model ${cfg.models.approver}). ${ctx}\n      then: ${SELF} learned ${job.id}`;
      return `DONE: job is ${job.stage}.`;
  }
}

function writeBrief(job) {
  if (!TERMINAL.includes(job.stage)) writeJobFile(job, 'brief.md', renderBrief(job, loadLessons(), cfg));
}

function report(job, headline) {
  saveJob(job);
  writeBrief(job);
  say(`${headline}\n[${job.id}] stage=${job.stage} round=${job.round}\n${nextHint(job)}`);
}

// ---------------------------------------------------------------- commands

const commands = {};

commands.queue = () => {
  const jobs = listJobs();
  const active = jobs.filter((j) => !TERMINAL.includes(j.stage));
  const running = active.filter((j) => j.stage !== 'needs-human');
  let pending = [];
  let warning = null;
  if (GH_ENABLED) {
    const r = ghTry(['issue', 'list', '--label', cfg.label, '--state', 'open', '--limit', '100', '--json', 'number,title']);
    if (r.ok) {
      const known = new Set(jobs.map((j) => j.issue).filter(Boolean));
      pending = JSON.parse(r.out).filter((i) => !known.has(i.number)).sort((a, b) => a.number - b.number);
    } else warning = `Could not read GitHub issues: ${r.err}`;
  }
  const slots = Math.max(0, cfg.concurrency - running.length);
  say(JSON.stringify({
    concurrency: cfg.concurrency,
    freeSlots: slots,
    running: running.map((j) => ({ id: j.id, stage: j.stage, round: j.round, next: nextHint(j) })),
    toLearn: jobs.filter((j) => j.learn === 'pending').map((j) => ({ id: j.id, mistakes: j.mistakes.length, next: nextHint(j) })),
    needsHuman: active.filter((j) => j.stage === 'needs-human').map((j) => ({ id: j.id, title: j.title, reason: j.blockedReason })),
    pendingIssues: pending,
    startNow: pending.slice(0, slots).map((i) => `${SELF} create ${i.number}`),
    ...(warning ? { warning } : {}),
  }, null, 2));
};

commands.create = ({ _, flags }) => {
  let issue = null;
  let title = flags.title;
  let body = flags.body || '';
  let url = null;
  if (_[0]) {
    issue = Number(String(_[0]).replace(/^#/, ''));
    if (!Number.isInteger(issue)) fail('Usage: create <issue-number>  |  create --title "..." [--body "..."]');
    const existing = listJobs().find((j) => j.issue === issue);
    if (existing) return report(existing, `Job already exists for issue #${issue}.`);
    const data = JSON.parse(gh(['issue', 'view', String(issue), '--json', 'number,title,body,url']));
    ({ title, body, url } = data);
  }
  if (!title || title === true) fail('Usage: create <issue-number>  |  create --title "..." [--body "..."]');

  const id = issue ? `${issue}-${slugify(title)}` : `L${listJobs().filter((j) => !j.issue).length + 1}-${slugify(title)}`;
  const base = baseBranch();
  if (hasOrigin()) gitTry(['fetch', 'origin', base]);
  const baseRef = gitTry(['rev-parse', '--verify', '--quiet', `origin/${base}`]).ok ? `origin/${base}` : base;
  const branch = `factory/${id}`;
  const worktree = resolve(ROOT, cfg.worktreeDir, id);
  mkdirSync(resolve(ROOT, cfg.worktreeDir), { recursive: true });
  const wt = gitTry(['worktree', 'add', '-b', branch, worktree, baseRef]);
  if (!wt.ok) fail(`Could not create worktree: ${wt.err}`);

  const now = new Date().toISOString();
  const job = {
    id, issue, url, title, source: issue ? 'issue' : 'local', branch, base, baseRef, worktree,
    stage: 'intake', prevStage: null, waitingFor: null, round: 1, specRound: 1, risk: null, pain: null, surfaces: [], reviewers: [],
    type: null, plan: null, mistakes: [], learn: null, verdicts: {}, gateFailures: 0, usage: [], pr: null, createdAt: now, updatedAt: now,
    history: [{ stage: 'intake', at: now }],
  };
  writeJobFile(job, 'issue.md', `# ${title}\n\n${url ? `${url}\n\n` : ''}${body || '(no description)'}`);

  if (!flags['no-setup']) {
    const setup = cfg.setup === null ? detectSetup(worktree) : cfg.setup;
    const failed = setup.map((cmd) => ({ cmd, ...sh(cmd, worktree) })).filter((r) => r.code !== 0);
    if (failed.length) writeJobFile(job, 'setup-failed.md', failed.map((f) => `## \`${f.cmd}\` exited ${f.code}\n\n\`\`\`\n${tail(f.out, 60)}\n\`\`\``).join('\n\n'));
  }
  comment(job, 'picked up. Starting intake.');
  report(job, `Created job ${id} on branch ${branch}.`);
};

commands.intake = ({ _, flags }) => {
  const job = loadJob(_[0]);
  requireStage(job, 'intake');
  const { decision, risk, reason } = flags;
  const pain = flags.pain || 'low';
  if (!['accept', 'reject', 'needs-info'].includes(decision)) fail('--decision must be accept, reject or needs-info');
  if (decision === 'reject') {
    transition(job, 'rejected', reason || 'Rejected at intake');
    cleanupWorktree(job);
    comment(job, `rejected at intake. ${reason || ''}`);
    if (job.issue && GH_ENABLED) ghTry(['issue', 'edit', String(job.issue), '--remove-label', cfg.label]);
    return report(job, 'Rejected.');
  }
  if (decision === 'needs-info') {
    blockJob(job, `Intake needs more information: ${reason || 'see intake.md'}`, 'answers');
    return report(job, 'Blocked for more information.');
  }
  if (!RISKS.includes(risk)) fail(`--risk must be one of ${RISKS.join(', ')}`);
  const type = flags.type;
  if (!TYPES.includes(type)) fail(`--type must be one of ${TYPES.join(', ')}`);
  if (!['low', 'high'].includes(pain)) fail('--pain must be low or high');
  const surfaces = String(flags.surfaces || '').split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = surfaces.filter((s) => !SURFACES.includes(s));
  if (unknown.length) fail(`Unknown surfaces: ${unknown.join(', ')}. Allowed: ${SURFACES.join(', ')}`);
  const plan = planJob({ type, risk, pain, surfaces }, cfg);
  Object.assign(job, { type, risk, pain, surfaces, reviewers: plan.reviewers, planReview: plan.planReview, plan: { design: plan.design, specCheck: plan.specCheck, autoMerge: plan.autoMerge, approach: plan.approach, skills: plan.skills, stages: plan.stages } });
  transition(job, plan.design ? 'design' : 'spec', reason);
  comment(job, `accepted as a **${type}**. Risk **${risk}**, touches: ${surfaces.join(', ') || 'nothing flagged'}. Pipeline: ${plan.stages.join(' → ')}.`);
  report(job, 'Accepted.');
};

commands['design-done'] = ({ _ }) => {
  const job = loadJob(_[0]);
  requireStage(job, 'design');
  if (!existsSync(join(jobDir(job.id), 'design.md'))) fail(`design.md is missing from ${jobDir(job.id)}. The design agent must write it.`);
  transition(job, 'spec');
  report(job, 'Design written.');
};

commands['spec-done'] = ({ _ }) => {
  const job = loadJob(_[0]);
  requireStage(job, 'spec');
  if (!existsSync(join(jobDir(job.id), 'spec.md'))) fail(`spec.md is missing from ${jobDir(job.id)}. The spec agent must write it.`);
  if (job.plan ? job.plan.specCheck : cfg.specReview) {
    transition(job, 'grill');
    return report(job, 'Spec written. It goes to the spec check next.');
  }
  specAccepted(job, 'Spec written.');
};

const PLAN_REASON = 'Plan review: read spec.md and approve it, or give feedback, before any code is written.';

function specAccepted(job, headline) {
  if (job.planReview && !job.planApproved) {
    blockJob(job, PLAN_REASON, 'plan');
    return report(job, headline + ' Waiting for a human to approve the plan.');
  }
  transition(job, 'build');
  report(job, headline);
}

commands.grill = ({ _, flags }) => {
  const job = loadJob(_[0]);
  requireStage(job, 'grill');
  if (!['clear', 'revise', 'ask'].includes(flags.result)) fail('--result must be clear, revise or ask');
  const file = 'grill-' + job.specRound + '.md';
  if (!existsSync(join(jobDir(job.id), file))) fail(file + ' is missing from ' + jobDir(job.id) + '. The spec check agent must write it.');
  const next = afterGrill(job, flags.result, cfg);
  if (flags.result !== 'clear') recordMistake(job, 'spec', flags.result === 'ask' ? 'spec-open-question' : 'spec-gap', flags.summary === true ? file : flags.summary || file);
  if (next.stage === 'spec') {
    job.specRound = next.specRound;
    transition(job, 'spec', 'spec has gaps: see ' + file);
    return report(job, 'The spec has gaps the spec writer can close. It must address ' + file + '.');
  }
  if (next.waitingFor === 'answers') {
    const lead = next.exhausted ? 'The spec still has gaps after ' + job.specRound + ' attempts.' : 'The spec has open questions only a person can answer.';
    blockJob(job, lead + ' Answer the questions in ' + file + ', or approve to accept its recommended answers.', 'answers');
    comment(job, 'the spec has open questions for a human. See ' + file + ' in the job folder.');
    return report(job, 'Spec check found questions for a human.');
  }
  specAccepted(job, 'Spec check passed.');
};

commands.gate = ({ _ }) => {
  const job = loadJob(_[0]);
  requireStage(job, 'build', 'gate');
  const wt = job.worktree;
  if (!existsSync(wt)) fail(`Worktree is missing: ${wt}`);
  transition(job, 'gate');
  saveJob(job);

  const problems = [];
  const sections = [];
  const dirty = git(['status', '--porcelain'], wt);
  if (dirty) problems.push(`Uncommitted changes in the worktree. Commit everything:\n\`\`\`\n${tail(dirty, 30)}\n\`\`\``);
  const ahead = Number(gitTry(['rev-list', '--count', `${job.baseRef}..HEAD`], wt).out || 0);
  if (!ahead) problems.push(`No commits on ${job.branch}. Nothing was built.`);

  if (hasOrigin()) gitTry(['fetch', 'origin', job.base]);
  const mt = gitTry(['merge-tree', '--write-tree', 'HEAD', job.baseRef], wt);
  if (mt.code === 1) problems.push(`The branch conflicts with ${job.baseRef}. Merge ${job.baseRef} into the branch and resolve the conflicts.`);

  const scan = scanDiff(gitTry(['diff', `${job.baseRef}...HEAD`], wt).out, gitTry(['diff', '--name-status', `${job.baseRef}...HEAD`], wt).out, cfg);
  if (scan.findings.length) {
    const rows = scan.findings.map((f) => `- ${f.blocking ? 'BLOCKING' : 'warning'} \`${f.rule}\`${f.file ? ` in ${f.file}${f.line ? `:${f.line}` : ''}` : ''}${f.detail ? `: ${f.detail}` : ''}`);
    sections.push(`## Slop and secrets scan\n\n${rows.join('\n')}`);
    if (scan.blocking) problems.push('The slop and secrets scan found blocking problems (listed below). Fix the cause; do not suppress checks, skip tests, or commit credentials.');
  }

  const prFile = join(jobDir(job.id), 'pr.md');
  const prProblems = existsSync(prFile) ? validatePrDescription(readFileSync(prFile, 'utf8')) : [`pr.md is missing from ${jobDir(job.id)}.`];
  if (prProblems.length) {
    problems.push('The pull request description (pr.md in the job folder) is missing or not in the required format. Fix what is listed below.');
    sections.push(`## Pull request description\n\nRequired headings, in this order: ${PR_SECTIONS.join(', ')}.\n\n${prProblems.map((p) => `- ${p}`).join('\n')}`);
  }

  let checks = { results: [], pass: true, none: false };
  if (!problems.length) {
    checks = runChecks(wt, cfg);
    if (checks.none) sections.push('## Checks\n\nWARNING: no checks are configured and none were detected. Add `checks` to factory/factory.config.json.');
    else sections.push(`## Checks\n\n${checks.results.map((r) => `- ${r.pass ? 'PASS' : 'FAIL'} \`${r.cmd}\` (${formatDuration(r.ms)})`).join('\n')}`);
    for (const r of checks.results.filter((x) => !x.pass)) {
      problems.push(`Check \`${r.cmd}\` failed with exit code ${r.code}.`);
      sections.push(`### Output of \`${r.cmd}\`\n\n\`\`\`\n${tail(r.out)}\n\`\`\``);
    }
  }

  const pass = problems.length === 0;
  const head = `# Gate, round ${job.round}: ${pass ? 'PASS' : 'FAIL'}\n\nDiff: ${scan.stats.files} files, +${scan.stats.added} -${scan.stats.removed}.`;
  writeJobFile(job, `gate-${job.round}.md`, [head, pass ? '' : `## Must fix\n\n${problems.map((p) => `- ${p}`).join('\n')}`, ...sections].filter(Boolean).join('\n\n'));

  job.lastGate = { round: job.round, stats: scan.stats, none: checks.none, checks: checks.results.map((r) => ({ name: r.name, cmd: r.cmd, pass: r.pass, ms: r.ms })) };
  if (pass) {
    job.verdicts[job.round] = {};
    transition(job, 'review');
    return report(job, 'Gate PASSED.');
  }
  job.gateFailures += 1;
  recordMistake(job, 'build', 'gate-failure', problems.map((p) => p.split('\n')[0]).join(' | '));
  if (job.gateFailures > cfg.maxGateFailures) {
    blockJob(job, `The gate has failed ${job.gateFailures} times. See gate-${job.round}.md.`);
    return report(job, 'Gate FAILED too many times.');
  }
  transition(job, 'build', `gate failed (${job.gateFailures})`);
  report(job, `Gate FAILED. The builder must read gate-${job.round}.md and fix it.`);
};

function prBody(job) {
  const dir = jobDir(job.id);
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').trim() : '');
  const rounds = Object.entries(job.verdicts).filter(([, v]) => Object.keys(v).length).map(([round, v]) => `- Round ${round}: ${Object.entries(v).map(([n, x]) => `${n} ${x.verdict}`).join(', ')}`);
  const spec = read('spec.md');
  const gate = job.lastGate || { checks: [] };
  const ran = gate.checks.length
    ? gate.checks.map((c) => `| \`${c.cmd}\` | ${c.pass ? 'passed' : 'FAILED'} | ${formatDuration(c.ms)} |`)
    : ['| (no checks configured) | - | - |'];
  const fold = (title, body) => (body ? `<details><summary>${title}</summary>\n\n${body.length > 20000 ? `${body.slice(0, 20000)}\n\n(truncated)` : body}\n\n</details>` : '');
  return [
    finishPrDescription(read('pr.md')),
    `### Checks the factory ran\n\nThese ran on this exact commit before any reviewer saw it.\n\n| Check | Result | Time |\n|---|---|---|\n${ran.join('\n')}`,
    `### Reviews\n\n${rounds.join('\n') || 'Reviews have not run yet.'}`,
    '---',
    job.issue ? `Closes #${job.issue}` : '',
    '> This pull request was written and reviewed by AI agents in the software factory. A human owns the decision to ship it.',
    `**Kind:** ${job.type} | **Risk:** ${job.risk} | **Touches:** ${job.surfaces.join(', ') || 'nothing flagged'} | **Review rounds:** ${job.round} | **Gate failures:** ${job.gateFailures}`,
    fold('Builder notes', read(`build-${job.round}.md`)),
    fold('Design', read('design.md')),
    fold('Spec', spec),
  ].filter(Boolean).join('\n\n');
}

function openPr(job) {
  if (!job.issue || !GH_ENABLED || !hasOrigin()) return;
  const push = gitTry(['push', '-u', 'origin', job.branch], job.worktree);
  if (!push.ok) throw new Error(`git push failed: ${push.err}`);
  if (job.pr) { gh(['pr', 'edit', String(job.pr.number), '--body-file', '-'], { input: prBody(job) }); return; }
  const url = gh(['pr', 'create', '--head', job.branch, '--base', job.base, '--title', `${job.title} (#${job.issue})`, '--body-file', '-'], { input: prBody(job) }).split(/\r?\n/).pop();
  job.pr = { url, number: Number(url.split('/').pop()) };
}

commands.verdict = ({ _, flags }) => {
  const job = loadJob(_[0]);
  requireStage(job, 'review');
  const [, name, verdict] = _;
  if (!job.reviewers.some((r) => r.name === name)) fail(`"${name}" is not a reviewer on this job. Reviewers: ${job.reviewers.map((r) => r.name).join(', ')}`);
  if (!['pass', 'fail'].includes(verdict)) fail('Verdict must be pass or fail');
  const file = `review-${job.round}-${name}.md`;
  if (!existsSync(join(jobDir(job.id), file))) fail(`${file} is missing from ${jobDir(job.id)}. The reviewer must write its findings there first.`);
  job.verdicts[job.round] = { ...(job.verdicts[job.round] || {}), [name]: { verdict, at: new Date().toISOString(), summary: flags.summary === true ? '' : flags.summary || '' } };

  if (verdict === 'fail') recordMistake(job, 'build', `review-fail:${name}`, flags.summary === true ? file : flags.summary || file);
  const result = afterReviews(job, cfg);
  if (!result.done) return report(job, `Recorded ${name}: ${verdict}. Waiting on: ${result.pending.join(', ')}.`);
  const summary = Object.entries(job.verdicts[job.round]).map(([n, v]) => `${n} ${v.verdict}`).join(', ');
  if (result.stage === 'approve') {
    try { openPr(job); } catch (e) {
      blockJob(job, `All reviews passed but the pull request could not be opened: ${e.message}`, 'approval');
      return report(job, 'Could not open the pull request.');
    }
    transition(job, 'approve');
    comment(job, `round ${job.round} reviews all passed (${summary}).${job.pr ? ` Pull request: ${job.pr.url}` : ''}`);
    return report(job, 'All reviewers passed.');
  }
  if (result.stage === 'needs-human') {
    blockJob(job, result.reason);
    return report(job, 'Review rounds exhausted.');
  }
  comment(job, `round ${job.round} review: ${summary}. Sending back to the builder.`);
  job.round = result.round;
  transition(job, 'build', `rework after review: ${result.failed.join(', ')}`);
  report(job, `Review failed (${result.failed.join(', ')}). The builder must address review-${result.round - 1}-*.md.`);
};

function doMerge(job, by) {
  const wtFiles = changedFiles(job);
  if (job.pr && GH_ENABLED) {
    gh(['pr', 'merge', String(job.pr.number), `--${cfg.approval.mergeMethod}`]);
    cleanupWorktree(job);
    gitTry(['push', 'origin', '--delete', job.branch]);
  } else {
    const current = git(['branch', '--show-current']);
    if (current !== job.base) throw new Error(`The main checkout is on "${current}", not "${job.base}". Switch to ${job.base} and retry.`);
    if (existsSync(job.worktree)) gitTry(['worktree', 'remove', '--force', job.worktree]);
    const m = gitTry(['merge', '--no-ff', '-m', `Merge ${job.branch}: ${job.title}`, job.branch]);
    if (!m.ok) { gitTry(['merge', '--abort']); throw new Error(`git merge failed: ${m.err || m.out}`); }
    cleanupWorktree(job);
  }
  job.mergedBy = by;
  job.filesChanged = wtFiles.length;
  transition(job, 'merged', `merged by ${by}`);
  comment(job, `merged (${by === 'human' ? 'approved by a human' : 'auto-merged by the factory'}).`);
}

function tryMerge(job, by) {
  try { doMerge(job, by); return report(job, `Merged (${by}).`); } catch (e) {
    blockJob(job, `Merge failed: ${String(e.stderr || e.message).trim()}`, 'approval');
    job.prevStage = 'approve';
    return report(job, 'Merge failed.');
  }
}

commands.approve = ({ _, flags }) => {
  const job = loadJob(_[0]);
  requireStage(job, 'approve');
  if (!['merge', 'escalate'].includes(flags.decision)) fail('--decision must be merge or escalate');
  const verdict = decideApproval({ job, recommendation: flags.decision, files: changedFiles(job) }, cfg);
  job.approval = { recommendation: flags.decision, reason: flags.reason === true ? '' : flags.reason || '', escalations: verdict.reasons, at: new Date().toISOString() };
  if (verdict.merge) return tryMerge(job, 'factory');
  const why = [...verdict.reasons, job.approval.reason].filter(Boolean).join('. ');
  blockJob(job, `Approval needed: ${why}.${job.pr ? ` Review ${job.pr.url}` : ''}`, 'approval');
  report(job, 'Escalated to a human.');
};

commands['approve-human'] = ({ _ }) => {
  const job = loadJob(_[0]);
  requireStage(job, 'needs-human');
  const waiting = job.waitingFor;
  if (waiting === 'plan') {
    job.planApproved = true;
    job.blockedReason = null;
    job.waitingFor = null;
    transition(job, 'build', 'plan approved by human');
    comment(job, 'plan approved by a human. Building.');
    return report(job, 'Plan approved.');
  }
  if (waiting === 'answers' && job.prevStage === 'grill') {
    const n = jobFiles(job.id).filter((f) => f.startsWith('feedback-')).length + 1;
    writeJobFile(job, 'feedback-' + n + '.md', '# Human feedback ' + n + '\n\nThe human accepted every recommended answer in grill-' + job.specRound + '.md. Write them into the spec as decisions.');
    job.specRound += 1;
    job.blockedReason = null;
    job.waitingFor = null;
    transition(job, 'spec', 'human accepted the recommended answers');
    return report(job, 'Recommended answers accepted. The spec writer will fold them in.');
  }
  if (waiting === 'approval' && job.prevStage === 'approve') return tryMerge(job, 'human');
  fail(`This job was blocked during "${job.prevStage}", so there is nothing to approve. Reply with: ${SELF} feedback ${job.id} "<guidance>"`);
};

commands.feedback = ({ _, flags }) => {
  const job = loadJob(_[0]);
  const text = _.slice(1).join(' ').trim();
  if (!text) fail('Usage: feedback <job> "<what the human said>" [--to <stage>]');
  if (TERMINAL.includes(job.stage)) fail(`Job ${job.id} is already ${job.stage}.`);
  const n = jobFiles(job.id).filter((f) => f.startsWith('feedback-')).length + 1;
  writeJobFile(job, `feedback-${n}.md`, `# Human feedback ${n}\n\nGiven while the job was in: ${job.stage}${job.blockedReason ? ` (${job.blockedReason})` : ''}\n\n${text}`);
  recordMistake(job, job.stage === 'needs-human' ? job.prevStage : job.stage, job.waitingFor === 'answers' ? 'human-answer' : 'human-correction', text);
  if (job.stage !== 'needs-human') return report(job, `Feedback recorded as feedback-${n}.md.`);
  const prev = job.prevStage;
  const to = flags.to || (prev === 'approve' || prev === 'review' || prev === 'gate' ? 'build' : prev === 'grill' ? 'spec' : prev);
  if (!['intake', 'design', 'spec', 'build'].includes(to)) fail(`Cannot resume into "${to}". Use --to intake, design, spec or build.`);
  if (to === 'build' && (prev === 'approve' || prev === 'review')) job.round += 1;
  if (to === 'build') job.gateFailures = 0;
  if (to === 'spec' && existsSync(join(jobDir(job.id), 'grill-' + job.specRound + '.md'))) job.specRound += 1;
  job.blockedReason = null;
  job.waitingFor = null;
  transition(job, to, `human feedback ${n}`);
  report(job, `Feedback recorded as feedback-${n}.md. Job resumed.`);
};

commands.block = ({ _, flags }) => {
  const job = loadJob(_[0]);
  if (TERMINAL.includes(job.stage) || job.stage === 'needs-human') fail(`Job ${job.id} is ${job.stage}.`);
  blockJob(job, flags.reason && flags.reason !== true ? flags.reason : 'Blocked by an agent. See the job files.');
  report(job, 'Blocked.');
};

commands.reject = ({ _, flags }) => {
  const job = loadJob(_[0]);
  if (TERMINAL.includes(job.stage)) fail(`Job ${job.id} is already ${job.stage}.`);
  const reason = flags.reason && flags.reason !== true ? flags.reason : 'Rejected';
  if (job.pr && GH_ENABLED) ghTry(['pr', 'close', String(job.pr.number)]);
  transition(job, 'rejected', reason);
  cleanupWorktree(job);
  if (job.pr && hasOrigin()) gitTry(['push', 'origin', '--delete', job.branch]);
  comment(job, `rejected. ${reason}`);
  if (job.issue && GH_ENABLED) ghTry(['issue', 'edit', String(job.issue), '--remove-label', cfg.label]);
  report(job, 'Rejected.');
};

commands.usage = ({ _, flags }) => {
  const job = loadJob(_[0]);
  const tokens = Number(flags.tokens);
  if (!flags.stage || !Number.isFinite(tokens)) fail('Usage: usage <job> --stage <name> --model <model> --tokens <n> [--ms <n>]');
  job.usage.push({ stage: flags.stage, model: flags.model || 'unknown', tokens, ms: Number(flags.ms) || null, at: new Date().toISOString() });
  saveJob(job);
  say(`Recorded ${tokens} tokens for ${flags.stage}.`);
};

commands.next = ({ _ }) => { const job = loadJob(_[0]); say(`[${job.id}] stage=${job.stage} round=${job.round}\n${nextHint(job)}`); };

commands.status = ({ _, flags }) => {
  if (_[0]) {
    const job = loadJob(_[0]);
    if (flags.json) return say(JSON.stringify(job, null, 2));
    const d = stageDurations(job);
    const u = usageTotals(job, cfg.pricing);
    say([
      `${job.id}: ${job.title}`,
      `stage=${job.stage} round=${job.round} risk=${job.risk || '?'} surfaces=${job.surfaces.join(',') || '-'} gateFailures=${job.gateFailures}`,
      job.url ? `issue: ${job.url}` : null,
      job.pr ? `pr:    ${job.pr.url}` : null,
      `time:  ${Object.entries(d).map(([s, ms]) => `${s} ${formatDuration(ms)}`).join(', ')}`,
      `tokens: ${u.tokens}${u.cost === null ? '' : ` (~$${u.cost.toFixed(2)})`}`,
      `files: ${jobFiles(job.id).join(', ')}`,
      nextHint(job),
    ].filter(Boolean).join('\n'));
    return;
  }
  commands.list({ flags });
};

commands.list = ({ flags }) => {
  const jobs = listJobs();
  if (flags.json) return say(JSON.stringify(jobs, null, 2));
  if (!jobs.length) return say('No jobs yet.');
  for (const j of jobs) say(`${j.stage.padEnd(12)} ${j.id.padEnd(44)} risk=${(j.risk || '?').padEnd(6)} round=${j.round}${j.stage === 'needs-human' ? `  <- ${j.blockedReason}` : ''}`);
};

commands.stats = () => {
  const lessons = loadLessons();
  say(JSON.stringify({ ...computeStats(listJobs()), lessons: lessons.length, lessonsToPromote: lessonsToPromote(lessons, cfg).map((l) => ({ id: l.id, seen: l.seen, text: l.text })) }, null, 2));
};

// Prints the pull request description exactly as it will be posted, for a human or an agent to check.
commands['pr-preview'] = ({ _ }) => {
  const job = loadJob(_[0]);
  const file = join(jobDir(job.id), 'pr.md');
  if (!existsSync(file)) fail(`pr.md is missing from ${jobDir(job.id)}.`);
  const problems = validatePrDescription(readFileSync(file, 'utf8'));
  if (problems.length) fail(`pr.md is not in the required format:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  say(prBody(job));
};

commands.brief = ({ _ }) => { const job = loadJob(_[0]); say(renderBrief(job, loadLessons(), cfg)); };

const csv = (v) => (v && v !== true ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

commands.lesson = ({ _, flags }) => {
  const [action, id] = _;
  let lessons = loadLessons();
  const job = flags.job && flags.job !== true ? loadJob(flags.job).id : undefined;
  if (action === 'list') return say(lessons.length ? lessons.map((l) => `${l.id}  seen=${l.seen}  [${l.agents.join(',')}]${l.types.length ? ` types=${l.types.join(',')}` : ''}${l.surfaces.length ? ` surfaces=${l.surfaces.join(',')}` : ''}\n     ${l.text}`).join('\n') : 'No lessons yet.');
  if (action === 'add') {
    const agents = csv(flags.agents);
    const r = addLesson(lessons, { text: flags.text, agents: agents.length ? agents : ['all'], types: csv(flags.types), surfaces: csv(flags.surfaces), job });
    saveLessons(r.lessons, renderLessons(r.lessons, cfg));
    return say(r.duplicate ? `That lesson already exists as ${r.lesson.id}; counted it as happening again.` : `Added lesson ${r.lesson.id}.`);
  }
  if (action === 'seen') {
    lessons = markSeen(lessons, id, job).lessons;
    saveLessons(lessons, renderLessons(lessons, cfg));
    const l = lessons.find((x) => x.id === id);
    return say(`Lesson ${id} has now gone wrong ${l.seen} times.${l.seen >= cfg.memory.promoteAfter ? ' Advice is not working: propose a deterministic check for it.' : ''}`);
  }
  if (action === 'remove') {
    if (!lessons.some((l) => l.id === id)) fail(`No lesson ${id}`);
    lessons = lessons.filter((l) => l.id !== id);
    saveLessons(lessons, renderLessons(lessons, cfg));
    return say(`Removed lesson ${id}.`);
  }
  fail(`Usage: lesson add --text "<what to do differently>" [--agents ${LESSON_AGENTS.join(',')}] [--types ${TYPES.join(',')}] [--surfaces <csv>] [--job <job>]
       lesson seen <id> [--job <job>]   |   lesson remove <id>   |   lesson list`);
};

commands.learned = ({ _ }) => {
  const job = loadJob(_[0]);
  if (job.learn !== 'pending') fail(`Job ${job.id} has nothing waiting to be learned (learn=${job.learn}).`);
  job.learn = 'done';
  saveJob(job);
  say(`Recorded: the factory has learned from ${job.id}. Commit factory/memory and factory/LESSONS.md so the lessons are shared.`);
};

commands.help = () => say(`Factory job control. The only writer of factory/jobs/<id>/job.json.

  queue                                   What is running, what is waiting, what to start
  create <issue#> | --title "..."         Start a job from a GitHub issue, or a local job
  intake <job> --decision --type --risk --pain --surfaces --reason
  design-done <job>                       Design is written
  spec-done <job>                         Spec is written; it goes to the spec check
  grill <job> --result <clear|revise|ask> Record the spec check (may stop for answers or plan review)
  gate <job>                              Run the deterministic checks on the build
  verdict <job> <reviewer> <pass|fail>    Record one reviewer's verdict
  approve <job> --decision <merge|escalate> --reason
  approve-human <job>                     A human approved the plan, the recommended answers, or the merge
  feedback <job> "<text>" [--to stage]    Record human guidance and resume a blocked job
  block <job> --reason "..."              Stop and wait for a human
  reject <job> --reason "..."             Drop the job
  usage <job> --stage --model --tokens    Record token usage for cost tracking
  lesson add|seen|remove|list             The factory's memory of its own mistakes
  learned <job>                           The retro for a finished job is done
  pr-preview <job>                        Check pr.md and print the pull request description as it will be posted
  brief <job>                             Print the job's brief: plan, approach, lessons that apply
  next <job> | status [job] | list | stats`);

const [cmd = 'help', ...rest] = process.argv.slice(2);
if (!commands[cmd]) fail(`Unknown command "${cmd}". Run: ${SELF} help`);
try { commands[cmd](parseArgs(rest)); } catch (e) { fail(String(e.stderr || e.message).trim()); }
