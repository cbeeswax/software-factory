#!/usr/bin/env node
// A read-only local dashboard over factory/jobs. It never changes job state.
//   node factory/dashboard/server.mjs [port]
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageDurations, usageTotals, computeStats } from '../lib/core.mjs';
import { jobDir, jobFiles, listJobs, loadConfig } from '../lib/env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const port = Number(process.argv[2]) || cfg.dashboard.port;

function state() {
  const jobs = listJobs();
  return {
    concurrency: cfg.concurrency,
    stats: computeStats(jobs),
    jobs: jobs.map((j) => ({ ...j, files: jobFiles(j.id), durations: stageDurations(j), totals: usageTotals(j, cfg.pricing) })),
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(body); };
  try {
    if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', readFileSync(join(here, 'index.html')));
    if (url.pathname === '/api/state') return send(200, 'application/json', JSON.stringify(state()));
    if (url.pathname === '/api/file') {
      const id = url.searchParams.get('job');
      const name = url.searchParams.get('name');
      // Only files that the listing itself reports: no path can escape the job directory.
      if (!listJobs().some((j) => j.id === id) || !jobFiles(id).includes(name)) return send(404, 'text/plain', 'Not found');
      const file = join(jobDir(id), name);
      return send(existsSync(file) ? 200 : 404, 'text/plain; charset=utf-8', existsSync(file) ? readFileSync(file) : 'Not found');
    }
    send(404, 'text/plain', 'Not found');
  } catch (e) {
    send(500, 'text/plain', String(e.message));
  }
});

server.listen(port, '127.0.0.1', () => console.log(`Factory dashboard: http://127.0.0.1:${port}`));
