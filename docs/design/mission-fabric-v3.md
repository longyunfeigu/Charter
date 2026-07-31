# Mission Fabric V3 — implemented product contract

- Status: Implemented, pending product-owner acceptance
- Date: 2026-07-31
- Supersedes: `mission-orchestration-v2.md`
- Scope: recursive delegation, direct peer communication, durable delivery, ACP runtimes, recovery,
  runtime-aware UI, CLI/Skill/MCP/native tool parity

## 1. Product decision

Charter is no longer a fixed parent-to-child terminal launcher. A Mission is a durable team whose
members may delegate work recursively and communicate directly:

```text
User
└── A — Lead
    ├── B — coordinator
    │   └── D — specialist created by B
    └── C — reviewer

B ── question/thread ──> C
C ── answer/thread ────> B
```

The responsibility tree, dependency graph, communication graph, and runtime topology are separate:

- an Assignment has one supervisor and forms the responsibility tree;
- Tasks and normalized dependency edges form the work-ordering DAG;
- messages may connect any two members of the same Mission;
- Claude, Codex, managed agents, ACP sessions, and visible terminals are runtime choices.

The user does not need to start from a special Mission screen. A manually opened Claude or Codex
session is promoted in place when it first uses a Mission command. Its conversation stays intact
and becomes the Lead's working surface.

## 2. What Skill, RPC, MCP, and ACP each do

They are complementary layers rather than interchangeable alternatives:

```text
Skill/manual
  teaches the model when and how to coordinate
          │
          ▼
One command contract
  inspect/delegate/message/ask/join/complete/...
          │
    ┌─────┼──────────────┐
    ▼     ▼              ▼
 native  CLI/socket RPC  MCP compatibility adapter
    └─────┴──────┬───────┘
                 ▼
      MissionOrchestrationService
                 │
     SQLite + event-first message bus
                 │
      runtime adapter + outbox
          ┌──────┴────────┐
          ▼               ▼
      ACP session     visible PTY fallback
```

- Skill is instruction and discoverability. It cannot own state, wake a waiting process, make a
  transaction atomic, or recover after restart.
- Local RPC is the host control path used by the CLI.
- MCP is a generated compatibility projection for external sessions already able to call MCP
  tools. It is not the source of truth.
- ACP is the process/session protocol between Charter and a Claude/Codex runtime. It replaces one
  terminal per background worker with structured, multiplexed sessions.

All four surfaces are generated from or route into the same command registry. Adding a Mission
command in only one surface is treated as a defect.

## 3. Complete command contract

The canonical registry is
`packages/tool-gateway/src/orchestration-command-registry.ts`.

| Command | Product behavior |
| --- | --- |
| `inspect` | Read the caller's Mission snapshot and identity |
| `sync` | Fetch durable inbox changes after a cursor and acknowledge observations |
| `delegate` | Atomically create one Task, Assignment, Attempt, and runtime-start event |
| `delegate_many` | Atomically create sibling work and start independent children concurrently |
| `message` | Send a durable Mission message to another member |
| `reply` | Reply on the original durable thread |
| `ask` | Send a question and wait event-first for its threaded answer |
| `wait` | Wait event-first for matching inbox messages |
| `join` | Wait event-first for a set of Assignments to reach terminal states |
| `progress` | Record structured progress and renew the active Attempt heartbeat |
| `complete` | Finish the current Attempt with outcome, summary, and evidence |
| `escalate` | Route a blocker or decision to supervisor, Lead, or user |
| `pause` / `resume` | Hold or release new input without corrupting the current turn |
| `cancel` | Cancel Assignment and active runtime |
| `retry` | Create a new Attempt; stale completions cannot win |
| `steer` | Deliver new direction at a safe turn boundary |
| `reassign` | Replace the assignee and create a fresh Attempt |

`delegate_many` is a transaction, not a loop around `delegate`: if any child is invalid, none is
created. Runtime starts are emitted only after the transaction commits. Independent aggregates are
started in parallel; events for the same aggregate preserve order.

## 4. Runtime architecture

### 4.1 ACP pool

`AcpProcessPool` starts at most one long-lived adapter process per provider and creates multiple
independent ACP sessions inside it. Two Codex children therefore use:

```text
one codex-acp process
├── ACP session B
└── ACP session C
```

