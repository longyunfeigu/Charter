# Project Files Restructure — Production Design QA

## Comparison target

- Approved interactive target: `docs/design/project-files-restructure-mock/index.html`.
- Approved desktop target screenshot: `/tmp/charter-project-files-mock-1320.png`.
- Real Electron implementation: `/tmp/charter-project-files-production-1320.png`.
- Approved narrow target screenshot: `/tmp/charter-project-files-mock-900.png`.
- Real Electron narrow implementation: `/tmp/charter-project-files-production-900.png`.
- State: Archive light, Projects selected, Files context visible, a source file open.

The approved target and real Electron implementation were opened together at
1320 × 760 and 900 × 900. The production capture uses the real persistent app
toolbar/status bar, Explorer, Monaco editor, workspace data, project switching,
Search and SCM stores rather than the mock's static substitutes.

## Findings

No actionable P0, P1, or P2 findings remain.

- Information architecture: the Projects panel now contains projects, Session
  counts, the current-project indicator, New Session actions, Open Folder and
  New Project only. The nested `HomeProjectTree` is no longer mounted there.
- Canonical context: Files, Search and Changes replace one another in the same
  278px contextual column. The real Explorer is the only visible file tree and
  keeps its existing create, refresh, ignored-file, git-decoration and file-open
  behavior.
- Space and hierarchy: Projects uses a compact 244px content panel on desktop;
  its footer actions stay pinned to the bottom. Context can collapse to zero
  width and immediately returns that space to Monaco.
- Responsive behavior: at 900px the global activity rail remains 44px, Projects
  is closed by default and opens as a 290px overlay. Selecting a project closes
  the overlay while Files and the editor remain mounted; no horizontal document
  overflow is introduced.
- Assets and visual language: production reuses Archive tokens, the existing
  icon system and Monaco's installed Codicon font for the distinct split/context
  controls. No placeholder image, emoji, handcrafted SVG or CSS-drawn asset was
  added.
- Accessibility and runtime health: tabs retain `aria-selected`; the context
  toggle reports `aria-pressed`, `aria-hidden` and `inert`; both desktop and
  narrow Electron runs report no page error, console error, framework overlay,
  blank surface or horizontal clipping.

## Comparison history

1. Initial production pass — blocked by P2 layout/detail mismatches.
   - Projects still consumed the shared 320px rail width, footer actions floated
     directly below the project list, and Split/Context reused an indistinguish-
     able layout icon at narrow width.
   - Fix: give the Projects view a 244px panel, pin its actions to a footer and
     use the real Codicon split/sidebar glyphs from the installed Monaco asset.
2. Final desktop and narrow comparison — no remaining P0/P1/P2 mismatch.
   - Production intentionally includes the real Charter window toolbar, status
     bar and Monaco chrome absent from the focused mock.

## Primary interactions tested

- Select and switch projects without rendering a second project file tree.
- Start a project-bound Session from the explicit project action.
- Open folders and files from the canonical Explorer into Monaco.
- Switch Files, Search and Changes in the same context column.
- Collapse context, restore it by selecting a tool, split and rejoin the editor.
- Open and close Projects as a 900px overlay while preserving the workbench.
- Preserve an active task while switching project context.
- Run 23 affected Electron regression tests, the production build, type/boundary
  checks and 479 unit tests.

final result: passed

---

# External Agent Reply Notifications — Design QA

## Comparison target

- Source visual truth:
  `/var/folders/23/z96fd00x791_2j0k757hsnjw0000gn/T/codex-clipboard-fc7w2f.png`
  (2736 × 1474 Retina pixels). The user's red annotation identifies the
  existing top-right Pi completion card as the notification surface Claude Code
  and Codex should share.
- Normalized source truth:
  `/tmp/charter-source-notice-normalized.png` at the source's 1368 × 737 logical
  viewport.
- Real Electron Claude implementation:
  `/tmp/charter-observed-claude-reply-notice.png` at 1368 × 737 CSS pixels.
- Real Electron Codex implementation:
  `/tmp/charter-observed-codex-reply-notice.png` at 1368 × 737 CSS pixels.
- Narrow evidence:
  `/tmp/charter-observed-claude-reply-notice-narrow.png` and
  `/tmp/charter-observed-codex-reply-notice-narrow.png` at 820 × 720.
- Installed vendor evidence:
  `/tmp/live-e2e/claude-observed-reply-shake.png` (Claude Code 2.1.212 local
  `/help`) and `/tmp/live-e2e/codex-observed-reply-notice.png` (Codex CLI
  0.144.5 local `/status`). Neither path sends a model prompt.
- State: a long-lived external-agent Session remains `IN_PROGRESS`; after a
  prompt submitted through the Session composer produces visible terminal
  output and that output stays quiet for 1.8 seconds, the corresponding
  provider reply notification and Session-row presence animation are visible.

## Visual evidence

- Focused source notification:
  `/tmp/charter-source-notice-focus.png`.
- Focused implementation notification:
  `/tmp/charter-implementation-notice-focus.png`.

The normalized full source and implementation, followed by both focused notice
crops, were opened together in one comparison input. The source's red outline
is a user annotation and is not treated as product chrome. The source and final
implementation share the same logical viewport, Archive light skin, top-right
placement, width, internal grid, typography hierarchy, icon slot, close target,
elevation, and five-second lifetime indicator.

## Findings

No actionable P0, P1, or P2 findings remain.

- Fonts and typography: the implementation reuses the existing
  `.session-notice` component without changing its 9.5/10.5/12.5px hierarchy,
  weights, line spacing, ellipsis rules, or Archive font stack. Provider label,
  project, stable Session identity, and evidence-aware body remain legible at
  both viewports.
- Spacing and layout rhythm: the notification retains the source component's
  360px desktop width, 14px right inset, title-bar-relative top inset, 10px
  radius, 28px icon track, and compact three-line copy grid. At 820px its full
  bounding box remains inside the renderer and does not obscure the Session
  rail's primary controls.
