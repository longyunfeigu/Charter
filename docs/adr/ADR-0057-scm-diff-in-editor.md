# ADR-0057: SCM diffs open as editor tabs; in-shell overlays portal to `<body>`

- Status: Accepted
- Date: 2026-08-09
- Relates to: ADR-0013 (git decorations, unchanged), ADR-0014 (in-room peek —
  "never a modal", extended to the SCM surface), ADR-0029 (project tools
  column), ADR-0054 (the editor lives in its owning contexts, extended)

## Context

Clicking an entry in the Changes panel (`ScmView`) opened `GitDiffModal`, a
94vw × 86vh modal left over from M5. During acceptance (2026-08-09 screenshots)
it presented as visually broken:

1. **The modal painted underneath the Session rail.** Every overlay rendered
   inside the persistent shell sits in `.hm-root`, which is a stacking context
   pinned at `z-index: 0` (`session-workbench.css`), while the sibling
   `.sr-rail` sits at `z-index: 4`. A `position: fixed` backdrop with
   `z-index: 80` inside `.hm-root` still paints below the rail — the modal's
   left ~270pt (including its title) disappeared under the Files pane and the
   backdrop dim never covered the rail. Every `modal-backdrop` inside the
   shell had this defect; the giant diff modal made it flagrant.
2. **Untracked/new files defaulted to a side-by-side diff against an empty
   original** — half the pane was hatched dead space and the other half a
   solid green wash.
3. **A full-screen modal contradicts the product's own design language.** The
   in-room peek (ADR-0014) is explicitly "a resident split panel — never a
   modal", and ADR-0054 moved the editor into its owning contexts. Both SCM
   hosts (Project tools' Changes column, the Terminal Session's Changes tool)
   sit right next to a live `EditorArea`, yet the click ignored it.

## Decision

1. **A git diff is a first-class editor tab.** The tab model
   (`store/editor-tabs.ts`, pure and unit-tested) now carries
   `file | diff` tabs addressed by a stable id — a file tab's id IS its path,
   so every legacy path-keyed call site works unchanged; diff tabs use
   `git-diff://{work|staged}/<path>`. Tabs persist and restore across
   sessions (`OpenTabsStateSchema` gains optional `kind`/`staged`; old
   payloads default to `file`, old builds strip the new keys).
2. **Working-tree diffs edit the live buffer.** `GitDiffPane` renders a Monaco
   diff editor whose modified side is the shared workspace document model
   (`doc.open`ed exactly like a file tab — dirty tracking, mirror, autosave,
   ⌘S all identical). Original side is the index (`git show :0:path`), i.e.
   `git diff` semantics. Staged diffs are HEAD ↔ index, read-only. The pane
   refreshes on `git.changed`, shows ±line stats, and falls back to read-only
   disk content for deleted/binary/oversized files.
3. **New files never waste half the pane.** When the original side is empty
   the pane defaults to inline rendering; the split/inline toggle remembers
   the user's last choice for subsequent diffs.
4. **Untracked and conflicted entries open the file itself** — there is
   nothing meaningful to diff (conflict markers are content).
   `git status` now runs with `--untracked-files=all` (acceptance finding,
   2026-08-09): the default collapses an untracked directory into one
   `examples/` row that nothing downstream can open, diff, or stage as a
   document — clicking it produced "The file could not be read". Files inside
   untracked directories enumerate individually, matching VS Code; the
   renderer additionally refuses to route any `dir/` path to `doc.open`.
5. **`GitDiffModal` is deleted.** The SCM row's discard action is visually
   destructive (danger hover), actions surface on hover/focus via opacity
   (keyboard-reachable), and the whole surface is localized.
6. **Overlay discipline: full-viewport overlays rendered inside `.hm-root`
   must `createPortal` to `document.body`.** Applied to the SCM discard
   confirm, editor compare/close dialogs, the diff-so-far lens, the new
   project/task dialogs, the terminal create/kill dialogs and the search
   replace preview. Workbench-level overlays (settings, review, rename,
   trust) already render outside the shell and are unchanged. New overlays
   inside the shell must follow this rule; the alternative — raising
   `.hm-root` above the rail — would put shell content above the rail's
   hover tooltips.

## Acceptance round 2 (2026-08-09)

Three findings from live use, fixed in the same change set:

1. **SCM row tooltips show the full path again.** The rewrite had put the
   action hint ("Open diff in the editor") in `title`, but the row text is
   what truncates — the tooltip's job is the path.
2. **The Search/Changes column is user-resizable.** A drag handle on the
   divider (`.ptc-resize`, same pointer/keyboard idiom as the rail's
   `.sr-rail-resize`: drag, arrow keys, Home/double-click reset) drives
   `--ptc-width`, persisted in `localStorage`
   (`charter.projectTool.contextWidth.v1`, 200–640px). A window-resize
   re-clamp keeps the editor stage ≥ 420px and replaces the old fixed 256px
   narrow-viewport CSS override.
3. **Tree decorations now clear on commit** (amends ADR-0013's merge rule).
   Two causes: (a) `gitStatusStore` refreshed only on `fs.batch` and task
   edges — commits mutate `.git` only, which the workspace watcher never
   reports, so the Changes panel emptied while the tree stayed green; it now
   also subscribes to `git.changed`. (b) In a git repo the agent-mark overlay
   kept marks for paths git considers clean — a file the user committed still
   showed 'A' until its task archived. Git is now authoritative for the whole
   tree in repos (everything an agent writes on disk is visible to git);
   agent change records decorate only non-git projects, which was their
   stated purpose.

## Consequences

- The editor tab strip can now hold non-file surfaces. Status-bar items that
  read `docs[active]` treat a diff tab as "no file" and hide (EOL/encoding),
  which is correct; the cursor item is fed by the diff pane.
- `tabs.save` payloads written by this build parse in older builds (unknown
  keys strip to file tabs); a diff-tab `active` id degrades to an empty
  selection there.
- E2E-008 asserts the tab flow (`git-diff-pane`, `tab-git-diff://…` testids)
  instead of `git-diff-modal`, plus untracked → file tab and staged → staged
  tab paths.
- The `Stage: '阶段'` dictionary key predates this change and is wrong for
  git staging; SCM uses distinct `Stage file` / `Unstage file` message ids.