Each session receives:

- its own Mission identity and active Attempt;
- its own initial prompt and working directory;
- a session-scoped Charter MCP bridge;
- streamed runtime events;
- a durable inbox and safe delivery queue.

Claude and Codex use official ACP adapters. If ACP cannot start or negotiate, the
`FallbackRuntimeAdapter` starts the existing visible PTY runtime so Mission execution remains
available.

### 4.2 Turn-safe delivery

Messages are not pasted into a model while it is generating. The runtime adapter:

1. persists a delivery record;
2. coalesces pending doorbells for that Assignment;
3. if the session is busy or paused, queues the doorbell;
4. after `turn.stopped`, prompts the Agent to call `sync`;
5. marks delivery `DELIVERED`, `READ`, or `FAILED`.

Message content remains in SQLite; the doorbell is only a wake-up signal. Duplicate wake-ups do
not duplicate the message.

### 4.3 Provider permissions

Charter does not create a second per-child permission system. Mission children reuse the host and
provider permission policy already granted on the machine. ACP permission requests choose the
provider's `allow_always` option when offered, otherwise `allow_once`.

Mission membership still scopes coordination: a caller may only address Assignments in its own
Mission, and Attempt identity prevents a replaced runtime from completing current work.

## 5. Durable state and recovery

Migration `mission-fabric-runtime-and-delivery` adds:

- `orchestration_runtime_sessions`;
- `orchestration_runtime_events`;
- `orchestration_message_deliveries`.

The Mission snapshot exposes those records to the renderer and tests. Runtime bindings persist
provider, transport, external session id, process key, capabilities, and state.

On application restart:

- undelivered messages are scheduled again;
- a provider supporting ACP `session/load` is reattached to its prior external session;
- a missing or unsupported runtime follows the existing orphan/retry reconciliation path;
- an Attempt already replaced by retry or reassign cannot publish a successful completion;
- `ask`, `wait`, and `join` use in-process events while running and durable state as the recovery
  source, never terminal-output polling.

## 6. User stories

### Agent-first

1. The user opens Claude in Charter and describes a large goal.
2. Claude calls `delegate_many` for independent B and C work.
3. Charter promotes Claude to Mission Lead without restarting the conversation.
4. Codex B and C run as parallel ACP sessions without adding terminal tabs.
5. B discovers it needs C's judgment and calls `ask` directly.
6. C receives a durable doorbell, calls `sync`, and replies on the same thread.
7. B finishes after the answer; A calls `join`, reviews both results, and completes.
8. The user sees one Mission with an auditable work map, messages, evidence, and runtime details.

### Recursive delegation

1. B finds a bounded specialist problem during its work.
2. B calls `delegate` and becomes D's supervisor.
3. D reports progress and completion directly to B.
4. A can inspect or steer D because Mission control is Mission-wide, but A does not proxy B's
   creation call.

### User intervention

1. The user selects an active Assignment.
2. `Guide this work` persists a steer request.
3. Busy runtimes receive it after the current turn; paused runtimes retain it until resume.
4. Pause, resume, cancel, retry, and reassign are real lifecycle commands whose states are shown
   from persisted domain data.

## 7. UI contract

Mission Center and Mission Workbench are the canonical product surfaces:

- Work Map shows recursive ownership and dependency state.
- Updates shows durable communication and delivery state.
- Results shows completion summaries and evidence.
- Runtime details show requested runtime, actual transport, process/session identity, lifecycle
  state, last streamed event, and inbox delivery counts.
- ACP background work shows `ACP event stream`; it does not offer a fake terminal-opening action.
- terminal-backed work exposes its real working session.
- terminal Assignment states render a terminal icon/state, never a spinner derived from an
  unrelated terminal process.

A Mission with all Assignments completed moves to `Ready to review`; the user accepts or rejects the
result rather than watching an indefinitely busy Lead process.

## 8. Implementation map

