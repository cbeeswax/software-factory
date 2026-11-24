// End-to-end tests of the job lifecycle against a real throwaway git repository, with GitHub off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const JOB = resolve(dirname(fileURLToPath(import.meta.url)), '../factory/bin/job.mjs');

function makeRepo(config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-test-'));
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'factory@example.invalid');
  g('config', 'user.name', 'Factory Test');
  g('config', 'commit.gpgsign', 'false');
  g('config', 'core.autocrlf', 'false');
  writeFileSync(join(root, 'README.md'), '# demo\n');
  writeFileSync(join(root, '.gitignore'), 'factory/jobs/\n.factory/\n');
  mkdirSync(join(root, 'factory'), { recursive: true });
  writeFileSync(join(root, 'factory', 'factory.config.json'), JSON.stringify({
    checks: [{ name: 'check', cmd: 'node check.js' }],
    approval: { auditRate: 0 },
    ...config,
  }));
  writeFileSync(join(root, 'check.js'), 'process.exit(require("fs").existsSync("BROKEN") ? 1 : 0);\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  const job = (...args) => {
    const r = spawnSync(process.execPath, [JOB, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root, FACTORY_NO_GH: '1' } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const state = (id) => JSON.parse(readFileSync(join(root, 'factory', 'jobs', id, 'job.json'), 'utf8'));
  const jobFile = (id, name, text) => writeFileSync(join(root, 'factory', 'jobs', id, name), text);
  const commit = (id, file, text, msg = 'work') => {
    const wt = state(id).worktree;
    writeFileSync(join(wt, file), text);
    execFileSync('git', ['add', '-A'], { cwd: wt });
    execFileSync('git', ['commit', '-q', '-m', msg], { cwd: wt });
  };
  return { root, g, job, state, jobFile, commit, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5 }) };
}

function toBuild(r, title, intake = ['--risk', 'low', '--surfaces', 'logic'], type = 'chore') {
  assert.equal(r.job('create', '--title', title, '--no-setup').code, 0);
  const id = JSON.parse(r.job('list', '--json').out).at(-1).id;
  assert.equal(r.job('intake', id, '--decision', 'accept', '--type', type, ...intake, '--reason', 'fine').code, 0);
  if (r.state(id).stage === 'design') { r.jobFile(id, 'design.md', '# Design\n'); assert.equal(r.job('design-done', id).code, 0); }
  r.jobFile(id, 'spec.md', '# Spec\n');
  return id;
}

// The spec is written; pass the spec check so the job moves on.
function specDone(r, id, result = 'clear') {
  let out = { out: '' };
  if (r.state(id).stage === 'spec') { out = r.job('spec-done', id); assert.equal(out.code, 0); }
  if (r.state(id).stage !== 'grill') return out;
  r.jobFile(id, `grill-${r.state(id).specRound}.md`, 'checked\n');
  return r.job('grill', id, '--result', result, '--summary', 'checked');
}

function passAllReviews(r, id) {
  const { round, reviewers } = r.state(id);
  for (const rv of reviewers) {
    r.jobFile(id, `review-${round}-${rv.name}.md`, 'ok\n');
    assert.equal(r.job('verdict', id, rv.name, 'pass', '--summary', 'ok').code, 0);
  }
}

test('happy path: a low-risk local job is built, gated, reviewed and auto-merged', () => {
  const r = makeRepo();
  try {
    const id = toBuild(r, 'Add hello file');
    assert.match(id, /^L1-add-hello-file$/);
    assert.deepEqual(r.state(id).reviewers.map((x) => x.name), ['code', 'qa']);
    assert.equal(r.job('spec-done', id).code, 0);
    assert.equal(r.state(id).stage, 'build', 'a chore skips the design stage and the spec check');
    assert.equal(r.state(id).learn ?? null, null);

    r.commit(id, 'hello.txt', 'hello\n');
    const gate = r.job('gate', id);
    assert.match(gate.out, /Gate PASSED/);
    assert.equal(r.state(id).stage, 'review');

    passAllReviews(r, id);
    assert.equal(r.state(id).stage, 'approve');
    const done = r.job('approve', id, '--decision', 'merge', '--reason', 'clean');
    assert.match(done.out, /Merged \(factory\)/);
    const s = r.state(id);
    assert.equal(s.stage, 'merged');
    assert.equal(s.mergedBy, 'factory');
    assert.equal(s.learn, 'none', 'a job with no mistakes has nothing to learn');
    assert.equal(readFileSync(join(r.root, 'hello.txt'), 'utf8'), 'hello\n');
    assert.equal(existsSync(s.worktree), false, 'worktree is removed after merge');
    assert.deepEqual(s.history.map((h) => h.stage), ['intake', 'spec', 'build', 'gate', 'review', 'approve', 'merged']);
  } finally { r.cleanup(); }
});

