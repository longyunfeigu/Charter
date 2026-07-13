# ADR-0008 — Task-centric shell: Task Room, Studio visual language, entry consolidation, Live Board

Status: Accepted (product owner approved 2026-07-13)
Supersedes: parts of ADR-0004 §surfaces and ADR-0006 §navigation (details below)

## Context

Product review of the dual-form shell (ADR-0004/0006, walkthrough screenshots
2026-07-13) found structural and craft problems:

1. **Co-equal surfaces force the IDE on delegation flows.** Home and the
   workbench are peers; opening a task, approving a plan or reviewing changes
   all context-switch into a full VS Code-style IDE, although none of those
   moments need a file tree or terminal. The product promise is
   "describe the outcome → agent works → you review"; the review moments were
   squeezed into a ~300px agent sidebar while an IDE the user did not ask for
   dominated the screen. Review/Replay already render as full-screen overlays
   covering the workbench — evidence that task work never needed the IDE frame.
2. **Internal language leaks.** Raw state enums (`AWAITING_PLAN_APPROVAL`,
   `REVIEW_READY`, `UNVERIFIED_BY_USER`), raw tool names ("propose_plan —
   SUCCEEDED") and transition rows ("→ EXPLORING") are user-visible in the
   workbench, while Home maps the same states to plain labels — two vocabularies
   for one lifecycle.
3. **Craft defects.** Emoji used as icons (activity bar, timeline cards) beside
   an SVG icon system on Home; VS Code palette (blue status bar, `⌘0 ▲0`
   glyphs) colliding with Home's minimal style; review toolbar overlapping the
   title bar and two empty-states overprinting each other; `Accept all changes`
   and `Roll back all` adjacent in the review header; dead vertical void
   between Home's hero and its bottom-anchored composer.
4. **Naming collision.** "Workspace" means both "the opened project folder"
   (workspace-service) and "the IDE surface" ("Open IDE workspace") — two
   concepts, one word.
5. **Audience.** The product targets technical *and* semi-technical users; the
   only structure that serves both is progressive disclosure — a simple default
   path with the full IDE one keystroke away, never a forced passage.

A direction-picker mockup (`docs/design/direction-picker.html`, three IA
options × three visual directions) was reviewed with the product owner, who
selected **IA option B** and the **Studio** visual direction, and added the
**Live Board** requirement (visible agent presence while tasks run).

## Decision

### 1. Three-layer information architecture (IA option B)

```
Home (launcher + mission control)
  └─ Task Room (per-task page: timeline, approvals, changes, verification, decision)
       └─ Editor (the existing workbench — on-demand power tool)
```

- **Task Room** becomes a first-class page inside the Home surface. Clicking a
  task anywhere on Home opens its Task Room, not the workbench. It hosts the
  conversation timeline, plan/permission/question cards, a changes + verification
  rail, the decision panel (review / accept / rollback) and a reply composer.
- **The workbench survives unchanged in capability** (spec §4, milestones 3–9
  and their acceptance stay authoritative) but is demoted from co-equal surface
  to on-demand tool and is called **"Editor"** in all user-visible copy.
  Engine/code identifiers (`workspace-service`, IPC channels) do not rename.
- The workbench agent panel remains (technical users may live in the Editor);
  it shares components and state-label vocabulary with the Task Room.

### 2. Entry consolidation and no auto-jump

- Removed: Home main-area "Open IDE workspace →" chip.
- Sidebar bottom row renamed "Open IDE workspace" → **"Editor"**, with ⌘E as
  the global shortcut (registered on both surfaces).
- Added: Task Room header **"Open in editor"** (jumps into the Editor with the
  task's context: agent panel visible, task selected).
- The Editor keeps its persistent "⌂ Home" title-bar control (PIVOT-006's
  state-preservation guarantee is unchanged).
- **Submitting a task no longer auto-switches to the workbench.** The user
  stays on Home; the new task appears immediately in mission control (running
  card + sidebar glow); notifications call the user back on attention states.

### 3. Studio visual language

- Warm paper light theme + matching dark theme (system-following), ink-black
  primary actions, serif display face for the Home hero, 12–14px radius cards,
  soft shadows. Both surfaces share the same design tokens — no VS Code blue
  status bar, no `⌘0 ▲0` glyphs.
- One shared **state-label dictionary** maps every task state to plain language
  ("Waiting for your approval", "Ready to review", …) with a chip tone; no raw
  enum, raw transition row or raw tool-status string is user-visible anywhere.
- One SVG icon set (extended `Ic`) across both surfaces; emoji are banned from
  chrome/cards (message *content* from users/agents is exempt).
- Trust selector becomes a segmented control with a caption line explaining the
  active level (replaces the bare `<select>`).
- Dangerous-action hierarchy: `Accept` and `Roll back` are never adjacent;
  rollback is a quiet tertiary entry with explicit confirmation; plan rejection
  is a tertiary "Cancel task…" text action, not a red primary.

### 4. Live Board (agent presence)

While ≥1 task runs, Home's Running section expands into per-project boards:

- A tile per recently-touched file: ripple animation on each write, heat level
  (hot/warm/cool) from write frequency with ~60s exponential decay, a mini
  write-rhythm bar row, and a "writing" beacon on the file currently being
  written.
- Per-project header: presence beacon, current task + step, writes/min rate.
- Clicking a tile opens the read-only **"diff so far"** file lens (reuses the
  P2 replay lens machinery). Sidebar project rows and Editor tree glow stay in
  sync — all three light layers are driven by the same change events.
- Hard constraints: driven exclusively by change events (**never fs polling**,
  same invariant as PIVOT-016); animations pause when the window is unfocused
  and under `prefers-reduced-motion`; tile cap with "+N more" overflow; event
  batching per animation frame; board collapses when nothing runs.

## Acceptance changes

Revised (supersede the ADR-0004/0006 wording where they conflict):

| ID | Revision |
| --- | --- |
| PIVOT-005 | Submit creates and starts the task but **stays on Home**; the task appears in mission control immediately. Empty intent / no project remain guided no-ops. |
| PIVOT-006 | Surface switching: Editor reachable via sidebar "Editor" row, ⌘E, and Task Room "Open in editor"; "⌂ Home" returns; state preserved both ways. The main-area workspace chip is gone. |
| PIVOT-007 | Clicking a task (sidebar, mission control, ⌘K) opens its **Task Room**. |
| PIVOT-013 | Mission-control cards jump to the Task Room (review states may deep-link to the review overlay). |

New:

| ID | Requirement |
| --- | --- |
| PIVOT-021 | Task Room: task page with timeline, plan/permission/question cards, changes + verification rail, decision panel and reply composer; header has human state chip and "Open in editor"; plan approval, permission grants, review entry, accept and rollback all work without entering the Editor. |
| PIVOT-022 | Entry consolidation per §2 including no auto-jump on submit. |
| PIVOT-023 | Humane language: no raw state enum, transition row, or tool-status string is user-visible on any surface; one shared label dictionary; no emoji iconography in chrome/cards. |
| PIVOT-024 | Studio theme (light + dark) applied to both surfaces from shared tokens; review overlay renders without chrome collisions (no overlapping toolbars/empty-states). |
| PIVOT-025 | Live Board per §4: event-driven tiles with ripple/heat/writing states, per-project grouping for parallel tasks, tile → read-only diff-so-far lens, no polling, reduced-motion/unfocus pause, collapsed when idle. |

## Consequences

- E2E specs that encoded the old navigation (auto-jump on submit, task click →
  workbench panel) are updated together with this ADR; engine-flow coverage
  (E2E-009..018) is untouched. This is a formal spec change, not a test
  weakening.
- `AgentPanel` is refactored into shared timeline/card components consumed by
  both the Task Room and the Editor agent panel.
- The Studio token set replaces `theme.css` values; `workbench.css` loses its
  VS Code-specific chrome (status bar color, activity-bar emoji buttons).
- New unit tests: state-label dictionary completeness (every TaskState mapped),
  live-board heat/decay reducer. New E2E: task room flow, entry consolidation,
  live board presence (mock runtime).
- `docs/UX_PIVOT_SPEC.md` gains the v3 section; IMPLEMENTATION_STATUS tracks
  SHELL-V3 phases (fixes → reskin → task room → live board).

## Amendments (implementation, 2026-07-13)

1. **Submit opens the Task Room.** PIVOT-005's "stays on Home" is implemented
   as: submit opens the new task's room (still the Home surface, one click back
   to the launcher, never the Editor). Watching your just-delegated task start
   matches the chat mental model; mission control remains the multi-task home.
2. **Live Board groups per task.** The engine opens one project at a time, so
   "per-project boards" degenerate to per-running-task boards under the
   Running section plus the (already shipped) sidebar project-row glow. If
   multi-project sessions ever land, boards regain the project grouping level.
3. **Agent panel mounting.** The Editor's agent panel unmounts while the Home
   surface is active so task testids/flows have exactly one owner at a time;
   Review/Replay render from the global overlay registry and work on both
   surfaces.

## Alternatives considered

- **A — keep co-equal dual surfaces, restyle only.** Cheapest; rejected: keeps
  forcing the IDE through delegation flows, keeps the double mental model.
- **C — dissolve the IDE into Task Room tabs (Devin-style).** Purest
  task-centric story; rejected: conflicts with spec §4 workbench acceptance,
  largest rebuild, and alienates the technical persona that wants a real IDE.
