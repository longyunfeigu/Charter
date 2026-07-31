# Mission Orchestration V2 — recursive agent teams for Charter

- Status: Superseded by `mission-fabric-v3.md`
- Date: 2026-07-30
- Target repository revision: `f086509dc45413a43434238052dbf796a9514d3d`
- Intended successor to: `docs/adr/ADR-0044-session-orchestration.md`
- Reference implementations inspected:
  - FanBox `fd632c7921eab8e068665e0db1f29ef280084e01`
  - Orca `f5f026649e4fae6e77aef916f79581079ca69d1b`

## 1. Executive decision

Charter will replace its fixed two-level terminal fleet model with a durable Mission orchestration
control plane.

The defining behavior is recursive delegation:

```text
User
└── Agent A — Mission Lead
    ├── Agent B — frontend assignment
    │   └── Agent D — test-failure investigation
    └── Agent C — backend assignment
```

Agent B creates Agent D directly. Agent A does not proxy that RPC, and the user does not approve a
new permission request for every child.

All agents in the same Mission reuse one Mission-level execution policy. Charter does not add a
per-agent permission hierarchy, capability attenuation, or delegation-grant bureaucracy. The
existing provider permission behavior of Claude, Codex, or another runtime remains intact; Charter
does not duplicate it.

The system separates four relationships that the current implementation partially conflates:

1. Responsibility is a single-parent Assignment tree.
2. Work ordering is a Task dependency DAG.
3. Communication is a Mission-wide message graph.
4. Claude, Codex, managed agents, shells, and visible terminals are runtime surfaces.

The feature is not implemented by MCP. Its canonical stack is:

```text
charter-orchestration Skill
            ↓
charter orchestration CLI
            ↓
local socket RPC
            ↓
MissionOrchestrationService
            ↓
runtime adapters
```

Managed Charter agents may call the same service through native Tool Gateway tools. MCP is an
optional thin adapter for clients that already prefer MCP; it is not a state owner, permission
boundary, or architectural dependency.

## 2. Why the current model is insufficient

ADR-0044 intentionally implemented a two-level topology:

```text
commander → worker
```

`TerminalControlService.assertTopLevel` currently refuses `create`, `send`, and `kill` when the
caller terminal is already registered as a worker. That rule prevents loops in the V1 terminal
model, but also prevents a worker from decomposing a newly discovered subproblem.

Deleting only that guard would produce recursive terminals, not recursive orchestration. The host
would still lack:

- a durable Mission identity;
- an explicit Task DAG;
- a distinction between a responsibility Assignment and one execution Attempt;
- idempotent creation when a tool call is retried;
- protection against a failed Attempt reporting completion after a retry began;
- structured messages and questions independent of terminal output;
- parent-loss, app-restart, and runtime-reconnect semantics;
- a consistent way to include managed agents and external Claude/Codex sessions;
- an agent-facing policy for deciding when another agent is useful.

The V2 design therefore builds a new control plane and turns terminal control into one runtime
adapter. It does not grow `TerminalControlService` into a larger all-purpose coordinator.

## 3. Source-derived lessons

### 3.1 FanBox: use the visible runtime behavior, not its domain model

FanBox's `fanbox-agent` Skill teaches an agent to invoke six local HTTP endpoints with `curl`:
list, read, send, create, wait, and kill. The actual capability lives in Electron Main and the
local HTTP server. The Skill is instruction, not execution infrastructure.

Useful FanBox behavior:

- a created worker is a real visible tab;
- the user can inspect and take over that tab;
- terminal input normalizes newlines and supports bracketed paste;
- reads use bounded rolling output;
- waits return only output observed after the wait began;
- create has an explicit renderer receipt;
- remote control is visibly signaled in the UI.

FanBox behavior not adopted as canonical Mission semantics:

- one shared token for all terminals;
- terminal id as agent, task, and authority identity;
- output quietness as authoritative task completion;
- direct terminal create as equivalent to assignment creation;
- no durable task, attempt, message, or recovery model;
- no idempotency boundary for repeated create requests.

FanBox itself documents MCP as a possible future thin proxy over HTTP. Its agent-control feature is
currently Skill + HTTP, not MCP.

### 3.2 Orca: reuse task and attempt mechanics, not its whole coordinator

Orca separates a durable Task from a DispatchContext. Each retry receives a distinct dispatch id.
Heartbeat and worker completion messages carry both task id and dispatch id. Lifecycle
reconciliation verifies that the sender is the active assignee before changing task state.

Useful Orca behavior:

- Task and execution attempt are separate records;
- task dependencies move pending work to ready only when prerequisites complete;
- one assignee cannot hold conflicting active dispatches;
- failure count survives retries;
- stale or foreign completion messages are rejected;
- structured message types distinguish heartbeat, escalation, question, and completion;
- message threads use a monotonic sequence;
- workers receive an explicit completion and heartbeat protocol;
- worktree drift is checked before dispatch.

Orca behavior not adopted unchanged:

- terminal handle as the primary actor identity;
- AI task decomposition is not implemented in its coordinator;
- coordinator progress is a polling loop;
- stale heartbeat detection only warns;
- task dependencies are stored as JSON rather than normalized edges;
- its RPC methods do not form a recursive Mission membership model;
- it does not provide Charter's desired agent-first promotion flow.

Orca orchestration is driven through `orca orchestration ...` CLI commands. The CLI calls the Orca
runtime through Unix socket or named-pipe RPC, and uses WebSocket for paired remote environments.
The MCP-related code in Orca serves other concerns such as MCP configuration inspection and Linear
compatibility; it is not the orchestration transport.

### 3.3 Charter: preserve its stronger foundations

Charter already has the pieces that should remain authoritative:

- visible node-pty terminals;
- event-driven command and external-agent turn completion;
- bounded terminal buffers and takeover queues;
- per-terminal identities and a mode-0600 Unix socket;
- one Tool Gateway for native and external calls;
- durable task events, tool calls, file changes, and verification records;
- ExternalSessionService for manually started Claude and Codex;
- AgentHost for managed runtimes;
- worktree creation and file-change accounting;
- Electron UI surfaces for terminals, sessions, replay, and user intervention.

V2 composes these foundations behind new Mission contracts. It does not replace the terminal,
session, file-accounting, or verification subsystems.

## 4. Product contract

### 4.1 Two equally valid entry paths

#### Mission-first

The user creates a Mission from Charter UI, enters the goal and acceptance criteria, chooses a
default runtime policy, and starts a Lead.

#### Agent-first

The user opens a Charter terminal, starts Claude or Codex manually, and describes the work in that
conversation. When the agent first calls `orchestration.delegate`, Charter promotes the existing
session in place to Mission Lead.

Promotion does not:

- restart the CLI;
- replace the terminal;
- discard conversation context;
- create a second visible copy of the same session;
- require the user to navigate to a Mission page first.

The current conversation Task becomes `origin_conversation_task_id` on the Mission. The Mission is
a durable coordination object, not a mandatory front-door screen.

### 4.2 Permission contract

Within one Mission, every member inherits the same Mission execution policy:

```ts
interface MissionExecutionPolicy {
  inheritHostPermissions: true;
  controlScope: 'mission-wide';
  workspaceRoot: string;
  toolPolicy: 'inherit';
  runtimeDefaults: {
    environment: Record<string, string>;
    preferredRuntime?: 'managed' | 'claude' | 'codex' | 'shell';
    preferredModel?: string;
  };
  limits: {
    maxConcurrentAgents: number | null;
    maxTotalAgents: number | null;
  };
}
```

