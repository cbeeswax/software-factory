# Software Factory

An agentic software factory for Claude Code. GitHub issues go in; reviewed pull requests come out. A team of specialist agents does the work, a small deterministic program decides what happens next, and a human is asked only when the stakes call for it.

```
 FORWARD PRESSURE                         THE LINE                                      BACK PRESSURE
 what starts work                                                                       what stops bad work

 GitHub issues ─┐
 Sentry errors ─┤            ┌────────┐  ┌──────┐  ┌───────┐  ┌──────┐  ┌─────────┐  ┌─────────┐
 Inbox notes   ─┼─▶ issue ─▶ │ intake │─▶│ spec │─▶│ build │─▶│ GATE │─▶│ reviews │─▶│ approve │─▶ merge
 Any command   ─┘            └────────┘  └──────┘  └───────┘  └──────┘  └─────────┘  └─────────┘
                              reject or     │          ▲          │          │            │
                              ask a human   ▼          └──────────┴──────────┘            ▼
                                       human reviews      fails go back to           human approves when
                                       the plan when      the builder                risk, protected paths
                                       it is hard to                                 or a spot-check say so
                                       reverse
```

## What it does

1. **Intake.** An agent reads the issue against the codebase, decides whether it is worth building, narrows the scope, and rates the risk. The rating decides how much review the job gets.
2. **Spec.** An agent writes acceptance criteria and a task plan. If the work fixes something hard to change later (a schema, a public API), a human approves the plan before any code is written.
3. **Build.** An agent implements the spec test-first in its own git worktree, so several jobs run in parallel without touching each other or your checkout.
4. **Gate.** No agent involved. A script runs your real checks (lint, types, tests, build) and scans the diff for committed credentials, suppressed lint rules, skipped or deleted tests, oversized files and oversized diffs. A failing build goes straight back to the builder and never reaches a reviewer.
5. **Reviews.** Code and QA reviewers always run. Security joins for medium and high risk or sensitive areas; UX and UI join when the job touches the interface. They run in parallel. Any failure sends the job back to the builder for another round, up to a limit.
6. **Approve.** An agent recommends merge or escalate. Then rules it cannot override apply: high risk, protected paths, and a random spot-check all force a human review.
7. **Merge.** The pull request is merged, the worktree is removed, and the issue is closed with the full history in its comments.

After that, `/factory collect` turns production errors and inbox notes into new issues, and `/factory retro` studies finished jobs and records what the factory should do differently. That is the loop that lets it improve.

## Requirements

