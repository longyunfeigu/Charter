# ADR-0044: Session orchestration — terminal.* tools, per-terminal identity door, grow-in-place command UI

- Status: Accepted (product owner decisions, 2026-07-21: grow-in-place direction over a dedicated
  fleet page; fusion-mockup details — 44px child rows, numeric needs badges, two-column tiles, both
  pause granularities; director-stage defaults — commander-room only, snapshot lookback, auto mode
  default; M12 ships first, this lands as the M13 track)
- Date: 2026-07-21
- Related: ORCH-001..012 (new, expanded in IMPLEMENTATION_BACKLOG), ADR-0002 (process topology),
  ADR-0006 (task modes), ADR-0015 (managed skills store), ADR-0017 (external sessions / agent
  detect), ADR-0021 (OSC 133 shell integration), ADR-0023 (grouped session rail), ADR-0030 (external
  room single input), PIVOT-013/014 (needs-you + notifications). Approved mockups:
  `docs/design/agent-orchestration-fusion-mockup.html` (baseline),
  `docs/design/agent-orchestration-v3-director-stage.html` (director overlay). External reference
  input: alchaincyf/fanbox `docs/12-Agent控制接口-本机HTTP.md` (v2.7 agent control interface and its
  three-tier token analysis).

## Context

Charter already treats terminals and external CLI sessions as first-class citizens: node-pty
terminals with agent-CLI detection (ADR-0017), OSC 133 semantic command marks with real exit codes
(ADR-0021), external claude/codex sessions rendered as rooms whose center column is the live
terminal (ADR-0030), a grouped session rail (ADR-0023), a Tool Gateway with an R0–R4 permission
engine and command classifier, and a durable ledger (tool_calls / permission_requests /
permission_decisions) that replay renders.

The feature: one agent session (the **orchestrator** — either the managed runtime or an external
CLI such as claude running in a Charter terminal) can open and direct sibling **worker** sessions.
Six primitive capabilities: list sessions, read output, inject input, create a session, wait for
completion, close. Canonical user stories: "try approaches A/B/C in three windows, adopt whichever
goes green"; "hand my plan to a codex window for review and argue it out, cap three rounds"; "un-stick
a session stuck on a confirmation prompt".

Reference study: FanBox v2.7 ships this as six local-HTTP endpoints plus a claude skill. Its
docs/12 analyzes three token tiers (loopback-only → token file → per-launch in-memory token) and
its pragmatics (bracketed paste, \n→\r, long-poll wait, autorun settle) are adopted here. What we
deliberately do differently: **per-terminal tokens carry caller identity** (FanBox's single shared
token cannot answer "who commanded whom"), **safety rules are enforced by the Permission Engine**
(FanBox relies on skill prose), and **every action lands in the ledger** (FanBox flashes ⚡ for 8s
and keeps no attribution).

The UI direction went through three mockup rounds. A dedicated "fleet page" was rejected (it
competes with the rail and mission control as a second center). The approved shape grows inside the
existing shell: rail family tree + commander-room fleet section (fusion mockup) with a
director-stage overlay (v3 mockup, built and verified by an independent design pass).

## Decision

1. **One heart, two doors.** Six tools — `terminal.list`, `terminal.read`, `terminal.send`,
   `terminal.create`, `terminal.wait`, `terminal.kill` — registered on the Tool Gateway
   (`registerTerminalTools`, same pattern as the command/write/skill families) and implemented by a
   new main-process `terminal-control-service`. The managed runtime reaches them over the existing
   agent-host path; external CLIs reach them through the local control door (decision 7). Both
   doors converge on the same `ToolGateway.executeCall` — one classifier, one Permission Engine,
   one ledger. No second enforcement path exists.

2. **Risk levels.** `list` R0; `wait` R0; `read` R1 (sibling output may contain secrets);
   `create` R2; `kill` R3. `send` is dynamic: when the target's foreground is a bare shell the
   injected text IS command execution — it runs through `classifyCommand` with a floor of R2;
   when the target is a TUI/agent the text is content injection → R1 (the target agent's own
   permission flow still applies); control characters (e.g. ^C) → R2. The gateway's existing R4
   pre-refusal applies unchanged.

