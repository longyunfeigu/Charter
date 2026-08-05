# Repository Agent Instructions

## Electron UI validation

This repository is an Electron desktop application. For rendered application UI testing and
visual QA, use the repository's Playwright Electron workflow directly.

- Do not try the Codex in-app Browser for Charter UI validation unless the user explicitly asks
  for browser-based testing.
- Launch automated UI tests with the existing Electron helpers and isolated user-data directory
  in `tests/e2e/helpers/launch.ts`.
- Prefer targeted runs while iterating, for example:

  ```sh
  npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/<target>.spec.ts
  ```

- Run `npm run build` before Electron E2E when renderer, preload, main-process, or shared package
  source has changed.
- Store temporary screenshots, traces, and ad hoc QA artifacts outside the repository, normally
  under `/tmp`. Do not commit generated QA artifacts unless the user explicitly requests them.
- For visual changes, validate the real Electron surface at the intended desktop viewport and a
  narrower viewport when practical. Check page identity, non-blank rendering, framework overlays,
  relevant console/page errors, screenshot evidence, and the primary interaction path.

## Release workflow

Before creating or pushing a release tag:

1. Require a clean worktree and a successful main-branch CI run for the exact target commit.
2. Run the fast release-contract gates locally before starting the expensive release workflow:

   ```sh
   npm run check
   npm test
   npm run test:perf
   node scripts/dependency-safety.mjs --check
   npm audit --omit=dev --audit-level=high
   CHARTER_SIGNING_MODE=unsigned node scripts/release-policy.mjs --tag <tag>
   ```

3. When changing constants, limits, chunk sizes, timeouts, retries, or transport semantics, search
   for the old contract across unit, performance, security, and E2E tests. Update the implementation
   and its acceptance contract in the same commit.
4. While iterating on an Electron failure, run the targeted spec first, repeat the affected test
   three times, and run the full Electron suite only after the targeted runs are stable.
5. Built-in product workflows must not rely solely on optional host tools such as Python. Prefer a
   bundled runtime and verify that its entry point is available in the packaged application.
6. Never force-move a release tag after a failed release workflow. Increment the prerelease version
   and create a new tag.
7. Treat the release as complete only after verifying all of the following:
   - the GitHub Release exists, is not a draft, and is marked as a prerelease;
   - the annotated tag resolves to the expected commit;
   - macOS, Windows, and Linux assets are uploaded;
   - `GATE_REPORT.md` reports `PASS`;
   - the release manifest, SHA256 checksums, SBOM, and license notices are present.
8. Release workflows can take 45–60 minutes. Report material state transitions and failures rather
   than repeatedly reporting an unchanged running state.