- Colors and visual tokens: card background, border, shadow, foregrounds, and
  hover state all resolve from the active Archive shell tokens. The source Pi
  card is amber because it means “Ready for review”; the external reply card is
  intentionally green because a reply completed successfully while the
  long-lived task is still active. A failed structured reply uses the existing
  error tone.
- Image quality and asset fidelity: no raster asset is required. The shared
  icon-library check-circle is reused at the same size and optical alignment;
  no placeholder, emoji, handcrafted SVG, or new CSS-art asset was introduced.
- Copy and content: Claude and Codex are named explicitly. Structured streams
  say the latest reply finished; observed TUIs say terminal output settled, so
  the banner does not fabricate a semantic turn or claim the task is ready for
  review. The title uses the same stable Session identity as the left rail.
- Interaction and identity: the whole notice remains clickable, dismisses
  itself after five seconds, honors the global notification preference, and
  opens the exact `data-task-id` Session. A later terminal task-state completion
  atomically replaces the reply notice with “Ready for review” instead of
  stacking a duplicate card.
- Responsiveness and accessibility: the notification region retains
  `aria-live="polite"`, both open and dismiss buttons have accessible names, and
  desktop/narrow runs report no page errors, console errors, framework overlay,
  blank renderer, or viewport clipping.

## Comparison history

1. Initial behavior pass — blocked by P1 missing feedback.
   - Finding: Pi task-state completion entered the shared notification store,
     but Claude/Codex reply boundaries only drove the left-row animation, so no
     top-right card could render for long-lived external sessions.
   - Fix: connect both structured provider turns and the observed PTY
     output-settled edge to a provider-specific reply notice while preserving
     the distinction from task completion.
2. Initial full-view comparison — blocked by P2 state-normalization noise.
   - Finding: the first implementation capture still showed the earlier
     external-session detection toast at bottom right, while the source capture
     represented a settled Session state.
   - Fix: dismiss the unrelated detection toast before capturing the reply
     boundary; no product visual styling changed.
3. Final same-viewport full and focused comparison — no remaining P0/P1/P2
   mismatch. The semantic green tone and external Session content are
   intentional state differences; component geometry and visual language match
   the selected Pi notification surface.
4. Narrow pass — no clipping or loss of either notification action at
   820 × 720.

## Primary interactions tested

- Claude and Codex each launch as a genuine long-lived process in the embedded
  PTY, are detected into separate accounting Sessions, accept input through the
  Session composer, emit visible output, and settle through the host timer.
- Each provider produces its own reply label, evidence-aware body, exact task
  identity, whole-card diagonal Session shake, and water-wave presence.
- Clicking each banner opens the exact external Session.
- Two simultaneous structured Claude Sessions retain distinct right panes;
  the correct replying Session gets the structured notice, and its later
  `REVIEW_READY` task notification replaces rather than duplicates it.
- The original managed Pi completion notification regression remains covered at
  desktop and narrow viewports.
- Installed Claude Code 2.1.212 and Codex CLI 0.144.5 each traverse their native
  TUI and produce the same notification using local slash commands only; the
  Codex smoke also covers its fresh-directory trust prompt.

final result: passed

---

# Session Reply Diagonal Shake — Design QA

## Comparison target

- Source visual truth:
  `/var/folders/23/z96fd00x791_2j0k757hsnjw0000gn/T/codex-clipboard-EDvBBf.png`.
  The red annotation identifies the complete selected Session card as the
  motion surface; the user's accompanying direction specifies a short diagonal
  shake after the agent finishes output.
- Real installed-Claude Electron implementation:
  `/tmp/live-e2e/claude-observed-reply-shake.png` at 1600 × 900 CSS pixels.
- Deterministic observed-TUI full and focused evidence:
  `/tmp/charter-observed-claude-reply-shake.png` and
  `/tmp/charter-observed-claude-reply-card.png` at 1440 × 900 CSS pixels.
- Narrow evidence:
  `/tmp/charter-session-reply-shake-narrow.png` at 820 × 720 CSS pixels.
- State: selected Claude Session after user-submitted input, visible PTY output,
  and 1.8 seconds of stable output silence. The vendor proof uses the installed
  Claude Code 2.1.212 `/help` flow without a model request; the deterministic
  proof uses a non-structured long-lived TUI fixture.

The source, focused implementation, and narrow implementation were opened
together in one comparison input. The Electron assertion also reads the live
transform matrix at the first peak: rotation magnitude exceeds 0.02 and the
vertical translation exceeds 0.5 CSS pixels, proving this is not the previous
horizontal-only nudge.

## Findings

No actionable P0, P1, or P2 findings remain.

- Fonts and typography: the animation moves the Session card as one rigid
  surface. Provider mark, live dot, title, status, detail text, and timestamp
  retain their existing sizes, baselines, weight, truncation, and
  antialiasing; no internal element drifts independently.
- Spacing and layout rhythm: the card pivots around 18% of its width, reaches a
  visible 2.4-degree diagonal first peak, then alternates through four smaller
  rebounds before settling at its exact original geometry in 2.2 seconds.
  Transform animation does not reflow the rail or move adjacent Sessions.
- Colors and visual tokens: the selected background, border, inset accent, and
  semantic completion color continue to come from the active shell skin. Two
  whole-card outline waves now accompany the provider wave, making the event
  readable without a new palette or hard-coded card surface.
- Image quality and asset fidelity: no new image asset is required. The
  existing provider mark remains sharp while the browser compositor transforms
  the complete card; no placeholder, emoji, custom SVG, or CSS-art icon was
  added.
- Copy and content: Session identity, terminal-output summary, timestamp, and
  completion state are unchanged. Only the completion presence behavior was
  modified.
- Responsiveness and accessibility: at 820 × 720 the first diagonal peak stays
  inside the viewport and does not cover or clip the next Session. Under
  `prefers-reduced-motion`, the shake and water-wave animations are disabled and
  the existing static completion halo remains.