test('the gate sends failing builds back, and blocks after too many failures', () => {
  const r = makeRepo({ maxGateFailures: 1 });
  try {
    const id = toBuild(r, 'Break things');
    specDone(r, id);
    assert.match(r.job('gate', id).out, /Gate FAILED/, 'no commits yet');
    assert.equal(r.state(id).stage, 'build');
    assert.match(readFileSync(join(r.root, 'factory', 'jobs', id, 'gate-1.md'), 'utf8'), /No commits/);

    r.commit(id, 'BROKEN', 'x\n');
    const second = r.job('gate', id);
    assert.match(second.out, /too many times/);
    assert.equal(r.state(id).stage, 'needs-human');
    assert.match(readFileSync(join(r.root, 'factory', 'jobs', id, 'gate-1.md'), 'utf8'), /node check\.js` failed/);
  } finally { r.cleanup(); }
});

test('the gate rejects uncommitted work and lowered quality bars', () => {
  const r = makeRepo();
  try {
    const id = toBuild(r, 'Sneaky build');
    specDone(r, id);
    r.commit(id, 'a.js', 'export const a = 1;\n');
    writeFileSync(join(r.state(id).worktree, 'stray.txt'), 'left behind\n');
    r.job('gate', id);
    assert.match(readFileSync(join(r.root, 'factory', 'jobs', id, 'gate-1.md'), 'utf8'), /Uncommitted changes/);

    r.commit(id, 'a.test.js', `${['it', '.skip("todo", () => {});'].join('')}\n`);
    r.job('gate', id);
    assert.match(readFileSync(join(r.root, 'factory', 'jobs', id, 'gate-1.md'), 'utf8'), /BLOCKING `skipped-test` in a\.test\.js:1/);
    assert.equal(r.state(id).stage, 'build');
  } finally { r.cleanup(); }
});

test('a failed review sends the job back for another round', () => {
  const r = makeRepo();
  try {
    const id = toBuild(r, 'Needs rework');
    specDone(r, id);
    r.commit(id, 'a.txt', 'v1\n');
    r.job('gate', id);
    r.jobFile(id, 'review-1-code.md', 'unclear naming\n');
    r.jobFile(id, 'review-1-qa.md', 'ok\n');
    assert.match(r.job('verdict', id, 'code', 'fail').out, /Waiting on: qa/);
    assert.match(r.job('verdict', id, 'qa', 'pass').out, /Review failed \(code\)/);
    assert.equal(r.state(id).stage, 'build');
    assert.equal(r.state(id).round, 2);

    r.commit(id, 'a.txt', 'v2\n');
    r.job('gate', id);
    passAllReviews(r, id);
    assert.equal(r.state(id).stage, 'approve');
  } finally { r.cleanup(); }
});

test('a verdict is refused without the reviewer\'s written findings', () => {
  const r = makeRepo();
  try {
    const id = toBuild(r, 'No findings');
    specDone(r, id);
    r.commit(id, 'a.txt', 'v1\n');
    r.job('gate', id);
    const out = r.job('verdict', id, 'code', 'pass');
    assert.equal(out.code, 1);
    assert.match(out.out, /review-1-code\.md is missing/);
  } finally { r.cleanup(); }
});

test('high-pain work stops for human plan review before any code is written', () => {
  const r = makeRepo();
  try {
    const id = toBuild(r, 'Change the schema', ['--risk', 'medium', '--pain', 'high', '--surfaces', 'data'], 'feature');
    assert.deepEqual(r.state(id).reviewers.map((x) => x.name), ['code', 'qa', 'security', 'privacy', 'architecture']);
    assert.match(specDone(r, id).out, /Waiting for a human to approve the plan/);
    assert.equal(r.state(id).stage, 'needs-human');
    assert.equal(r.state(id).waitingFor, 'plan');

    assert.equal(r.job('feedback', id, 'use', 'a', 'separate', 'table').code, 0);
    assert.equal(r.state(id).stage, 'spec', 'feedback sends the plan back to the spec agent');
    specDone(r, id);
    assert.equal(r.job('approve-human', id).code, 0);
    assert.equal(r.state(id).stage, 'build');
  } finally { r.cleanup(); }
});

test('protected paths escalate to a human, who can then approve the merge', () => {
  const r = makeRepo({ approval: { auditRate: 0, escalatePaths: ['**/billing/**'] } });
  try {
    const id = toBuild(r, 'Touch billing');
    specDone(r, id);
    mkdirSync(join(r.state(id).worktree, 'billing'));
    r.commit(id, 'billing/price.txt', '10\n');
    r.job('gate', id);
    passAllReviews(r, id);
    const out = r.job('approve', id, '--decision', 'merge', '--reason', 'looks fine');
    assert.match(out.out, /Escalated to a human/);
    assert.match(r.state(id).blockedReason, /Touches protected paths: billing\/price\.txt/);
    assert.equal(existsSync(join(r.root, 'billing', 'price.txt')), false, 'nothing merged yet');

    assert.match(r.job('approve-human', id).out, /Merged \(human\)/);
    assert.equal(r.state(id).mergedBy, 'human');
    assert.equal(existsSync(join(r.root, 'billing', 'price.txt')), true);
  } finally { r.cleanup(); }
});

test('commands refuse to run out of order', () => {
  const r = makeRepo();
  try {
    const id = toBuild(r, 'Out of order');
    const out = r.job('approve', id, '--decision', 'merge');
    assert.equal(out.code, 1);
    assert.match(out.out, /is in "spec", but this command needs: approve/);
    assert.equal(r.job('intake', id, '--decision', 'accept', '--risk', 'low').code, 1);
  } finally { r.cleanup(); }
});

test('intake can reject, and the queue reports free slots', () => {
  const r = makeRepo({ concurrency: 2 });
  try {
    r.job('create', '--title', 'Bad idea', '--no-setup');
    const id = JSON.parse(r.job('list', '--json').out)[0].id;
    assert.equal(JSON.parse(r.job('queue').out).freeSlots, 1);
    r.job('intake', id, '--decision', 'reject', '--reason', 'out of scope');
    assert.equal(r.state(id).stage, 'rejected');
    assert.equal(existsSync(r.state(id).worktree), false);
    assert.equal(JSON.parse(r.job('queue').out).freeSlots, 2);
  } finally { r.cleanup(); }
});

test('spec check: gaps go back to the spec writer, then to a human when they persist', () => {
  const r = makeRepo();
  try {
    const id = toBuild(r, 'Vague feature', undefined, 'feature');
    assert.equal(r.job('grill', id, '--result', 'clear').code, 1, 'cannot grill before the spec is written');
    r.job('spec-done', id);
    assert.match(r.job('grill', id, '--result', 'revise').out, /grill-1\.md is missing/);

    assert.match(specDone(r, id, 'revise').out, /gaps the spec writer can close/);
    assert.equal(r.state(id).stage, 'spec');
    assert.equal(r.state(id).specRound, 2);

    assert.match(specDone(r, id, 'revise').out, /questions for a human/, 'second failed check stops the loop');
    assert.equal(r.state(id).stage, 'needs-human');
    assert.equal(r.state(id).waitingFor, 'answers');
    assert.match(r.state(id).blockedReason, /still has gaps after 2 attempts/);
  } finally { r.cleanup(); }
});

test('spec check: a human can answer the questions or accept the recommendations', () => {
  const r = makeRepo();
  try {
    const id = toBuild(r, 'Needs a decision', undefined, 'feature');
    assert.match(specDone(r, id, 'ask').out, /questions for a human/);
    assert.equal(r.state(id).waitingFor, 'answers');

    assert.match(r.job('approve-human', id).out, /Recommended answers accepted/);
    assert.equal(r.state(id).stage, 'spec');
    assert.equal(r.state(id).specRound, 2);
    assert.match(readFileSync(join(r.root, 'factory', 'jobs', id, 'feedback-1.md'), 'utf8'), /accepted every recommended answer in grill-1\.md/);

    assert.match(specDone(r, id, 'ask').out, /questions for a human/);
    r.job('feedback', id, '1:', 'option', 'B');
    assert.equal(r.state(id).stage, 'spec');
    assert.equal(r.state(id).specRound, 3);
    assert.match(specDone(r, id).out, /Spec check passed/);
    assert.equal(r.state(id).stage, 'build');
  } finally { r.cleanup(); }
});

test('the spec check can be turned off', () => {
  const r = makeRepo({ specReview: false });
  try {
    const id = toBuild(r, 'No check', undefined, 'feature');
    r.job('spec-done', id);
    assert.equal(r.state(id).stage, 'build');
  } finally { r.cleanup(); }
});

test('high-risk personal-data work gets privacy and doubt reviewers', () => {
  const r = makeRepo();
  try {
    const id = toBuild(r, 'Export user emails', ['--risk', 'high', '--surfaces', 'pii,api'], 'feature');
    assert.deepEqual(r.state(id).reviewers.map((x) => x.name), ['code', 'qa', 'security', 'privacy', 'doubt', 'architecture']);
    assert.ok(r.state(id).reviewers.every((x) => x.model === 'opus'));
  } finally { r.cleanup(); }
});

test('the Copilot agent copies are in sync with the Claude agents', () => {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), '../factory/bin/sync-agents.mjs');
  const out = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
});

test('the kind of job decides the pipeline: a risky feature is designed first, a bug is not', () => {
  const r = makeRepo();
  try {
    r.job('create', '--title', 'Add teams', '--no-setup');
    const feature = JSON.parse(r.job('list', '--json').out).at(-1).id;
    assert.equal(r.job('intake', feature, '--decision', 'accept', '--risk', 'low').code, 1, 'a type is required');
    r.job('intake', feature, '--decision', 'accept', '--type', 'feature', '--risk', 'medium', '--surfaces', 'api', '--reason', 'ok');
    assert.equal(r.state(feature).stage, 'design');
    assert.equal(r.job('design-done', feature).code, 1, 'design.md must exist');
    r.jobFile(feature, 'design.md', '# Design\n');
    assert.equal(r.job('design-done', feature).code, 0);
    assert.equal(r.state(feature).stage, 'spec');

    r.job('create', '--title', 'Fix crash on empty list', '--no-setup');
    const bug = JSON.parse(r.job('list', '--json').out).at(-1).id;
    r.job('intake', bug, '--decision', 'accept', '--type', 'bug', '--risk', 'medium', '--surfaces', 'logic', '--reason', 'ok');
    assert.equal(r.state(bug).stage, 'spec', 'bugs skip design');
    const brief = readFileSync(join(r.root, 'factory', 'jobs', bug, 'brief.md'), 'utf8');
    assert.match(brief, /Kind of job:\*\* bug/);
    assert.match(brief, /Reproduce it first/);
    assert.match(brief, /debugging-and-error-recovery/);
  } finally { r.cleanup(); }
});

test('a spike is never merged without a human', () => {
  const r = makeRepo();
  try {
    const id = toBuild(r, 'Try a new parser', undefined, 'spike');
    specDone(r, id);
    r.commit(id, 'spike.txt', 'notes\n');
    r.job('gate', id);
    passAllReviews(r, id);
    assert.match(r.job('approve', id, '--decision', 'merge', '--reason', 'works').out, /Escalated to a human/);
    assert.match(r.state(id).blockedReason, /A spike is never merged without a human/);
  } finally { r.cleanup(); }
});

test('memory: mistakes are recorded, a lesson is learned, and the next job is briefed with it', () => {
  const r = makeRepo();
  try {
    const first = toBuild(r, 'First job');
    specDone(r, first);
    r.job('gate', first);
    r.commit(first, 'a.txt', 'v1\n');
    r.job('gate', first);
    r.jobFile(first, 'review-1-code.md', 'duplicated a helper\n');
    r.jobFile(first, 'review-1-qa.md', 'ok\n');
    r.job('verdict', first, 'code', 'fail', '--summary', 'duplicated the date helper');
    r.job('verdict', first, 'qa', 'pass');
    r.commit(first, 'a.txt', 'v2\n');
    r.job('gate', first);
    passAllReviews(r, first);
    const merged = r.job('approve', first, '--decision', 'merge', '--reason', 'ok');
    assert.match(merged.out, /made 2 mistake\(s\) along the way/);
    assert.match(merged.out, /factory-retro/);
    const s = r.state(first);
    assert.deepEqual(s.mistakes.map((m) => m.kind), ['gate-failure', 'review-fail:code']);
    assert.equal(s.learn, 'pending');
    assert.equal(JSON.parse(r.job('queue').out).toLearn[0].id, first);

    assert.match(r.job('lesson', 'add', '--job', first, '--agents', 'builder', '--surfaces', 'logic', '--text', 'Dates are formatted with formatDate in src/lib/format.js; do not add another formatter.').out, /Added lesson L1/);
    assert.equal(r.job('lesson', 'add', '--text', 'too short').code, 1);
    assert.equal(r.job('lesson', 'add', '--agents', 'nobody', '--text', 'A perfectly long lesson about something.').code, 1);
    assert.equal(r.job('learned', first).code, 0);
    assert.equal(r.state(first).learn, 'done');
    assert.match(readFileSync(join(r.root, 'factory', 'LESSONS.md'), 'utf8'), /formatDate/);

    const second = toBuild(r, 'Second job');
    assert.match(readFileSync(join(r.root, 'factory', 'jobs', second, 'brief.md'), 'utf8'), /\*\*Builder\*\*\n- Dates are formatted with formatDate/);

    const other = toBuild(r, 'Docs only job', ['--risk', 'low', '--surfaces', 'docs']);
    assert.doesNotMatch(readFileSync(join(r.root, 'factory', 'jobs', other, 'brief.md'), 'utf8'), /formatDate/, 'lessons are only shown where they apply');

    r.job('lesson', 'seen', 'L1', '--job', second);
    assert.match(r.job('lesson', 'seen', 'L1').out, /gone wrong 3 times\. Advice is not working/);
    assert.equal(JSON.parse(r.job('stats').out).lessonsToPromote[0].id, 'L1');
    assert.match(readFileSync(join(r.root, 'factory', 'LESSONS.md'), 'utf8'), /Keeps happening: turn these into checks/);
  } finally { r.cleanup(); }
});
