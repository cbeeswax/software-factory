import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG, afterReviews, computeStats, decideApproval, globToRegExp, mergeConfig, needsPlanReview,
  parseDiff, route, scanDiff, scanSecrets, slugify,
} from '../factory/lib/core.mjs';

const cfg = DEFAULT_CONFIG;
const noAudit = mergeConfig(cfg, { approval: { auditRate: 0 } });

test('slugify makes short, safe ids', () => {
  assert.equal(slugify('Add Dark Mode!! (v2)'), 'add-dark-mode-v2');
  assert.equal(slugify(''), 'job');
  assert.ok(slugify('x'.repeat(100)).length <= 40);
});

test('globs', () => {
  assert.ok(globToRegExp('**/migrations/**').test('db/migrations/001.sql'));
  assert.ok(globToRegExp('**/migrations/**').test('migrations/001.sql'));
  assert.ok(globToRegExp('factory/**').test('factory/bin/job.mjs'));
  assert.ok(!globToRegExp('factory/**').test('src/factory.js'));
  assert.ok(globToRegExp('**/*.test.*').test('src/a/b.test.ts'));
  assert.ok(!globToRegExp('*.js').test('src/a.js'));
});

test('mergeConfig overrides deeply and replaces arrays', () => {
  const c = mergeConfig(cfg, { concurrency: 5, approval: { escalatePaths: ['x/**'] } });
  assert.equal(c.concurrency, 5);
  assert.deepEqual(c.approval.escalatePaths, ['x/**']);
  assert.equal(c.approval.mergeMethod, 'squash');
});

test('routing: reviewers depend on risk and surfaces', () => {
  const names = (j) => route(j, cfg).map((r) => r.name);
  assert.deepEqual(names({ risk: 'low', surfaces: ['docs'] }), ['code', 'qa']);
  assert.deepEqual(names({ risk: 'low', surfaces: ['ui'] }), ['code', 'qa', 'ux', 'ui']);
  assert.deepEqual(names({ risk: 'medium', surfaces: ['logic'] }), ['code', 'qa', 'security']);
  assert.deepEqual(names({ risk: 'low', surfaces: ['auth'] }), ['code', 'qa', 'security']);
  assert.equal(route({ risk: 'high', surfaces: [] }, cfg)[0].model, 'opus');
  assert.equal(route({ risk: 'low', surfaces: [] }, cfg)[0].model, 'sonnet');
});

test('plan review is required for high pain or high risk', () => {
  assert.equal(needsPlanReview({ risk: 'low', pain: 'low' }, cfg), false);
  assert.equal(needsPlanReview({ risk: 'low', pain: 'high' }, cfg), true);
  assert.equal(needsPlanReview({ risk: 'high', pain: 'low' }, cfg), true);
  assert.equal(needsPlanReview({ risk: 'low', pain: 'low' }, mergeConfig(cfg, { planReview: 'always' })), true);
  assert.equal(needsPlanReview({ risk: 'high', pain: 'high' }, mergeConfig(cfg, { planReview: 'never' })), false);
});

test('afterReviews: waits, passes, reworks, then gives up', () => {
  const reviewers = [{ name: 'code' }, { name: 'qa' }];
  const v = (verdict) => ({ verdict });
  assert.deepEqual(afterReviews({ round: 1, reviewers, verdicts: { 1: { code: v('pass') } } }, cfg).pending, ['qa']);
  assert.equal(afterReviews({ round: 1, reviewers, verdicts: { 1: { code: v('pass'), qa: v('pass') } } }, cfg).stage, 'approve');
  const rework = afterReviews({ round: 1, reviewers, verdicts: { 1: { code: v('fail'), qa: v('pass') } } }, cfg);
  assert.equal(rework.stage, 'build');
  assert.equal(rework.round, 2);
  assert.deepEqual(rework.failed, ['code']);
  assert.equal(afterReviews({ round: 3, reviewers, verdicts: { 3: { code: v('fail'), qa: v('pass') } } }, cfg).stage, 'needs-human');
});

test('approval: the agent can escalate but cannot override the rules', () => {
  const job = { id: 'j1', risk: 'low' };
  assert.equal(decideApproval({ job, recommendation: 'merge', files: ['src/a.js'] }, noAudit).merge, true);
  assert.equal(decideApproval({ job, recommendation: 'escalate', files: ['src/a.js'] }, noAudit).merge, false);
  assert.equal(decideApproval({ job: { id: 'j1', risk: 'high' }, recommendation: 'merge', files: [] }, noAudit).merge, false);
  assert.equal(decideApproval({ job, recommendation: 'merge', files: ['db/migrations/1.sql'] }, noAudit).merge, false);
  assert.equal(decideApproval({ job, recommendation: 'merge', files: ['factory/bin/job.mjs'] }, noAudit).merge, false);
  assert.equal(decideApproval({ job, recommendation: 'merge', files: [] }, mergeConfig(noAudit, { approval: { autoMerge: false } })).merge, false);
});

test('approval: spot-check audit is deterministic and roughly the configured rate', () => {
  const audit = mergeConfig(cfg, { approval: { auditRate: 0.2 } });
  const run = () => Array.from({ length: 500 }, (_, i) => decideApproval({ job: { id: `job-${i}`, risk: 'low' }, recommendation: 'merge', files: [] }, audit).merge);
  const first = run();
  assert.deepEqual(first, run());
  const escalated = first.filter((m) => !m).length / 500;
  assert.ok(escalated > 0.12 && escalated < 0.28, `audit rate was ${escalated}`);
});

