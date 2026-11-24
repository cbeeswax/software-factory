# Factory design

This factory, described in the shared language of the [`software-factory` skill](https://github.com/mattpocock/skills/tree/main/skills/in-progress/software-factory). Use these terms when discussing or changing it. To redesign or extend the factory, load that skill with `grilling` and work from this page (`/factory design`).

One term here is this factory's own. A **job** is one ticket's whole journey: the chain of runs that takes it from intake to merged. The skill has no word for that chain; it is not a task.

## Services: every slot filled

| Slot | Filled by | Notes |
|---|---|---|
| Ticket tracker | GitHub Issues | The human interface. Labels route work; comments carry the conversation. |
| Ticket sources | The collector (`factory/bin/collect.mjs`): Sentry, an inbox folder, any command, a ratchet list. Also people. | Sources file under `factory:triage`; a human promotes a ticket by adding `factory`. |
| Git host | GitHub | Branches, pull requests, merges. |
| Orchestrator | An agent session running the `/factory` skill, with `factory/bin/job.mjs` as its record of which runs are queued, in flight and finished. | The skill starts runs; the script decides which run is next. |
| Runner | A fresh subagent context in a git worktree on the orchestrator's machine. | Disposable in context and checkout, not in machine. See "Known gaps". |
| Observability platform | A deliberate none. | The job folder, the local dashboard and the ticket comments show enough. |

## Brakes

Every trigger is an accelerator. These are the brakes, and the factory starts with all three on.

- **Automated checks:** the gate. The project's own checks, plus the scan for credentials, suppressed checks, skipped or deleted tests, oversized changes, and a missing pull request description.
- **Automated review:** the reviewer runs. Each reads the diff cold, in its own context, against the ticket and the spec.
- **Human review:** `approval.autoMerge` is `false` by default, so a human reads every pull request. What they catch becomes lessons, and lessons that recur become checks.

Opening the throttle is a decision, made one setting at a time as the brakes earn trust:

| Throttle | Setting | Starts at |
|---|---|---|
| Merge without a human | `approval.autoMerge` | off |
| Human spot-checks once auto-merge is on | `approval.auditRate` | 1 in 5 |
| Tickets a source may file per collection | `collect.maxPerRun` | 5 |
| Sources queue work without a human | `collect.autoQueue` | off |
| Jobs in flight | `concurrency` | 3 |
| Retros on jobs that went cleanly | `memory.sampleCleanJobs` | 1 in 10 |

Every loop of runs is capped before it reaches a human: review rounds (`maxRounds`), gate failures (`maxGateFailures`), spec revisions (`maxSpecRounds`).

## Tasks

For each task: what triggers it, what it does and which services it reads and writes, what it triggers next, where a human re-enters, and what stops two runs doing the same work.

Two answers are the same for every task below, so they are given once:

- **What stops two runs doing the same work.** A ticket has at most one live job: the job script refuses a second, and marks the ticket `factory:running` in the tracker so another factory on another machine leaves it alone. Within a job, the script allows exactly one next run at each step and refuses commands out of order.
- **Where a human re-enters.** A run never waits for a human. It ends, the job is marked `needs-human` (and the ticket `factory:needs-human`), and the human's reply starts the next run. They reply in the orchestrator session, or on the ticket with a comment beginning `/factory`.

| Task | Trigger | Does | Reads / writes | Triggers next |
|---|---|---|---|---|
| **Explore** (`factory-intake`) | A ticket gets the `factory` label; or a task described to the orchestrator. | Checks the request against the codebase, classifies it, rates risk. Never pushes. | Reads the ticket. Writes its findings to the job and a comment on the ticket. | Decompose, design, or spec. Reject ends the job. A question ends it waiting for a human. |
| **Decompose** (`factory-decompose`) | Explore says the ticket is too big. | Splits it into tickets, each recording which tickets it depends on. | Writes new tickets to the tracker. | Nothing directly: the new tickets carry the `factory` label, and each is explored once the tickets it depends on are closed. |
| **Design** (`factory-design`) | Explore accepts work that is not low risk, or is expensive to reverse. | Works out how the change fits the system. | Writes to the job. | Spec. |
| **Spec** (`factory-spec`) | Explore or design finishes; or the spec check or a human sends it back. | Writes acceptance criteria and a plan. | Writes to the job. | Spec check. |
| **Spec check** (`factory-grill`) | A spec is written. | Interrogates the spec for gaps. | Writes to the job. | Spec again (capped), implement, or ends waiting for a human's answers or plan approval. |
| **Implement** (`factory-builder`) | The spec is accepted. | Builds the ticket in a worktree, test-first, and writes the pull request description. | Writes commits to a branch. | The gate, which is code, not a run. A pass triggers automated review; a fail triggers rework. |
| **Automated review** (`factory-reviewer-*`) | The gate passes. | Each reviewer reads the diff cold from its own angle. | Writes a verdict to the job; the round's result to the ticket. | All pass: opens the pull request, then approve. Any fail: rework. |
| **Rework** (`factory-builder`) | A failed gate or a failed automated review. | Fixes what was named, and pushes. | Writes commits to the branch. | The gate again. After the cap, ends waiting for a human. |
| **Approve** (`factory-approver`) | Every reviewer passed. | Recommends merge or escalate; code decides. | Writes to the job, merges on the git host. | Merge, or ends waiting for a human. |
| **Retro** (`factory-retro`) | A job finishes having made mistakes; or a clean merged job is sampled (1 in 10). | Finds the cause and records lessons. | Writes to the factory's memory in the repository. | Nothing. Lessons reach later runs through their briefs. |
| **Architecture** (`factory-scout`) | `/factory scan`, or a schedule. | Scans recent changes for refactoring candidates and files them as one note. | Writes one inbox note, which the collector files as a ticket. | Nothing. A human picks a candidate and labels it. |
| **Ratchet** (a ticket source plus implement) | A collection finds the exception list non-empty and no ratchet ticket open. | Files one ticket: take one file off the list and make it pass the stricter check. | Writes a ticket to the tracker. | Nothing directly: the ticket is triaged like any other. One small pull request at a time. |

## Ticket sources

For each: what stops it filing the same ticket twice.

| Source | Stops duplicates by |
|---|---|
| Sentry, command | Every filed ticket carries a `Factory-Source:` line with the problem's id; the collector searches for it before filing. If the ticket is closed and the problem is reported again, the collector reopens it instead of filing a new one. |
| Inbox | The same `Factory-Source:` line, and the note is moved to `done/` once filed. |
| Ratchet | Files nothing while a ratchet ticket for that check is open, and the path leaves the exception list when its fix merges. |
| Decompose | The job remembers each ticket as it files it, so a retry continues where it stopped. |

## Known gaps

Where this factory does not yet meet the skill's definition. These are the next things to design, with the skill and a grilling session.

- **The runner is not a disposable machine.** Runs execute on the orchestrator's machine, and the job folder (`factory/jobs/`) lives on that machine's disk. The skill requires that a run's only memory of earlier runs is the ticket tracker, the git host and the orchestrator. Today the ticket comments and the pull request hold the outcome of each run, but not enough to rebuild a job. Moving to a remote runner (a CI runner, a microVM) needs job state stored where a fresh machine can read it.
- **The orchestrator is a session, not a service.** Triggers are polled when someone runs `/factory run` (or a schedule does), not received as events. A label change on a ticket does not start a run by itself.
- **Runs share one identity.** The factory acts as whoever is logged in to `gh`. A dedicated bot identity would let automated review approve a pull request another identity authored, and would make agent comments distinguishable from a colleague's.
- **No fix task.** A run that fails inside the factory blocks its job for a human; nothing files the failure as a ticket.
- **Gates on the git host are not set up.** Branch protection and required checks would make the brakes hold even if the factory misbehaved. That is a setting on the repository, outside this code.
