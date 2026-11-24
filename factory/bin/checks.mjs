#!/usr/bin/env node
// Runs the same checks the gate runs, in any directory. The builder uses this before handing off.
//   node factory/bin/checks.mjs [dir]
import { resolve } from 'node:path';
import { loadConfig } from '../lib/env.mjs';
import { runChecks, tail } from '../lib/checks.mjs';

const dir = resolve(process.argv[2] || process.cwd());
const { results, pass, none } = runChecks(dir, loadConfig());
if (none) console.log('WARNING: no checks configured or detected. Add `checks` to factory/factory.config.json.');
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.cmd}  (${Math.round(r.ms / 1000)}s)`);
  if (!r.pass) console.log(`${tail(r.out, 80)}\n`);
}
process.exit(pass ? 0 : 1);