## Comparison history

1. Initial completion-presence pass — blocked by P1 trigger and motion mismatch.
   - Finding: only the provider emitted rings and the card translated
     horizontally by at most two pixels, so the completion lacked the requested
     whole-card diagonal recoil. More importantly, a real interactive Claude
     TUI is observed-grade and emits no structured `result`, so it never entered
     the animation state at all.
   - Fix: arm a presence-only edge when the user submits PTY input, require
     visible output, and fire after a stable quiet period. This edge is not
     written as semantic Replay evidence. The card now uses a 2.2-second damped
     rotation/x/y sequence plus two whole-card outline waves.
2. Real vendor-Claude pass — no remaining P0/P1/P2 mismatch.
   - Evidence: installed Claude Code 2.1.212 rendered `/help` in the real
     embedded PTY and the corresponding Session visibly tilted and rippled.
     No model request was made.
3. Desktop peak-motion pass — no remaining P0/P1/P2 mismatch.
   - Evidence: the focused Electron capture visibly tilts the selected card;
     the real transform-matrix assertion verifies both rotation and vertical
     movement at the same frame.
4. Narrow pass — no clipping or neighboring-row collision.
   - Evidence: the 820 × 720 production capture and bounding-box assertions.

## Primary interactions tested

- Launch the installed Claude Code TUI, submit local `/help`, and verify the
  observed reply-presence path without spending model tokens.
- Launch two independent deterministic embedded Claude PTYs and bind each to
  its own Session.
- Submit through the current Session Composer, wait for its non-structured PTY
  output to settle, and verify startup output alone never triggers presence.
- Select one Claude Session and wait for its structured result boundary.
- Verify only the corresponding card receives the reply state, whole-card
  shake, and provider water-wave.
- Preserve the correct right-side Session identity during the completion event
  and subsequent cross-Session switches.
- Complete a managed Pi Session and verify the same whole-card completion
  behavior at desktop and narrow viewports.
- Assert no renderer page errors, console errors, framework overlay, blank
  surface, horizontal clipping, or stale right-pane identity.

final result: passed

---

# Semantic Session Replay — Design QA

## Comparison target

- Source visual truth:
  `docs/design/replay-first-principles/concepts/03-semantic-session-playback-concept.png`
  (1586 × 992).
- Production Electron implementation:
  `/tmp/charter-replay-semantic/pi-studio.png`.
- Four-skin production captures:
  `/tmp/charter-replay-semantic/pi-studio.png`,
  `/tmp/charter-replay-semantic/pi-terminal.png`,
  `/tmp/charter-replay-semantic/pi-archive.png`, and
  `/tmp/charter-replay-semantic/pi-index.png`.
- Focused native-agent/code state:
  `/tmp/charter-replay-semantic/claude-recap.png`.
- Responsive state: `/tmp/charter-replay-semantic/pi-narrow-1024.png` at
  1024 × 768 CSS pixels.
- Capture method: the repository's production-mode Playwright Electron harness,
  isolated user-data directories, and real BrowserWindow surfaces. The desktop
  BrowserWindow targeted 1600 × 969; the local macOS work area constrained the
  renderer to 1600 × 889 CSS pixels. The fixed reference and implementation
  were normalized to a common 1600px width without distorting either image.

## Visual evidence

- Full source/implementation comparison in one image:
  `/tmp/charter-replay-semantic/design-qa-full-comparison.png`.
- Focused semantic-story/artifact comparison in one image:
  `/tmp/charter-replay-semantic/design-qa-body-comparison.png`.
- Focused TypeScript artifact comparison in one image:
  `/tmp/charter-replay-semantic/design-qa-code-comparison.png`.
- Focused transport/timeline comparison in one image:
  `/tmp/charter-replay-semantic/design-qa-timeline-comparison.png`.

The reference and current Electron capture were opened together for the final
comparison. Dynamic task text, timestamps, file size, provider identity, and
evidence level are session data and were not treated as visual drift.

## Findings

No actionable P0, P1, or P2 findings remain.

- Fonts and typography: the existing Charter serif display face, UI font, and
  monospace artifact stack are retained. Header identity, semantic event labels,
  result facts, artifact metadata, and timeline chapters preserve the reference's
  hierarchy and truncate long observed output rather than changing track width.
- Spacing and layout rhythm: the stable page is header → session contract →
  37/63 semantic story/artifact canvas → one bottom playback timeline. The
  compact contract is an intentional production addition that keeps original
  goal, outcome, verification, and evidence coverage visible at every depth.
  It does not introduce a second navigation or playback surface.
- Colors and tokens: Replay does not own a hard-coded page background. Studio,
  Terminal, Archive, and Index resolve the Replay root/artifact area from
  `--bg-editor`, the story rail from `--bg-sidebar`, the timeline from
  `--bg-panel`, and header/contract/cards from the corresponding shared shell
  tokens. The automated test compares computed surface colors to the resolved
  root variables in all four skins. Selection follows each skin's accent, so
  Studio uses its existing near-black selection rather than inventing a Replay-
  only blue.
- Image and asset fidelity: the screen contains no photographic or generated
  imagery. Existing icon-library glyphs and provider marks for Pi, Claude, and
  Codex are reused; no placeholder, emoji, CSS drawing, or custom inline SVG was
  introduced.
- Copy and evidence honesty: the source's private-reasoning wording is presented
  as “显示上下文/收起上下文”. Replay only expands recorded events and never
  claims access to hidden model reasoning. Structured records, observed external
  activity, and trust boundaries remain visibly distinct. Mock scenario fixture
  directives are removed at the Replay presentation boundary while the stored
  source record remains unchanged.
- States and interactions: previous/play/pause/next, speed, idle compression,
  semantic chapter selection, result jump, view/depth menu, result/change
  summary, evidence sheet, context expansion, Recap/Explore/Verify navigation,
  search, receipt, and close/back paths all work in the real renderer. A selected
  story row stays centered and there is exactly one active semantic node.
