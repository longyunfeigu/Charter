# SSH / SFTP user-first Skill forward test

## Artifacts

- Previous reference:
  [`../mock-html-skill-showcase/sftp-transfer.html`](../mock-html-skill-showcase/sftp-transfer.html)
- Revised candidate: [`index.html`](index.html)
- Interactive comparison: [`compare.html`](compare.html)
- Frozen task and baseline ledger: [`contract.md`](contract.md)

The repository artifact is the historical reference. It is not represented as a transcript of a prior chat.

## What the revised Skill changed

The Skill revision is product-agnostic. It added:

- an ordinary-user proxy lens;
- a baseline-strength ledger;
- a first-person `see → infer → act → feedback → next` rehearsal;
- progressive-disclosure classification;
- dominant-task regression blockers;
- scoring weight for ordinary-task fluency and preserved proven advantages.

SSH/SFTP appears only in this forward-test artifact, not in the Skill rules.

## Same-task comparison

| Dominant-task evidence | Previous | Revised candidate |
| --- | --- | --- |
| First cue | Selected local files and right-facing arrow | Same selected files, destination, drag hint, and Upload action |
| First action | Click upload arrow | Drag to remote pane or click Upload |
| Persistent workspace | Two large panes plus transfer center | Same; file panes retain at least 68% of workspace and stay within 3 percentage points of the baseline |
| Information to remember | Selection and destination stay visible | Same |
| Conflict | Appears after upload action | Appears after drag or upload; previews the resulting filename |
| Recovery | Retry remains in a non-terminal “正在重试” state | Only interrupted file resumes and reaches 2/2 verified |
| Ordinary-state weight | Three unrelated transfer cards are already present | Quiet transfer center until the current action begins |
| Narrow layout | Long reflow of the three-pane document | Local/Remote tabs, persistent upload action, compact transfer region |

The revised candidate keeps the spatial model instead of replacing it with a persistent manifest, route diagram, host
rail, or explanatory hero.

## Strict revised-rubric result

| Category | Previous reference | Revised candidate |
| --- | ---: | ---: |
| Product fitness | 21/25 | 24/25 |
| Interaction quality | 21/25 | 24/25 |
| Visual and aesthetic craft | 18/20 | 18/20 |
| Accessibility and adaptation | 13/15 | 13/15 |
| Evidence and product integrity | 8/10 | 9/10 |
| Prototype proof | 3/5 | 5/5 |
| **Total** | **84 · blocked** | **93 · recommended** |

### Remaining candidate deductions

- Product: permission-denied and cancellation during an active write remain outside this focused loop.
- Interaction: the prototype does not demonstrate multi-selection modifiers or a real filesystem.
- Visual: transfer-center typography becomes compact at the tested desktop width; a production implementation should
  validate localization and system font metrics.
- Accessibility: this was keyboard- and semantics-checked, but not tested with a screen reader or an actual user.
- Evidence: the ten-second first-action result is an expert proxy walkthrough, not observed user research.

## Operated evidence

- Electron Playwright through `tests/e2e/helpers/launch.ts` with isolated user data.
- 1440 × 900:
  - both file panes and paths visible;
  - no persistent manifest;
  - file panes retain the baseline workspace share;
  - Transfer Center collapses and restores;
  - selected-file drag to remote opens conflict handling;
  - visible Upload fallback opens the same flow;
  - Escape closes the dialog and restores focus;
  - Keep both previews `charter-1.0.0 (1).dmg`;
  - start creates a partial failure;
  - resume affects only `release-notes.md`;
  - remote list and receipt reach 2/2 complete.
- 760 × 820:
  - Local and Remote tabs remain reachable;
  - upload stays visible;
  - conflict sheet remains usable;
  - no horizontal document overflow.
- No relevant page or console errors.
- Static Mock audit and JavaScript syntax checks are clean.

## Recursive correction

| Pass | Rendered defect | Lens | Correction | Verification |
| --- | --- | --- | --- | --- |
| 1 | A completion toast survived reset and overlapped a later narrow conflict state | State integrity / ordinary-user proxy | Reset and dialog entry now clear transient status and its timer | Added hidden-state assertion; reran full desktop and narrow path |

## Honest confidence statement

This result shows that the revised method prevented the specific regression seen in the rejected manifest-first design
while closing the previous recovery defect. It is an expert heuristic and automated interaction forward test. It does
not prove that actual users prefer the candidate; that judgment still belongs to the user comparison and, if needed,
observed usability testing.