3. **Depth cap and anti-loop.** Orchestration depth is two levels (orchestrator → worker).
   `create`/`send`/`kill` from a session that is itself a worker is refused with a typed error.
   A caller can never `send`/`kill` its own terminal. Both rules are enforced host-side, never by
   skill prose.

4. **Budgets and pauses.** Per-orchestrator budgets, settings-tunable (defaults: ≤5 live workers,
   ≤30 sends/min). Two pause granularities (product-owner confirmed): per-worker "pause remote
   control" on the ⌁ band, and fleet-wide "pause all" in the fleet section. Pause queues **new**
   injections; it never interrupts a running command and never closes terminals. User keystrokes in
   a worker terminal = **takeover**: that worker's injection queue holds automatically until the
   user hands control back, at which point queued sends release in order.

5. **Identity.** Every product-spawned pty receives three env vars: `CHARTER_TERM_ID`,
   `CHARTER_CTL` (door address), `CHARTER_CTL_TOKEN` — a per-terminal random token held in an
   in-memory registry (token → terminal), regenerated every app launch, never written to disk.
   A `CHARTER_CTL_TOKEN_OVERRIDE` env exists for dev/tests only. Distinct tokens are what let every
   ledger row answer "who commanded whom".

6. **Ledger content policy.** Every call lands in `tool_calls` with caller identity (task/session
   id, or `terminal:<id>` via the door). Injected `send` text is recorded in full — it is the audit
   trail and has passed classification. `read`/`wait` record metadata only (target, line/byte
   counts, completion reason, exit code) — captured output is never persisted, because sibling
   terminals may display secrets. The per-terminal ANSI-stripped rolling buffers (~200 KB each) that
   back `read` are in-memory only and die with the terminal.

7. **External control door.** A Unix domain socket at `<userData>/ctl.sock` (mode 0600) speaking
   HTTP, routes mirroring the six tools, token required on every request. The door is a translator
   only: validate token → resolve caller terminal → build a ToolCallRequest → `executeCall`.
   Failure semantics: 403 bad/missing token; 404 unknown target; 409 depth/self-control refusal;
   429 over budget; 501 orchestration disabled. No TCP listener exists. Windows named-pipe
   transport is recorded as follow-up; V1 targets macOS.