- Responsiveness and accessibility: at 1024 × 768 both semantic regions, page
  identity, transport, and timeline remain reachable with no global horizontal
  overflow. Buttons keep accessible names/pressed state, the depth menu remains
  above the evidence sheet, and the final runs reported no renderer page errors,
  console errors, Vite overlay, or blank surface.

Residual P3: the selected managed Pi fixture changes a one-line text file, while
the concept shows a longer TypeScript retry diff. The file/document renderer is
data-dependent; the focused Claude comparison demonstrates the same production
surface with a real observed TypeScript before/after artifact. The reference is
also taller than the available desktop work area, so the full comparison keeps
both complete images at a common width instead of cropping the timeline.

## Comparison history

1. Initial layer pass — blocked by P2 menu/evidence stacking.
   - Fix: raised the Replay source/depth menu above the evidence detail sheet.
2. Short-session pass — blocked by P2 timeline marker collisions.
   - Fix: semantic chapters use evenly distributed visual positions while their
     labels retain measured wall-clock times and the coverage band retains real
     intervals.
3. Selection pass — blocked by P2 off-screen active context.
   - Fix: selected semantic rows center within the story scroller, including
     result jump and narrow layouts.
4. Electron screenshot pass — blocked by a transient compositor frame and a P2
   fixture directive visible in the original-goal contract.
   - Fix: wait for the post-navigation frame before capture and sanitize only
     the user-facing goal projection.
5. Final same-input comparison — no remaining P0/P1/P2 drift. The preserved
   production contract and skin-owned selection accent are deliberate product
   system decisions, not unimplemented reference regions.

## End-to-end validation

- Pi Agent: a complete managed task on the real Electron surface, all four
  skins, semantic selection/evidence, context expansion, playback controls,
  Explore and Verify depths, result jump, and 1024px responsive layout.
- Claude Code and Codex: each traverses a genuine embedded PTY process, native
  session detection, workspace watcher, file accounting, review handoff,
  observed/structured evidence boundary, Recap evidence, and Explore search.
  Deterministic fixture executables keep this proof repeatable and do not fake
  the PTY/accounting/Replay path.
- Installed vendor CLI smoke: Claude Code 2.1.212 and codex-cli 0.144.5 were each
  launched in their real interactive TUI through Electron. Claude also exited
  back into the actual Replay surface. These smoke tests deliberately avoided a
  billed model request.
- Pi gateway credentials were not configured in this environment, so no live
  network-model claim is made; the managed Pi proof uses the repository's real
  adapter/task/ledger/Replay pipeline with its deterministic runtime.
- Verification totals: production build passed; repository check passed;
  59 unit-test files / 477 tests passed; the combined parallel Replay,
  semantic-provider, and Replay V3 Electron run passed 10/10; external CLI
  accounting/Replay passed; real Claude and Codex interactive smoke tests passed.

final result: passed

---

# Unified Session Canvas — Design QA

## Comparison target

- Source visual truths:
  - `/Users/edy/.codex/generated_images/019f6dd2-efed-7192-8c25-8f0354b55d93/exec-1cfca054-d647-4bf0-88d9-2576809d4d68.png` — persistent Session shell.
  - `/Users/edy/.codex/generated_images/019f6dd2-efed-7192-8c25-8f0354b55d93/exec-c1c556a8-07b7-4365-8efc-5b3a70e831f0.png` — tool/code-expanded state.
  - `/Users/edy/.codex/generated_images/019f6dd2-efed-7192-8c25-8f0354b55d93/exec-fea62e94-43e2-4833-a959-023093980346.png` — evidence-first Review state.
  - `/var/folders/23/z96fd00x791_2j0k757hsnjw0000gn/T/codex-clipboard-r22dXe.png` — user-selected inline Diff fidelity target.
- Implementation screenshots captured from the real Electron renderer:
  - `/tmp/charter-session-canvas/launcher-1440.png`
  - `/tmp/charter-session-canvas/agent-picker-1440.png`
  - `/tmp/charter-session-canvas/review-1440.png`
  - `/tmp/charter-session-canvas/diff-zoom-1440.png`
  - `/tmp/charter-session-canvas/diff-zoom-900.png`
  - `/tmp/charter-session-canvas/diff-panel-1440.png`
  - `/tmp/charter-session-canvas/claude-session-1440.png`
- Viewport: 1440 × 900 CSS pixels; responsive validation at 900 × 900.
- Theme: Studio light, using the existing Charter tokens and icon system.
- States: shared Agent Picker open, managed Session ready for review, balanced
  evidence ledger, expanded Diff tool, narrow reordered canvas, and preserved
  Claude native PTY Session. The existing multi-terminal manager is also
  preserved as a Session-owned Terminal state rather than a second IDE shell.
  Before a Session exists, Files, Search, Changes, the editor, and Problems are
  available as Project Tool content states inside the same persistent shell.

## Visual evidence

- Full-view Review source/implementation comparison:
  `/tmp/charter-session-canvas/design-qa-review-comparison.png`
- Focused collaboration-plus-Diff comparison:
  `/tmp/charter-session-canvas/design-qa-diff-focus-comparison.png`
- User-selected Diff reference/implementation comparison:
  `/tmp/charter-session-canvas/diff-reference-vs-implementation.png`

Both comparison images normalize the source and implementation to 1440 × 900
before stacking them in one input. Fixture project names, one-file mock output
and verification counts are dynamic data and were not treated as design drift.

## Findings

No actionable P0, P1 or P2 findings remain.

- Fonts and typography: the existing Charter UI/monospace stacks are retained,
  with a serif Session title and compact metadata hierarchy matching the source
  direction. The inline Diff uses Monaco's real tokenizer so TypeScript
  keywords, strings and types preserve editor syntax color rather than a
  hand-authored approximation. Titles and project paths truncate instead of
  changing track size.
