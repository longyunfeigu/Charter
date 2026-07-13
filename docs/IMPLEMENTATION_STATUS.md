# IMPLEMENTATION_STATUS.md

Overall status: IN_PROGRESS  
Current milestone: 11 (M10 + Home v2 P1–P3 verified)  
Last verified commit: (see git log)

## Status legend

- NOT_STARTED
- IN_PROGRESS
- BLOCKED
- DONE
- VERIFIED

## Milestones

| Milestone | Status | Exit evidence | Notes |
| --- | --- | --- | --- |
| 1. Engineering baseline | VERIFIED | E2E m1-baseline (isolation+IPC), 28 unit tests, packaged .app launch smoke, boundary lint | node:sqlite/node-pty/rg strategies in ADR-0003 |
| 2. Shell and persistence | VERIFIED | E2E m2-shell (restart restore), m2-db-failure (safe mode), 10 unit tests (db+settings) | |
| 3. Workspace and editor | VERIFIED | E2E-002/003 pass (m3-editor.spec), 31 unit tests (doc store/workspace/path boundary), 10k-file lazy tree integration test | Data-loss race renderer-guard documented in editorStore |
| 4. Search, LSP, terminal | VERIFIED | E2E-004..007 pass, 6 search unit tests, full E2E suite 12/12 twice | rg via system binary (ADR-0003); python LSP degrades with guidance |
| 5. Git and changes | VERIFIED | E2E-008 + non-git flow, 51 unit tests incl. 34-case rollback matrix | Full 50-case matrix expands at M12 gate run |
| 6. Pi read-only agent | VERIFIED | E2E-009/019-core/HIST-002 (4 E2E), pi adapter contract tests (no-builtin-tools), 141 unit tests total | OAuth providers deferred to API-key flow (ADR pending M12 notes) |
| 7. Tools and permissions | VERIFIED | E2E-012/013 + approve-and-run + ask_user (4 E2E green), permission engine 15 tests, classifier 17, runner 11, command tools 9, security matrix 9, SQL store 3 | R3 never granted permanently; R4 refused pre-prompt; PERM-007 param-binding enforced |
| 8. Agent editing and review | VERIFIED | E2E-010/011/014/015 all green (m8-review.spec, full suite 26/26), 25 new unit tests (review hunks 10, write tools 10, plan utils 5) | Plan approval flows through the propose_plan tool channel (works for real Pi too); write gate denies first write until plan approved (AG-007); hunk keys are content-derived so decisions fail closed on staleness |
| 9. Verification and history | VERIFIED | E2E-016/017/018 green (m9-verification.spec, full suite 29/29 twice), VerificationService 7 unit tests, rename tool test | Final report separates agent narrative from system evidence; stale/superseded semantics on verification_runs; unverified accept needs explicit confirm; rollback preflight stops on external-change conflicts |
| PIVOT. Dual-form shell (ADR-0004) | VERIFIED | pivot-shell.spec 3 E2E (PIVOT-001..009), full suite 32/32 twice, model-catalog 4 unit tests | Charter branding (no Pi in UI); Home task launcher default entry; Settings provider keys + live model fetch |
| HOME-V2 P1. Activity stream + mission control (ADR-0006) | VERIFIED | home-v2.spec 3 E2E (PIVOT-011..015), full suite 35/35 twice, activity projection 9 + notification 4 unit tests | Pure-projection activity stream (live = replay source); mission-control cards with live current action; macOS notifications on attention edges (focused-window suppressed); drag/@ context refs; clickable paths; tool lifecycle renders as one in-place card (callId dedupe) |
| HOME-V2 P2. Parallel runs + replay + glow + ⌘K (ADR-0006) | VERIFIED | p2-parallel-replay.spec 3 E2E (PIVOT-016..018), full suite 38/38 ×3 consecutively, gateway modeForTask unit test (252 total) | maxConcurrentRuns (default 3, FIFO beyond); per-task mode resolution replaces the mutable gateway.mode; action-centric session replay (scrubber + stored per-step patches + file lens, read-only); presence glow on tree/task rows from change events (no polling); ⌘K over projects/tasks/files/actions |
| HOME-V2 P3. Light editing (ADR-0007, PIVOT-019/020) | VERIFIED | p3-light-edit.spec 2 E2E, full suite 40/40 ×3 consecutively after fixes | Rich Markdown via @mdxeditor/editor@4.0.4 (opt-in per file + setting; writes through the SAME Monaco model → identical dirty/conflict/save guarantees; lazy-loaded + error boundary; Prism global shim). In-house canvas image annotator (arrow/box/true-pixel mosaic, save-copy never overwrites, attach-to-charter). Root-caused the earlier full-run flakes: (1) E2E runs were emitting real macOS notifications — now silenced under PI_IDE_E2E; (2) ⌘K hover-on-render stole keyboard selection when the physical cursor overlapped the palette — onMouseEnter→onMouseMove; (3) rich-editor mount settle window swallowed instant edits — replaced with a normalization-baseline guard |
| SHELL-V3. Task-centric shell (ADR-0008, PIVOT-021..025) | VERIFIED | shell-v3.spec 3 E2E (Task Room flow, entry consolidation, Live Board); full suite 46/46 ×2 (soak skipped); state-labels 5 + live-board 4 unit tests (262 total) | P1 humane vocabulary (shared dictionary, no raw enums/emoji; data-state for tests), danger hierarchy (two-step rollback, Cancel-task demoted), review-overlay collision root-caused (undefined --bg); P2 Studio tokens ported 1:1 from direction-picker.html (light+warm dark, serif hero anchored to composer, segmented trust control + caption, quiet status bar); P3 Task Room on the Home surface (timeline/cards shared with the Editor panel via TaskTimeline exports; changes+verification rail; decision panel; Review/Replay global overlays; submit→room, no auto-jump; Editor entries: sidebar row + ⌘E + room header); P4 Live Board (event-driven tiles: ripple/heat 60s decay/rhythm/writing beacon; per-task boards; diff-so-far FileLens with pulse-following refetch; pauses on blur/reduced-motion; edit-live mock scenario). Amendments in ADR-0008 |
| 10. Recovery and diagnostics | VERIFIED | m10-recovery.spec 3 E2E (E2E-020/022 + renderer crash), soak.spec 50-task run (opt-in), disk-write-failure unit test, full suite 43/43 ×2 (soak skipped) | Worker orphan guards (port close + ppid watchdog); ordered will-quit teardown (gates resolved → worker disposed → DB closed last, fixes "database is not open" on quit); INTERRUPTED recovery entry (Home + AgentPanel Resume/Review/Roll back); orphaned pending permissions cancelled in the event log on restart (no replay); redacted support bundle (diagnostics.supportBundle); E2E crash dialogs/notifications suppressed under PI_IDE_E2E |
| 11. Security and quality hardening | NOT_STARTED | | |
| 12. Packaging and Stable release | NOT_STARTED | | |

