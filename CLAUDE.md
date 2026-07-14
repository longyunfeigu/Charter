# CLAUDE.md — Pi-powered Agentic IDE

## Mission

Build the complete V1.0 desktop product defined in `docs/PRODUCT_ENGINEERING_SPEC.md`. This is not a prototype. Do not stop after the Electron shell, editor, or read-only Pi integration. Completion requires all 12 milestones and all release gates.

## Source of truth

1. `docs/PRODUCT_ENGINEERING_SPEC.md`
2. `docs/UX_PIVOT_SPEC.md` — shell/branding layer (ADR-0004): dual-form "Charter" supersedes spec §4 entry/branding; engine spec unchanged
3. `docs/IMPLEMENTATION_BACKLOG.md`
4. Acceptance tests and state-machine invariants
5. ADRs in `docs/adr/` and `docs/DECISIONS.md`

When requirements conflict, acceptance criteria take precedence. Record interpretations in an ADR; do not silently remove scope.

## Non-negotiable architecture

- Electron + React + TypeScript + Monaco.
- Pi runs outside the renderer in an agent utility/child process.
- Only `packages/agent-runtime-pi` may import Pi packages.
- UI/domain code depends on the product `AgentRuntime` and `AgentEvent` contracts.
- Do not copy Pi source into this repository. Pin the SDK exactly.
- Renderer: `nodeIntegration=false`, `contextIsolation=true`, `sandbox=true`.
- No generic IPC bridge. Every channel has a versioned runtime schema.
- Pi never gets unrestricted filesystem/shell access. All tools go through Tool Gateway and Permission Engine.
- File changes use revision/hash checks, snapshots, atomic writes and conflict handling.
- Agent completion means `REVIEW_READY`, never automatic `ACCEPTED` — except the
  user-opt-in Full mode (ADR-0012): system auto-accept after completion, with
  verification-failure/merge-conflict fallbacks to review and post-accept rollback.

## Working protocol

1. Read the complete specification and backlog before coding.
2. Work milestone by milestone and dependency order.
3. Keep the application runnable after every task.
4. For each task: implement happy path, failure/cancel path, tests, logs, docs, and migration if needed.
5. Run `npm run check` and relevant tests before marking DONE.
6. Mark VERIFIED only after the milestone exit test passes.
7. Update `docs/IMPLEMENTATION_STATUS.md` after each meaningful change.
8. Add an ADR for dependency changes, architecture deviations, security tradeoffs or Pi patches.
9. Never use static fake UI in a completed feature. Mock Runtime is allowed only as a deterministic backend for tests/dev.
10. Never bypass an acceptance failure by weakening the test unless the specification is formally changed.

## Required commands

- `npm run dev`
- `npm run build`
- `npm run check`
- `npm run test`
- `npm run test:e2e`
- `npm run test:security`
- `npm run test:perf`
- `npm run package`
- `npm run release:verify`

## Definition of done

A feature is complete only when it has normal, loading, empty, error and cancellation states; persists correctly; respects security and permission boundaries; has automated tests; and is mapped to a requirement/acceptance ID. The product is complete only when E2E-001 through E2E-024 and all security, data-integrity, reliability, performance and packaging gates pass.
