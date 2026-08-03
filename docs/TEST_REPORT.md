# Charter 1.0.0-beta.5 Test Report

## Build identity

- Version: `1.0.0-beta.5`
- Candidate tag: `v1.0.0-beta.5`
- Pi SDK: `@earendil-works/pi-coding-agent@0.82.1`
- Electron: `43.1.0`
- Date: 2026-08-03
- Release scope: zero-cost, unsigned GitHub Prerelease

This report qualifies the Beta 5 candidate. It does not qualify a signed or notarized Stable build.
The tag workflow must repeat every release gate and publish only after the native macOS, Windows and
Linux package jobs pass.

## Five-role acceptance

| Role | Scope | Result |
| --- | --- | --- |
| Product owner | Version identity, release value, documentation, limitations and upgrade story | PASS |
| UX acceptance | Home, Session rail, Stop all, Skills, worktree flow and 960×720 narrow layout | PASS |
| QA engineer | Static, unit/integration, performance, Electron E2E and packaged smoke | PASS |
| Security engineer | Privacy deletion, production dependency audit, IPC contracts and Electron boundaries | PASS |
| Release engineer | Prerelease policy, package matrix, metadata and GitHub publication controls | PASS |

The role review found and closed four candidate blockers: stale Beta 4 documentation, obsolete visual
and external-session E2E expectations, Terminal Replay recordings missing from privacy cleanup, and a
High-severity nested `brace-expansion` resolution. The Windows packaged smoke cleanup was also made
tolerant of the runner's post-test `EPERM` without weakening product assertions.

## Candidate gate evidence

| Suite | Candidate result | Evidence |
| --- | --- | --- |
| Static checks | PASS | Prettier, 534 architecture-boundary files and TypeScript |
| Unit/integration | PASS | 1,261 passed, 2 skipped |
| Performance | PASS | 9 configured budgets |
| Security | PASS | Secret scan; 148 security tests; 2 Electron boundary tests |
| Production dependency audit | PASS | Dependency safety PASS; `npm audit --omit=dev --audit-level=high` reports 0 vulnerabilities |
| Targeted visual/privacy E2E | PASS | Home/Skills/narrow layout and privacy deletion flows on real Electron |
| Packaged macOS smoke | PASS | Packaged security and PTY restart paths |
| Reliability soak | PASS | 50/50 deterministic task laps |
| Complete Electron E2E | PASS | 186 passed, 29 intentionally skipped, 0 failed on real Electron with isolated user-data |
| Native package matrix | REQUIRED ON MAIN AND TAG | macOS arm64, Windows x64 and Linux x64 |
| Release metadata | REQUIRED ON TAG | SPDX SBOM, licenses, notices, manifest, checksums and gate report |

Mock Runtime results are not claimed as real-provider qualification. Real Claude Code, Codex, Kimi
and custom external Agents retain their own permission and trust boundaries.

## Release gates and limitations

| Gate | Result | Evidence / limitation |
| --- | --- | --- |
| Data integrity and privacy cleanup | PASS | Terminal recordings are counted and deleted with local history |
| Permission and path boundaries | PASS | Security suite and fail-closed IPC policy |
| Secret leakage | PASS | Secret scan and support-bundle coverage |
| Unsigned Beta packaging | CONDITIONAL | Native matrix must pass before publication |
| GitHub distribution channel | CONDITIONAL | Workflow enforces prerelease, non-draft and not-latest metadata |
| Signed/notarized Stable | BLOCKED | Requires Apple and Windows signing credentials |
| Fixed real-provider evaluation | OPEN | Requires owner credentials and sign-off; not claimed by this Beta |

## Release decision

`1.0.0-beta.5` is approved as an **unsigned GitHub Prerelease candidate**. The complete local
Electron E2E and soak gates passed. Publication remains conditional on a green main CI run and the
tag-triggered workflow's repeated gates, native packages and artifact metadata. The immutable commit,
workflow run and published assets are recorded by GitHub after those conditions succeed.
