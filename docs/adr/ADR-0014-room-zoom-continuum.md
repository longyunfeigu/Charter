# ADR-0014 — Room zoom continuum: conversation-anchored file viewing (L0/L1/L2)

Date: 2026-07-14 · Status: ACCEPTED (product owner approved the end state and the
mockup `docs/design/room-peek-directions.html`, then delegated implementation)
Amends: ADR-0008 (Editor as on-demand tool), PIVOT-006/015/025/027 defaults.

## Context

Daily use of the task-centric shell surfaced one structural friction: while
chatting with the agent in a Task Room, *looking at a file* — the most frequent
side-action of agent-driven development — always costs a full surface switch to
the Editor (`TaskRoomView` rail rows and every Home file affordance call
`editor.openFile()` + `setSurface('workspace')`). The only intermediate layer,
`FileLens`, is a modal diff-only overlay: it blocks the conversation, shows only
this task's recorded diff, and cannot show a file's current content.

A competitor survey (Codex App, Devin, Claude Code desktop, Conductor, Jules,
Cursor 2/3, Antigravity 2.0) found **no shipping product that page-switches on
file view**:

- Claude Code desktop opens a *file pane* beside the chat in the same workbench;
- Devin/Conductor/Jules keep a persistent split (chat + workspace/diff rail);
- Codex App offers only diff-level inline review and jumps to an *external*
  editor for whole files — called out by reviews as its main flow-breaker;
- Antigravity 2.0 removed file visibility behind a chat-only shell and users
  described it as a lockout — the opposite failure.

The safe (and converged) design region: **conversation stays present; files are
progressively disclosed beside it; the full editor remains one explicit step
away.**

## Decision — one room, three zoom levels, one invariant

The product has one anchor: the task conversation. "Home vs Editor" stops being
two worlds and becomes zoom levels of the same room:

- **L0 — conversation.** The Task Room as it exists (timeline, rail, composer).
- **L1 — conversation + file peek.** Activating a file reference opens a
  *resident split panel* inside the room (never a modal): Changes/File dual
  mode, pinned tabs, read-only, contents read through the task's own mount
  (project root or worktree — worktree-honest by construction), live-following
  while the agent writes. The rail collapses to a restore tab; the conversation
  stays fully interactive.
- **L2 — conversation + full editor.** The existing workbench, reached by
  *explicit intent only* (⌘E, sidebar Editor row, room header, peek header
  "Open in editor", ⌘-click a file reference). Entering and leaving preserves
  the conversation's identity: same task active, agent panel visible, reply
  draft and timeline scroll position survive the round-trip.

**Invariant (the anchor rule): no plain click on a file reference moves the
user off the conversation.** Escalation to L2 is always an explicit verb.

### Implementation shape

1. **`task.peekFile` channel** (v1, strict): `{ taskId, path } →
   { content|null, binary, missing, truncated, sizeBytes, fromBuffer }`.
   Implemented as `TaskService.peekFile` → `contextForTask(taskId)` →
   `RoutedDocumentStore.readLogical(path)`. This reuses the ADR-0009 multi-mount
   facade: path-boundary enforcement (`resolveInsideRoot`), live editor buffer
   when the mount is the focused workspace, plain disk reads otherwise, and the
   task's worktree when isolated. Content is capped (1 MB, `truncated` flag);
   binary/missing return honest flags instead of errors.
2. **`appStore.peek`** — `{ taskId, paths[], active, mode }` global state (like
   `lens`), so peek survives L2 round-trips; opening another task's room resets
   it. Pure tab/active bookkeeping lives in `views/peek.ts` (unit-tested).
3. **`FilePeek` component** in the Task Room between `tr-main` and `tr-rail`:
   diff mode renders the recorded change set (same data as FileLens, pulse-
   following); file mode mounts a read-only Monaco editor (same direct
   `monaco-setup` import the Review overlay already uses on this surface).
4. **Reference rewiring** (all default to peek while a room is open):
   rail Changes rows, in-room LiveBoard tiles, room timeline evidence paths
   (made clickable), `openWorkspaceFile` (⌘K launcher files, report chips) when
   `surface==='home' && taskRoomTaskId` and no overlay is above, Home project
   tree files when the room's project is the focused one. ⌘/alt-click keeps the
   direct Editor jump. Launcher-context opens (no room) keep the Editor —
   there is no conversation to anchor to.
5. **Room-aware ⌘E**: `surface.toggleEditor` from a room = "open THIS task in
   the editor" (agent panel visible, task active, cross-project focus switch as
   in the room header button). Draft text and timeline scroll are keyed per
   task in session-scoped stores shared by the room and the Editor agent panel.

### Explicitly bounded

- **Read-only v1.** Spot-editing inside the peek (Claude Code-style save with
  conflict warning) is desirable end-state but requires an attribution design —
  user hand-edits vs agent changes in change tracking / review semantics — and
  will come as its own ADR. The escape hatch keeps editing one explicit step
  away meanwhile.
- **Worktree tasks hide "Open in editor"** in the peek (the main tree does not
  contain those changes — same honesty rule as the old rail behavior). Peek
  file mode *does* show worktree content, which the old flow could not.
- **PIVOT-037 (shell unification)** — the Editor as a content-area state of the
  persistent shell (surface concept disappears, morph transition) — is the
  recorded end-state skeleton, staged for a later round; L1/L2 above neither
  block nor depend on it.
- The global `FileLens` overlay remains for launcher mission-control boards
  (no room context) and replay; in-room uses are replaced by the peek.

## Consequences

- PIVOT-015/025/027 default click behavior is superseded by PIVOT-034/035 (see
  `docs/UX_PIVOT_SPEC.md` — Shell v5 section); their Editor behavior survives
  under explicit modifiers/entries. E2E specs asserting "file click → Editor"
  are updated with this ADR — a formal spec change, not test weakening.
- New failure surfaces: peek on a missing/binary/oversized file renders honest
  notes (no error toast storm); a peek for a deleted task closes itself.
- The mock-runtime E2E path covers: peek open from rail + timeline, mode
  switch, pinned tabs, Esc restore, escape hatch to Editor, ⌘E round-trip
  state preservation.
