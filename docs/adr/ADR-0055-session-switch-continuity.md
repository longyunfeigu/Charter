# ADR-0055 — Session switch continuity: per-task timeline cache, progressive first paint, kept-alive room pool

- Status: PROPOSED (pending user acceptance of the working-tree change set)
- Date: 2026-08-09
- Relates to: ADR-0052 (transcript render performance), M11-04 (timeline windowing), PIVOT-036 (scroll memory)
- Supersedes nothing; ADR-0053/0054 are unrelated (numbers taken by parallel work)

## Context

Switching Sessions felt like a full rebuild: the store held ONE timeline that
was cleared and refetched on every switch, `HomeShell` remounted the room via
`key={taskId}`, and a heavy transcript re-parsed hundreds of markdown messages
from scratch — seconds of visible reconstruction, no scene preservation.
ORCA (read first-hand) keeps every *visited* worktree surface mounted,
switches by toggling `display:none`, and bounds the kept set (30 s hysteresis,
hot-retain 8 worktrees / 12 tabs, cap as primary evictor).

## Decision

Three cooperating layers, each independently useful:

1. **Per-task timeline cache (store)** — `timelines: Record<taskId, events>`
   alongside the active singleton (`timelines[activeTaskId] === timeline`,
   same reference). `openTask` is stale-while-revalidate: a cache hit paints
   synchronously (no Loading flash) and the ledger re-read reconciles
   **preserving event identity** (immutable events: same id+sequence ⇒ same
   object), so an unchanged history keeps the same array — zero re-renders.
   `task.event` now applies to any *cached* task, so kept-alive rooms stay
   current while hidden; uncached tasks keep the old drop-and-refetch
   behavior. Bounded MRU (8), active task immune; entries drop on task
   delete/archive.

2. **Progressive first paint (timeline window)** — opening a Session mounts
   an 80-event tail (`PROGRESSIVE_WINDOW`) instead of 400; scrolling within
   240 px of the clipped top auto-grows the window with the existing anchor
   preservation ("Load earlier" remains as the explicit affordance). A saved
   mid-transcript reading position opts back into the full window so
   PIVOT-036 restores land correctly. The `__PI_IDE_TIMELINE_WINDOW` E2E
   override always wins.

3. **Kept-alive room pool (`SessionRoomPool`)** — the most recently visited
   rooms (cap 3) stay mounted; each renders through a portal into a stable
   container element and switching **re-parents** the active container into
   the visible host while detaching the rest from the document (the
   codebase's own mountTerminal pattern). Chosen over `display:none` stacking
   deliberately: detached DOM is invisible to global queries, so duplicated
   `data-testid` landmarks cannot break Playwright strict selectors or the
   a11y tree, and hidden rooms cost zero layout/compositing. React fibers and
   state survive; a revisit is a reattach. Scroll position is re-asserted
   from scroll memory on reveal (detached nodes forget offsets).

### The freeze contract (the "don't hurt anything else" guarantee)

A hidden room must not re-render for what the active session does. An
adversarial pass measured ~5 stray re-renders per active run through the
original whole-catalog `s.tasks` subscriptions; the contract is now enforced
by three mechanisms working together — (a) `TaskRoomView` and
`SessionRoomPool` are `React.memo` with primitive props, stopping shell
re-render cascades, (b) each room subscribes to **its own** task object (the
catalog array being replaced for another task's transition yields the same
reference), and (c) every active-only field is gated *inside the selector*,
pinning to a constant unless the room is active:

- `RoomTimeline`: `streaming`/`streamingThinking`/`loadingTimeline` pin to
  null/false; data comes from `timelines[task.id]`; the decision-scroll,
  live-follow and restore effects early-return when inactive.
- `TaskRoomView`: `changeSet` and the global orchestration snapshot pin to
  constants; `openTask` sync and global view writes (`setSessionRoomView`)
  run only for the active instance.
- `SessionToolCanvas` inner components: `changeSet`/`loadingChangeSet` gated,
  timeline reads per-task.
- `useTimelineContext` accepts the room's own timeline and pins its singleton
  subscription to a constant in that mode.

Per-token cost for hidden rooms: zero (streams stay active-gated). Per-event
cost for a hidden room whose OWN background run is working: one memoized-row
append with no layout (detached). Residual, measured honestly: an active run
still causes at most one shallow `TaskRoomView` re-render of hidden rooms per
presence/attention flip (memoized subtrees bail; the pool boundary itself
stays at zero — fiber-probe verified before/after: ~5 full-tree re-renders →
pool frozen, one shallow pass). Sessions outside the pool/cache behave
exactly as before.

## Consequences

- Switch-back to a pooled room ≈ reattach + style/layout of a small
  (progressive-window) tree; no RPC on the critical path, no Loading flash,
  no markdown re-parse.
- First-open of any Session paints the 80-event tail quickly; deep history
  streams in on demand.
- Memory: ≤8 cached event arrays + ≤3 mounted room trees (small windows);
  external rooms keep their xterm alive in the pool — deliberate, that is the
  seamlessness users feel in ORCA.
- Known limits: no time-based parking (cap-only eviction; add ORCA-style
  hysteresis later if 3 heavy external rooms prove costly); background
  streaming text for a hidden room is not accumulated (unchanged from before
  — the completed message arrives via its persisted event); `AgentPanel`'s
  editor-side list still reads the active singleton (active-only surface).
- Tests: `taskStore.cache.test.ts` (SWR, identity reconcile incl. the
  broadcast-race tail and live tool rows, failed-fetch placeholder cleanup,
  cached-event application, MRU bound, cleanup — 10 cases),
  `timeline-window.test.ts` (openingWindow policy), and
  `tests/e2e/session-room-pool.spec.ts` (landmark uniqueness under the pool,
  no-reload switch-back, draft survival, cap-3 eviction with cached-ledger
  fallback).
- Adversarially probed (real Electron harness): no data crosstalk between
  pooled rooms, pool cap/eviction, detached xterm reattach, mid-scroll
  restore drift 0, SWR picks up out-of-band ledger writes, cached background
  runs stay current. Two confirmed findings from that pass are fixed: the
  stray re-renders above, and the auto-grow misfire on open (a programmatic
  bottom-pin scroll event near the clipped top grew the window without any
  user scroll — growth now requires actual upward movement).
