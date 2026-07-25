# Frozen benchmark contracts

These contracts are the Barrier A input for the `design-mock-html` parallel forward test. Candidate builders must not
inspect `docs/design/mock-html-boundary-validation/` or its evaluation because those are the comparison baseline.

## Shared product frame

- Product: Charter, an Electron desktop workspace for agentic development.
- Intended viewports: 1440 × 900 and 760 × 820.
- Product identity to preserve: warm archival surfaces, restrained ink-like contrast, serif for editorial hierarchy,
  sans for controls, mono for technical identity and receipts.
- Avoid copying Material, Fluent, or macOS visual skins. Use external systems only for layout, state, type, and motion
  reasoning.
- Study controls must be visually separate from product UI.
- Use semantic controls, visible focus, logical tab order, reduced-motion support, and no placeholder links.
- Implement the primary path, one recovery path, and the named edge state.
- Do not add a surface unless it passes a causal inclusion test.

## Case A — Screenshot intent loop

### Brief

When a developer captures a failing Electron test, help them turn the image into useful Session context without losing
it when no Session is active or when they need it again later.

### Object ledger

| Field | Contract |
| --- | --- |
| Asset | `asset_01K0X` |
| Filename | `Clipboard 2026-07-21 10.42.31.png` |
| Size | `1440 × 900` |
| Session | `SS-184 · Fix failing Electron test · fable5` |
| Annotation | one marked failure region |
| Scope | transient at capture → Session-scoped at attach/send → reusable Session asset |

### Required surfaces and path

1. Capture/Quick Card: identify destination and optionally annotate.
2. Session composer: show attachment scope before send and prove the sent state.
3. Session assets: preserve provenance and reuse without duplication.

Edge state: no active Session at capture time. Recovery must queue or deliberately retain the image, then attach it
after a Session is selected.

### Visual brief

- Character: immediate, surgical, trustworthy.
- Anti-character: noisy, toy-like, magically automatic.
- Attention: captured object → destination/scope → primary action → secondary annotation/save.
- Signature detail: a restrained provenance/annotation tracer that visibly survives the transition.

Builder owns only `docs/design/mock-html-parallel-v2/screenshot/`.

## Case B — Effective memory

### Brief

When a developer starts work in `fable5`, help them understand which instructions will actually affect the run, edit a
source safely, resolve precedence conflicts, and see the exact receipt used at execution.

### Object ledger

| Field | Contract |
| --- | --- |
| Project | `fable5` |
| Effective sources | `Charter workspace rule` → `.claude/CLAUDE.md` → `~/.codex/AGENTS.md` |
| Editable source | `/Users/edy/git/fable5/.claude/CLAUDE.md` |
| Conflict | test command differs between Charter rule and project memory |
| Receipt | immutable per run; one source may be excluded for this run only |

### Required surfaces and path

1. Effective state: task-first precedence and provider provenance; provider library remains secondary.
2. Source editor: scope, provider, precedence, and effect of save remain visible.
3. New Session receipt: inspect/exclude a source and prove what was sent.

Edge state: two active sources conflict. Recovery must resolve the project effect without silently overwriting managed
or global sources.

### Visual brief

- Character: legible, causal, controlled.
- Anti-character: provider-centric, configuration dump, mysterious.
- Attention: effective set → conflict/precedence → source action → run receipt.
- Signature detail: a compact precedence trail that follows a source from configuration into the run.

Builder owns only `docs/design/mock-html-parallel-v2/memory/`.

## Case C — Artifact lifecycle

### Brief

When a Session produces a review package, help the user inspect versioned artifacts, attach region-specific feedback,
handle regeneration without losing note identity, and return to the same review state after the Session ends.

### Object ledger

| Field | Contract |
| --- | --- |
| Session | `SS-211 · Prepare Q2 design review` |
| Artifact set | `artifact_set_01K1A` |
| Primary artifact | `Q2-review.pdf` |
| Supporting artifacts | `decision-summary.md`, `evidence.csv` |
| Feedback identity | artifact ID + immutable version + page/region + author |
| Edge transition | feedback on v1 → regeneration creates v2 → explicit re-anchor or preserve on v1 |

### Required surfaces and path

1. Session completion: outcome and versioned artifact set.
2. Artifact review: region anchor, note, v1→v2 stale state, and explicit re-anchor.
3. History return: retained review status, artifact count, and link to producing event.

Edge state: artifact regenerated after feedback was authored. Never silently move or mutate the v1 note.

### Visual brief

- Character: editorial, reviewable, version-trustworthy.
- Anti-character: generic file manager, transcript-heavy, destructive.
- Attention: outcome → primary artifact/version → selected evidence → feedback consequence.
- Signature detail: an anchor/version thread connecting review feedback to its origin.

Builder owns only `docs/design/mock-html-parallel-v2/artifact/`.
