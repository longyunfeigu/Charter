# Design Mock HTML Skill · four-case forward test

Historical chat evidence was unavailable in the ADE search index. Historical baselines therefore
come from repository mock groups, their README/ADR context, and current implementation evidence.
They are not represented as chat transcripts.

## Release gate

- Recommended total: at least 90/100.
- Category floors: product 21/25; interaction 22/25; visual 18/20; accessibility/adaptation
  13/15; evidence 8/10; prototype proof 5/5.
- No blockers.

## Results

| Case | Product | Interaction | Visual | Access/adapt | Evidence | Proof | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Session split | 23 | 23 | 18 | 14 | 9 | 5 | **92** |
| Context attachment | 23 | 24 | 18 | 14 | 9 | 5 | **93** |
| SFTP transfer | 24 | 24 | 18 | 14 | 9 | 5 | **94** |
| Project entry | 23 | 23 | 19 | 14 | 8 | 5 | **92** |

No score is 100 because the mocks have not been validated with real users or a screen reader, and
some implementation constraints remain assumptions.

## Rendered defects and revisions

| Case | Pass | Rendered defect | Revision | Verification |
| --- | ---: | --- | --- | --- |
| Split | 1 | Divider and reset behavior depended on hidden gestures | Added visible grip, named presets, and explicit reset | Pointer and keyboard paths |
| Split | 2 | Focus return label claimed a fixed ratio | Restored the actual preset/custom ratio | Focus → return assertion |
| Split | 3 | Ratio feedback remained during a mode transition | Suppressed it in Focus and narrow layouts | Screenshot and class assertion |
| Context | 1 | Attachment scope was not prominent enough | Added a “this message” shelf and project-scope contrast | Add → remove → send |
| Context | 2 | Narrow layout hid the only visible file source | Added an accessible file drawer from the `@` button | 760px drawer assertion |
| Context | 3 | Tree row contained nested interactive semantics | Split row container from attachment control | Keyboard add path |
| SFTP | 1 | Transfer center obscured the remote list | Made queue a stable third pane and flow content when narrow | Desktop and 760px screenshots |
| SFTP | 2 | Arrow alone did not communicate destination or risk | Added source/target labels and preflight | Upload → conflict policy |
| SFTP | 3 | Failed transfer lacked a concrete recovery proof | Added resumable retry state | Retry assertion |
| Projects | 1 | One fixed entry ignored the difference between populated and empty states | Added Header Add and task-first empty actions | Both scenarios |
| Projects | 2 | First empty-state draft retained stale project detail | Synchronized the main canvas with the empty state | Empty screenshot |
| Projects | 3 | Menu was pointer-first | Added arrow navigation, Escape, and focus return | Keyboard assertions |

## Automated evidence

- HTML baseline audit: clean for all four recommended mocks.
- Playwright paths: no relevant page or console errors.
- Desktop viewport: 1440 × 900.
- Narrow viewport: 760 × 820.
- No horizontal document overflow in tested viewports.
- Primary and recovery paths tested: split Focus/return, context attach/send/drawer, SFTP
  preflight/retry, and project menu/empty/dialog/keyboard escape.