8. **Instruction surfaces.** One manual, three projections: a `charter-terminal` skill in the
   managed skills store (ADR-0015) with a settings one-click install; an AGENTS.md snippet for
   codex-family CLIs; the managed runtime needs none (tool descriptions are native). The skill
   documents etiquette and pitfalls (never echo the token; regex waits match command echo; how to
   un-stick a worker's confirmation prompt) — but every safety-relevant rule is enforced host-side
   regardless of what the manual says.

9. **Approvals: one record, many entries.** A risky call creates one `permission_request`; the UI
   renders it at multiple entries — rail badge, fleet tile, worker-room card, mission-control
   "Needs you", native notification (PIVOT-013/014) — all bound to the same record. Resolving at
   any entry clears all. "Always allow for this task" materializes as a StandingRule scoped to
   (task, tool, target terminal).

10. **`wait` semantics.** Four completion modes: **turn** mode subscribes to the next semantic
    Claude/Codex completion edge (structured result, or the observed-TUI settled fallback);
    **command** mode uses OSC 133 `D;exit` (ADR-0021) and returns the real exit code; **quiet** is a
    raw output settle window; **until** evaluates a regex only against output produced after the
    wait began. All modes are event/timer driven, not interval polling. Timeout clamp 1s–240s,
    default 60s. Cancellation rides the gateway AbortSignal: stopping the task cleanly detaches
    pending waiters.

11. **UI: grow-in-place, no new surface** — per the two approved mockups. Rail: two-level family
    tree, worker rows one step shorter (44px vs 56px), numeric needs badges bubbling to the
    orchestrator row, "⌁ commands N" chip. Worker room: ⌁ band naming the commander (click to
    jump), takeover state, per-worker pause. Commander room: collapsible fleet section with
    two-column live tiles, on-tile approval actions, open-room jump, pause-all. **Director stage**
    overlays the fleet section: one large live pane auto-cut by explicit priority
    (pending-approval > failure > just-finished > streaming > quiet); every cut shows a reason
    chip; lockable; auto is default with a manual mode; while an approval is pending other events
    queue (a "pending cut" chip) rather than steal the stage; the director log is a filtered ledger
    view with snapshot lookback. Roster selection and the automatic stage are separate: raw output
    timestamps never move the user's left-side selection, and equal-priority streaming workers are
    sticky instead of cutting on every line. V1 scope: commander-room only, not global. Every new
    UI piece ships with normal/loading/empty/error/cancellation states per CLAUDE.md.

12. **Master switch.** Settings toggle "会话编排" (default ON). OFF unregisters the tool family,
    does not create the socket, and hides all orchestration UI — a one-flag circuit breaker.

13. **Fleet-level resume.** Resuming a commander resumes its durable formation, not only the
    commander terminal. `workerCreated`/`workerBound`/`workerKilled` events project the last live
    fleet across Main-process restarts. Workers that are still active are re-parented immediately;
    ended Claude/Codex workers resume their exact external conversation in a replacement terminal,
    concurrently and within the worker budget. A worker resume explicitly disables nested fleet
    recovery (depth remains two). One failed worker is reported as a partial restore and never rolls
    back the resumed commander or successful siblings.

## Alternatives

- **Single shared token (FanBox tier 3 as-is)**: rejected — cannot attribute "who commanded whom";
  identity is the ledger's core answer.
- **Token file on disk**: rejected per FanBox's own tier-2 analysis — readable by any local
  process, including package-manager postinstall scripts.
- **TCP localhost port**: rejected — reachable by every local process and prone to port collisions;
  a socket file adds an OS permission wall and needs no port.
- **MCP server as the door**: deferred — per-CLI configuration burden; can be added later as a thin
  proxy over the same gateway path without changing enforcement.
- **Safety by skill prose alone** (FanBox's model): rejected — enforcement belongs to the
  Permission Engine; prose is etiquette only.
- **Dedicated fleet page**: rejected in design review — a second center competing with the rail and
  mission control; superseded mockup retained as archive.
- **Headless worker ptys**: rejected — visible, user-takeoverable real tabs are a product
  principle (the user can always see and grab the wheel).

## Security and data impact

New attack surface: a local control door plus programmatic input injection into user terminals.
Mitigations: socket file permissions (0600); per-terminal in-memory tokens that die with the app;
identity on every call; a single enforcement path through the existing Permission Engine including
R4 pre-refusal and plan gates; classification of injected text; budgets and rate caps; takeover
precedence; full audit of injected text; the master switch.

Residual risks, accepted and documented: (a) any process launched **inside** a worker terminal
inherits that terminal's token — the capability boundary is the process tree, exactly as in FanBox;
the skill instructs agents never to echo or persist the token; (b) an orchestrator reads worker
output that may contain untrusted text (prompt-injection vector) — mitigated, not eliminated, by
approvals on risky follow-up actions; (c) quiet-mode completion is heuristic — a misread costs
latency, never safety.

Privacy: captured terminal output is never persisted; only injected send text (which the user may
have been asked to approve) enters the ledger.

## Migration and rollback

No schema migration: `tool_calls`/`permission_*` absorb the new call kinds; new timeline/event
kinds are additive. Rollback = master switch OFF (fully inert) or revert the commits; no data
cleanup is required beyond normal retention.

## Verification

Acceptance IDs (expanded as the M13 section of IMPLEMENTATION_BACKLOG):

- ORCH-001 managed-driver closed loop: create → send → wait (exit 0) → read → kill, every step
  ledgered with caller identity.
- ORCH-002 R3 injection prompts for approval; the deny path returns a typed refusal to the caller.
- ORCH-003 one approval record renders at every entry; resolving at any entry clears all.
- ORCH-004 takeover: local keystrokes hold the injection queue; hand-back releases queued sends in
  order.
- ORCH-005 pause single and pause all queue new sends and never interrupt a running command.
- ORCH-006 depth cap and self-control refusals return typed errors.
- ORCH-007 budget overruns surface as 429/typed errors and are ledgered.
- ORCH-008 door auth: missing/invalid token → 403; tokens invalid after app restart; resolved
  caller identity equals the spawning terminal.
- ORCH-009 wait modes: agent-turn event, exit-code, quiet, until-regex (post-wait output only);
  send/create-to-wait races do not lose a completion edge; task stop leaves no orphan waiters.
- ORCH-010 director stage: priority order honored; approval-pending queues other cuts with a
  "pending cut" chip; every cut carries a reason chip; lock and manual mode work.
- ORCH-011 replay renders ⌁ orchestration events from the ledger.
- ORCH-012 master switch OFF: tools unregistered, no socket file, UI hidden; e2e proves inert.

Security suite additions: socket permission test; token restart invalidation; external-path risk
classification parity with the internal path. Performance note: buffer memory stays capped under
N concurrent terminals (200 KB × N, N bounded by worker budget).

## Amendment (2026-07-22): observation and TUI content injection are prompt-free

Product-owner decision after first real use: the R1 approval cards on `terminal.read` and on
`terminal.send` toward a TUI target added a human round-trip to every observe/instruct step of an
orchestration loop without adding a matching safety property. Decision 2 is amended:

- `terminal.read` → **R0**. Rationale: the buffer is in-memory only, the ledger records metadata
  (never content), and the sibling screen is already visible to the user. Side effect (accepted):
  read now appears in the Ask-mode catalog, so read-only managed sessions can observe workers.
- `terminal.send` with a TUI foreground → **R0**. Rationale: the injected text is conversation
  content for another agent, which applies its own permission flow to any resulting action;
  delivery is still governed by takeover precedence, the two pause granularities, send budgets,
  and the depth/self-control preflights, and the full text still lands in the ledger.
- Unchanged: bare-shell sends keep the `classifyCommand` floor of R2 (R3/R4 escalation intact),
  control characters stay R2, `create` stays R2, `kill` stays R4, and worker/send budgets and the
  master switch are untouched.

Note on R0 semantics: R0 bypasses standing deny rules by design (as for `list`/`wait`); the
per-worker/fleet pause and takeover remain the user's blocking levers for content injection.
ORCH-002 (R3 approval + deny path) is unaffected; the e2e read-approval anchors were updated to
assert the new prompt-free behavior.

## Amendment (2026-07-25): the terminal capability lane is prompt-free

Field use with one commander driving multiple Claude/Codex/shell workers exposed a protocol-level
failure in the previous policy. `terminal.create` and bare-shell `terminal.send` waited inside the
local HTTP/MCP request for a permission decision. The CLI caller could not see that permission card,
so the request looked like a hung write channel while `list` and `read` continued to work. Parallel
calls amplified the false impression that the control plane was globally blocked.

Product-owner decision: the complete `terminal.*` family is an owner-trusted capability lane and
does not enter the interactive Permission Engine. This replaces the earlier R0-only exemption:

- `terminal.list/read/send/create/wait/kill` register with `permissionPolicy: auto-allow`. They are
  available in every task mode, create no permission requests/cards, and ignore persisted standing
  allow/deny rules. Calls retain their real risk classification in the tool audit.
- The global R4 product wall remains first-class. A shell send classified R4 is still refused with
  zero side effects; this lane only auto-allows R0-R3. `terminal.kill` returns to R3 and is executable
  without a card, while the manual limits it to an explicit user request and keeps completed workers
  open by default.
- Host preflight and runtime controls are unchanged: authenticated per-terminal identity, master
  switch, top-level-only control, self-control refusal, worker/send budgets, pause, takeover queues,
  schema validation, cancellation, and ledger attribution all remain enforced.
- The compatibility CLI now treats `help/-h/--help` as documentation instead of a create request,
  validates required arguments locally, and returns a typed timeout instead of waiting forever when
  the control door stops responding. The manual now states that `queued: true` means not delivered
  and that resident agent TUIs remain `busy: true` for their entire process lifetime.

Verification amendment: ORCH-002 now asserts that R0-R3 terminal calls produce no permission card
even when the Permission Engine would deny them, while an R4 shell injection is still refused before
execution. Electron coverage asserts both managed and authenticated external drivers complete the
create/send/wait/read loop with zero terminal permission cards.

## Amendment (2026-07-25): event-driven worker completion and non-blocking create

Multi-console use exposed two latency/meaning gaps. A resident Claude/Codex process remains alive
between assignments, so process-level `busy` cannot mean "this assignment is unfinished". Also,
shell `terminal.create` waited for the 350ms input-safety settle before returning, even when no
input needed to be delivered yet.

- `terminal.wait` adds `mode: "turn"`. `ExternalSessionService` bridges structured Codex
  `turn.completed` / Claude result events and its observed-TUI activity-settled fallback into
  `TerminalControlService`. A pending long wait resolves on that edge immediately; there is no
  polling interval and no unsolicited text injection into another model's active turn.
- Each terminal keeps a monotonic in-memory turn sequence. `create(initialText)` and `send` capture
  the pre-delivery sequence, so a completion arriving before the caller starts `wait` is returned
  immediately instead of being lost. Wait results expose status, source, worker task id, completion
  time, sequence, and duration without persisting terminal output.
- Worker UI state uses the semantic edge: a live resident TUI can now be `completed` or `failed`
  while process-level `busy` truthfully remains `true`. A subsequent submitted prompt marks it
  active again.
- Shell creation returns immediately. During the existing startup-safety window, follow-up sends
  are queued with `reason: "starting"` and released in order after the shell is paste-ready. This
  preserves the input-loss guard while removing the 350ms control-plane response delay.

## Amendment (2026-08-11): semantic Agent control over unified Presence

Raw terminal primitives remain necessary for shells, but they force a coordinator to infer Agent
meaning from `busy`, screen text, and quiet timing. The unified Presence engine now supplies a
provider-neutral lifecycle, so Charter adds six semantic tools on the same Gateway/identity/audit
path: `agent.status`, `agent.explain`, `agent.result`, `agent.read`, `agent.wait`, and `agent.prompt`.

- Presence carries two monotonic cursors. `identitySeq` changes only when a terminal id receives a
  new/restarted Agent process; `stateChangeSeq` changes on every committed presence transition.
  Waiters pin both, so an old idle state or a replacement process cannot satisfy a new wait.
- `agent.wait` is event-driven. It subscribes before re-reading current Presence, supports exact
  working/blocked/idle/unknown/exited conditions, and cleans up on match, timeout, cancellation,
  process exit, or replacement. It never polls terminal text.
- `agent.prompt` accepts only idle/blocked Agents, installs a newer-Working waiter before using the
  existing bracketed-paste + Enter delivery path, and returns success only after that edge. Queued
  delivery is `AGENT_PROMPT_QUEUED` and the prompt is not retained for later delivery; delivered input without a Working edge is
  `AGENT_PROMPT_STALLED`. Active/unknown targets fail with `AGENT_NOT_READY` rather than injecting
  into an ambiguous turn.
- `agent.read` defaults to a passive `screen` read. Only explicit `mode=transcript` may acquire the
  preemptible interaction lease, drive an idle alternate-screen TUI with mouse-wheel reports,
  overlap-align captured rows, and verify bottom restoration. User input, resize, lifecycle/identity
  changes, alignment failure, timeout, and restore failure are explicit errors.
- `agent.result` is the normal post-wait answer path. It asks the Adapter-selected trusted history
  connector for the latest provider final answer; any recognized Agent without a usable native
  connector falls back to the passive current screen with `fidelity=observed`. Core semantic
  control never branches on provider names. `terminal.read` rejects recognized Agent targets so a
  coordinator cannot accidentally return to raw TUI scraping.
- The tools are R0 conversational/observation operations and therefore create no permission card,
  while Terminal Control still enforces orchestration enabled, caller depth, self-control, pause,
  takeover, and send budgets. Calls remain ledgered by the Gateway.
- The Unix door exposes `/v1/agents/:target/status|explain|result|read|wait|prompt`; the injected MCP exposes
  `agent_status|explain|result|read|wait|prompt`; the compatibility CLI exposes
  `charter-terminal agent <command>`. All are projections of the same Gateway tools.
- `agent.sendKeys` is deliberately deferred: raw key combinations need a separate allowlist and
  foreground-identity contract. Normal text must use `agent.prompt`.
- Lifecycle state is coordination evidence only. None of these operations completes or mutates a
  Charter Task, Assignment, Attempt, or Mission.
