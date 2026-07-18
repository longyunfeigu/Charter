# M11 — Security & Performance Gate Report

Milestone 11 (Security, performance, privacy, accessibility hardening). This is
the M11-06 exit evidence: a per-item conformance matrix against spec §16.4
(security), §16.5 (performance), A11Y-001..005 and PRIV-001..003, plus the
dependency/license position.

Scope was re-defined by **ADR-0025** (gap-closure against the unified Session
shell); task detail lives in `docs/IMPLEMENTATION_BACKLOG.md` M11. Implementation
decisions are in **ADR-0027**.

Baseline commit for the work: `e81b72e`. All commands below are reproducible.

## Runnable gates (were non-runnable before M11)

| Command | Result |
| --- | --- |
| `npm run test:security` | repo secret-scan clean → 137 vitest (14 files) → build → 2 Electron specs. All green. |
| `npm run test:perf` | 6 perf specs green at default load; `PI_IDE_PERF_FULL=1` scales to the §16.5 reference sizes (50k files verified). |
| `npm run check` | prettier + boundary(283) + tsc clean. |
| `npm test` | 524 unit/integration passed. |

Both `test:security` and `test:perf` pointed at missing config files before M11
(the scripts existed, the configs did not) — restored in M11-01 / M11-03.

## §16.4 Security gate

| Requirement | Status | Evidence |
| --- | --- | --- |
| Renderer `nodeIntegration=false`, `contextIsolation=true`, `sandbox=true`, CSP passes | PASS | m1-baseline asserts the web prefs; `tests/security/shell-hardening.spec.ts` asserts inline-script, external-frame and exfil-fetch are all CSP-blocked against the packaged app:// surface. |
| Path traversal / encoding / symlink / TOCTOU blocked | PASS | `vitest.security.config.ts` gathers the tool-gateway traversal/symlink suites + skill-root `realpath` containment + attachment path-escape guards (14 files, 137 cases). |
| R3-unapproved executions = 0; R4 executions = 0 | PASS | M7 permission-engine + command-classifier suites (incl. the forge-CLI R4 split from ADR-0022) in the security suite. |
| API key not detectable in renderer heap snapshot / localStorage / logs / support bundle | PASS | `tests/security/secret-not-detectable.spec.ts`: stores a sentinel key via the real provider IPC, reloads, then scans a CDP heap snapshot, web storage, on-disk logs and the support bundle — all clear; the `.bin` is ciphertext, `.meta` carries only a `…last4` hint. |
| External navigation / unknown protocols / malicious Markdown links inert | PASS | `security-policy.ts` pins (unit) + shell-hardening e2e asserts `javascript:`/`file:`/unknown-scheme navigation and `window.open` are refused, workbench survives. |
| Preview iframe / injection boundary | PASS | `tests/security/unit/preview-boundary.test.ts`: iframe sandbox grants pinned, picker injects only into plain-http loopback on the task's own port, picker script is posts-only/self-cleaning (static audit), CSP `frame-src` matches the injection gate. |
| Electron fuses | PASS | `scripts/fuse-plan.cjs` (runAsNode off, NODE_OPTIONS/inspect off, asar integrity + onlyLoadAppFromAsar on) flipped in the `afterPack` hook; the plan is pinned by `tests/security/unit/shell-policy.test.ts`. |
| Dependency / license scan: no unhandled Critical/High | PASS (with note) | `npm audit`: 2 findings, **1 low + 1 moderate**, both DOMPurify reached only through monaco-editor's bundled copy. No Critical/High. See Known issues. |

## §16.5 Performance gate

Measured on the dev machine (Apple Silicon). The vitest harness covers the
algorithmic budgets; cold-start / paint-latency numbers require the packaged
app on the reference machine and are deferred to the M12 release run.

