# ADR-0009 — Global tasks, multi-project mounts, worktree isolation, and light completion

Status: accepted
Date: 2026-07-13
Related: ADR-0004 (dual-form shell), ADR-0006 (concurrent runs), ADR-0008 (task-centric shell), spec §5, §6, §8, PIVOT-021..027

## Context

ADR-0008 made the task the primary object, but the engine still mounts exactly one
project: the tool gateway, permission engine, change tracking and verification service
are all rebound to "the open workspace" whenever it changes. Consequences observed in
real use:

1. **Cross-project parallelism is impossible and unsafe.** Starting a task in project A
   and then opening project B rebinds the single gateway to B's root while A's run is
   still alive — A's tool calls would resolve against B (a correctness/safety hole), and
   A's pending permissions/plans are cancelled ("workspace changed").
2. **Same-project parallelism is muddy.** ADR-0006 allows 3 concurrent runs, but two
   tasks writing one working tree interleave their diffs; review/rollback semantics
   degrade.
3. **The sidebar lies.** Tasks are listed per current project; Mission Control claims to
   be a control tower but forgets every other project.
4. **Chat-weight tasks get task-weight ceremony.** A zero-change "hi" ends in a Final
   report, an UNVERIFIED warning and a "Review changes" primary button with nothing to
   review.
5. **The Pi adapter silently dropped `systemPreamble`** — mode rules, the plan-first
   instruction and product identity never reached real models.

## Decision

### 1. Tasks are global citizens; a project is an attribute of a task

- `task.list` gains `scope: 'workspace' | 'all'` (shell uses `all`); the DTO carries
  `projectName`, `projectPath`, `changedFiles`, `worktree`.
- Mission Control (Needs You / Running), the Inbox badge and the sidebar task list are
  global and group by project. Task interactions route by taskId, never by "the current
  workspace".

### 2. Multi-mount engine: per-project agent contexts

A `ProjectContext` = { DocumentStore facade, ChangeService, BlobStore, ToolGateway,
PermissionEngine, VerificationService } keyed by **mount root** (project canonical path
or a task's worktree path), created lazily and kept alive independent of the focused
editor workspace.

- The focused-editor concept (WorkspaceHost + M5 UI services) is unchanged; when a
  context's root equals the focused workspace, the context delegates document access to
  the live editor DocumentStore so dirty-buffer semantics stay exact (M8-06).
- Switching the focused project no longer cancels permissions/plans or rebuilds
  gateways. `TOOL_NO_GATEWAY` for live tasks is eliminated by construction.
- Permission grants stay workspace-scoped (`SqlPermissionStore(ws.id)`), shared by all
  mounts of that project including worktrees.
- Recovery scan (`markOrphanedRunsInterrupted`) covers all workspaces, not the opened one.

### 3. Worktree isolation for same-project parallel tasks

- `task.create` gains `isolation: 'none' | 'worktree'` (git projects only). Worktree
  tasks get `git worktree add -b charter/<taskId> <userData>/worktrees/<wsId>/<taskId>
  HEAD`; the task's context mounts the worktree root, so tools, change records, review
  and the Live Board all operate on the isolated tree with zero special cases.
- **Accept = merge back** (file-level, not a git merge): for each file in the task's net
  change set, the main tree must match the task baseline (or already match the result);
  otherwise it is a conflict. No conflicts → bytes are copied/deleted atomically into
  the main tree, recorded as `task.mergedBack`, then REVIEW_READY → ACCEPTED as usual.
  Conflicts → `task.accept` returns them; the user may force (`confirmConflicts`) after
  an explicit second confirmation, mirroring rollback semantics (CHG-009/010).
- **Rollback of a worktree task discards the worktree** (byte-exact by construction; the
  main tree was never touched).
- The engine state machine (§6.1) is unchanged; merge-back happens inside the
  REVIEW_READY → ACCEPTED action.

### 4. Plan "Request changes" flows through the composer

`task.planDecision` gains `decision: 'request_changes'` (+ feedback in `reason`). The
blocked `propose_plan` call resolves with `PLAN_CHANGES_REQUESTED` and the feedback text;
the model revises and proposes v2 (state hops AWAITING_PLAN_APPROVAL → IN_PROGRESS →
PLANNING → AWAITING_PLAN_APPROVAL, all legal). The Task Room composer sends this
automatically while a plan is awaiting approval — no extra button (per product decision;
plan card buttons stay Approve + Edit plan + Cancel task).

### 5. Light completion for zero-change tasks

`tasks.changed_files` (migration v2) is recorded when a run finalizes. A REVIEW_READY
task with `changedFiles === 0` is *presented* as "Answered": no Final-report card, no
Review button, a quiet Done action (plain `task.accept`, which is trivially safe with an
empty change set), excluded from the amber Needs-You count, and the OS notification says
"answered" instead of "ready for review". The machine state remains REVIEW_READY and
`data-state` still exposes it — §6.1 and "completion means REVIEW_READY, never
auto-ACCEPTED" are untouched.

### 6. Runtime preamble delivery + identity

The Pi adapter injects `systemPreamble` ahead of the session's first prompt (the SDK has
no system-prompt option). The preamble now also pins product identity (the agent
introduces itself as Charter's agent and never mentions internal harness/vendor names) —
a presentation instruction; message content itself remains exempt per PIVOT-008.

## Consequences

- The renderer can finally show one truthful global control tower; the persistent-shell
  UI (PIVOT-028+) builds directly on it.
- The single-workspace M5 services (git panel, editor, terminals, LSP) remain focused-
  workspace-bound — deliberate: the *editor* is a lens, agent execution is not.
- Worktree merge-back is file-level; git history/branch merging is explicitly out of
  scope (accept ≠ commit, spec §5.4). The `charter/<taskId>` branch is kept for audit.
- New failure surfaces (worktree creation, merge conflicts) get product error codes
  (`WT_*`, `ACCEPT_MERGE_CONFLICTS`) and explicit UI paths.
