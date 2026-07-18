# Project Files Restructure Mock — Design QA

- Source visual truth: `/var/folders/23/z96fd00x791_2j0k757hsnjw0000gn/T/codex-clipboard-L9LGiE.png`
- Implementation: `docs/design/project-files-restructure-mock/index.html`
- Desktop implementation screenshot: `/tmp/charter-project-files-mock-1320.png`
- Narrow implementation screenshot: `/tmp/charter-project-files-mock-900.png`
- Full-view comparison: `/tmp/charter-project-files-comparison.png`
- Focused comparison: `/tmp/charter-project-files-comparison-focused.png`
- Desktop viewport: 1320 × 760 logical pixels. The 2640 × 1520 source is a 2× Retina capture.
- Narrow viewport: 900 × 900.
- State: Archive light, fable5 active, Files selected, OPUS.md open.

## Findings

- No actionable P0/P1/P2 findings remain.
- The source's red annotation rectangles and editor spelling/diagnostic overlays are review markup and transient editor evidence, not product chrome; they are intentionally not reproduced.

## Required fidelity surfaces

- Fonts and typography: Archive's Iowan/Palatino/Georgia display stack and Menlo/Monaco code stack are preserved. Headings, compact metadata, file rows and code line rhythm visually match the source density.
- Spacing and layout rhythm: the persistent activity rail, Projects panel, contextual Files pane, tabs and editor remain aligned to the source. Projects was reduced to 244px and Files to 278px after the first comparison so the editor receives more width than the current duplicated-tree layout.
- Colors and tokens: the mock uses the product's Archive light tokens for editor, sidebar, panel, border, selected, accent, success and warning states.
- Image and asset fidelity: the screen contains no raster product imagery. All interface icons use Monaco's real Codicon font from the installed dependency; no placeholder, emoji, custom SVG or CSS-drawn icons are used.
- Copy and content: project names, paths, file names, editor tabs and OPUS content follow the supplied screen. The only new copy is the functional `Hide context` / `Show context` control.

## Comparison history

### Pass 1 — blocked

- [P1] Removing the duplicate tree did not initially return space to the editor because the mock used a 316px Projects panel and 310px Files pane.
- Fix: reduced the global activity rail to 54px, Projects to 244px and Files to 278px while keeping both independently collapsible.

### Pass 2 — passed

- Evidence: `/tmp/charter-project-files-comparison-focused.png` shows the source's global tree + Explorer replaced by a compact project list + one canonical Explorer.
- The editor now begins earlier than in the source at the same logical viewport, while project switching and contextual file actions remain visible.

## Primary interactions tested

- Switch Files, Search and Changes without introducing another sidebar.
- Collapse and restore the contextual pane.
- Split and join the editor canvas.
- Select files from Files, Search and Changes.
- Search and switch global projects.
- At 900px, keep Projects closed by default and open it as an overlay without duplicating the file tree.
- Checked page errors and console errors: none.

## Follow-up polish

- [P3] A production implementation should reuse Monaco's real editor model and tab overflow menu rather than the mock's static code renderer.
- [P3] The exact auto-collapse policy for Projects after file selection should be user-tested; the mock keeps manual control on desktop and closes it automatically at narrow widths.

final result: passed