There is no `DelegationGrant` table and no child-specific capability reduction.

Mission-wide control means a Mission member may:

- create another member;
- inspect Mission tasks and assignments;
- send structured messages to another member;
- wait for another member's message or completion;
- steer, pause, resume, cancel, or retry a Mission runtime;
- propose or perform reassignment within the same Mission.

The host still checks that the target belongs to the same Mission. This is object-integrity
validation, not an agent permission hierarchy. It prevents an incorrect identifier in Mission X
from terminating an unrelated process in Mission Y.

The global orchestration master switch remains. Resource limits remain configurable stability
controls and may be disabled. They are not fixed architecture depth limits.

### 4.3 Worktree contract

Equal permissions do not imply unsafe shared writes.

Default behavior:

- read-only assignments may share the Mission workspace;
- write assignments receive an isolated worktree when the project supports Git worktrees;
- a Lead or Integration assignment owns merge and conflict resolution;
- shared-tree writes require an explicit Assignment mode and truthful UI warning;
- folder workspaces without Git use scoped path coordination and conflict detection rather than
  claiming isolation.

Isolation is a correctness mechanism, not a permission boundary.

### 4.4 Visibility contract

Every running agent has an inspectable runtime representation. A visible terminal is required for
external Claude, Codex, and shell workers. Managed agents may use a native activity surface, but
must still expose their transcript, state, task, artifacts, and controls.

The user can always:

- see who created an Assignment;
- see which runtime is executing it;
- open the live runtime or its structured activity;
- pause or take over;
- cancel or retry;
- see why Charter considers it waiting, failed, or completed.

## 5. Object coordinates

The following terms are deliberately distinct.

| Object | Meaning | Durable | Primary owner |
| --- | --- | --- | --- |
| Mission | User's complete objective and acceptance contract | Yes | Mission service |
| MissionTask | A unit of work in the dependency graph | Yes | Mission service |
| TaskDependency | A directed prerequisite edge | Yes | Mission service |
| Principal | A user, agent session, or system actor identity | Yes | Identity registry |
| Assignment | Responsibility for one task, arranged as a parent tree | Yes | Mission service |
| ExecutionAttempt | One try to execute an Assignment | Yes | Attempt lifecycle |
| RuntimeSession | Claude, Codex, managed runtime, shell, or terminal instance | Partly | Runtime adapter |
| Message | Structured inter-agent communication | Yes | Message bus |
| Artifact | File, report, diff, test result, or verification evidence | Yes/reference | Artifact services |
| Terminal | A visible PTY execution surface | Live + daemon metadata | Terminal manager |
| Skill | Agent instructions for using the orchestration API well | Versioned file | Skills system |
| CLI | Stable agent and human command surface | No state ownership | CLI adapter |
| RPC | Transport from CLI to running Charter | No state ownership | RPC adapter |
| MCP | Optional compatibility adapter | No state ownership | MCP adapter |

An Agent is an actor. A model client is a dependency of that actor. A terminal is a runtime
surface. A Task is not an Agent, and an Agent is not an Attempt.

## 6. Topology

### 6.1 Responsibility tree

Each Assignment has at most one `supervisor_assignment_id`.

```text
AS-A Lead
├── AS-B Frontend
│   └── AS-D Failure investigation
└── AS-C Backend
```

This tree answers:

- who asked for this work;
- where a completion summary should be routed;
- which subtree should appear beneath an Assignment in UI;
- what should be paused together when a supervisor disappears.

It is not a permission tree.

### 6.2 Task DAG

Task dependencies are independent of the responsibility tree.

```text
T-B frontend ──────┐
                   ├──> T-E integration verification
T-C backend ───────┘

T-D investigate failing frontend tests ──> T-B frontend completion
```

Agent B can create T-D after discovering a failure, even though T-D was absent from the original
plan. The host inserts the new dependency edges transactionally and rejects cycles.

### 6.3 Message graph

Any Mission member may message any other Mission member. A message can be a direct communication,
a reply in a thread, a broadcast to a Mission group, or a lifecycle message associated with an
Attempt.

Communication does not change the responsibility tree unless an explicit reassign operation is
accepted by the Mission service.

### 6.4 Runtime graph

Runtime sessions are replaceable execution resources.

```text
Assignment AS-B
└── Attempt AT-B1
    └── Runtime RT-17
        └── Terminal term-42
```

If RT-17 fails, AS-B and its Task survive. Retry creates AT-B2 and may create RT-23. The old
terminal may remain visible for evidence, but it no longer has lifecycle authority for AS-B.

## 7. Canonical architecture

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Agent instruction layer                                             │
│ charter-orchestration Skill + worker system preamble                │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            │                 │                 │
       Charter CLI       Native tools      Optional MCP
            │                 │                 │
            └─────────────────┼─────────────────┘
                              │
                    trusted CallerContext
                              │
┌─────────────────────────────▼───────────────────────────────────────┐
│ MissionOrchestrationService                                        │
│                                                                     │
│ MissionRepository   AttemptLifecycle   OrchestrationMessageBus      │
│ TaskGraph           AssignmentTree     OrchestrationOutboxRunner    │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ RuntimeCommand
┌─────────────────────────────▼───────────────────────────────────────┐
│ OrchestrationRuntimeRegistry                                       │
│                                                                     │
│ VisibleTerminal  ExternalCli  ManagedAgent  Shell  future adapters │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                    processes, PTYs, files, models
```

### 7.1 One state owner

`MissionOrchestrationService` is the only component allowed to commit Mission state transitions.

Runtime adapters may report observations but may not directly mark a Task completed. CLI, native
tools, MCP, Skill, renderer, and terminal output are all inputs to the service, not competing state
owners.

### 7.2 Trusted caller context

The caller does not provide its own Principal, Assignment, or Attempt identity in ordinary tool
input.

```ts
interface OrchestrationCallerContext {
  principalId: string;
  runtimeSessionId: string;
  missionId: string | null;
  assignmentId: string | null;
  attemptId: string | null;
  origin: 'managed-run' | 'charter-terminal' | 'attached-cli' | 'user' | 'system';
}
```

The host derives this context from:

- AgentHost's active run map for managed agents;
- per-terminal identity and ExternalSessionService binding for Charter terminals;
- a one-time attach ticket for external terminals;
- the signed IPC sender for user operations.

Tool payload knowledge is never sufficient to impersonate another Attempt.

## 8. Persistence model

The current `tasks` table represents a user Session/Conversation lifecycle and should not be
stretched into a recursive Mission task graph. Migration 9 adds normalized V2 tables alongside the
existing schema.

### 8.1 `missions`

```sql
CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  origin_conversation_task_id TEXT REFERENCES tasks(id),
  title TEXT NOT NULL,
  goal_md TEXT NOT NULL,
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  execution_policy_json TEXT NOT NULL,
  state TEXT NOT NULL,
  lead_assignment_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
```

Mission states:

```text
PLANNING → RUNNING ↔ BLOCKED → VERIFYING → COMPLETED
                    ├────────→ FAILED
                    └────────→ CANCELLED