// Fake credentials are assembled at runtime so that no scanner flags this file.
const fakeAws = `AKIA${'ABCDEFGHIJKLMNOP'}`;
const fakeGh = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;

test('scanSecrets finds credentials and never returns them', () => {
  const hits = scanSecrets(`const ok = 1;\nconst key = "${fakeAws}";\nconst t = "${fakeGh}";`);
  assert.deepEqual(hits.map((h) => [h.rule, h.line]), [['aws-access-key', 2], ['github-token', 3]]);
  assert.ok(!JSON.stringify(hits).includes(fakeAws));
  assert.equal(scanSecrets(`password = "${'hunter2hunter2hunter2'}"`).length, 1);
});

test('scanSecrets ignores placeholders and environment lookups', () => {
  assert.equal(scanSecrets('api_key = "your-api-key-goes-here"').length, 0);
  assert.equal(scanSecrets('const apiKey = process.env.API_KEY;').length, 0);
  assert.equal(scanSecrets('password: "${DB_PASSWORD_FROM_ENV}"').length, 0);
});

const diffOf = (path, lines, { isNew = false } = {}) => [
  `diff --git a/${path} b/${path}`,
  ...(isNew ? ['new file mode 100644'] : []),
  `--- ${isNew ? '/dev/null' : `a/${path}`}`,
  `+++ b/${path}`,
  `@@ -${isNew ? '0,0' : '1,1'} +1,${lines.length} @@`,
  ...lines.map((l) => `+${l}`),
].join('\n');

test('parseDiff reads files, line numbers and new-file status', () => {
  const [f] = parseDiff(diffOf('src/a.js', ['one', 'two'], { isNew: true }));
  assert.equal(f.path, 'src/a.js');
  assert.equal(f.isNew, true);
  assert.deepEqual(f.added, [{ n: 1, text: 'one' }, { n: 2, text: 'two' }]);
});

test('parseDiff is not fooled by added lines that look like headers', () => {
  const [f] = parseDiff(diffOf('a.md', ['++ not a header', '-- nor this']));
  assert.equal(f.added.length, 2);
});

test('slop gate: suppressions, skipped tests and secrets block', () => {
  const suppress = ['// es', 'lint-disable-next-line'].join('');
  const skip = ['it', '.skip("later", () => {})'].join('');
  const r = scanDiff([diffOf('src/a.js', [suppress, 'const x = 1;']), diffOf('src/a.test.js', [skip]), diffOf('src/c.js', [`const k = "${fakeAws}";`])].join('\n'), '', cfg);
  assert.deepEqual(r.findings.map((f) => f.rule).sort(), ['aws-access-key', 'lint-suppression', 'skipped-test']);
  assert.equal(r.blocking, true);
  assert.equal(r.findings.find((f) => f.rule === 'lint-suppression').line, 1);
});

test('slop gate: clean diffs pass', () => {
  const r = scanDiff(diffOf('src/a.js', ['export const add = (a, b) => a + b;']), 'M\tsrc/a.js', cfg);
  assert.equal(r.blocking, false);
  assert.deepEqual(r.stats, { files: 1, added: 1, removed: 0 });
});

test('slop gate: deleted tests, oversized files and oversized diffs', () => {
  assert.equal(scanDiff('', 'D\tsrc/a.test.js\nD\tsrc/old.js', cfg).findings[0].rule, 'deleted-test-file');
  const big = Array.from({ length: 600 }, (_, i) => `const v${i} = ${i};`);
  assert.ok(scanDiff(diffOf('src/big.js', big, { isNew: true }), '', cfg).findings.some((f) => f.rule === 'oversized-new-file'));
  const huge = Array.from({ length: 900 }, (_, i) => `line ${i}`);
  assert.ok(scanDiff(diffOf('src/huge.js', huge), '', cfg).findings.some((f) => f.rule === 'diff-too-large'));
  assert.ok(!scanDiff(diffOf('package-lock.json', huge), '', cfg).findings.length, 'generated files do not count');
});

test('slop gate: warn mode reports without blocking, but secrets always block', () => {
  const warn = mergeConfig(cfg, { slop: { mode: 'warn' } });
  const suppress = ['// @ts', '-ignore'].join('');
  assert.equal(scanDiff(diffOf('a.ts', [suppress]), '', warn).blocking, false);
  assert.equal(scanDiff(diffOf('a.ts', [`const k = "${fakeAws}";`]), '', warn).blocking, true);
});

test('computeStats summarises jobs for a retro', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const s = computeStats([
    { stage: 'merged', mergedBy: 'factory', round: 2, gateFailures: 1, verdicts: { 1: { code: { verdict: 'fail' }, qa: { verdict: 'pass' } } }, history: [{ stage: 'intake', at }, { stage: 'merged', at }] },
    { stage: 'needs-human', round: 1, gateFailures: 0, verdicts: {}, history: [{ stage: 'intake', at }, { stage: 'needs-human', at, note: 'Risk is high' }] },
  ]);
  assert.equal(s.merged, 1);
  assert.equal(s.autoMerged, 1);
  assert.equal(s.reworkRounds, 1);
  assert.deepEqual(s.reviewerFails, { code: 1 });
  assert.deepEqual(s.blockedReasons, { 'Risk is high': 1 });
});
