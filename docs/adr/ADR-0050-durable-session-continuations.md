# ADR-0050: Durable Session continuations

- Status: Accepted
- Date: 2026-07-31
- Related: ADR-0044, ADR-0049, `docs/design/mission-fabric-v3.md`

## Context

Event-first `wait` and `join` avoid database polling, but a long wait still occupies an Agent tool
call and provider turn. It is also a poor recovery boundary: the in-memory waiter disappears when
Electron or the runtime restarts. Repeating a short wait is worse because it consumes turns and
tokens even when no durable state changed.

Charter already owns the information required for a stronger flow: Assignment and message events
are committed in SQLite, Runtime adapters can deliver a prompt, and native PTY delivery waits for a
semantic turn boundary.

## Decision

1. Add a durable Continuation bound to one exact owner Assignment and active Attempt.
2. A Continuation contains `all` or `any` conditions over terminal Assignment states or typed,
   optionally threaded messages after a sequence cursor. It may contain a durable deadline.
3. Registration reads current durable state in the same transaction, closing the
   event-before-registration race.
4. Event writes satisfy matching targets in their own transaction. The transition to `READY`
   creates exactly one idempotent ResumeIntent.
5. The runtime runner delivers ResumeIntents at least once. Native Claude/Codex uses the existing
   PTY safe-turn queue; ACP uses its protocol prompt queue. Offline delivery remains pending with
   bounded exponential retry.
6. The injected prompt names the Continuation and calls `orchestration.continue`. That command is
   idempotent, validates the exact active Attempt, returns committed context, and transitions the
   owner back to `RUNNING`.
7. Retry, reassignment, cancellation, completion, and orphan recovery cancel continuations owned
   by the replaced or terminal Attempt.
8. `wait`, `ask`, and `join` stay available for short bounded waits and compatibility. Skills teach
   Agents to use `park` for work that should outlive the current turn.

## Consequences

- Waiting consumes no Agent turn, token stream, or long-lived control RPC.
- Completion and message races cannot lose a wake-up, and application restart can reconstruct both
  readiness and delivery.
- A PTY write remains an at-least-once side effect. A crash in the write/ack gap may duplicate the
  compact prompt, but cannot duplicate the Continuation or advance a stale Attempt.
- Standard inbox doorbells are held while an Assignment is parked so a condition-triggered resume
  is the single normal wake-up. Urgent messages may still interrupt it.
- UI can explain whether an Agent is waiting, queued for a safe boundary, delivered, or resumed
  from persisted domain state rather than a spinner heuristic.

## Verification

- Migration and reopen tests cover Continuation, target, and ResumeIntent durability.
- Repository tests cover event-before-park, `all`/`any`, typed/threaded cursors, idempotency,
  deadlines, stale owner cancellation, and duplicate consumption.
- Runtime tests cover transient delivery failure, retry, and delivery acknowledgement.
- Service/tool tests cover `park` → child completion → automatic prompt → `continue` against the
  same Session and Attempt.
- Electron/live tests exercise native Claude Code and Codex without selecting an explicit model.