```

### 8.2 `mission_tasks`

```sql
CREATE TABLE mission_tasks (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  parent_task_id TEXT REFERENCES mission_tasks(id),
  created_by_assignment_id TEXT,
  title TEXT NOT NULL,
  goal_md TEXT NOT NULL,
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  expected_artifacts_json TEXT NOT NULL DEFAULT '[]',
  write_scope_json TEXT,
  state TEXT NOT NULL,
  result_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
```

Task states:

```text
PROPOSED → BLOCKED → READY → RUNNING → VERIFYING → COMPLETED
                         ├────────────→ FAILED
                         └────────────→ CANCELLED
```

`BLOCKED` means dependencies or a decision prevent dispatch. `READY` means every persisted
dependency is complete and the Mission is permitted to schedule work.

### 8.3 `mission_task_dependencies`

```sql
CREATE TABLE mission_task_dependencies (
  task_id TEXT NOT NULL REFERENCES mission_tasks(id),
  depends_on_task_id TEXT NOT NULL REFERENCES mission_tasks(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);
```

Cycle detection happens before insertion. Readiness promotion and dependency insertion occur in the
same database transaction.

### 8.4 `orchestration_principals`

```sql
CREATE TABLE orchestration_principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  provider TEXT,
  external_identity TEXT,
  display_name TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);
```

Principal kinds:

```text
user | managed_agent | external_agent | shell_agent | system
```

### 8.5 `assignments`

```sql
CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  task_id TEXT NOT NULL REFERENCES mission_tasks(id),
  supervisor_assignment_id TEXT REFERENCES assignments(id),
  assignee_principal_id TEXT NOT NULL REFERENCES orchestration_principals(id),
  active_attempt_id TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
```

Assignment states:

```text
PENDING → ACTIVE ↔ WAITING ↔ PAUSED → COMPLETED
                 ├───────────────→ FAILED
                 ├───────────────→ CANCELLED
                 └───────────────→ ORPHANED
```

`ORPHANED` is an observed recovery state: the supervisor runtime is lost and no replacement or
reparent decision has yet been applied. It never grants uncontrolled execution.

### 8.6 `execution_attempts`

```sql
CREATE TABLE execution_attempts (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(id),
  ordinal INTEGER NOT NULL,
  runtime_session_id TEXT,
  state TEXT NOT NULL,
  lease_expires_at TEXT,
  last_heartbeat_at TEXT,
  started_at TEXT,
  ended_at TEXT,
  failure_code TEXT,
  failure_json TEXT,
  result_json TEXT,
  UNIQUE (assignment_id, ordinal)
);
```

Attempt states:

```text
PLANNED → STARTING → RUNNING ↔ WAITING → SUCCEEDED
                       ├──────────────→ FAILED
                       ├──────────────→ TIMED_OUT
                       ├──────────────→ CANCELLED
                       └──────────────→ STALE
```

### 8.7 `orchestration_messages`

```sql
CREATE TABLE orchestration_messages (
  id TEXT NOT NULL UNIQUE,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  from_assignment_id TEXT REFERENCES assignments(id),
  to_assignment_id TEXT REFERENCES assignments(id),
  thread_id TEXT,
  attempt_id TEXT REFERENCES execution_attempts(id),
  type TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  subject TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  payload_json TEXT,
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  read_at TEXT,
  suppressed_at TEXT,
  suppression_reason TEXT
);
```

Lifecycle messages that do not match the active Attempt are retained and marked suppressed. They
are not silently deleted, and they do not wake ordinary completion waiters.

### 8.8 `mission_events`

The append-only audit stream records state changes rather than serving as the only query model.

```sql
CREATE TABLE mission_events (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_principal_id TEXT,
  assignment_id TEXT,
  attempt_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (mission_id, sequence)
);
```

### 8.9 `orchestration_outbox`

Runtime creation, prompt delivery, cancellation, and wakeups are external side effects. They must
not occur inside an uncommitted database transaction.

```sql
CREATE TABLE orchestration_outbox (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  operation TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (mission_id, operation, idempotency_key)
);
```

### 8.10 Artifact references

`assignment_artifacts` links Mission work to Charter's existing file changes, blobs, verification
runs, reports, snapshots, and external URLs. It stores references, not duplicate file contents.

## 9. Agent-facing API

The canonical service methods are exposed through native tools and CLI commands.

### 9.1 Inspect

```text
orchestration.inspect
charter orchestration inspect --json
```

Returns the caller's Mission, Assignment, active Attempt, parent, children, dependencies, unread
messages, waiting decisions, and a compact Mission summary.

### 9.2 Delegate

```ts
interface DelegateRequest {
  goal: string;
  acceptanceCriteria: string[];
  dependencies?: string[];
  expectedArtifacts?: string[];
  requestedRuntime?: 'managed' | 'claude' | 'codex' | 'shell';
  requestedModel?: string;
  workMode?: 'read-only' | 'isolated-write' | 'shared-write';
  writeScope?: string[];
  reason: string;
  idempotencyKey: string;
}
```

The service returns:

```ts
interface DelegateResult {
  missionId: string;
  taskId: string;
  assignmentId: string;
  attemptId: string;
  runtime: {
    state: 'planned' | 'starting' | 'running';
    runtimeSessionId?: string;
    terminalId?: string;
  };
  reused: boolean;
}
```

`reused: true` means the same idempotency key already created the work.

### 9.3 Message and reply

```text
orchestration.message
orchestration.reply
charter orchestration message --to <assignment> ...
charter orchestration reply --message <id> ...
```

Messages are structured and persisted. Sending terminal input remains a low-level runtime action,
not the normal inter-agent protocol.

### 9.4 Wait

```text
orchestration.wait
charter orchestration wait --types question,completion --timeout-ms 600000
```

Wait subscribes to durable messages and state transitions. It is event-driven. Socket keepalive
frames may maintain a long request, but they do not represent Mission heartbeats or state changes.

### 9.5 Progress

```ts
interface ProgressRequest {
  attemptId: string;
  phase: string;
  summary: string;
  completed?: string[];
  remaining?: string[];
  blockers?: string[];
}
```

Only the active Attempt may update its progress.

### 9.6 Complete

```ts
interface CompleteRequest {
  attemptId: string;
  outcome: 'success' | 'failure';
  summary: string;
  artifacts: ArtifactReference[];
  verification: VerificationReference[];
  filesModified?: string[];
}
```

Completion validates caller identity and active Attempt before moving Assignment or Task state.
Self-report alone does not complete the Mission. Task acceptance and verification policy still run.

### 9.7 Escalate

```text
orchestration.escalate
```

Escalation may target the supervisor, Lead, user decision inbox, or a named Mission member. It does
not silently fail the Attempt unless the caller explicitly reports failure or policy times out.

### 9.8 Runtime control

```text
orchestration.steer
orchestration.pause
orchestration.resume
orchestration.cancel
orchestration.retry
orchestration.reassign
```

These operations address Assignment or Attempt ids. The service resolves the current runtime.
Callers do not need to know whether the target is a terminal, a managed run, or a resumed external
CLI session.

### 9.9 Low-level terminal compatibility

`terminal.list/read/send/create/wait/kill` remain available during migration and for manual runtime
control. New orchestration behavior must not encode Mission state by interpreting arbitrary
`terminal.send` text.

## 10. Skill contract

The product ships a managed `charter-orchestration` Skill. This Skill is the primary behavioral
contract for agents, while host code enforces state integrity.

### 10.1 When to delegate

Delegate when at least one condition is true:

- a subproblem can be independently verified;
- two tasks can progress in parallel without sharing uncoordinated writes;
- another runtime or model is materially better suited to the work;
- the current Assignment has discovered a bounded investigation that would pollute its context;
- an independent review or validation would reduce a concrete risk;
- the current Agent is blocked, but another Agent can gather missing evidence.

Do not delegate merely because:

- the task feels difficult;
- the Agent has not inspected the problem yet;
- the proposed child has no distinct goal or acceptance criteria;
- the child would immediately need the complete private conversation history;
- the only work is a tiny sequential step cheaper to perform locally.

### 10.2 Required child contract

Every child request must state:

- a goal;
- acceptance criteria;
- expected artifacts or evidence;
- dependencies;
- read-only, isolated-write, or shared-write mode;
- why delegation is preferable to local execution.

### 10.3 Recursive delegation

The Skill explicitly states that every Mission member may delegate recursively. A worker does not
ask its parent to proxy the call. Before delegating, it runs `orchestration.inspect`, selects a
bounded subproblem, and uses a stable idempotency key for that logical request.

### 10.4 Completion behavior

After sending `orchestration.complete`, an agent stops mutating the Assignment unless it receives a
new Attempt or follow-up. A resident Claude/Codex runtime may remain open and idle for reuse.

Task completion and runtime lifetime are separate.

### 10.5 Prompt is not enforcement

The Skill and worker preamble explain protocol. Host code still enforces:

- Mission membership;
- active Attempt identity;
- idempotency;
- dependency cycle prevention;
- valid state transitions;
- output and input size limits;
- target existence;
- app-restart reconciliation.

These checks protect consistency even though per-agent permissions are intentionally absent.

## 11. Transport design

### 11.1 CLI is canonical

The supported human and agent surface is:

```bash
charter orchestration inspect --json
charter orchestration delegate --request-file request.json --json
charter orchestration message --to AS-B --subject "API ready" --body-file - --json
charter orchestration wait --types completion,question --timeout-ms 600000 --json
charter orchestration complete --request-file result.json --json
```

Structured file/stdin inputs avoid shell quoting failures for multiline goals and payloads.

### 11.2 Local RPC

CLI requests use the existing mode-0600 local socket direction, generalized from terminal-only
routes to versioned orchestration RPC envelopes.

```ts
interface RpcRequest {
  id: string;
  protocolVersion: number;
  authToken: string;
  method: string;
  params: unknown;
}

interface RpcSuccess {
  id: string;
  ok: true;
  result: unknown;
  runtimeId: string;
}
```

Long waits may interleave transport keepalive frames. The final response id and Charter runtime id
must match the request context.

### 11.3 Native Tool Gateway

Managed agents do not spawn the CLI. Tool Gateway adapters call the same service in process and
derive CallerContext from AgentHost's active run registry.

### 11.4 Optional MCP adapter

The MCP adapter exports the same method schemas and forwards to the same local service. It owns no
database, identity policy, retry policy, or alternate authorization path.

Removing MCP configuration must not disable:

- Mission UI;
- managed agents;
- Skill + CLI usage;
- local recovery;
- external agents attached through the Charter CLI.

### 11.5 External terminal attach

An agent launched outside Charter cannot inherit a Charter terminal identity. V2 may support:

```bash
charter attach
charter claude
charter codex
```

`charter attach` produces a short-lived pairing flow visible in Charter. On success, the external
process receives a scoped runtime token that identifies its Principal and session. The token is not
a global persistent machine-control credential.

External attach is an adapter feature. The Mission domain model does not depend on its first-release
availability.

## 12. Runtime adapter contract

```ts
interface OrchestrationRuntimeAdapter {
  readonly kind: 'visible-terminal' | 'external-cli' | 'managed-agent' | 'shell';

  start(input: RuntimeStartRequest, signal: AbortSignal): Promise<RuntimeSessionRef>;
  deliver(input: RuntimeDeliveryRequest, signal: AbortSignal): Promise<void>;
  steer(input: RuntimeSteerRequest, signal: AbortSignal): Promise<void>;
  pause(runtimeSessionId: string): Promise<void>;
  resume(runtimeSessionId: string): Promise<void>;
  cancel(runtimeSessionId: string, reason: string): Promise<void>;
  inspect(runtimeSessionId: string): Promise<RuntimeObservation>;
  reconcile(runtimeSessionId: string): Promise<RuntimeReconciliation>;
}
```

### 12.1 VisibleTerminalRuntime

Extracts from `TerminalControlService`:

- visible terminal creation;
- bounded output and screen snapshots;
- normalized input injection;
- startup-safe queuing;
- semantic turn, command, quiet, and regex observation;
- pause, takeover, and handback;
- terminal exit and daemon restore observations.

It does not create Mission tasks or decide that quiet output means successful work.

### 12.2 ExternalCliRuntime

Wraps ExternalSessionService:

- detects and binds manually started Claude/Codex;
- preserves external session ids and resume data;
- forwards structured turn start and completion observations;
- associates file-accounting events with the active Attempt;
- supports agent-first Mission promotion.

### 12.3 ManagedAgentRuntime

Wraps AgentHost:

- creates or resumes runtime sessions;
- starts runs with a trusted execution context;
- routes tool requests through the Mission-aware Gateway;
- maps run end and structured result events into Attempt observations;
- supports steer, follow-up, and abort.

### 12.4 ShellRuntime

Uses a visible terminal and OSC 133 command boundaries. Command exit is evidence for the Attempt,
not sufficient Mission completion unless the Assignment contract declares that command and exit
code as its acceptance condition.

## 13. Normal execution movie: A delegates to B, B creates D

This scenario is the reference acceptance path.

### S0 — user starts Claude manually

The user opens a Charter terminal in the Charter repository and runs `claude`.

ExternalSessionService detects the foreground agent and binds:

```text
Terminal: term-A
Conversation Task: conv-A
External runtime: Claude
Mission: none
```

No Mission exists yet.

### S1 — user gives the objective

The user says:

```text
完成新的设置页面。把设置数据层和 UI 分开处理；如果测试失败，可以继续创建 agent 调查。
```

Claude A decides the work has independently verifiable parts and calls `orchestration.delegate`
for the settings data layer.

### S2 — agent-first promotion

The service derives CallerContext from `term-A` and `conv-A`. Because the caller is a recognized
external agent without a Mission, it atomically creates:

```text
Mission M1
Principal P-A
Lead Task T-A
Lead Assignment AS-A
Lead Attempt AT-A1 bound to the existing runtime
```

The existing Claude process continues. The promotion event enters `mission_events`; no replacement
terminal is created.

### S3 — A delegates B

A's request contains:

```json
{
  "goal": "Implement the settings persistence and data access layer",
  "acceptanceCriteria": [
    "Existing settings remain readable",
    "Updates are persisted atomically",
    "Unit tests cover upgrade and write failure"
  ],
  "expectedArtifacts": ["source changes", "unit-test results"],
  "requestedRuntime": "codex",
  "workMode": "isolated-write",
  "reason": "The data layer is independently testable and can proceed in parallel",
  "idempotencyKey": "M1/settings-data/v1"
}
```

The Mission transaction creates T-B, AS-B, AT-B1, an isolated-worktree request, event rows, and a
runtime-start outbox row.

### S4 — outbox starts B

After commit, the outbox runner creates the worktree and a visible Codex terminal. It binds the
runtime to AT-B1 before delivering the task preamble.

If the process starts twice because the outbox response is lost, the runtime adapter's idempotency
key resolves the existing session instead of creating a second Assignment.

### S5 — A delegates C in parallel

A creates UI Assignment AS-C. Its isolated worktree is separate from B's. Task T-E, final
integration, depends on both T-B and T-C.

### S6 — B discovers a test failure

B implements persistence, runs tests, and sees a migration-only failure it cannot quickly explain.
This is a bounded, independently verifiable investigation. The Skill instructs B to inspect its
Mission context and delegate directly.

B calls:

```json
{
  "goal": "Determine why the settings migration test fails only on upgraded databases",
  "acceptanceCriteria": [
    "Identify the failing state transition",
    "Provide a minimal reproduction",
    "Recommend a fix or prove the current implementation correct"
  ],
  "expectedArtifacts": ["failure analysis", "reproduction command"],
  "requestedRuntime": "claude",
  "workMode": "read-only",
  "reason": "The investigation can run independently while B reviews the implementation",
  "idempotencyKey": "M1/settings-data/migration-investigation/v1"
}
```

### S7 — host creates D without A

The service verifies only structural integrity:

- B is an active member of M1;
- M1 is running;
- the dependency insertion creates no cycle;
- the idempotency key is new;
- configured stability limits permit another runtime.

It does not ask A to proxy the call and does not create a per-agent permission request.

The transaction creates T-D, AS-D with `supervisor_assignment_id = AS-B`, and AT-D1.

### S8 — D reports a finding

D sends a structured progress message to B, then completes AT-D1 with a report artifact. Attempt
lifecycle verifies D's Principal and AT-D1 before accepting the completion.

T-D completes. The message wakes B's `orchestration.wait` call. A may observe the event in the
Mission activity stream but does not need to relay it.

### S9 — B completes

B applies the finding, runs its unit tests, and reports:

- files modified;
- test command and result;
- D's analysis artifact;
- a concise completion summary.

Acceptance validation completes T-B. The Task DAG reevaluates T-E but keeps it blocked until T-C is
also complete.

### S10 — integration and Mission completion

After T-C completes, T-E becomes ready. The Lead integrates worktrees, resolves conflicts, and runs
Mission-level verification.

Only after Mission acceptance succeeds does M1 enter `COMPLETED`. B, C, and D runtimes may remain
resident and idle until cleanup policy or the user closes them.

## 14. Failure and recovery movie

### F0 — first Attempt loses its runtime

AT-B1 is running when the Codex process exits unexpectedly. The runtime adapter reports the exit.

AttemptLifecycle marks AT-B1 `FAILED`; AS-B and T-B survive. Policy creates retry AT-B2 and a new
runtime.

### F1 — stale completion arrives

The old terminal reconnects or flushes buffered output and sends:

```json
{
  "attemptId": "AT-B1",
  "outcome": "success",
  "summary": "done"
}
```

The service observes:

```text
AS-B.active_attempt_id = AT-B2
message.attempt_id      = AT-B1
```

It stores the message as suppressed with reason `inactive_attempt`. T-B remains running. The stale
message does not wake completion waiters.

Without Attempt identity, this late result would incorrectly complete the retry and possibly the
Mission.

### F2 — app restarts while AT-B2 runs

SQLite persists Mission, Task, Assignment, Attempt, Message, event, and outbox state. Terminal
daemon metadata or runtime provider state may survive independently.

On startup:

1. MissionRepository loads nonterminal Missions.
2. OutboxRunner resumes unfinished side effects idempotently.
3. RuntimeRegistry asks each adapter to reconcile persisted runtime ids.
4. AttemptLifecycle compares live observations with leases and process state.
5. UI receives a new Mission snapshot after reconciliation, not before.

### F3 — runtime is found alive

If the daemon-backed terminal and Codex session still exist, the adapter rebinds them to AT-B2.
The Attempt remains running and its lease is renewed from observed activity or heartbeat.

No duplicate `workerCreated` event is written merely because Electron restarted.

### F4 — runtime is missing

If the runtime cannot be found, AT-B2 becomes `STALE` or `FAILED` according to policy. The
Assignment moves to a visible recovery state. Charter may retry automatically or surface it to the
Lead/user.

It never pretends that restored database rows prove an external process is still executing.

### F5 — supervisor runtime is lost

If A's runtime disappears while B and C are active, the Mission survives. Their Assignment tree
still references AS-A, but new parent-directed messages cannot be delivered.

The control plane marks the subtree's supervision state and applies configured recovery:

- recreate or resume A;
- temporarily pause children;
- reassign Lead to a live Mission member;
- ask the user to choose.

Children never become ownerless merely because a terminal exited.

### F6 — recovery succeeds

After A is resumed or Lead is reassigned, undelivered messages remain available by sequence. Active
Attempts continue or retry. Mission verification eventually runs against persisted artifacts and
current workspace state, not against the assumption that every pre-restart runtime succeeded.

## 15. Concurrency and idempotency

### 15.1 Delegate transaction

`delegate` follows this order:

1. Resolve trusted CallerContext.
2. Begin an immediate database transaction.
3. Load and version-check Mission and caller Assignment.
4. Check for an existing operation with the same idempotency key.
5. Validate Task dependencies and cycles.
6. Insert Task, dependency edges, Principal placeholder if needed, Assignment, and Attempt.
7. Insert Mission events and runtime-start outbox row.
8. Commit.
9. Let OutboxRunner perform external side effects.

The service never starts a terminal and then hopes it can record the Assignment afterward.

### 15.2 Completion transaction

`complete` follows this order:

1. Resolve CallerContext.
2. Load Attempt and Assignment.
3. Require caller Principal and active Attempt match.
4. Persist artifacts and verification references.
5. Run deterministic acceptance policy.
6. Mark Attempt terminal.
7. Update Assignment and Task.
8. Promote newly ready dependent tasks.
9. Append messages and Mission events.
10. Commit, then wake waiters.

Waiters wake only after commit.

### 15.3 Optimistic versions

Mission and Task mutable rows use integer versions. Conflicting reassign, cancel, or completion
operations fail with a typed conflict and return the latest state for retry.

## 16. Work isolation and integration

### 16.1 Isolated-write Assignment

Before starting a write Attempt, Charter creates or reuses a worktree keyed by Assignment. The
runtime starts inside that path. Mission metadata records base revision and integration target.

### 16.2 Shared-write Assignment

Shared writes are allowed because this is the user's computer and Mission policy is permissive.
However, UI and structured context must say that isolation is absent. File accounting records the
active Attempt when attribution is reliable and marks ambiguity when two write windows overlap.

### 16.3 Integration

Completion of a write Task means its worktree satisfies its local contract. It does not mean the
changes are already in the Mission target tree.

Integration is a distinct Task or Lead action with:

- source Assignment/worktree ids;
- base and head revisions;
- conflict outcome;
- post-integration verification;
- artifact lineage.

## 17. UI information architecture

V2 is conversation-first, but a Mission is a first-class product object above conversations,
Agents, Tasks, Attempts, and terminals. Compatibility with V1 data does not imply compatibility
with the V1 Fleet interaction model.

### 17.1 Conversation surface

When a current Claude/Codex conversation becomes Lead, its room gains a compact Mission status
entry:

```text
In progress · Refactor settings
2 of 5 work items done · 2 working · 1 needs you
```

The user can keep talking in the same conversation. Opening Mission is optional.

### 17.2 Global Mission Center

The activity bar has a first-class Missions destination. It lists active Missions, review-ready
Missions, attention counts, and recent terminal Missions. Completed evidence remains available
after restart. Mission Center is not nested under a commander Session and never uses worker count
as its primary unit.

### 17.3 Mission Workbench

Workbench follows the user's outcome-oriented sequence:

1. **Work** combines Task hierarchy, responsibility, current owner, latest update, and explicit
   dependencies in one work map. The user does not reconcile a separate Team tree and Task graph.
2. **Needs you** is a durable decision and recovery queue above the work map. Questions and
   escalations remain actionable until an answer is recorded on their message thread.
3. **Updates** is a readable Mission history for delegation, progress, decisions, handoffs, and
   completion.
4. **Results** groups Mission acceptance criteria, Task outcomes, verification, changed files, and
   deliverables. Review-ready Missions open here by default.

Selecting work opens an inspector. Goal, owner, outcome, evidence, and guidance are primary;
Assignment ids, Attempt state, runtime session identity, Lead promotion, reassignment, and resident
runtime controls are disclosed as advanced details.

### 17.4 Runtime focus

Selecting an Assignment reveals its current Attempt and runtime. Opening or switching a runtime is
observation. Takeover is an explicit action. The product does not treat viewing a terminal as a
control transfer.

### 17.5 Required user actions

The user can:

- pause or resume one runtime or a subtree;
- steer an Agent;
- retry an Assignment;
- cancel an Assignment or Mission;
- reassign a Task;
- promote a new Lead;
- open artifacts and verification evidence;
- request changes during Mission review. This reopens the existing Lead Assignment with a new
  Attempt, records the user's feedback durably, and returns the Mission to `RUNNING`;
- accept the reviewed Mission;
- close resident runtimes independently of Task state.

### 17.6 Snapshot DTO

Replace the flat `workers[]` model with a normalized snapshot:

```ts
interface MissionSnapshotDto {
  mission: MissionDto;
  principals: PrincipalDto[];
  assignments: AssignmentDto[];
  tasks: MissionTaskDto[];
  dependencyEdges: TaskDependencyDto[];
  attempts: ExecutionAttemptDto[];
  runtimeSessions: RuntimeSessionDto[];
  unreadMessages: OrchestrationMessageDto[];
  decisions: MissionDecisionDto[];
}
```

Renderer stores derive the work map, decision queue, results, and inspector from ids. They do not
rebuild authority or lifecycle semantics from terminal rows.

## 18. Service and file plan

### 18.1 New domain package

```text
packages/orchestration-domain/
├── package.json
└── src/
    ├── index.ts
    ├── mission.ts
    ├── mission-task.ts
    ├── task-dependency-graph.ts
    ├── principal.ts
    ├── assignment.ts
    ├── execution-attempt.ts
    ├── orchestration-message.ts
    ├── mission-execution-policy.ts
    └── state-machines.ts
```

The package is pure TypeScript: schemas, state transitions, graph validation, and invariants. It
does not import Electron, SQLite, terminal, or provider code.

### 18.2 Persistence

Modify:

```text
packages/persistence/src/migrations.ts
packages/persistence/src/index.ts
```

Add:

```text
packages/persistence/src/mission-repository.ts
packages/persistence/src/mission-repository.test.ts
```

Migration tests must cover fresh database, upgrade from migration 8, checksum verification,
failure rollback, and foreign-key integrity.

### 18.3 Main-process control plane

Add:

```text
apps/desktop-main/src/services/mission-orchestration-service.ts
apps/desktop-main/src/services/attempt-lifecycle.ts
apps/desktop-main/src/services/orchestration-message-bus.ts
apps/desktop-main/src/services/orchestration-outbox-runner.ts
apps/desktop-main/src/services/mission-runtime-registry.ts
apps/desktop-main/src/services/mission-recovery.ts
```

Avoid vague `helpers` or `utils` modules. Each file owns one named domain responsibility.

### 18.4 Runtime adapters

Add:

```text
apps/desktop-main/src/services/orchestration-runtimes/visible-terminal-runtime.ts
apps/desktop-main/src/services/orchestration-runtimes/external-cli-runtime.ts
apps/desktop-main/src/services/orchestration-runtimes/managed-agent-runtime.ts
apps/desktop-main/src/services/orchestration-runtimes/shell-runtime.ts
```

Refactor:

```text
apps/desktop-main/src/services/terminal-control-service.ts
apps/desktop-main/src/services/external-session-service.ts
apps/desktop-main/src/services/agent-host.ts
packages/agent-contract/src/worker-protocol.ts
```

V1 behavior remains behind compatibility adapters until migration is complete.

### 18.5 Tool Gateway and CLI

Add:

```text
packages/tool-gateway/src/tools-orchestration.ts
packages/tool-gateway/src/tools-orchestration.test.ts
apps/desktop-main/src/services/orchestration-rpc-server.ts
apps/desktop-main/src/services/orchestration-rpc-server.test.ts
apps/desktop-main/src/cli/orchestration-cli.ts
```

If the existing CLI package is moved or split during implementation, preserve one canonical
command grammar and RPC client rather than duplicating logic in Electron and scripts.

### 18.6 Skill and optional MCP

Add a bundled managed Skill under the existing skills distribution mechanism:

```text
charter-orchestration/SKILL.md
```

The exact package path should follow the current managed-skills catalog rather than introducing a
second installation system.

Refactor the existing terminal MCP integration into a thin compatibility adapter after CLI/RPC is
working. MCP method handlers call the same orchestration service and share schemas with native
tools.

### 18.7 IPC and renderer

Modify or add:

```text
packages/ipc-contracts/src/orchestration.ts
apps/desktop-main/src/ipc/orchestration-handlers.ts
apps/desktop-renderer/src/store/orchestrationStore.ts
apps/desktop-renderer/src/views/MissionCenterView.tsx
apps/desktop-renderer/src/views/MissionView.tsx
apps/desktop-renderer/src/views/mission/MissionStatusStrip.tsx
apps/desktop-renderer/src/views/mission/MissionRailPanel.tsx
apps/desktop-renderer/src/views/mission/MissionWorkMap.tsx
apps/desktop-renderer/src/views/mission/MissionDecisionPanel.tsx
apps/desktop-renderer/src/views/mission/MissionActivity.tsx
apps/desktop-renderer/src/views/mission/MissionResults.tsx
apps/desktop-renderer/src/views/mission/RuntimeInspector.tsx
apps/desktop-renderer/src/views/mission/mission-view-model.ts
```

Existing SessionRail and TaskRoom surfaces receive compact Mission projections rather than owning
Mission state.

## 19. Implementation sequence

### Phase 0 — decision and contracts

- Accept this design or record amendments.
- Add a successor ADR that identifies which ADR-0044 decisions remain compatibility behavior.
- Freeze domain names and state machines.
- Freeze CLI and tool schemas.
- Add feature flags without changing current behavior.

Exit criterion: domain and API review agrees that terminal, Agent, Task, Assignment, and Attempt are
not aliases.

### Phase 1 — domain and migration

- Implement the pure domain package.
- Add migration 9 and MissionRepository.
- Implement DAG cycle and readiness logic.
- Implement Assignment tree invariants.
- Add idempotency and outbox storage.

Exit criterion: repository tests can construct A → B → D, persist a Task DAG, reopen the database,
and return the same state.

### Phase 2 — control plane without real agents

- Implement MissionOrchestrationService against mock runtime adapters.
- Implement delegate, message, wait, progress, complete, cancel, retry, and reassign.
- Implement active-Attempt validation and stale-message suppression.
- Implement event-driven waiter wakeup after commit.

Exit criterion: deterministic integration tests pass without Electron or provider processes.

### Phase 3 — managed agent runtime

- Extend AgentHost active-run context.
- Bind managed tool calls to Mission CallerContext.
- Start a managed child from a parent managed Agent.
- Support B creating D.
- Route structured completion and artifacts.

Exit criterion: mock or Pi managed runtime completes the recursive reference scenario.

### Phase 4 — visible terminal and external CLI runtime

- Extract visible terminal runtime operations.
- Adapt ExternalSessionService.
- Promote a manually started Claude/Codex session in place.
- Start visible Claude/Codex child runtimes.
- Preserve takeover, pause, and resident-session behavior.

Exit criterion: the user can start Claude manually, ask it to delegate, and see B and D appear as
real inspectable runtimes.

### Phase 5 — Skill, CLI, and RPC

- Ship `charter orchestration` CLI.
- Ship the `charter-orchestration` Skill.
- Use JSON schemas shared with native tools.
- Add long-wait keepalive and cancellation.
- Keep MCP as a thin optional adapter.

Exit criterion: recursive orchestration works with MCP removed from the test environment.

### Phase 6 — worktree integration and verification

- Default write Assignments to isolated worktrees.
- Link artifacts, file changes, and verification records.
- Add Integration Task behavior.
- Detect and surface ambiguous shared writes.

Exit criterion: two parallel writers cannot silently overwrite the same Mission target tree under
the default policy.

### Phase 7 — recovery and fault injection

- Rehydrate Missions at startup.
- Reconcile daemon terminals and provider sessions.
- Resume outbox work idempotently.
- Add Attempt leases and parent-loss behavior.
- Test crash boundaries before and after every external side effect.

Exit criterion: restart does not duplicate an Assignment or accept stale completion.

### Phase 8 — UI and compatibility rollout

- Add normalized Mission snapshot IPC.
- Add Mission Center, work map, decision queue, updates, results, and a secondary runtime inspector.
- Project compact outcome/progress status into existing conversation surfaces.
- Remove V2 from the `conversation | fleet` navigation and worker-count shortcuts.
- Keep V1 Fleet reachable only through an explicitly labeled legacy compatibility action.
- Migrate new Missions first; do not rewrite old task history destructively.

Exit criterion: a user can understand and control the reference scenario without opening raw
database or terminal logs.

## 20. Compatibility and migration

### 20.1 Existing V1 fleets

Existing `orchestration.worker*` task events remain readable. V2 does not reinterpret every historic
terminal relation as a Mission automatically.

Options during rollout:

- V1 sessions continue through the legacy facade;
- a live eligible commander may explicitly promote its current formation;
- new delegate calls use V2;
- replay labels old fleet events as legacy orchestration.

### 20.2 Existing external sessions

An external Claude/Codex conversation keeps its current Task and file-accounting records. Mission
promotion adds references; it does not move or duplicate the conversation row.

### 20.3 Rollback

Feature flags can stop new V2 Mission creation and hide V2 UI. Persisted Mission data remains
readable and exportable. Rollback never deletes Mission tables or attempts to squeeze their state
back into V1 worker events.

## 21. Observability

Every Mission state change includes:

- mission id;
- actor Principal id;
- Assignment and Attempt ids when applicable;
- operation id/idempotency key;
- previous and next state;
- runtime kind;
- duration and outcome;
- sanitized error code.

Metrics:

- active Missions;
- active Assignments and runtimes by kind;
- delegate latency;
- runtime-start latency and failure rate;
- retries per Assignment;
- stale completion suppression count;
- outbox backlog and oldest age;
- message delivery and wait latency;
- recovery outcomes after restart;
- worktree conflicts and integration failures.

Terminal output and secrets are not copied into Mission events. Artifact references and bounded
sanitized summaries are preferred.

## 22. Security boundary after removing per-agent permissions

This design intentionally removes per-agent authorization. It does not remove basic process and data
integrity.

Still enforced:

- caller identity is derived, not self-declared;
- target must belong to the same Mission;
- socket files and attach tickets are protected from unrelated local clients;
- schema and size limits apply;
- global product safety walls remain where Charter already refuses impossible or catastrophic
  operations;
- provider-native permissions remain provider concerns;
- audit attributes every action;
- the user master switch and immediate cancel remain available.

Not implemented:

- parent-to-child capability attenuation;
- separate filesystem capabilities per Agent;
- per-child interactive approvals;
- role-based ACLs among Mission members;
- Agent-specific allow/deny rule sets.

The Mission is the trust boundary. Joining a Mission grants the Mission's full execution policy.

## 23. Test matrix

| Injection or action | Expected observation | Forbidden false positive |
| --- | --- | --- |
| A delegates B | one Task, Assignment, Attempt, runtime-start outbox row | terminal exists without durable Assignment |
| same delegate request repeats | `reused: true`, same ids | second worker/runtime |
| B delegates D | D parent is B; no A proxy call | depth-limit error or user permission card |
| B messages C | persisted ordered message delivered to C | Assignment tree changes |
| wrong Mission targets an id | typed target mismatch | unrelated runtime receives action |
| old Attempt completes late | message suppressed and audited | current Task completes |
| foreign Principal claims Attempt | typed lifecycle rejection | Task or heartbeat changes |
| dependency completes | all-satisfied dependents become ready transactionally | partially satisfied task becomes ready |
| cycle insertion attempted | entire delegate transaction rolls back | partial Task/Assignment remains |
| runtime create response is lost | outbox retry resolves existing runtime | duplicate visible tab |
| Electron restarts | state rehydrates, runtime reconciles | database row treated as proof of liveness |
| supervisor runtime exits | subtree shows recovery state | children silently become ownerless |
| user takes over terminal | injections queue until handback | agent input interleaves with user input |
| write agents run in parallel | isolated worktrees by default | silent same-tree overwrite |
| MCP configuration removed | Skill + CLI and managed path still work | Mission feature disappears |
| Mission completion requested | acceptance and verification run | self-report alone completes Mission |

## 24. Acceptance criteria

### Recursive delegation

- A can create B and B can create D.
- B's delegate call does not require A to send a command or approve a request.
- No hard-coded orchestration depth exists.
- Resource limits are configurable or disabled.

### Unified Mission permissions

- B, C, and D inherit the same Mission execution policy as A.
- No delegation-grant or per-agent permission record is created.
- Mission membership still prevents cross-Mission target mistakes.

### Skill-first operation

- A bundled Skill explains delegation decisions and protocol.
- The complete reference scenario works through CLI + local RPC.
- MCP is removable without losing core functionality.

### Lifecycle correctness

- Task, Assignment, Attempt, and Runtime ids remain distinct.
- Duplicate delegate calls are idempotent.
- Stale and foreign completion messages cannot mutate the active Attempt.
- Task completion is separate from runtime exit or output quietness.

### Recovery

- App restart restores durable Mission state.
- Runtime liveness is reconciled rather than assumed.
- Outbox work resumes without duplicate side effects.
- Parent loss has a visible pause/resume/reassign path.

### Product experience

- A manually started Claude/Codex can become Lead in place.
- Worker runtimes are visible or inspectable.
- User takeover, pause, cancel, retry, and reassign are available.
- Team tree and Task DAG are shown as different views.

## 25. Non-goals for the first production release

- cross-device distributed Mission execution;
- organization-level multi-user ACLs;
- marketplace scheduling of remote agents;
- automatic economic optimization across providers;
- unbounded autonomous creation without user-configurable stability controls;
- inferring canonical completion solely from terminal text;
- rewriting all historic V1 fleet data into V2 tables;
- requiring a dedicated Mission screen before agent-first use.

## 26. Open implementation choices that do not change the architecture

The following may be decided during implementation:

- exact CLI binary packaging and command aliases;
- whether external attach ships in the first release or the next one;
- lease durations and retry backoff defaults;
- default maximum concurrent agents;
- exact UI placement of the compact Mission entry;
- whether Integration is always a Task or may be a Lead action for trivial changes;
- which managed model is the default child runtime.

These choices do not alter the core contracts: Mission state is native, Skill teaches behavior,
CLI/RPC is canonical, MCP is optional, permissions are Mission-wide, and execution is represented by
replaceable Attempts.

## 27. Review checklist

Before accepting an implementation patch, trace every changed operation through:

```text
caller identity
→ input schema
→ CLI/native/MCP adapter
→ Mission service
→ transaction and outbox
→ runtime side effect
→ observation/message
→ lifecycle reconciliation
→ persisted state
→ renderer snapshot
```

Reject a patch if it:

- uses terminal id as Task or Assignment id;
- allows renderer state to become Mission authority;
- marks completion from quiet output alone;
- starts a runtime before durable idempotent intent exists;
- trusts payload-supplied caller identity;
- adds a second Mission database behind MCP;
- makes the Skill the only protection for a state invariant;
- reintroduces per-agent permission prompts;
- stores Task dependencies only as unvalidated JSON;
- rebuilds current state exclusively by folding terminal events;
- treats a successful runtime start as successful Assignment completion;
- couples worker process lifetime to Task lifetime.

## 28. Source anchor index

The design is a proposal, but its assessment of current behavior is grounded in these inspected
source paths.

### Charter

- `apps/desktop-main/src/services/terminal-control-service.ts:138` — current in-memory
  `WorkerRelation`.
- `apps/desktop-main/src/services/terminal-control-service.ts:418` — current visible worker create
  path.
- `apps/desktop-main/src/services/terminal-control-service.ts:878` — current flat worker snapshot.
- `apps/desktop-main/src/services/terminal-control-service.ts:1323` — fixed top-level/depth guard.
- `packages/tool-gateway/src/tools-terminal.ts:6` — current caller identity is task id plus optional
  terminal id.
- `packages/tool-gateway/src/tools-terminal.ts:60` — terminal capability lane uses auto-allow.
- `apps/desktop-main/src/services/ctl-server.ts:93` — HTTP over the mode-0600 Unix socket and the
  shared Gateway path.
- `apps/desktop-main/src/services/terminal-control-integration.ts:50` — ephemeral Claude/Codex MCP
  wrappers currently installed in `userData`.
- `apps/desktop-main/src/index.ts:541` — persisted mode-0600 HMAC identity secret.
- `apps/desktop-main/src/index.ts:981` — external CLI session wiring and terminal turn events.
- `apps/desktop-main/src/services/external-session-service.ts:900` — product-launched and manually
  detected external-session binding.
- `apps/desktop-main/src/services/agent-host.ts:268` — managed runtime event and tool-request routing.
- `packages/agent-contract/src/worker-protocol.ts:25` — current task/run worker protocol.
- `packages/persistence/src/migrations.ts:21` — current conversation Task table.
- `packages/persistence/src/migrations.ts:52` — current task-bound agent sessions.
- `packages/persistence/src/migrations.ts:337` — migration 8, the current schema tip at the inspected
  revision.
- `apps/desktop-main/src/services/task-service.ts:2500` — current orchestration fleet event
  projection.
- `packages/ipc-contracts/src/orchestration.ts:3` — current flat orchestration worker DTO.

### FanBox

- `/Users/edy/git/fanbox/skills/fanbox-agent/SKILL.md:23` — Skill invokes local HTTP through `curl`.
- `/Users/edy/git/fanbox/electron/main.js:523` — PTY spawn and injected control environment.
- `/Users/edy/git/fanbox/electron/main.js:656` — input normalization and bracketed paste.
- `/Users/edy/git/fanbox/electron/main.js:666` — renderer-receipted visible terminal creation.
- `/Users/edy/git/fanbox/electron/main.js:695` — incremental output/quiet/regex wait.
- `/Users/edy/git/fanbox/server.js:2382` — `/api/agent/*` HTTP dispatch.
- `/Users/edy/git/fanbox/docs/12-Agent控制接口-本机HTTP.md:55` — MCP described as future thin proxy,
  not the current control implementation.

### Orca

- `/Users/edy/git/orca/src/main/runtime/orchestration/types.ts:1` — typed messages, Task states, and
  DispatchContext shape.
- `/Users/edy/git/orca/src/main/runtime/orchestration/db.ts:111` — message, Task, and dispatch tables.
- `/Users/edy/git/orca/src/main/runtime/orchestration/db.ts:513` — Task creation and initial readiness.
- `/Users/edy/git/orca/src/main/runtime/orchestration/db.ts:604` — dependency completion promotion.
- `/Users/edy/git/orca/src/main/runtime/orchestration/db.ts:645` — dispatch creation and active
  assignee lock.
- `/Users/edy/git/orca/src/main/runtime/orchestration/db.ts:787` — active-dispatch heartbeat update.
- `/Users/edy/git/orca/src/main/runtime/orchestration/db.ts:809` — retry failure count and circuit
  breaker.
- `/Users/edy/git/orca/src/main/runtime/orchestration/lifecycle-reconciliation.ts:16` — sender
  lifecycle authority.
- `/Users/edy/git/orca/src/main/runtime/orchestration/lifecycle-reconciliation.ts:105` — heartbeat
  reconciliation.
- `/Users/edy/git/orca/src/main/runtime/orchestration/lifecycle-reconciliation.ts:155` — completion
  reconciliation and stale-attempt rejection.
- `/Users/edy/git/orca/src/main/runtime/orchestration/preamble.ts:65` — worker completion, heartbeat,
  decision, and escalation protocol.
- `/Users/edy/git/orca/src/main/runtime/orchestration/coordinator.ts:185` — decomposition is not
  implemented in the inspected coordinator.
- `/Users/edy/git/orca/src/main/runtime/orchestration/coordinator.ts:207` — stale dispatches currently
  warn rather than auto-fail.
- `/Users/edy/git/orca/src/cli/handlers/orchestration.ts:338` — orchestration CLI to runtime RPC.
- `/Users/edy/git/orca/src/cli/runtime/transport.ts:7` — Unix socket/named-pipe transport.

## 29. Final product statement

Charter Mission orchestration is a native, durable team-management system. Agents learn to use it
through a Skill. They reach it through CLI + local RPC or native tools. MCP is optional. Every member
of a Mission shares the same execution permissions, while the host preserves identity, state,
idempotency, dependency, lifecycle, and recovery correctness.

The user manages the objective and can take the wheel. The Lead manages the team. Any worker may
create another worker when the work justifies it. Charter owns the durable truth that makes those
agents a recoverable product rather than a collection of terminals sending text to each other.