| Concern | Source |
| --- | --- |
| Domain state machines and dependency graph | `packages/orchestration-domain/src/` |
| SQLite repository and atomic operations | `packages/persistence/src/mission-repository.ts` |
| Runtime/delivery migration | `packages/persistence/src/migrations.ts` |
| Command schemas and generated tool surfaces | `packages/tool-gateway/src/orchestration-command-registry.ts` |
| Mission application service | `apps/desktop-main/src/services/mission-orchestration-service.ts` |
| Event-first waits and subscriptions | `apps/desktop-main/src/services/orchestration-message-bus.ts` |
| Parallel outbox and durable doorbells | `apps/desktop-main/src/services/orchestration-outbox-runner.ts` |
| ACP pool and fallback adapter | `apps/desktop-main/src/services/acp-runtime.ts` |
| Visible terminal adapter | `apps/desktop-main/src/services/visible-terminal-runtime.ts` |
| Restart reconciliation | `apps/desktop-main/src/services/orchestration-recovery-service.ts` |
| CLI and MCP bridge | `terminal-control-cli.ts`, `terminal-control-mcp.ts` |
| Agent manual/Skill content | `apps/desktop-main/src/services/orchestration-manual.ts` |
| Mission UI | `apps/desktop-renderer/src/views/MissionCenterView.tsx`, `MissionView.tsx`, `mission/` |

## 9. Acceptance evidence

The default automated suite covers schema parity, state transitions, authorization, idempotency,
atomic delegation, parallel scheduling, retry safety, recovery, message delivery, turn boundaries,
IPC, CLI, MCP, renderer state, and Electron UI.

Provider tests are opt-in so ordinary CI does not consume live credentials:

```bash
RUN_REAL_ACP=codex npx vitest run \
  apps/desktop-main/src/services/acp-runtime.real.test.ts

RUN_REAL_ACP=claude npx vitest run \
  apps/desktop-main/src/services/acp-runtime.real.test.ts
```

The complete product path is:

```bash
CHARTER_LIVE_FABRIC=1 \
CHARTER_LIVE_WORKSPACE=/path/to/workspace \
npx playwright test \
  --config tests/e2e/playwright.config.ts \
  tests/e2e/mission-fabric-live-acp.spec.ts
```

That test proves with real providers:

- one visible Claude Lead;
- exactly two parallel Codex ACP child sessions;
- one shared Codex adapter process;
- a durable B-to-C question and C-to-B threaded answer;
- all three Attempts succeeded;
- the Mission reached `VERIFYING` / Ready to review;
- zero background Codex terminal tabs;
- runtime event and UI state agreement;
- no renderer page errors.

Screenshots are written under `/tmp` and test user data is removed after the app closes.

### Five-Agent communication matrix

The live matrix exercises three different topologies with one visible Lead and four real
Claude/Codex workers:

```bash
CHARTER_LIVE_FABRIC=1 \
npx playwright test \
  tests/e2e/mission-fabric-live-multi-agent.spec.ts \
  --workers=1
```

| Example | Topology | Required communication proof |
| --- | --- | --- |
| Recursive tree | A delegates B/C; B delegates D/E | D asks C across ownership levels, C replies on the same thread, and E reports progress to B |
| Durable handoff chain | A supervises B → C → D → E | Three alternating Claude/Codex handoffs are persisted and observed before the next stage completes |
| Parallel fan-in | B/C/D → E → A | E observes three independent inputs, aggregates them, and sends one completion message upward |

Every example requires five successful Assignments and Attempts, `VERIFYING` Mission state,
`observed` delivery records for every asserted message, one shared ACP process per provider, zero
background worker terminal tabs, and a Mission UI showing `5/5`. The screenshots are:

- `/tmp/charter-fabric-example-1-tree.png`
- `/tmp/charter-fabric-example-2-chain.png`
- `/tmp/charter-fabric-example-3-fanin.png`

Visible Codex sessions are launched with explicit forwarding of `CHARTER_CTL` and
`CHARTER_CTL_TOKEN` to their stdio MCP server. Their MCP tool timeout exceeds Charter's maximum
one-hour blocking wait. Deferred initial prompts wait for the provider composer to be ready, and
the optional Codex update prompt is skipped without modifying the installed CLI.

## 10. Non-goals

- no arbitrary cross-Mission control;
- no unbounded autonomous agent creation outside configured Mission limits;
- no terminal output scraping as a source of lifecycle truth;
- no replacement of Skills with MCP or MCP with Skills;
- no requirement that every background ACP session be rendered as a terminal;
- no silent commit, push, merge, or destructive workspace action.
