# ADR-0016 — Room ending as state (review bar) + per-reply model/effort override

Date: 2026-07-14 · Status: ACCEPTED (product owner picked direction B from
`docs/design/room-ending-directions.html` and approved the reply-composer
model/effort parity, then delegated implementation)
Amends: ADR-0014 room presentation; PIVOT-032 timeline language; ADR-0010
model·effort control scope.

## Context

Two frictions surfaced in daily Task Room use:

1. **The final report card is redundant.** Every completed run appends a
   full-width "Final report" card (`report.final` → `ReportCard` in
   `RoomTimeline`) restating what the timeline just showed live: the Write
   rows already carry +/− stats, the Verify rows already carry pass/fail.
   Zero-change tasks were fixed earlier (the "Answered" milestone, PIVOT-031);
   change-making tasks still pay the ceremony on every completion.

2. **The reply composer hard-codes model/effort.** The Home composer and the
   follow-up composer share `ModelEffortControl`; the mid-task reply composer
   renders the task's model as a read-only string. Steering an agent onto a
   stronger (or cheaper) model for the next turn required abandoning the task.

## Decision

### 1. The completion report is *state*, not a timeline *event* (direction B)

- The `report.final` timeline entry renders as a quiet `✓ Done` **milestone**
  (elapsed-style meta: files ±, checks) — same visual grammar as every other
  milestone. No card.
- While the task is `REVIEW_READY` (and not "Answered"), the room shows a
  **review bar** docked above the composer: changed-stats, verification
  summary (per-run detail incl. superseded/stale), unverified/risk warnings,
  the primary **Review changes** action, and an overflow menu (agent summary,
  roll back all). It disappears the moment the state moves on
  (accept/rollback/new run) — exactly like the plan-approval affordance.
- The "Answered" completion is unchanged: milestone only, no bar, no report.
- The **Editor agent panel keeps its dense report card**: it is the deep-dive
  surface; evidence density is its job (M6/M9 editor-surface tests unchanged).
- Data source is unchanged: the recorded `report.final` event. Nothing about
  report *generation*, acceptance gates (§6.1) or evidence honesty changes —
  only the room presentation.

### 2. Replies can override model/effort for the next turn

- The reply composer gets the same `ModelEffortControl` as Home/follow-up.
  Trust level stays read-only (the session's tool catalog and permission
  gateway are mode-scoped at creation; changing it mid-task would lie).
- `task.message` gains an optional `model: ModelRef`. When present and
  different from the task's current model, the task-service:
  - persists it as the task's model (`tasks.model_json`) — the task record
    always names the model that will serve the *next* turn;
  - applies it to the live session via a new runtime capability
    `setSessionModel(sessionId, model)` (pi: `AgentSession.setModel` +
    `setThinkingLevel`, clamped; mock: records it) — sessions are reused
    across runs, so idle restarts also re-assert the task model on launch;
  - records a `task.modelChanged` timeline note (honest audit of who is
    serving which turn; `agent_runs` rows already record per-run model).
- Failure handling: if the runtime rejects the switch (unknown model, worker
  down), the message send fails loudly with a product error — the user's text
  stays in the composer; nothing is silently sent on the wrong model.
- Mid-stream semantics: pi applies `setModel` to the next LLM call; an
  in-flight completion finishes on the old model. The timeline note says
  "next turn", which is exactly true.

## Consequences

- E2E specs that asserted the room report card (`tl-report` in
  `pivot-shell`, `shell-v4`, `soak`) move to the review-bar testids
  (`review-bar`, `report-*` rows live inside it; rollback sits in its
  overflow menu). Editor-surface specs (m6/m9) are untouched. This is a
  presentation change sanctioned by this ADR — the acceptance semantics
  (completion presents evidence; rollback is double-confirmed and reachable
  from the completion presentation) are preserved.
- `AgentRuntime` grows one method; the worker protocol grows one
  request/response pair. Both runtimes implement it.
- The composer's model pill always reflects `task.model` — after a reply
  with an override, the task record and the pill agree.

## Alternatives considered

- **A (timeline-native one-line ending)**: keeps everything in the scroll;
  rejected — the report is an *actionable state*, and burying live actions in
  history repeats the old plan-card mistake PIVOT-032 fixed.
- **C (receipt chips on the last agent message)**: prettiest, but couples the
  agent's prose (unverified narrative) with recorded evidence — weakens the
  evidence/narrative separation the product is built on.
- **Per-message ephemeral override (not persisted on the task)**: rejected —
  the task record would lie about which model serves the next turn, and an
  idle restart would silently revert.
