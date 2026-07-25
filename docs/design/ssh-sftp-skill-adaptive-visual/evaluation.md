# Adaptive Skill forward-test evaluation

## Outcome

The rerun passes the release gate at **94/100**, with no blocker found in the tested path. This is not a claim that one
visual direction is objectively best. The improvement is that the Skill now:

- preserves the previous version's valid dual-pane and persistent-activity advantages;
- uses current first-party product evidence to choose interaction relationships;
- separates behavior uncertainty from visual uncertainty;
- derives exploration breadth from distinct hypotheses instead of a fixed number;
- supports rejecting every presented direction and using the rejection to form the next experiment.

The installed `web-access` Skill was used for the public-source research in this run because the environment required
it. That research mainly informed interaction and layout conventions. The exact A/B/C visual treatments were a
transparent synthesis of the historical Mock, user feedback, general design principles, and original design judgment;
they were not copied from, or validated by, a curated online visual gallery.

Use [`compare.html`](./compare.html) for the previous-output comparison and [`index.html`](./index.html) for the
three-direction interactive study.

## Same-case result

The previous output and adaptive rerun use the same host, paths, selected files, name conflict, interruption, and
completion target.

| Concern | Previous output | Adaptive rerun |
| --- | --- | --- |
| Spatial model | Dual panes plus Transfer Center | Preserved; not replaced merely to appear novel |
| Ordinary first action | Drag or visible transfer control | Drag plus a more explicit `Upload 2 items` fallback |
| Conflict | Conflict preview | Safe `Keep both` default, result preview, cancel, Escape focus restoration |
| Recovery | Retry/resume affordance | `Resume from 2.8 KB` reaches a verified 2-of-2 terminal state |
| Narrow window | Existing narrow behavior | Local/Remote tabs preserve the job without horizontal overflow |
| Visual judgment | One treatment presented as output | Three evidenced hypotheses; no forced selection and no hidden “winner” |

## Why three directions in this case

Three is a consequence of the evidence in this case, not a reusable quota:

1. **Warm Archive** represents the known warm/editorial preference pole.
2. **Mac Utility** represents the system-familiar, compact pole.
3. **Warm Precision** tests the stated possibility that strengths from both poles can coexist.

A fourth direction was stopped because it added styling variation without a new supported hypothesis. A future round
may contain one, two, four, or more directions if the uncertainty structure requires it.

## Rubric

The three visual directions share the same behavior and all meet the same release score. Taste remains unresolved, so
the rubric does not manufacture a visual winner.

| Category | Score | Rendered evidence | Deduction / next point |
| --- | ---: | --- | --- |
| Product fitness | 24/25 | Dual-pane relationship, clear destination, subordinate Transfer Center, conflict and recovery closure | Validate the embedded workflow with target users inside the production shell |
| Interaction quality | 24/25 | Drag and button entry, safe conflict default, cancel/Escape, resume to 2/2 | Measure novice completion time and error rate rather than relying only on expert review |
| Visual craft | 18/20 | Three coherent voices vary typography, density, temperature, and material while preserving hierarchy | Resolve product voice with user preference evidence; test production font rendering |
| Accessibility and adaptation | 13/15 | Semantic controls, pressed state, focus restoration, visible focus, 760 px job preservation | Run exhaustive keyboard traversal and independent contrast/a11y audit |
| Evidence and integrity | 10/10 | Dated first-party research matrix, context gaps, explicit adopt/adapt/reject decisions | — |
| Prototype proof | 5/5 | Full conflict → interrupted → resume → 2/2 path operated in Electron; no relevant console/page errors | — |
| **Total** | **94/100** | All category floors met | No release blocker |

## Electron verification

- Desktop: `1440 × 900` for every visual direction.
- Compact: `760 × 820` for every visual direction.
- Compared distinct computed surface color, selected-row color, title font, and row height.
- Operated Upload, conflict sheet, cancel/Escape, drag, interruption, resume, and final 2-of-2 arrival.
- Operated the direction lab, the reject-all path, and the previous-versus-current comparison controls.
- Confirmed no horizontal overflow in the tested compact path and no relevant page/console errors.
- Static HTML audit passed for the mock, direction lab, and comparison page.

## Recursive revision log

| Pass | Defect observed | Lens | Change | Verification |
| --- | --- | --- | --- | --- |
| 1 | The old Skill could preserve questionable local UI without checking current domain conventions | Product | Added triggered first-party pattern research, evidence matrix, context-gap translation, and saturation stop | Skill validation and SFTP research forward test |
| 2 | A fixed “three directions” rule could turn exploration into quota fulfillment | Product / Aesthetic | Replaced fixed count with the smallest non-dominated hypothesis set; added rejection and synthesis paths | Generic references contain no product-specific terms |
| 3 | The output risked solving visual taste by changing a proven interaction model | Usability | Froze the dual-pane, direct-manipulation, fallback, conflict, and recovery contract before visual exploration | Same DOM and behavior used for A/B/C |
| 4 | A remaining “3–4 cases” sentence could still be misread as a hard target | Method | Changed benchmark breadth to risk/context coverage; retained 3–4 only as a non-binding practical range | Skill revalidated after edit |
| 5 | Initial visual highlight did not expose its state to assistive technology | Accessibility | Added and updated `aria-pressed` for every direction card | Electron assertion and clean static audit |
| 6 | The new lab did not put the historical output directly beside the rerun | Judgment | Added an operable comparison page with layout and visual-direction controls | Electron comparison run and screenshot |

## Honest boundary

This run shows a stronger process and three release-quality candidates. It does **not** prove that the rerun looks
better to every user than the historical version. That final preference remains deliberately open; the comparison
surface exists so a user can choose, combine specific axes, or reject all three.