- Spacing and layout rhythm: the implementation has one 210px persistent rail,
  a balanced 56/44 collaboration/tool split, a 38/62 expanded-tool state, one
  bottom Action Dock, and consistent small-radius cards. The source's three
  stable regions remain visually legible without the former nested Activity
  Bar, global Sidebar, or Agent Panel shell. Project diagnostics use a local
  lower panel inside Project Tools instead of restoring global workspace chrome.
- Colors and tokens: warm Studio neutrals, green completion states, amber Needs
  You attention, blue selection, and red/green diff semantics map to existing
  product variables. No new independent theme or decorative gradient was added.
- Image quality and asset fidelity: these application screens contain no
  photographic or illustrative assets. Existing provider marks and product
  icons are reused and remain sharp; no placeholder imagery, custom SVG art,
  CSS art, emoji, or generated substitute asset was introduced.
- Copy and content: the primary user object is consistently Session. Internal
  mock scenario directives no longer leak into titles or transcripts, Replay is
  secondary under More, and review-ready copy asks for changes or context rather
  than claiming it starts another run.
- States and interactions: running Sessions expose Summary, while review-ready
  Sessions use the reference's File, Diff, Preview, Terminal, and Review tabs in
  the same tool canvas. Diff is a complete inline review: totals, selectable
  file ledger, line-numbered hunks, copy/advanced-review actions, recorded
  verification, and the single Request changes / Rollback / Approve changes
  Dock. File Peek remains a separate File state and expands in place.
  Control+backquote opens the mature multi-terminal manager inside the same
  persistent Session shell; live PTYs, promotion, resizing, return-to-dock, and
  external-session accounting remain intact. A zero-change answer stays on
  Summary instead of showing an empty Review, and rollback retires the active
  Review state as soon as its change set is gone.
- Responsiveness and accessibility: at 900px the rail compresses to 210px and
  the center/tool tracks reorder vertically at full available width. There is no
  global horizontal overflow or hidden persistent decision control. Tabs use
  tab semantics, menus/dialogs retain accessible labels, buttons remain keyboard
  reachable, and reduced-motion removes layout transitions.

Residual P3: the user reference contains a longer 38-line retry rewrite and 12
tests, while the deterministic Electron proof contains a five-line TypeScript
change and one recorded check. This creates expected white space after the
verification card; the same renderer expands naturally with real hunk volume.
File names, line counts and diff totals are task data, not visual drift.

## Comparison history

1. Initial Review pass — blocked by P1 interaction/copy ambiguity.
   - Finding: the review-ready Composer said a reply would start another run,
     while the decision was duplicated between the old review bar and side card.
   - Fix: moved all decisions into one responsive Action Dock and changed the
     Composer prompt to “Request changes or add review context…”.
   - Post-fix evidence: `review-1440.png` and
     `design-qa-review-comparison.png` show one decision surface.
2. Initial production-data pass — blocked by P2 internal vocabulary leakage.
   - Finding: `[scenario:edit-basic]` and provider id `mock` were visible as
     product content.
   - Fix: strip mock-runner directives at the transcript presentation boundary,
     sanitize the Session title, and map the mock provider to Charter.
   - Post-fix evidence: `review-1440.png` contains the clean Session title and
     transcript plus the Charter identity chip.
3. Initial 900px pass — blocked by P2 responsive instability.
   - Finding: the first capture measured the center and tool columns during a
     width transition, leaving each narrower than the available canvas.
   - Fix: disable track-width transitions below 1120px and explicitly set both
     reordered regions to 100% width.
   - Post-fix evidence: `diff-zoom-900.png`; the Electron test also asserts both
     regions equal the body width and global overflow is at most one pixel.
4. Tool-state pass — blocked by P2 state lock-in.
   - Finding: the automatic Review default effect re-ran after every store
     update, preventing the user from switching back to Summary.
   - Fix: apply the Review default only when Session id/state crosses the
     review-ready boundary.
   - Post-fix evidence: the final E2E switches Review → Summary → Review before
     opening Diff and expanding the tool canvas.
5. Full-regression pass — blocked by P1 terminal shortcut regression.
   - Finding: Control+backquote still created a shell PTY, but the removed legacy
     workspace shell meant that PTY no longer had a visible host.
   - Fix: mounted the existing Terminal Parallel manager and promoted external
     panel as a Session-owned Terminal view, including the single-terminal
     auto-collapse rule and a stacked narrow layout. No PTY/session behavior was
     reimplemented or discarded.
   - Post-fix evidence: all five `external-cli.spec.ts` scenarios cover live
     xterm input, multi-agent switching, panel promotion/resize, return to dock,
   native-installer detection, durable review, and resume/restart behavior.
6. Project-capability pass — blocked by P1 access regression.
   - Finding: removing the legacy workspace shell also hid arbitrary file
     editing, Search/Replace, Git Changes, TypeScript Problems, split editors,
     and conflict handling before a Session existed.
   - Fix: added `ProjectToolView`, which mounts those mature tools as contextual
     content beside the same global Session Rail. Problems open in a local
     lower panel; terminal commands open a Terminal Session. No second Activity
     Bar, global Sidebar, or Agent Panel was restored.
   - Post-fix evidence: M3 editor, M4 search/LSP/terminal, and M5 Git Electron
     suites pass against the unified shell.
7. Final accessibility/regression pass — blocked by P2 keyboard focus and stale
   product contracts.
   - Finding: historical plan disclosure lacked a visible programmatic/keyboard
     focus outline, while several E2E cases still required deleted Live Board,
     report-card, creation-dialog, or Full workspace controls.
   - Fix: restored the plan disclosure focus ring and migrated those contracts
     to the Session ledger, Agent Picker, Review Checks, Project Tools, and one
     Action Dock. The superseded sidebar mock is explicitly gated out.
   - Post-fix evidence: the complete Electron suite passes with only manual or
     environment-gated scenarios skipped.
