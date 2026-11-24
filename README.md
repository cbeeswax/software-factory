# Software Factory

An agentic software factory for Claude Code and GitHub Copilot. GitHub issues go in; reviewed pull requests come out. A team of specialist agents does the work, a small deterministic program decides what happens next, and a human is asked only when the stakes call for it. The pipeline is chosen for each task, and the factory remembers its mistakes so the next job does not repeat them.

```
 FORWARD PRESSURE                         THE LINE                                      BACK PRESSURE
 what starts work                                                                       what stops bad work

 GitHub issues ─┐
 Sentry errors ─┤            ┌────────┐  ┌──────┐  ┌───────┐  ┌──────┐  ┌─────────┐  ┌─────────┐
 Inbox notes   ─┼─▶ issue ─▶ │ intake │─▶│ spec │─▶│ build │─▶│ GATE │─▶│ reviews │─▶│ approve │─▶ merge
 Any command   ─┘            └────────┘  └──────┘  └───────┘  └──────┘  └─────────┘  └─────────┘
                              reject or    │  ▲        ▲          │          │            │
                              ask a human  ▼  │ gaps   └──────────┴──────────┘            ▼
                                       ┌────────────┐     fails go back to           human approves when
                                       │ spec check │     the builder                risk, protected paths
                                       └────────────┘                                or a spot-check say so
                                        human answers open questions,
                                        and approves the plan when it
                                        is hard to reverse
```

## What it does

1. **Intake.** An agent reads the issue against the codebase, decides whether it is worth building, narrows the scope, says what kind of job it is, and rates the risk. Code turns that into the job's plan and writes a brief every later agent reads first.

   | Kind of job | How it is handled |
   |---|---|
   | feature | Designed first when it is risky or hard to reverse; built test-first in thin slices. |
   | bug | No design stage. Reproduced with a failing test first, fixed at the root cause, nothing else changed. |
   | refactor | Behaviour pinned down by tests before anything moves; an architecture reviewer always looks at it. |
   | docs | Light pipeline, one reviewer; every statement checked against the code. |
   | chore | Light pipeline; one thing changed at a time, the full checks prove nothing else moved. |
   | spike | Quick experiment to answer a question; never merged without a human. |

2. **Design.** For work that is risky or expensive to reverse, an agent works out how the change fits the existing system: boundaries, interfaces, data model, and the alternatives it rejected.
3. **Spec.** An agent writes acceptance criteria and a task plan. If the work fixes something hard to change later (a schema, a public API), a human approves the plan before any code is written.
4. **Spec check.** A second agent grills the spec for gaps before any code is written: decisions it left open, criteria nobody could test, claims about the codebase that are not true. Gaps the code or the issue can settle go back to the spec writer. Questions only a person can answer stop the job and are put to you, each with a recommended answer.
5. **Build.** An agent implements the spec test-first in its own git worktree, so several jobs run in parallel without touching each other or your checkout.
6. **Gate.** No agent involved. A script runs your real checks (lint, types, tests, build) and scans the diff for committed credentials, suppressed lint rules, skipped or deleted tests, oversized files and oversized diffs. A failing build goes straight back to the builder and never reaches a reviewer.
7. **Reviews.** Reviewers are chosen per job and run in parallel:

   | Reviewer | Runs when | Looks for |
   |---|---|---|
   | code | always | correctness, fit with the codebase, code that should not exist |
   | qa | always | whether each acceptance criterion is met and properly tested |
   | security | medium or high risk, or the job touches auth, data, APIs, infrastructure or dependencies | what an attacker could now do |
   | privacy | the job touches personal data or stored data | what the system does with people's data: collection, logs, third parties, retention, deletion |
   | ux and ui | the job touches the interface | flows, states and wording; design consistency and accessibility |
   | architecture | refactors, high risk, or hard-to-reverse designs | boundaries, dependencies, invariants, whether the build follows the design |
   | performance | intake flagged a hot path or cost that grows with data | regressions at realistic scale, measured where possible |
   | doubt | high risk | takes every claim the builder made and tries to prove it false |

   Any failure sends the job back to the builder for another round, up to a limit.
8. **Approve.** An agent recommends merge or escalate. Then rules it cannot override apply: high risk, protected paths, and a random spot-check all force a human review.
9. **Merge.** The pull request is merged, the worktree is removed, and the issue is closed with the full history in its comments.
10. **Learn.** If anything went wrong on the way, a retro agent works out the cause and records a lesson. See "How it learns" below.

`/factory collect` turns production errors and inbox notes into new issues, which closes the loop.

## How it learns

The factory keeps a record of its own mistakes and feeds them back into later jobs.

