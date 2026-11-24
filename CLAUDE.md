# Software factory

This repository is the factory itself: a Claude Code skill, a set of subagents, and a small Node program that moves jobs through a fixed pipeline. It is installed into other projects with `node install.mjs <project>`, and it can also run on itself.

## Layout

- `.claude/skills/factory/SKILL.md`: the orchestrator. Read this first to understand the flow.
- `.claude/agents/factory-*.md`: one agent per stage.
- `factory/lib/core.mjs`: every decision the factory makes (routing, review outcomes, approval rules, the slop and secrets scan). Pure functions, no I/O.
- `factory/lib/env.mjs`, `factory/lib/checks.mjs`: git, GitHub, the filesystem and shell commands.
- `factory/bin/job.mjs`: the job state machine and the only writer of `job.json`.
- `factory/bin/collect.mjs`, `guard.mjs`, `checks.mjs`, `factory/dashboard/`: the collector, the secret-blocking hook, the checks runner, the dashboard.
- `test/`: `core.test.mjs` for the pure logic, `job.test.mjs` for the lifecycle against real throwaway git repositories.

## Working here

- Run `npm test` before finishing. It needs only Node 20+ and git; there are no dependencies, and adding one needs a strong reason.
- A decision belongs in `core.mjs` with a test, not in an agent's instructions. Agents recommend; code decides.
- Agents never write job state. If a change makes an agent edit `job.json`, the design is wrong.
- Scripts must work on Windows, macOS and Linux: use `execFileSync` with argument arrays, never string-built shell commands, except for user-configured check commands.
- Test fixtures that look like credentials are assembled at runtime from pieces, so secret scanners (including this factory's own) do not flag the repository.

## Software factory

- `/factory run` processes open GitHub issues labelled `factory`. `/factory <description>` builds one feature without an issue.
- `node factory/bin/job.mjs` is the only writer of job state. Never edit `factory/jobs/*/job.json`.
- Changes under `factory/` and `.claude/` always go to a human for approval, even when the factory builds them.