8. User-selected Diff fidelity pass — blocked by P1 review-structure drift.
   - Finding: the first unified canvas routed Diff into the old single-file Peek,
     omitting the reference's change summary, inline hunk card, verification
     result and three-action decision dock.
   - Fix: implemented a Session-owned inline Diff with selectable files,
     line-numbered red/green hunks, Monaco syntax color, compact verification,
     copy/advanced-review actions and the exact File/Diff/Preview/Terminal/Review
     focus hierarchy. The destructive rollback remains two-step even though its
     first state visually matches the reference.
   - Post-fix evidence: `diff-panel-1440.png` and
     `diff-reference-vs-implementation.png`; production Electron regressions
     covering Session Canvas, File Peek, Review, Editor, worktree, 1440px and
     900px states pass 16/16 with no renderer console/page errors.

## Primary interactions tested

- Open the single Composer Agent Picker and select Charter, Claude, or Codex.
- Create a managed auto-mode Session that changes three files, run a configured
  verification, switch/select files in the inline Diff, copy the active patch,
  open advanced review, and retain the single decision Dock.
- Switch File, Diff, and Review without losing the Session or conversation.
- Open a changed file in File Peek from the File tab while the timeline remains mounted.
- Reorder the same canvas at 900px and verify no horizontal overflow.
- Accept unverified changes from the single Action Dock and remain in the same
  persistent Session shell.
- Dispatch Claude from the same Composer into a real preserved PTY and verify
  its Session row, working directory, and global rail remain present.
- Open a plain shell with Control+backquote, launch/switch external agents,
  promote and resize a live terminal, return it to the dock, and resume ended or
  interrupted Claude Sessions without restoring the old global Agent Panel.
- Open Project Files, Search, Changes, split editor, TypeScript Problems, and a
  plain terminal before a Session exists without changing the global shell.

Console errors checked: yes. The final Playwright flow collected renderer
`pageerror` and `console.error` events and asserted an empty list.

## Implementation checklist

- [x] Keep one persistent Session Rail as the only global navigation.
- [x] Merge managed and native agents into one Composer Agent Picker.
- [x] Make files, Diff, Preview, Terminal, Summary, and Review Session-owned
      tool states.
- [x] Reproduce the supplied Diff reference with a file summary, selectable
      inline hunks, syntax color, verification card, and one decision Dock.
- [x] Preserve the existing live multi-terminal/Claude/Codex manager inside the
      Session-owned Terminal state, including PTY identity and promotion.
- [x] Preserve editor, Search/Replace, Git, Problems, split/conflict handling,
      and Quick Open as Project Tool states before a Session exists.
- [x] Remove the runtime Full workspace Activity Bar/Sidebar/Agent Panel shell.
- [x] Use one responsive Action Dock for all review and execution decisions.
- [x] Demote Replay while restoring the historical event-driven Live Board
      semantics inside the unified Session shell.
- [x] Restore all three execution-presence layers from the historical HTML:
      persistent Session Rail ticker; one Launcher Live Board per running
      Session; Room live timeline row + file heat tiles + activity strip. Real
      task/change events drive hot/warm/cool decay, rhythm, writing beacon, and
      direct live-file → Diff interaction; no decorative scanning loop remains.
- [x] Verify desktop, narrow, managed-agent, native-agent, tool zoom, and accept
      paths in the production Electron renderer.

final result: passed

---

# Mature CodeContextRef — Design QA

## Comparison target

- Source visual truth:
  `docs/design/code-context-ref-mockups/unified.html`, captured at
  `/tmp/charter-code-context-source-1440.png`.
- Electron implementation:
  `/tmp/charter-code-context-1440.png` and the responsive
  `/tmp/charter-code-context-900.png`.
- Viewports: 1440 × 900 and 900 × 900 CSS pixels.
- State: a live managed Session with one line selected from its inline Diff,
  frozen into the next-turn Composer as a structured code reference.
- Capture method: the repository Playwright Electron harness and isolated user
  data, as required by AGENTS.md. The renderer was built before capture.

## Visual evidence

- Same-input full comparison:
  `/tmp/charter-code-context-comparison-1440.png`.
- Same-input focused Composer comparison:
  `/tmp/charter-code-context-comparison-focused.png`.
- Narrow post-fix evidence: `/tmp/charter-code-context-900.png`.

The source and implementation were placed in the same comparison images and
opened together. The mock uses the Archive cream presentation while the
production capture intentionally retains the current Studio-light product
tokens; object hierarchy, selection provenance, Composer shelf, Session/tool
continuity and responsive priority are the comparison truth.

## Findings

No actionable P0, P1 or P2 findings remain.

- Fonts and typography: production retains Charter's UI and monospace stacks.
  File path, exact line range, selected-code preview, source surface and frozen
  snapshot state form the same compact hierarchy as the mature mock, with
  truncation on long paths instead of changing the Composer width.
- Spacing and layout rhythm: the context shelf sits inside the existing
  Composer rather than becoming another panel. It reports selection/line
  totals, keeps one removable reference card per snapshot and does not move the
  conversation or Session rail. Diff remains beside the conversation at 1440;
  at 900 it follows the conversation as the second priority region.
- Colors and visual tokens: context uses existing information blue, card,
  border, foreground and muted tokens. It remains legible in Studio light and
  does not introduce the mock's cream palette as a fifth skin.
- Image quality and asset fidelity: this flow contains no photography or
  illustration. It reuses the existing Charter file and action icon set; no
  generated image, emoji, placeholder graphic, custom SVG or CSS-art asset was
  added.
- Copy and content: “Code context for this turn”, source/version provenance and
  “frozen snapshot” make delivery semantics explicit. Timeline evidence says
  how many code selections were sent without duplicating the full prompt.