- [Claude Code](https://claude.com/claude-code)
- Node.js 20 or newer, and git 2.38 or newer
- The GitHub CLI, `gh`, logged in (only needed for issue and pull request features)
- Recommended: the [agent-skills](https://github.com/addyosmani/agent-skills) plugin. The stage agents use its skills (spec-driven development, test-driven development, code review, security hardening, accessibility) when they are installed, and fall back to built-in instructions when they are not.

There are no npm dependencies.

## Install it into a project

```bash
git clone https://github.com/cbeeswax/software-factory.git
node software-factory/install.mjs /path/to/your/project
```

This copies the skill, the agents and the `factory/` folder into your project, adds a section to your `CLAUDE.md`, adds the ignore rules, registers a hook that blocks credentials from being written, and creates the `factory` and `factory:triage` labels on GitHub. Run it again to upgrade; it never overwrites your config or lessons.

Then:

1. Open `factory/factory.config.json` and set `checks` to the commands that prove a build is good:
   ```json
   "checks": [
     { "name": "lint", "cmd": "npm run lint" },
     { "name": "types", "cmd": "npm run typecheck" },
     { "name": "test", "cmd": "npm test" },
     { "name": "build", "cmd": "npm run build" }
   ]
   ```
2. Commit the new files.
3. Add the `factory` label to an issue. Only labelled issues are ever picked up.
4. Start Claude Code in the project and type `/factory run`.

## Using it

| Command | What happens |
|---|---|
| `/factory run` | Processes every open issue labelled `factory`, three at a time by default. |
| `/factory run 12` | Processes only issue 12. |
| `/factory add a copy button to code blocks` | Builds one feature from your description, with no GitHub issue. Merges locally. |
| `/factory status` | Shows every job and its stage. |
| `/factory approve 12` | You approve a plan, or a merge, that was waiting on you. |
| `/factory 12: use a separate table instead` | Your feedback is recorded and the job resumes. |
| `/factory collect` | Files new issues from the configured sources. |
| `/factory retro` | Studies finished jobs, updates `factory/LESSONS.md`, proposes factory changes. |
| `/factory dashboard` | Opens the live board at http://127.0.0.1:4317. |

The session where you type `/factory run` is the orchestrator. If it dies, type `/factory run` again: job state is on disk, and each job resumes from its current stage. Work an agent had in flight at that moment is redone.

To keep it running unattended, combine it with Claude Code's own scheduling, for example `/loop 30m /factory run`.

## What makes this more than a prompt

**Code decides, agents recommend.** `factory/bin/job.mjs` is the only thing that writes job state. An agent cannot move a job forward by saying it is done: the spec file has to exist, the gate has to pass, each reviewer's written findings have to exist before its verdict is accepted, and commands run out of order are refused.

**A gate agents cannot talk their way past.** The cheapest way for an agent to get a green build is to lower the bar. The gate fails the build for a new `eslint-disable`, `@ts-ignore`, `# noqa`, `.skip(`, `.only(`, a deleted test file, a credential, uncommitted files, a merge conflict with the base branch, a new file over 500 lines, or a diff over 800 lines. All of it is configurable under `slop` in the config.

**Review matched to risk.** A copy change gets two reviewers on a faster model. An authentication change gets a security reviewer and the strongest model. The routing is one function in `factory/lib/core.mjs`.

**Humans where judgement matters.** A human is asked at three points, each for a reason:

- before building, when the plan includes a decision that is expensive to reverse;
- before merging, when the job is high risk, touches protected paths (`migrations`, `billing`, `auth`, `.github`, and the factory itself), or the approver agent is unsure;
- at random, for one in five jobs that would otherwise auto-merge, so that you keep reading a sample of what ships. Set `approval.auditRate` to change this, or `approval.autoMerge` to `false` to approve everything yourself.

**Everything is written down.** Each job keeps its issue, intake, spec, build notes, gate results, every review, the approval decision and your feedback as Markdown in `factory/jobs/<id>/`, and posts its progress as comments on the GitHub issue. The pull request says plainly that agents wrote it and points at what a human should look at.

## Configuration

Everything is in `factory/factory.config.json`.

| Setting | Default | Meaning |
|---|---|---|
| `label` | `factory` | Issues with this label are picked up. |
| `concurrency` | `3` | Jobs running at once. Jobs waiting on a human do not count. |
| `maxRounds` | `3` | Review rounds before a job is handed to a human. |
| `maxGateFailures` | `5` | Failed gates before a job is handed to a human. |
| `planReview` | `high-pain` | When a human approves the plan: `high-pain`, `always` or `never`. |
| `checks` | auto-detected | Commands the gate runs in the job's worktree. |
| `setup` | auto-detected | Commands that prepare a fresh worktree, such as `npm ci`. |
| `models` | see file | Model per stage, and per risk level for reviewers. |
| `approval.autoMerge` | `true` | Allow merges with no human. |
| `approval.auditRate` | `0.2` | Share of auto-mergeable jobs sent to a human anyway. |
| `approval.escalateRisk` | `["high"]` | Risk levels that always need a human. |
| `approval.escalatePaths` | see file | Paths that always need a human. |
| `slop.mode` | `fail` | `fail` blocks on slop findings; `warn` only reports them. Credentials always block. |
| `collect.sources` | inbox | Where new work comes from (below). |
| `pricing` | `{}` | Dollars per million tokens by model name, to show cost estimates on the dashboard. |

### Sources of work

```json
"collect": {
  "label": "factory:triage",
  "autoQueue": false,
  "sources": [
    { "type": "sentry", "org": "acme", "project": "web", "minEvents": 5 },
    { "type": "inbox", "dir": "factory/inbox" },
    { "type": "command", "name": "posthog", "cmd": "node scripts/posthog-errors.mjs" }
  ]
}
```

- **sentry** reads unresolved issues from the Sentry API. Set `SENTRY_AUTH_TOKEN` in your environment.
- **inbox** turns each Markdown file in a folder into an issue.
- **command** runs anything that prints a JSON array of `{ "key", "title", "body" }`. Use it for PostHog, support tickets, a metrics threshold, or any other system.

Collected issues are labelled `factory:triage`, not `factory`, so a person chooses what gets built. Each one carries a `Factory-Source:` line that stops the same problem being filed twice. Set `autoQueue` to `true` only when you trust a source enough to let it start work on its own.

## Where the design comes from

This project implements the ideas in four talks, and says so where it follows one:

| Idea | Source | Where it lives |
|---|---|---|
| A skill as orchestrator, subagents per stage, Markdown job files, a dashboard, worktrees for parallel jobs | ZazenCodes, [Build Your Own AI Software Factory with Claude Code](https://www.youtube.com/watch?v=ctoaIC4LHmI) | `.claude/skills/factory`, `.claude/agents`, `factory/dashboard` |
| Issues in and pull requests out, an intake stage, a deterministic spine, a gate before review, routing by risk, concurrency, time and cost per job, resuming after a crash | ZazenCodes, [Build a Better Software Factory with Claude Code](https://www.youtube.com/watch?v=RiaTyJ2POVo) | `factory/bin/job.mjs`, `factory/lib/core.mjs` |
| Collecting work from telemetry, a QA specialist, a "should this code exist" check before building, progress logged on the issue, hooks that block secrets | Eric Tech, [I Built a Self-Improving Software Factory](https://www.youtube.com/watch?v=aggJvNZxfKA) | `factory/bin/collect.mjs`, `factory-reviewer-qa`, `factory-builder`, `factory/bin/guard.mjs` |
| Forward and back pressure, planning in proportion to the cost of being wrong, fighting slop with deterministic rules, learning from past sessions, keeping decisions in one place, humans reviewing a subset chosen by stakes | Dex Horthy, [12 Rules for a Software Factory That Doesn't Ship Slop](https://www.youtube.com/watch?v=-NFMsM2y0Vk) | the slop gate, plan review, `approval.auditRate`, `factory/LESSONS.md`, `factory-retro` |

## Before you trust it with production

- **Start with `autoMerge` off**, or on a repository where a bad merge is cheap, and read what it produces. Turn automation up as it earns it.
- **The gate is only as good as your checks.** With weak tests, the factory will ship code that passes weak tests.
- **Issue text is untrusted input.** Agents are told to treat it as a request and not as instructions, and only issues you label are processed, but do not label an issue you have not read on a public repository.
- **It costs tokens.** A job runs six to nine agents, more if it needs rework. `job.mjs status <job>` shows the time per stage and the tokens recorded.
- **Job files are local.** `factory/jobs/` is not committed. The durable record is the issue comments and the pull request.
- **Not yet exercised against live services:** the Sentry source was written from Sentry's API documentation and has not been run against a real account.

## Development

```bash
npm test
```

`test/core.test.mjs` covers the decision logic. `test/job.test.mjs` runs whole job lifecycles against throwaway git repositories with GitHub turned off.