1. **Every failure is recorded as it happens.** A failed gate, a failed review, a gap the spec check found, a correction or answer from a human: the job script writes each one into the job's record. No agent has to remember to report it.
2. **A job that made mistakes is not finished until it has been learned from.** After it merges or is rejected, the retro agent reads what went wrong, finds the cause, and decides for each mistake whether it is a one-off, something new worth remembering, or something the factory already knew and did anyway.
3. **Lessons are stored in the repository.** `factory/memory/lessons.json` holds them, each tagged with the agents it is for and the kinds of job and areas of code it applies to. `factory/LESSONS.md` is the readable view. Commit both and the whole team's factory shares one memory.
4. **The next job is briefed with the lessons that apply to it.** A lesson about migrations reaches the builder of the next job that touches data, and does not clutter a CSS change. The most-repeated lessons come first.
5. **A lesson that keeps recurring becomes a rule.** When the same mistake happens three times despite the lesson, the factory flags it: advice has failed, and it should be enforced by a check in the gate. `/factory retro` writes those proposals for you to review.

You can teach it directly too: `/factory lessons` lists what it knows, and `node factory/bin/job.mjs lesson add --text "..." --agents builder` adds one.

## Requirements

- [Claude Code](https://claude.com/claude-code) or GitHub Copilot (the CLI, or agent mode in VS Code)
- Node.js 20 or newer (22.20 or newer for automatic skill installation), and git 2.38 or newer
- The GitHub CLI, `gh`, logged in (only needed for issue and pull request features)

There are no npm dependencies.

## Install it into a project

```bash
git clone https://github.com/cbeeswax/software-factory.git
node software-factory/install.mjs /path/to/your/project
```

This copies the skill, the agents (for both Claude Code and Copilot) and the `factory/` folder into your project, adds a section to your `CLAUDE.md` and `AGENTS.md`, adds the ignore rules, installs any agent skills that are missing, registers a Claude Code hook that blocks credentials from being written, and creates the `factory` and `factory:triage` labels on GitHub. Run it again to upgrade; it never overwrites your config or lessons.

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
4. Start Claude Code or GitHub Copilot in the project and type `/factory run`.

## Using it

| Command | What happens |
|---|---|
| `/factory run` | Processes every open issue labelled `factory`, three at a time by default. |
| `/factory run 12` | Processes only issue 12. |
| `/factory add a copy button to code blocks` | Builds one feature from your description, with no GitHub issue. Merges locally. |
| `/factory status` | Shows every job and its stage. |
| `/factory approve 12` | You approve a plan, the recommended answers, or a merge that was waiting on you. |
| `/factory grill 12` | The factory walks you through the open questions on a spec, one round at a time. |
| `/factory 12: use a separate table instead` | Your feedback is recorded and the job resumes. |
| `/factory collect` | Files new issues from the configured sources. |
| `/factory skills` | Checks that the agent skills are installed, and installs any that are missing. |
| `/factory lessons` | Shows what the factory has learned. |
| `/factory retro` | Reviews the factory as a whole and proposes changes to it, including checks for lessons that keep recurring. |
| `/factory dashboard` | Opens the live board at http://127.0.0.1:4317. |

The session where you type `/factory run` is the orchestrator. If it dies, type `/factory run` again: job state is on disk, and each job resumes from its current stage. Work an agent had in flight at that moment is redone.

To keep it running unattended, combine it with your harness's own scheduling, for example `/loop 30m /factory run` in Claude Code.

## Claude Code and GitHub Copilot

The factory is written once and runs in both.

| Piece | Claude Code | GitHub Copilot |
|---|---|---|
| The `/factory` skill | `.claude/skills/factory` | reads the same folder |
| Stage agents | `.claude/agents/factory-*.md` | `.github/agents/factory-*.agent.md`, generated from the Claude files by `node factory/bin/sync-agents.mjs` |
| Project guidance | `CLAUDE.md` | `AGENTS.md` |
| Agent skills | `.claude/skills`, or the agent-skills plugin | reads `.claude/skills` |
| Job control, gate, dashboard | plain Node scripts | the same scripts |
| Secret guard hook | `.claude/settings.json` | not wired; the gate's scan of the final diff still applies |

The orchestrator instructions say "delegate to agent X" and let each harness do that its own way. Where a harness can run subagents in parallel, reviews run in parallel; where it cannot, they run one after another with the same result. The model names in the config (`fable`, `opus`, `sonnet`) are Claude's; in Copilot they are treated as hints, so set `models` to names your Copilot plan offers if you want per-stage models there.

## Agent skills

The stage agents lean on published skills for their method: spec-driven development, test-driven development, code review, security hardening, accessibility, doubt-driven development, and `grilling` for the spec check. Each agent also carries its own fallback instructions, so the factory works without them.

`node factory/bin/skills.mjs ensure` checks for every skill listed under `skills.sources` in the config and installs the missing ones into `.claude/skills` with the open [`skills`](https://github.com/vercel-labs/skills) installer. The project installer runs it, and so does the orchestrator at the start of each run. Commit the installed skills and everyone on the project has them, in either harness. Set `skills.autoInstall` to `false` to only report what is missing.

By default the skills come from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) and [mattpocock/skills](https://github.com/mattpocock/skills). If you already have the agent-skills plugin in Claude Code, those count as installed.

## What makes this more than a prompt

**Code decides, agents recommend.** `factory/bin/job.mjs` is the only thing that writes job state. An agent cannot move a job forward by saying it is done: the spec file has to exist, the gate has to pass, each reviewer's written findings have to exist before its verdict is accepted, and commands run out of order are refused.

**A gate agents cannot talk their way past.** The cheapest way for an agent to get a green build is to lower the bar. The gate fails the build for a new `eslint-disable`, `@ts-ignore`, `# noqa`, `.skip(`, `.only(`, a deleted test file, a credential, uncommitted files, a merge conflict with the base branch, a new file over 500 lines, or a diff over 800 lines. All of it is configurable under `slop` in the config.

**Gaps are found before code, not after.** The spec check costs one agent. A gap found in review costs a rebuild and a second round of every reviewer.

**Review matched to risk.** A copy change gets two reviewers on a faster model. A high-risk change to personal data gets security, privacy and doubt reviewers on the strongest model. The routing is one function in `factory/lib/core.mjs`.

**Humans where judgement matters.** A human is asked at three points, each for a reason:

- before building, when the spec has a question only a person can answer, or the plan includes a decision that is expensive to reverse;
- before merging, when the job is high risk, touches protected paths (`migrations`, `billing`, `auth`, `.github`, and the factory itself), or the approver agent is unsure;
- at random, for one in five jobs that would otherwise auto-merge, so that you keep reading a sample of what ships. Set `approval.auditRate` to change this, or `approval.autoMerge` to `false` to approve everything yourself.

**Every pull request reads the same way.** The description is written for someone who has not seen the code, in a fixed order the gate enforces:

1. **Summary** in plain words, as three separate parts: what changes, why, and how.
2. **Component diagram**, colour coded: green for newly added, amber for changed, grey for not changed.
3. **Sequence diagram** of the main flow.
4. **Tests**: what was tested at a high level, followed by the checks the factory actually ran and their results.

The builder writes it, the factory applies the same colours and legend to every diagram, a build without it does not pass the gate, and the reviewers and approver check that it matches the code. The risk, review history, builder notes, design and spec follow underneath, folded away.

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
| `specReview` | `true` | Run the spec check before building. |
| `maxSpecRounds` | `2` | Times the spec writer may revise on its own before the open gaps go to a human. |
| `playbooks` | see `core.mjs` | Per kind of job: whether it is designed and spec-checked, how the builder approaches it, which skills fit. |
| `routing` | see `core.mjs` | Which reviewers run for which risk levels, kinds of job and areas of code. |
| `memory.maxLessonsInBrief` | `12` | How many lessons a job brief carries. |
| `memory.promoteAfter` | `3` | Recurrences after which a lesson is flagged to become a check. |
| `skills.autoInstall` | `true` | Install missing agent skills automatically. |
| `skills.sources` | see file | Which skills the factory expects, and the repository each comes from. |
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
| Forward and back pressure, understanding the problem before building, planning in proportion to the cost of being wrong, fighting slop with deterministic rules, learning from past sessions, keeping decisions in one place, humans reviewing a subset chosen by stakes | Dex Horthy, [12 Rules for a Software Factory That Doesn't Ship Slop](https://www.youtube.com/watch?v=-NFMsM2y0Vk) | the slop gate, the design stage, the spec check, plan review, `approval.auditRate`, `factory/memory`, `factory-retro` |

## Before you trust it with production

- **Start with `autoMerge` off**, or on a repository where a bad merge is cheap, and read what it produces. Turn automation up as it earns it.
- **The gate is only as good as your checks.** With weak tests, the factory will ship code that passes weak tests.
- **Issue text is untrusted input.** Agents are told to treat it as a request and not as instructions, and only issues you label are processed, but do not label an issue you have not read on a public repository.
- **It costs tokens.** A small chore runs about five agents; a high-risk feature touching personal data runs fifteen or more, plus rework. `job.mjs status <job>` shows the time per stage and the tokens recorded.
- **Job files are local.** `factory/jobs/` is not committed. The durable record is the issue comments and the pull request.
- **Not yet exercised:** the Sentry source has not been run against a real account, and the GitHub Copilot path has not been run in Copilot. The Copilot agent files follow GitHub's documented format, but expect to adjust the delegation wording for your Copilot surface on the first run.

## Development

```bash
npm test
```

`test/core.test.mjs` covers the decision logic. `test/job.test.mjs` runs whole job lifecycles against throwaway git repositories with GitHub turned off, and fails if the Copilot agent copies are stale. After editing an agent in `.claude/agents`, run `node factory/bin/sync-agents.mjs`.