- Interaction and accessibility: Diff drag-selection, Monaco File Peek and
  Editor selection, Search-result attachment and Review feedback converge on
  the same removable Composer card. Buttons have labels/test ids, native
  selection remains visible until attachment, Enter sends, and refs can be
  removed before delivery.
- Responsiveness: the 900px canvas keeps Session identity, context shelf,
  Composer send action, all five tool icons, Diff evidence and the bottom live
  status visible. There is no horizontal page overflow or hidden persistent
  action.

Intentional P3 differences: the source mock demonstrates a three-line CSS
selection and archive skin; deterministic production evidence uses a one-line
text-file addition in Studio light. The card is correspondingly more compact,
while retaining the same range, provenance, snapshot and removal information.

## Comparison history

1. First Electron interaction pass — blocked by P0 render recursion.
   - Finding: a new empty array returned by the Zustand selector caused React
     update-depth error 185 as soon as a Session opened.
   - Fix: introduced one stable `EMPTY_CODE_CONTEXT_REFS` selector fallback and
     reused it in managed and external Session composers.
   - Post-fix evidence: the managed runtime Electron scenario renders and
     completes; the final 1440 and 900 screenshots are non-blank.
2. Initial 900px visual pass — blocked by P2 blank tool navigation.
   - Finding: wide Diff deliberately hid icons, while the narrow breakpoint
     hid labels; together those rules left only an unexplained underline.
   - Fix: restore existing tool icons for Diff at the narrow breakpoint while
     retaining the text-only wide layout.
   - Post-fix evidence: `/tmp/charter-code-context-900.png` shows File, Diff,
     Preview, Terminal and Review icons with Diff selected.
3. Initial responsive capture — blocked by P2 transient compositing evidence.
   - Finding: capturing in the same tick as the Electron viewport resize
     produced black composited regions even though locators were present.
   - Fix: wait for the real Diff line and a 300ms repaint boundary before the
     evidence screenshot.
   - Post-fix evidence: the final 900px capture is fully painted and the test
     asserts the Diff contents before capture.

## Primary interactions tested

- Drag-select an added Diff line, attach it, see the unified Composer shelf,
  send it and inspect the structured timeline evidence.
- Verify the Pi mock runtime receives the selected bytes in its actual runtime
  prompt rather than only seeing a frontend card.
- Deliver the same validated structured snapshot to live fake Claude and Codex
  processes through their real PTYs and observe the selected marker in terminal
  output.
- Resize the live Session from 1440 × 900 to 900 × 900 with the context shelf
  attached; assert Session tool canvas, reference card and Diff content remain
  visible.
- Collect `pageerror` and `console.error` events on the managed primary path and
  assert the final list is empty.

## Implementation checklist

- [x] Shared validated `CodeContextRef` schema with frozen text, path, source
      version, exact range, source hash and selection hash.
- [x] Per-Session draft storage, duplicate suppression, six-reference limit and
      48,000-character aggregate limit.
- [x] Unified selection entry points for Diff, File Peek, full Editor, Search
      results and advanced Review.
- [x] Main-process runtime serialization for Pi and main-process PTY delivery
      for Claude/Codex.
- [x] Structured Session-ledger evidence and compact timeline rendering.
- [x] Desktop/narrow visual validation and real Electron runtime tests.

final result: passed

---

# Projects Expansion + Home Queue Removal — Design QA

## Comparison target

- Projects source: `/var/folders/23/z96fd00x791_2j0k757hsnjw0000gn/T/codex-clipboard-Pcq8RZ.png`
- Home source: `/var/folders/23/z96fd00x791_2j0k757hsnjw0000gn/T/codex-clipboard-2KWfnW.png`
- Production surfaces: `apps/desktop-renderer/src/views/SessionRail.tsx` and
  `apps/desktop-renderer/src/views/HomeView.tsx`.
- Capture method: repository Playwright Electron harness with isolated user
  data, as required by the repository AGENTS.md.

## Visual evidence

- Expanded Projects production capture:
  `/var/folders/23/z96fd00x791_2j0k757hsnjw0000gn/T/charter-project-tree-expanded.png`
- Home without the duplicate queue:
  `/var/folders/23/z96fd00x791_2j0k757hsnjw0000gn/T/charter-home-without-mission-control.png`
- Normalized Projects comparison: `/tmp/charter-project-expansion-comparison.png`
- Same-viewport Home comparison: `/tmp/charter-home-removal-comparison.png`

The production screenshots and normalized comparisons were opened and
inspected together. No actionable P0, P1 or P2 visual finding remains.

## Findings

- Project selection now preserves the Projects activity state while opening
  the workspace, expands the selected project's real file tree in place and
  retains that state across the workspace-triggered rail remount.
- Clicking the active project row toggles the tree without navigating to the
  Sessions panel. The chevron accurately represents the expanded state.
- The Home Needs You and Recent queue was removed from both the component tree
  and stylesheet; the persistent Session rail is now the single task-status
  surface.
- Removing the queue does not leave a collapsed-card gap. The heading and
  composer retain the compact approved vertical position and the open canvas
  below remains intentionally quiet.
- The 963 × 749 Home capture verifies non-blank rendering and no duplicate
  queue at the user's supplied viewport. The Projects capture verifies the
  primary interaction path at a full desktop viewport.
- Targeted Electron tests asserted page identity, primary interactions and
  zero page or console errors on the new paths.

Intentional P3 deviations: the Projects comparison uses real fixture names and
the production project-tool surface rather than the user's local paths. The
tree behavior, hierarchy and selection state are the matched interaction
truth.

final result: passed

---

# Recommended Session Rail + Conversation Roles — Design QA

## Comparison target

- Rail source visual truth: `docs/design/session-rail-recommended-mock.html`
- Conversation source: `/var/folders/23/z96fd00x791_2j0k757hsnjw0000gn/T/codex-clipboard-xYttzS.png`
- Semantic-badge source: `/var/folders/23/z96fd00x791_2j0k757hsnjw0000gn/T/codex-clipboard-91fjqf.png`
- Production surface: the real Electron renderer at 1220 × 780 and the narrow
  960 × 720 viewport, using Archive/light for the visual comparison.