## Current blockers

None.

## Latest test evidence

| Date | Commit | Command | Result | Artifact |
| --- | --- | --- | --- | --- |
| 2026-07-13 | (shell-v3 P4) | `playwright test` (full) | 46 E2E passed ×2 consecutively (soak skipped); one earlier run flaked under heavy machine load only | playwright |
| 2026-07-13 | (shell-v3 P4) | `npm test` + `npm run check` | 262 passed; prettier+boundary(173)+tsc clean | vitest |
| 2026-07-13 | (M10) | `playwright test` (full) | 43 E2E passed ×2 (soak opt-in skipped) | playwright |
| 2026-07-13 | (M10) | `test:soak` (50 tasks) | 1 passed — one worker, 0 restarts, clean exit | playwright |
| 2026-07-13 | (M10) | `npm test` + `npm run check` | 253 passed; prettier+boundary(168)+tsc clean | vitest |
| 2026-07-13 | (home-v2 P3) | `playwright test` (full) | 40 E2E passed ×3 consecutively (logs /tmp/e2e-f\*.log) | playwright |
| 2026-07-13 | (home-v2 P3) | `npm test` + `npm run check` | 252 passed; prettier+boundary(167)+tsc clean | vitest |
| 2026-07-13 | (home-v2 P2) | `npm test` | 252 unit/integration passed (34 files) | vitest |
| 2026-07-13 | (home-v2 P2) | `playwright test` (full) | 38 E2E passed ×3 consecutively (one unidentified flake in an earlier run, not reproduced) | playwright |
| 2026-07-13 | (home-v2 P1) | `npm test` | 251 unit/integration passed (34 files) | vitest |
| 2026-07-13 | (home-v2 P1) | `playwright test` (full) | 35 E2E passed, twice consecutively | playwright |
| 2026-07-13 | (pivot) | `npm test` | 238 unit/integration passed (32 files) | vitest |
| 2026-07-13 | (pivot) | `playwright test` (full) | 32 E2E passed, twice consecutively | playwright |
| 2026-07-13 | (M9) | `npm test` | 234 unit/integration passed (31 files) | vitest |
| 2026-07-13 | (M9) | `npm run check` | prettier + boundary(147) + tsc clean | — |
| 2026-07-13 | (M9) | `playwright test` (full) | 29 E2E passed, twice consecutively | playwright |
| 2026-07-13 | (M8) | `npm test` | 226 unit/integration passed (30 files) | vitest |
| 2026-07-13 | (M8) | `playwright test` (full) | 26 E2E passed | playwright |
| 2026-07-13 | (M7) | `npm test` | 201 unit/integration passed (27 files) | vitest |
| 2026-07-13 | (M7) | `playwright test` (full) | 22 E2E passed (clean machine) | playwright |

## Requirement exceptions

None. Any exception requires an ADR and product-owner approval.
