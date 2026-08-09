# ADR-0054: The editor lives in its owning contexts — retire the global Editor entry

- Status: Accepted
- Date: 2026-08-09
- Relates to: ADR-0008 (entry consolidation, partially superseded), ADR-0014
  (in-room peek, unchanged), ADR-0029 (one project tree, unchanged),
  ADR-0042 (destination-owned surfaces), ADR-0046 (session defines working
  context, extended), PIVOT-006 (workspace auto-land, retired), PIVOT-027r
  (tree click-to-peek, superseded)

## Context

The Activity Bar carried a global "Editor" button wired to a compatibility
action (`setSurface('workspace')`) left over from the retired full IDE
workspace shell. One click produced three different outcomes depending on
hidden state: with an open Session it expanded that Session's tool canvas;
with a project it opened the plain editor; with neither it landed on a blank
editor with a one-line hint. The user's verdict on the button was
"非常的混乱" (deeply confusing), and after reviewing three interactive mock
directions (`docs/mockups/editor-entry-redesign.html`) chose direction A/C:
the editor is not a destination — it belongs to the context that owns the
files. During acceptance two more confusions were called out: the rail's
Files tree stayed empty until a Session was opened (browsing a project did
not bind the working context), and clicking a tree file while a Session was
open kept the conversation on screen (click-to-peek) instead of showing the
file, unlike the reference product's tree behavior.

## Decision

1. **No global Editor entry.** The Activity Bar bottom group holds Settings
   only. `surface`/`setSurface` and the `homePick` pin are deleted from the
   app store; nothing navigates by flag anymore.
2. **Opening a workspace never navigates by itself** (retires PIVOT-006).
   The caller that initiated the open decides where to land. The shell boots
   on Home even when a workspace is restored.
3. **The Project Center's Files tab hosts the real editor** for the working
   project — the shared document model (`EditorArea`), so tabs, dirty state,
   autosave, conflict handling and revision-checked saves are the same
   buffers everywhere. Clicking a file in the tab's tree opens it as an
   editable tab in place. A center whose project is not (yet) the working
   context keeps the safe read-only preview with an explicit
   "Set as current & edit" upgrade.
4. **Opening a project's center makes it the working context** — the same
   principle ADR-0046 established for sessions, extended to projects, via
   `followProject`. The rail's Files tree, the embedded editor and the
   composer binding follow what the user is looking at; the separate
   "Set as current" step is no longer required (the button remains as a
   no-op-hidden affordance for the non-current edge).
5. **A rail tree file click always opens the file full screen** in the plain
   editor (supersedes PIVOT-027r's click-to-peek). The file is the
   destination; an open conversation stays one Back away. In-room peeks
   remain the behavior for timeline evidence paths, where the conversation
   is the anchor (ADR-0014); ⌘/alt on a timeline path opens the peek's Edit
   mode instead of leaving the Session.
6. **⌘K and the palette keep an editor entry** ("Open project files",
   `project.files`) that can never land on a blank editor: with a workspace
   it opens that project's Files tab; without one it opens the Projects
   rail.

## Consequences

- The blank-editor dead end is structurally unreachable: every path into an
  editor starts from a project or a session.
- `NavigationSnapshot` and the navigation history no longer carry a surface
  flag; ProjectToolView (plain editor + Search/Changes) remains reachable
  contextually (rail tree click, Changes/Setup, palette) and unchanged
  otherwise.
- E2E specs that encoded the old contracts were updated in the same change
  set: launch helper no longer clicks an Editor entry nor waits for an
  auto-land; pivot-shell, shell-v3, shell-v4, home-dragref, project-center,
  project-files-restructure, session-rail-polish and terminal-remount assert
  the new journeys (embedded center editor, auto-follow on center open,
  Ctrl+` round-trip).
- Known tradeoff: browsing another project's center now moves the working
  context (with the usual toast/trust flow). Tasks are bound to their own
  project and survive the switch; re-entering a session follows back
  (ADR-0046).
