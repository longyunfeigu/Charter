# ADR-0060: Rich review projections and shadow entry snapshots for non-Git folders

- Status: Accepted
- Date: 2026-11-16
- Relates to: ADR-0013 (Review v2 diff), ADR-0017 (external CLI sessions and
  entry snapshots — this ADR replaces its non-Git "first-seen" degradation for
  local sessions), ADR-0014 (in-room peek)

## Context

Two gaps made Review weaker than the evidence Charter promises:

1. **Review only spoke source.** A Markdown change was reviewed as raw
   `+`/`-` lines and an image change hit "Binary file — no text diff". For
   documents and assets the reviewer's real question is "what will a reader
   see?", which the source diff answers poorly or not at all.
2. **Plain folders had no real baseline for external Agents.** The workspace
   watcher learns about an external CLI's write only after it landed. Git
   projects get an entry snapshot (`write-tree` through a temporary index);
   a non-Git folder fell back to "first-seen content is the baseline"
   (ADR-0017), which is the post-write content. The first edit to every
   pre-existing file was therefore invisible in Review and impossible to roll
   back.

## Decision

### 1. Rendered projections in Review

- Markdown files open in a **Rendered** view by default in the Session diff
  card and the full Review overlay. Both versions are split into top-level
  blocks (paragraphs, headings, lists, tables, fenced code, front matter),
  aligned with an LCS over normalized block text, and shown as rows of
  rendered Markdown: changed rows are tinted on both sides, added/removed
  rows are hatched on the empty side, long unchanged runs fold. Reference
  link definitions are appended to each rendered block so split blocks keep
  their links. Inline/Text (Session) and Source (Review) remain one click
  away; Request fix and hunk chips switch to Source because they address
  exact lines.
- Images (`png jpg jpeg gif webp bmp ico avif svg`) open as an **image
  compare**: a reveal slider over one stage (default) or side by side, with
  dimensions and byte sizes, on a transparency checkerboard. SVG keeps its
  source diff as an option. The in-room peek shows the same compare instead
  of the binary dead end.
- New channel `task.reviewImage` v1 returns both sides as base64 (20 MB per
  side; larger sides return size only). It resolves the baseline owner the
  same way as `task.reviewFile`, reads the baseline from the blob store and
  the current side from the task's mount. No new renderer dependency.

### 2. Shadow entry snapshots

- A local external CLI Session in a non-Git folder captures its entry
  snapshot into a private bare repository at
  `<userData>/shadow-snapshots/<sha256(root)[:24]>.git`, with the project
  folder as the work tree. Nothing is written into the project.
- The snapshot is the exact bytes: `core.autocrlf=false`, system config and
  attributes ignored, and `$GIT_DIR/info/attributes` unsets `text`, `filter`,
  `ident` and `working-tree-encoding` so in-tree `.gitattributes` (EOL rules,
  LFS) cannot rewrite them. Captured with `add -A -f` so `.gitignore` cannot
  silently drop a file.
- Coverage is explicit. Regenerable directories (`node_modules`, `.venv`,
  `dist`, `build`, `target`, caches …), nested repositories, symlinks,
  special files and files over 32 MB are excluded, and each tree stores a
  manifest of what it excluded. A read returns `bytes`, `absent` or
  `uncovered`; only `absent` may become a "did not exist" baseline, so an
  excluded or pruned path can never be mistaken for a created file (which
  rollback would delete). Uncovered paths keep the previous first-seen
  behaviour.
- Budget: at most 20 000 files / 256 MB per snapshot. Over budget, the home
  directory or a filesystem root → no snapshot (honest ADR-0017
  degradation), never a partial one.
- Refs are self-describing: shadow snapshots persist as `shadow:<tree>`, Git
  ones stay bare tree ids. A Git ref is never read from a shadow repository
  or the reverse; a folder that stopped being a repository loses its
  snapshot rather than reading the wrong store.
- Retention: each snapshot is pinned by `refs/charter/<ms>-<tree>`; once a
  day per repository, refs older than 30 days are dropped and the repository
  is `gc --prune=now`'d (the stat-cache index is then reset). The index is a
  persistent stat cache, so repeated captures only rehash changed files.
- Every capture/read/diff on one repository is serialized.
- The same source abstraction now serves Session start, offline/exit
  reconciliation, continuation and adoption, so non-Git folders also get the
  "changes made while no watcher was alive" recovery.

## Alternatives considered

- **Copy every file into the existing blob store.** No compression or stat
  cache, so every Session start would rehash and the store would grow without
  bound; it would also need its own manifest/diff code. Git already provides
  all three.
- **Snapshot inside the project (`.charter/`).** Pollutes user folders and
  their sync tools; rejected.
- **A per-file size cap only, no total budget.** A Session opened in a large
  folder would block the Agent start for minutes; refusing is honest and
  keeps today's behaviour.
- **A Markdown/diff library in the renderer.** The block alignment is ~150
  lines and needs no dependency.

## Security and data impact

- Shadow repositories copy project file contents into app data (same trust
  boundary as the existing baseline blob store; documented in README). They
  are not uploaded anywhere. Removing a project does not yet delete its
  shadow repository; the 30-day ref expiry bounds its growth.
- Rollback correctness improves: pre-existing files in plain folders are
  restored to their pre-Session bytes instead of their post-first-write bytes.
- Image previews are base64 data URLs rendered in `<img>` (no script
  execution, including SVG).

## Migration / rollback

No schema migration. Existing tasks keep `snapshotRef` values (bare Git tree
ids or null). Reverting the code leaves orphaned `shadow-snapshots/`
directories, which can be deleted safely.

## Verification

- `markdown-block-diff.test.ts` (block split, alignment, folding, references).
- `shadow-snapshot.test.ts` with real Git: exact CRLF/binary bytes despite
  hostile `.gitattributes`; excluded segments, nested repos, symlinks and
  oversize files read as `uncovered`; snapshot diffs; budget refusal;
  home/root refusal; pruned tree → `uncovered`; torn index recovery.
- `tests/e2e/review-rich-diff.spec.ts`: a fake external Agent edits Markdown,
  a PNG and a TypeScript file in a non-Git folder; Review shows the real
  one-line addition, the rendered Markdown rows, the image slider and side by
  side views in the Session card and full Review; rollback restores all three
  files byte for byte.
