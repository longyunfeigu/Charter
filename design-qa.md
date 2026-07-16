# Terminal Parallel vNext — Design QA

## Comparison target

- Source visual truth:
  - `docs/design/audit/terminal-vnext-01-bottom.png`
  - `docs/design/audit/terminal-vnext-02-codex-side.png`
  - `docs/design/audit/terminal-vnext-03-new-terminal.png`
  - Interactive source: `docs/design/terminal-parallel-vnext.html`
- Browser-rendered implementation screenshots (Electron Chromium, captured by
  the repository Playwright harness):
  - `docs/design/audit/terminal-vnext-implementation-01-bottom.png`
  - `docs/design/audit/terminal-vnext-implementation-02-codex-side.png`
  - `docs/design/audit/terminal-vnext-implementation-03-new-terminal.png`
- Viewport: 1440 × 900 CSS pixels. The source side screenshot was 1458 × 900
  and was normalized to 1440 × 900 for comparison.
- Theme: the product's light theme and existing design tokens.
- States:
  - Codex and Claude Code are live in different project contexts.
  - Codex is active in the Bottom Panel.
  - Codex occupies the single right focus slot while Claude remains in the
    Bottom Panel list.
  - New Terminal selects Claude Code plus the recent project and displays
    focused, recent, Task/worktree and scratch contexts.

## Visual evidence

Full-view source/implementation comparisons:

- `docs/design/audit/terminal-vnext-qa-full-bottom.png`
- `docs/design/audit/terminal-vnext-qa-full-side.png`
- `docs/design/audit/terminal-vnext-qa-full-modal.png`

Focused region comparisons:

- `docs/design/audit/terminal-vnext-qa-focus-bottom.png`
- `docs/design/audit/terminal-vnext-qa-focus-side.png`
- `docs/design/audit/terminal-vnext-qa-focus-modal.png`

The source side capture contains a prototype transition fade. The stable
implementation state was compared against both that capture and the approved
interactive HTML structure; the fade itself is not a product requirement.
Fixture project names, absolute temporary paths and terminal output are dynamic
content and were not treated as visual drift.

## Findings

No actionable P0, P1 or P2 findings remain.

- Fonts and typography: the implementation preserves the product's existing UI
  and monospace font stacks, weights and small-label hierarchy. Long real paths
  truncate instead of wrapping or changing row height.
- Spacing and layout rhythm: the 260px terminal list, 35px New Terminal row,
  34px session bar, 590px chooser, single 600px side slot and dense row rhythm
  match the approved composition. Production Explorer and Agent Panel widths
  leave less center space than the mock fixture; below 560px the session-bar
  context chip hides cleanly while the same context remains visible in the
  terminal row and tooltip.
- Colors and tokens: the implementation maps the mock's warm neutral surfaces,
  amber live state, green live counter, muted borders and selected fills to the
  existing theme variables. No new independent palette was introduced.
- Image quality and asset fidelity: the feature has no photographic,
  illustrative, logo or generated-image assets. Existing product icons and the
  source's compact terminal/placement symbols remain sharp at device scale.
- Copy and content: Shell, Claude Code, Codex, Focused, Recent Project,
  Isolated, Temporary, Room, Move/Replace and Return labels follow the approved
  terminology. The host-resolution note and same-working-tree warning reflect
  real behavior.
- Responsiveness and accessibility: the panel has no persistent-control
  overflow at the tested viewport; rows and dialog choices are keyboard
  reachable, visible focus styles are retained, the resize separator exposes
  ARIA values and reduced-motion rules disable status animation.

Residual P3 note: the production shell's existing Explorer and Agent Panel are
wider than the prototype's illustrative rails, so the editor canvas and bottom
terminal text area are narrower. The terminal feature responds without overlap
or control loss; changing those global product widths is outside this mock's
scope.

## Comparison history

1. Initial comparison — blocked by P2 bottom-panel clipping.
   - Finding: focusing the mounted xterm scrolled the Bottom Panel layout by
     35px, hiding the session bar and New Terminal row.
   - Fix: made the terminal grid/main pane zero-scroll, minimum-height-safe
     containers and reset the ancestor scroll position after xterm reparenting.
   - Post-fix evidence: `terminal-vnext-qa-full-bottom.png` and
     `terminal-vnext-qa-focus-bottom.png` show both persistent rows visible.
2. Narrow production center column — blocked by P2 responsive truncation.
   - Finding: the session context compressed to one character while preserving
     the higher-priority Room and Move controls.
   - Fix: added a container query that hides only that redundant context chip
     below 560px; the terminal row and title retain the full context.
   - Post-fix evidence: the focused bottom comparison shows a clean, complete
     control row with no clipped text or overlap.
3. State normalization — blocked by P2 comparison-state mismatch.
   - Finding: the first implementation capture had no Task/worktree fixture and
     selected Codex while the approved chooser capture selected Claude Code and
     showed four context kinds.
   - Fix: the visual E2E now creates a real isolated Task worktree, restores the
     intended focused/recent project order and selects Claude Code before
     capture.
   - Post-fix evidence: `terminal-vnext-qa-full-modal.png` and
     `terminal-vnext-qa-focus-modal.png` show the same four-row structure and
     selected state as the source.

## Primary interactions tested

- Open the existing terminal home with Control+backquote without creating a
  duplicate terminal.
- Launch Codex in project A, move editor focus to project B and verify the same
  terminal id and process id survive.