| Budget | Target | Measured (default load) | Status |
| --- | --- | --- | --- |
| Lazy tree listing, 50k-file workspace | responsive | p95 5.2 ms (7.4 ms at 50k FULL) | PASS |
| Quick Open first batch (2000) | ≤ 300 ms | p95 12.2 ms | PASS |
| Global search first batch (200) over large corpus | ≤ 1 s | p95 248 ms | PASS |
| Global search cancellable | prompt | pre-aborted returns cancelled in <1 ms | PASS |
| Oversized single file (96 MiB / 1 GiB) does not freeze search | < 500 ms | 6.3 ms (skipped by per-file cap) | PASS |
| Timeline projection, 10k events | < 200 ms | p95 28.9 ms | PASS |
| Room DOM bounded at 10k events | scrollable | RoomTimeline windowed to a 400-event tail + load-earlier (`timeline-window.ts`); e2e `timeline-window.spec.ts` | PASS |
| Large agent output does not freeze the renderer | < 500 ms | streaming buffer capped 256 KB + plain-tail render past 16 KB (`STREAM_*` in `timeline-window.ts`) | PASS |

Fixtures: `createLargeTreeFixture` (default 12k / FULL 50k) and
`createLargeTextFixture` (default 96 MiB / FULL 1 GiB, streamed). `PI_IDE_PERF_FULL=1`
runs the exact §16.5 reference sizes.

## A11Y gate

| Requirement | Status | Evidence |
| --- | --- | --- |
| A11Y-001 keyboard-completable core flow; accessible names/roles/focus | PASS | Menu Zoom + ⌘±/⌘0; diff F7/⇧F7; existing ⌘K / ⌘N / ⌘1-9 / ⌘E. `a11y-zoom-diff.spec.ts`. |
| A11Y-002 colour is not the only state signal | PASS (reviewed) | Change kinds carry text badges (added/removed/modified) beside colour; verification rows pair icon + text. |
| A11Y-003 80–200% UI zoom, no clipping | PASS | Real `webContents.setZoomFactor` (Monaco + terminal scale) via `general.uiScale`; persisted across reload; `a11y-zoom-diff.spec.ts` asserts 150%/reset + persistence; `ui-zoom.test.ts`. |
| A11Y-004 streaming uses a modest live region, not per-token | PASS | Room activity strip is `role=status aria-live=polite`, announcing at action granularity. |
| A11Y-005 accessible diff text mode + per-change navigation | PASS | Diff `Inline ⇄ Text mode` toggle; focusable change cards; F7/⇧F7; `diff-live` announcer; `accessible-diff.test.ts` + e2e. |

## PRIV gate

| Requirement | Status | Evidence |
| --- | --- | --- |
| PRIV-001 analytics default off; fields listed before enabling; never code/prompt/diff/path/output | PASS | Fields-list modal is the enable gate; honest "no transport in this build" banner (rule 9); `privacy-settings.spec.ts`. |
| PRIV-002 crash reporting separate opt-in with redacted preview | PASS | Real redacted sample built from live app state via `redactText`; `privacy-service.test.ts` asserts a planted key is stripped. |
| PRIV-003 local data location, retention, one-click delete | PASS | `privacy.dataSummary` (location + usage breakdown + retention) and `privacy.clearHistory` (task tables child-first + blobs + attachments + logs, keeps settings/keys/workspace); two-step confirm; `privacy-service.test.ts` + e2e. |

## Known issues (non-blocking)

- **DOMPurify advisories (1 low + 1 moderate)** reached only through
  monaco-editor's bundled copy. The app never calls `DOMPurify.setConfig`
  (grep-verified), and the renderer runs under `script-src 'self'` with no inline
  execution, so the `ALLOWED_ATTR`/hook-pollution XSS vectors are not reachable.
  Tracked for the monaco bump at M12; not a Critical/High release blocker.
- Cold-start p95, input-to-paint p95 and idle-memory numbers require the
  packaged app on the §16.5 reference machine — measured at the M12 release run,
  not in this vitest harness.
- SBOM + full third-party license inventory are M12-04 deliverables; this report
  covers only the vulnerability gate (`npm audit`).

## Verdict

All §16.4, §16.5, A11Y-001..005 and PRIV-001..003 items that can be verified
pre-packaging are PASS. The two dependency advisories are moderate/low and
mitigated. Remaining deferred items (packaged-app perf numbers, SBOM/licenses)
are M12 release-run scope by design.
