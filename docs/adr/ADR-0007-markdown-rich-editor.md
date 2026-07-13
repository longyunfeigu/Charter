# ADR-0007 — Markdown rich editing dependency (PIVOT-019)

Date: 2026-07-13
Status: Accepted

## Context

PIVOT-019 requires Notion-style WYSIWYG editing for `.md` files with the same
dirty-guard/conflict semantics as the Monaco path. A structured rich-text
editor cannot reasonably be built in-repo; this is a dependency decision
(CLAUDE.md requires an ADR for dependency changes).

## Decision

**`@mdxeditor/editor@4.0.4` (exact-pinned)** in the renderer only.

- Markdown is the *source of truth* by design (mdast/remark round-trip) — the
  file on disk stays clean CommonMark, which is the property that matters for
  an editor whose buffers are plain `.md` files.
- Single package, React-native (works with React 19), MIT, actively maintained.
- Rejected: **Milkdown** (good round-trip but multi-package prosemirror
  assembly), **TipTap + tiptap-markdown** (community serializer — weakest
  markdown fidelity), **Toast UI Editor** (aging architecture), building our
  own (out of scope).

## Integration contract (the part that keeps guarantees intact)

1. Rich edits write through the SAME Monaco text model the source view uses
   (`model.setValue` on a short debounce, loop-guarded); the existing
   editorStore listeners then drive dirty state, `doc.update`, ⌘S save and the
   external-change/conflict flow — one code path, one set of guarantees.
2. Model→rich sync on external reloads (`onDidChangeContent` when the change
   did not originate from the rich editor).
3. **Rich mode is opt-in per file** (toggle on `.md` tabs) plus a
   `editor.markdownRichDefault` setting (default **false**). Monaco stays the
   default surface, so every existing acceptance/E2E behavior is unchanged —
   the capability is added, nothing is re-defaulted.
4. Code blocks use a plain-text editor descriptor (no CodeMirror dependency).

## Consequences

- Bundle grows (lexical + mdast); acceptable for a desktop app, verified by
  the production build.
- The undo stack resets when toggling rich⇄source (setValue boundary) —
  documented limitation.
- Image annotation (PIVOT-020) is deliberately dependency-free (in-house
  canvas component + two bounded IPC channels).