- Launch Claude Code in project B while Codex remains live.
- Move Claude to the side slot, then replace it with Codex in one click and
  verify neither PTY is killed or recreated.
- Return the side terminal to the Bottom Panel and restore the prior Agent Panel
  state.
- Open the split New Terminal chooser, switch launch types and select a recent
  project while focused, recent, Task/worktree and scratch contexts are shown.
- Exercise the live xterm in both dock and side mounts and confirm its output
  and scrollback remain present.

Console errors checked: yes. The final Playwright flow collected renderer
`pageerror` and `console.error` events and asserted an empty list.

## Implementation checklist

- [x] Match the approved terminal-home, side-slot and chooser geometry.
- [x] Preserve real xterm/PTy identity during reparent and atomic swap.
- [x] Keep project/task accounting bound to the terminal's host-resolved
      context across editor focus changes.
- [x] Verify full and focused visual comparisons after each P2 fix.
- [x] Verify keyboard/accessibility affordances and renderer console health.

final result: passed

---

# Session Rail Workbench Mock — Design QA

## Comparison target

- Source visual truth: `/Users/edy/.codex/generated_images/019f68a6-81e9-7783-8ddf-35ffd5e32238/exec-fa30f18e-7158-4ec4-bc28-0fc4a7b7fd80.png`
- Implementation: `docs/design/session-rail-workbench.html`
- Native comparison viewport: 1440 × 1024 CSS pixels.
- Captured state: `?clean=1&step=7`, with the Pi session selected and ready
  for review while Claude and Codex remain live in the rail.
- Capture method: the repository Playwright Electron harness with an isolated
  temporary user-data directory. The project AGENTS.md explicitly requires
  Electron Playwright instead of the in-app Browser for Charter UI validation.

## Visual evidence

- Latest implementation: `/tmp/session-rail-workbench-pi-ready.png`
- Same-input full comparison: `/tmp/session-rail-workbench-comparison.png`
- Same-input top-region comparison: `/tmp/session-rail-workbench-focused-top.png`
- Claude plus Markdown state: `/tmp/session-rail-workbench-claude-markdown.png`
- Split PTY state: `/tmp/session-rail-workbench-split.png`
- New Session modal: `/tmp/session-rail-workbench-new-session.png`
- Narrow state at 1180 × 820: `/tmp/session-rail-workbench-narrow.png`

The source and latest implementation were both opened and inspected at the
same normalized viewport. No actionable P0, P1 or P2 visual finding remains.

## Findings

- Typography: the mock preserves the reference's compact system UI hierarchy,
  with a restrained monospace stack for paths, terminal output and diffs.
- Layout: the centered window title, persistent 210px session rail, two-row
  shell header, main work surface, bottom changes pane and status bar preserve
  the reference composition and information priority.
- Session rail: Claude, Codex and Pi remain independently visible with live,
  paused and ready-for-review states; switching sessions does not collapse the
  user's mental model into Home versus Editor.
- Main surface: Pi keeps its structured, multi-run execution timeline and
  review card. Claude and Codex keep terminal-native PTY surfaces rather than
  being forced into Pi's task-log grammar.
- Tools: code editing, Markdown editing/preview, Changes, Tests and Agent Log
  stay in the same workbench and can coexist with a running session.
- Colors: the true-white/cool-gray shell, cobalt selection, purple Pi, orange
  Claude, green Codex and semantic success/error colors match the selected
  reference direction.
- Assets: this desktop workbench has no photographic or illustrative assets;
  provider monograms and controls are rendered from product UI primitives and
  remain sharp at device scale.
- Copy above the fold: labels follow the selected visual truth. The final clean
  capture removes exploratory labels such as “Session-first prototype” and
  uses the reference-like ellipsis action in the header.
- Responsiveness: at 1180 × 820 the review card and composer remain visible;
  the guided cursor scrolls its target into view instead of covering or
  clipping the primary action.
- Accessibility and console health: buttons and session rows are keyboard
  reachable, focus is visible, dialog semantics are present, reduced motion is
  respected, and the Electron test asserted zero page errors and zero
  `console.error` events.

## Comparison history

1. Initial comparison found a missing global window bar, undersized session
   rows, an overly compressed Pi timeline and missing background-session
   context in the tool pane.
2. The mock added the reference's four-row shell geometry, restored session
   row height and timeline rhythm, added the background Claude notice and file
   breadcrumb, and limited the default Pi tool tabs to the useful code and
   preview surfaces.
3. The final comparison removed invented top-right copy, replaced the visible
   Tools label with the reference-like overflow action, fixed split-terminal
   contrast and centered guided-tour targets at the narrow viewport.

## Primary interactions tested

- Switch among Pi, Claude and Codex without losing each session's native state.
- Open Claude's terminal plus Markdown surface and Codex's live test terminal.
- Restore Pi's ready-for-review state after visiting external PTY sessions.
- Open New Session and choose Pi, Claude or Codex.
- Split Claude and Codex into a side-by-side terminal work surface.
- Use Previous/Next session shortcuts and Meta+1–4 direct selection.
- Send a Pi follow-up to start Run 4.
- Step through, replay and autoplay the nine-stage product journey.
- Verify the clean 1440 × 1024 state and the 1180 × 820 responsive state.

Intentional P3 deviations: macOS traffic lights are treated as host window
chrome, and the interactive tour controls are hidden in clean comparison mode.
Neither deviation changes the product workflow or the approved workbench
geometry.

final result: passed
