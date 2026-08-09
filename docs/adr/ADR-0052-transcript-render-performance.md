# ADR-0052 — Transcript render-performance pass (stream coalescing, precise subscriptions, containment)

- Status: PROPOSED (pending user acceptance of the working-tree change set)
- Date: 2026-08-08
- Relates to: §16.5 performance gates, ADR-0006 (tool lifecycle), ADR-0011 (thinking stream), ADR-0014/PIVOT-036 (scroll memory), M11-04 (timeline windowing)

## Context

Scrolling a long Session transcript stuttered compared to peer products, and the
transcript grew visibly heavier while an agent was working. Instrumented
diagnosis (CDP Performance domain + frame pacing on a seeded 400-event,
150k-node transcript) plus source audit identified independent costs:

1. **Per-token fan-out.** Every provider delta traveled provider → worker →
   task-service → Zod validation → structured clone → renderer store write,
   50–200×/s per run — twice that with thinking enabled. Terminal output
   already had a batching dispatcher; agent text had none.
2. **Whole-window re-renders.** `TaskRoomView` held four selector-less store
   subscriptions (including one on the filesystem store it never read, so
   watcher batches re-rendered the room every 120 ms during agent writes).
   Markdown had no memo boundary: any timeline append re-parsed every visible
   message through the remark pipeline; each tool call does 4 lifecycle
   transitions (ADR-0006), multiplying the rebuild.
3. **Layout-read churn on the scroll path.** Unthrottled `onScroll` handlers
   read `scrollHeight` twice per event; the live-tail follow effect ran a
   querySelector plus two `getBoundingClientRect` calls per token.
4. **Standing paint costs.** Historical warn milestones pulsed forever;
   the presence glow animated a two-layer `box-shadow`; the Atelier skin
   composited a full-viewport `mix-blend-mode: multiply` overlay (plus an
   `invert(1)` pass in dark) into every frame of every scroll.

## Decision

- **Coalesce stream deltas in the main process** (`task-service`): deltas
  accumulate for one frame (16 ms) per (channel, message) and flush as a single
  combined delta. Ordering is preserved **relative to agent-runtime events**
  (any non-delta event in `onAgentEvent` flushes first) and the worker-crash
  path flushes before its INTERRUPTED broadcast. Broadcast paths outside these
  flush points could still deliver a delta late, so the renderer additionally
  drops stream deltas for any task not in a running state (regression-locked
  by `taskStore.stream-guard.test.ts` — an adversarial review reproduced a
  ghost streaming bubble on worker crash before these two guards existed).
  `appendStreamDelta` concatenation is associative, so combined deltas render
  identically.
- **Precise store subscriptions** in the session-surface components
  (`TaskRoomView`, `RoomTimeline`, `SessionToolCanvas`, `AgentPanel`,
  `TimelineList`, `TaskComposer`, `HomeShell`, cards); actions are taken via
  `getState()` (zustand actions are stable).
- **Memo boundaries**: `Markdown` is `React.memo` (props are primitives);
  timeline rows render through a memoized `EventRow` compared on event
  identity + a reference-stable `TimelineContext` (contents-equality reuse) +
  the three task scalars rows actually read. Honest cost note: the window
  rebuild still calls `eventNode` once per event as a visibility probe
  (element creation only — the saving is the skipped re-render/reconciliation
  of settled subtrees, above all the remark re-parse of every message).
- **Code-fence colorize discipline**: streaming text defers Monaco
  tokenization until settled (`live` prop); results are cached in a bounded
  LRU keyed by (code, language, skin, theme); one shared appearance
  MutationObserver replaces one-per-block.
- **Scroll path**: one rAF-coalesced measurement per frame feeds both the
  pin-to-bottom verdict and scroll memory; live-tail follow writes scrollTop
  at most once per frame; split-handle drag caches the container rect and
  writes `--session-split` once per frame. Known cost (adversarially probed):
  if the surface unmounts inside the one-frame window (inertial scroll still
  running during a ⌘E hop), the final wheel's position update is dropped —
  the previous frame's saved position stands. It cannot be saved at cleanup
  time: the detached node measures 0/0/0, which reads as "pinned to bottom",
  so `saveScroll` now structurally refuses detached/zero-height elements
  (regression-locked by `scrollMemory.test.ts`).
- **CSS**: `contain: content` on `.rt-bubble`; code fences cap at 400 px with
  inner scroll; milestone dots pulse only while the Session runs
  (`.rt-scroll[data-live='true']`); the worklog entrance animates opacity
  only; the presence glow keeps only its outer layer; `.tr-main` width tween
  shortened 160 ms → 90 ms. The SessionRail minute tick gained a
  `visibilitychange` gate — note this Electron build does not fire that event
  on macOS window hide/minimize (verified), so the gate only helps where the
  platform reports hidden; it is correctness-neutral either way.
- **Atelier keeps its fibre texture but loses blend modes**: plain alpha
  compositing in light; dark gets explicit light-ink gradients instead of
  `invert(1)+screen`. At the shipped alphas the multiply-vs-alpha difference
  is under 1/255 per channel; the full-screen per-frame compositing cost was
  the only observable effect.

## Consequences

- Renderer receives ~one stream event per frame instead of per token; live
  text latency is bounded by one frame (16 ms), imperceptible.
- A timeline append re-renders the appended/replaced row, not the window.
- Settled transcripts no longer animate; idle style-recalc work drops to ~0.
- Long code fences become internally scrollable (visible UX change, applies
  to every Markdown surface including Memory view).
- `tests/perf/ui/scroll-bench.ts` (deterministic seeded transcript, mock
  backend per CLAUDE.md §10) and `tests/perf/ui/real-cli-bench.ts` (real
  claude/codex CLIs) are the evidence harnesses; results under
  `tests/perf/ui/results/`.
- Risk accepted: memo comparators must be kept in sync if `eventNode` starts
  reading more of `TaskDto` than id/state/changedFiles, and `TimelineContext`
  equality must grow with any new context field.