- Capture method: repository Playwright Electron harness with isolated
  user-data; no browser substitute was used for application validation.

## Same-input evidence

- Rail source + production: `/tmp/design-qa-session-rail.png`
- Conversation source + production: `/tmp/design-qa-conversation-roles.png`
- Badge source + production: `/tmp/design-qa-semantic-status.png`
- Production desktop: the platform temporary directory's
  `charter-session-rail-production-desktop.png`
- Production narrow: the platform temporary directory's
  `charter-session-rail-production-narrow.png`

## Findings

- The production rail matches the approved 320px structure: 44px stable
  activity navigation plus one contextual panel, with the same header,
  visible search, filter, dark split New Session control, project groups and
  two-line session-row rhythm.
- Attention is expressed once on the global Inbox icon. Project groups no
  longer repeat amber “need you” labels, reducing noise without hiding work.
- Review and Answered use the reference's compact amber and green semantic
  pills. Live work uses the green presence dot instead of another text badge.
- Archive/light user messages use the reference's right-aligned terracotta
  fill and light text. Agent replies are borderless reading-surface prose.
  Studio, Archive, Terminal and Index each resolve the same semantic roles
  through their own accent and contrast tokens.
- At 960 × 720 the rail remains fully operable at 304px; labels, badges,
  search, project control and primary session rows do not clip.
- The focused Electron test exercised session search, needs-only filtering,
  activity destinations, project context, Review/Answered states, both
  conversation roles and all four skins. It also asserted zero renderer page
  errors and zero `console.error` events.

Intentional P3 deviations: production captures use real fixture names, two
real tasks and the application's native host chrome instead of the mock's
illustrative five-task data. These do not change hierarchy, geometry or state
semantics.

final result: passed

---

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

# Session Rail Workbench Production — Design QA

## Comparison target

- Source visual truth: `/Users/edy/.codex/generated_images/019f68a6-81e9-7783-8ddf-35ffd5e32238/exec-fa30f18e-7158-4ec4-bc28-0fc4a7b7fd80.png`
- Production implementation: `apps/desktop-renderer/src/views/SessionRail.tsx`,
  `apps/desktop-renderer/src/views/SessionTerminalView.tsx` and the resident
  Home/Task Room/Workbench surfaces.
- Native comparison viewport: 1440 × 1024 CSS pixels; responsive validation:
  1180 × 820 CSS pixels.
- Capture method: the repository Playwright Electron launcher with an isolated
  Git fixture and temporary user-data directory. This is the product's real
  renderer and PTY integration, not the in-app Browser.

## Visual evidence

- Codex-style entry: `/tmp/session-workbench-production-entry.png`
- Pi review plus live edit: `/tmp/session-workbench-production.png`
- Session type chooser: `/tmp/session-workbench-production-modal.png`
- Narrow state: `/tmp/session-workbench-production-narrow.png`
- Same-input full comparison: `/tmp/session-workbench-production-comparison-final.png`
- Old Tasks density versus production Sessions:
  `/tmp/session-workbench-rail-comparison-final.png`
- Original Composer versus production Composer:
  `/tmp/session-workbench-entry-comparison-final.png`

The source and production capture were combined into the same comparison
inputs and opened at original detail. No actionable P0, P1 or P2 visual issue
remains.

## Findings

- Entry hierarchy: New Session now returns directly to the existing “What
  should we build?” Composer. Pi/Claude/Codex selection is a secondary split
  action, so the Session shell does not replace the product's primary task
  entry.
- Session density: rows use the previous Tasks list's compact rhythm. Project
  and branch share one metadata line, state stays scannable at the right edge,
  and unselected rows do not become dashboard cards.
- Terminology: the recent-folder domain section is labeled Project. Workspace
  remains only the name of the full editor surface in the footer.
- Layout: the permanent Session rail, continuous Pi surface, resident editor
  and review Composer preserve the reference's workbench geometry while using
  the application's existing title bar and design tokens.
- Typography and colors: existing Charter UI tokens remain authoritative;
  provider marks and semantic live/review states stay distinct across all four
  application backgrounds.
- Assets: existing product icons and provider marks are reused; no substitute
  illustration, handcrafted SVG or placeholder asset was introduced.
- Responsiveness: at 1180 × 820 session titles truncate before state labels,
  the review card and reply Composer stay visible, and the editor remains
  usable without horizontal control overlap.
- Accessibility and health: the split New Session controls have distinct
  accessible names, the chooser exposes dialog semantics, keyboard session
  switching remains intact, and the Electron flow asserted zero renderer
  `pageerror` or `console.error` events.

## Comparison history

1. The first production pass used 112px Session cards and made the rail feel
   like a second dashboard. It also opened the provider chooser as the primary
   New Session action and labeled the recent-folder section Workspace.
2. The final pass reduced rows to a 74px list rhythm, merged project/branch
   metadata, made the task Composer the direct entry, moved provider choice to
   the split menu and renamed the section Project.
3. Same-input comparison confirmed that the core rail/main/editor/review
   composition matches the selected workbench direction while restoring the
   existing product's original Composer and Tasks information density.

## Primary interactions tested

- Enter the original task Composer directly from New Session.
- Open the secondary chooser and select Pi, Claude or Codex.
- Run a multi-step Pi task to review-ready state.
- Open a changed file in the real resident Monaco editor without ending the
  session.
- Move to the full Workspace and return to the same task, file peek and draft.
- Keep real external PTY sessions visible and resumable in the Session rail.
- Switch sessions with Command+[ / Command+] and direct number shortcuts.

Intentional P3 deviations: the production capture uses Charter's real host
title bar, fixture paths and actual application copy rather than the mock's
illustrative window title and sample repository. These preserve product truth
without changing the selected interaction model.

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
