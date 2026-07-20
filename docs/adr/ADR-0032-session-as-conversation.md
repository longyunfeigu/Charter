# ADR-0032 — Session as conversation: one room for chat + work, per-turn settlement (4b)

- Status: **Proposed** (mockup `docs/design/session-4b-continuous-room.html` awaiting owner confirmation; do not implement before it flips to Accepted)
- Date: 2026-07-20
- Supersedes (on acceptance): the session-granularity reading of task completion in ADR-0008 (task-centric shell) and the follow-up-as-new-Session mechanics; amends ADR-0012 (Full mode), ADR-0016 (review bar), ADR-0017 am.8 / ADR-0031 (replay chapters)
- Related evidence: owner field report 2026-07-20 — a Full-mode Q&A chain produced one throwaway room per question; prior turns invisible except a dead context chip

## Context

The product model to date: one Session = one task = one review/rollback unit.
Acceptance closes the room; a follow-up spawns a NEW task carrying the prior
conversation as injected context (`task_conversation_references`). For
code-changing work this gave clean acceptance gates. For conversational use it
shreds the dialogue: in Full mode every question auto-accepts in seconds, so
every message opens a fresh room and the previous exchange disappears from
view (the "Previous Session context attached" chip is a non-clickable span).

The owner has decided on the full conversational model (option 4b): **one
Session is one continuous conversation where chatting and working interleave;
the ledger settles per turn, not per room** — the Claude Code shape.

Data audit: the per-turn ledger already exists. `agent_runs` is the turn
(1:N per task, model/usage/timestamps), `tool_calls.run_id` ties calls to
turns, `file_changes.tool_call_id` ties changes to calls, `file_baselines` +
content-addressed blobs give byte-exact restore points, and `task_events` is
already a continuous log. What is missing is only: a per-turn review state,
a restore-to-turn-boundary operation, and the UI that stops closing the room.

## Decision

1. **Session = the task record, lifecycle ACTIVE → ARCHIVED.** A Session never
   terminates on acceptance. The only "close" is archival (explicit user
   action; optional idle auto-archive later). `tasks.archived` already exists.

2. **Turn = one agent run.** `agent_runs` gains `review_state`
   (`pending | accepted | auto_accepted | rolled_back | answered`) and
   `reviewed_at`. A zero-change turn settles as `answered` automatically
   (existing "Answered" presentation, now per turn).

3. **Task state machine: settlement returns to IDLE, not to a terminal.**
   - New state `IDLE`: the last turn is settled; the composer is live; the
     next user message starts a new run (IDLE → EXPLORING/IN_PROGRESS).
   - `REVIEW_READY` remains the agent-completion invariant (spec §, CLAUDE.md
     rule unchanged — completion never auto-accepts outside Full mode), but
     accept/rollback now settle **the turn** and transition to IDLE.
   - `ACCEPTED`/`ROLLED_BACK` cease to exist as resting task states (they
     remain as per-turn review_state values and ledger events). `ARCHIVED`
     is the only terminal. Historic tasks migrate: terminal-state rows become
     `archived=1` Sessions (read-only rooms), their last run inheriting the
     matching review_state. No data loss; replay/receipts unaffected.

4. **The conversation stream stays pure — settlement lives in the rail**
   (owner feedback round 2: no "第 N 轮" separators, no inline settlement
   cards). Turn boundaries are implicit (each user message starts a run); the
   timeline renders only messages and action rows. Settlement surfaces:
   - the existing composer-docked review bar appears while the LATEST turn is
     REVIEW_READY (unchanged from ADR-0016) and collapses when the user just
     keeps talking;
   - the summary rail gains a **turn list** (per-turn title, review state,
     changed stats) whose pending entries expose Review / Accept / Roll back
     this turn — reusing the existing Review overlay, filtered to the turn;
   - an unsettled turn never blocks the composer.

5. **Rollback is per-turn, newest-first.** "Roll back this turn" restores
   every file the turn touched to its state at the turn boundary (derived
   from the `file_changes` before/after hash chain; conflicts go through the
   existing preflight). Only the newest settled turn can be rolled back, then
   the next — no holes in the middle (Claude Code rewind semantics).
   "Roll back everything" (to the session baseline) survives as a session
   action. Cross-turn conflict = existing `rollback.blocked` machinery.

6. **Full mode**: verification-passing turns auto-settle
   (`review_state: auto_accepted`) and the conversation continues; failures
   still park the turn at REVIEW_READY for a human. ADR-0012's fallbacks are
   unchanged, just scoped to the turn.

7. **Worktree Sessions: merge-back moves from accept-time to archive-time**
   (or an explicit "merge now" session action). Per-turn accept only records
   settlement; the worktree lives across turns. This removes the current
   "accepted worktree task cannot be rolled back" cliff for continuing
   conversations.

8. **Follow-up-as-new-Session is deleted.** The composer is always Reply in
   an ACTIVE session ("回复 — 继续这场会话…"); archived sessions are
   read-only with an explicit "继续到新会话" action that uses the existing
   prior-conversation injection (which remains for cross-session @refs).

9. **Surfaces**: rail rows stay one-per-session with a pending-turns badge;
   notifications fire per turn (existing REVIEW_READY edge, now with turn
   context); replay gains turn-boundary chapters (V3.1 fold/chapter machinery
   already copes with long ledgers); the summary rail groups Changed by turn
   with an all-session rollup and hosts the turn list (mock ③).

## Spec impact (formal change, not silent scope removal)

- E2E acceptance flows asserting "accept closes the room" / "follow-up spawns
  a Session" are rewritten to per-turn settlement equivalents. The invariant
  "agent completion is REVIEW_READY, never automatic ACCEPTED (except Full)"
  is preserved verbatim at turn scope.
- CLAUDE.md's completion invariant keeps its wording; this ADR is the formal
  spec change it requires for the session-scope reinterpretation.

## Phasing

- **P1 — the model**: `review_state` column + migration; IDLE state + settle
  transitions; message-after-settlement starts a new run; delete follow-up
  branching; timeline turn separators + per-turn settlement bar; composer
  copy. (Ship gate: all three mock turns work end-to-end; historic sessions
  migrate read-only.)
- **P2 — per-turn rollback**: restore-to-turn-boundary in ChangeService +
  newest-first guard + conflicts; settlement bar overflow wiring.
- **P3 — surfaces**: worktree archive-time merge, rail badges, replay turn
  chapters, notifications copy, session archive/auto-archive setting.

## Risks

- Largest blast radius: task-service settle/message paths and the e2e
  acceptance suite (E2E-0xx rewrite batch). Mitigation: phase gates + the
  invariant tests rewritten first, red→green per phase.
- Worktree multi-turn merge conflicts surface later (at archive) than today
  (at accept); mitigated by the existing merge preflight + an optional
  per-turn "merge now".
- Unsettled-turn pileup in long chats; mitigated by the rail badge and
  settlement bars staying pinned in the timeline.
