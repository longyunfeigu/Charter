# Boundary validation of `design-mock-html`

## First-principles verdict

The user's hypothesis is conditionally correct:

- A new Mock HTML should include related surfaces when they are necessary to close one user intent.
- It should not include every adjacent feature, and it should not redesign the whole product merely because the old UI
  is imperfect.
- The unit of design is the **minimum coherent surface set**: enough surfaces to prove object identity, state
  propagation, entry/return, and recovery.

The decision test is causal, not visual. Add another Mock HTML only when the same object crosses the boundary, an
action changes state elsewhere, the task must cross the boundary, an invariant must remain consistent, or recovery
requires it.

## Case 1 — Screenshot Quick Card: zero to one

Historical reference:
[`../screenshot-quickcard-mock.html`](../screenshot-quickcard-mock.html)

Recommended connected set:
[`screenshot-flow.html`](screenshot-flow.html)

### Impact map

| Surface | Shared object or state | Causal boundary | Legacy decision | Mock? | Reason |
| --- | --- | --- | --- | --- | --- |
| Quick Card | `asset_01K0X`, capture state | Entry | Preserve direct capture; correct ambiguous destination | Yes | The user decides what the capture is for |
| Session composer | same image, Session `SS-184` | Identity, scope, propagation | Correct hidden attachment scope | Yes | The image is not context until attached and sent |
| Session assets | same image and annotation | Recovery, identity | Add provenance instead of copying pixels | Yes | Dismissed or later reuse must not lose the object |
| OS screenshot settings | capture preference | Configuration | Preserve platform ownership | No | It does not answer a risk in the capture-to-context loop |
| Project file explorer | exported image file | Optional export | Out of scope | No | Export is not required for the dominant Session job |

### What changed

The historical mock already had a credible Quick Card. The connected prototype does not replace it with a new visual
style; it proves the missing contract:

- capture is a transient object;
- attaching gives it an explicit Session destination;
- sending changes it into Session context;
- saving retains provenance and annotation for recovery;
- no-active-Session is handled without discarding the capture.

Score: **93/100**

| Category | Score | Evidence | Remaining deduction |
| --- | ---: | --- | --- |
| Product fitness | 23/25 | Capture → attach → recover closes the dominant intent; no-Session state is explicit | OS privacy and permission denial are not modeled |
| Interaction quality | 24/25 | Clear default, annotation, dismissal, queued destination, reuse | Keyboard shortcuts are shown but not all are wired |
| Visual craft | 18/20 | Strong card/composer hierarchy at both widths | Asset library is intentionally less detailed than the primary path |
| Accessibility and adaptation | 14/15 | Semantic buttons, focus treatment, 760 px layout preserves the task | No screen-reader announcement test |
| Evidence and integrity | 9/10 | Preserves the historical capture model and adds the missing object ledger | Real clipboard API behavior remains an assumption |
| Prototype proof | 5/5 | Primary, recovery, and no-Session paths operated without page/console errors | — |

## Case 2 — Memory: correct a flawed legacy model

Historical reference:
[`../memory-ia-v3.html`](../memory-ia-v3.html)

Recommended connected set:
[`memory-system.html`](memory-system.html)

### Impact map

| Surface | Shared object or state | Causal boundary | Legacy decision | Mock? | Reason |
| --- | --- | --- | --- | --- | --- |
| Effective memory | ordered rule set for `fable5` | Precedence, scope | Correct provider-first default; preserve provider metadata | Yes | Users need to know what will affect their work |
| Source editor | `.claude/CLAUDE.md` | Mutation, scope | Preserve file ownership and path | Yes | Editing must reveal where and when the change applies |
| New Session receipt | immutable source set | Execution, audit, recovery | Add visible run-time receipt | Yes | “Configured” and “actually sent” are different states |
| Provider library | source inventory | Maintenance | Preserve as a secondary mode | Inside effective surface | It is useful, but not the default user job |
| General settings | preference UI | Configuration | Exclude | No | It repeats provider organization without proving run behavior |
| Historical run diff | receipt comparison | Audit | Future extension | No | One receipt proves the contract; diffing is a later workflow |

### What changed

The historical v3 design is rich but its default mental model is provider and inventory first. That is useful for
maintenance, yet it does not answer the most common product question: “What will a run in this project actually
inherit?”

The recommendation uses two deliberately different views:

- **Effective here** is task-first and ordered by actual precedence.
- **Source library** preserves provider ownership for maintenance.

Editing a file recalculates the effective set, and starting a Session shows an immutable receipt. A conflict is visible
and resolved at the project boundary; a source can be excluded for one run without silently rewriting it.

Score: **94/100**

| Category | Score | Evidence | Remaining deduction |
| --- | ---: | --- | --- |
| Product fitness | 24/25 | Effective state, edit effect, run receipt, and conflict form one coherent model | Cross-project bulk administration is intentionally excluded |
| Interaction quality | 24/25 | Task-first default, source mode, scoped save, one-run exclusion, conflict recovery | Full conflict merge editor is not implemented |
| Visual craft | 18/20 | Precedence and provenance scan cleanly; narrow flow was repaired after visual QA | Long source libraries would need search and virtualization |
| Accessibility and adaptation | 14/15 | Semantic controls, focus, non-color state labels, scrollable 760 px stacking | Editor syntax is not announced structurally |
| Evidence and integrity | 9/10 | Explicit preserve/correct/deprecate treatment avoids blindly copying v3 | Real provider precedence still requires implementation validation |
| Prototype proof | 5/5 | Mode switch, conflict, source save, exclusion, and receipt paths operated cleanly | — |

## Case 3 — Session artifacts: extend a good design without redesigning it

Historical reference:
[`../session-artifact-platform-final-mock.html`](../session-artifact-platform-final-mock.html)

Recommended connected set:
[`artifact-lifecycle.html`](artifact-lifecycle.html)

### Impact map

| Surface | Shared object or state | Causal boundary | Legacy decision | Mock? | Reason |
| --- | --- | --- | --- | --- | --- |
| Session completion | `artifact_set_01K1A`, review state | Handoff | Preserve the strong artifact-set model | Yes | Completion must expose an outcome, not only transcript |
| Artifact workspace | `Q2-review.pdf` v1 and anchored note | Version, feedback | Preserve review UI; add immutable anchor contract | Yes | Feedback is unsafe without artifact/version/region identity |
| Session history | same set and review status | Return, recovery | Correct loss of review state after completion | Yes | Users return after the Session has ended |
| Replay | producing event `#438` | Provenance | Preserve as a link target | No | A deep replay redesign is unnecessary to prove provenance |
| Export/share | artifact delivery | Permission | Future extension | No | It introduces a separate authorization problem |

### What changed

The historical artifact platform is already polished and coherent. Redesigning it would be novelty, not progress. The
new mock instead tests a narrow lifecycle gap:

- Session completion exposes one versioned artifact set;
- review feedback binds to artifact ID, immutable version, and region;
- regeneration creates v2 and makes the v1 note visibly stale;
- history retains artifact count, review status, and a path back to the origin event.

Score: **95/100**

| Category | Score | Evidence | Remaining deduction |
| --- | ---: | --- | --- |
| Product fitness | 24/25 | Completion → review → return closes the artifact lifecycle | External sharing and permissions are separate unresolved work |
| Interaction quality | 24/25 | Review, attach, accept, stale anchor, re-anchor, and replay-origin paths | Multi-reviewer conflict is not modeled |
| Visual craft | 19/20 | Clear review hierarchy and version warning; anchor box was corrected after visual QA | Supporting artifact previews are intentionally shallow |
| Accessibility and adaptation | 14/15 | Semantic controls, visible focus, labels, and usable narrow scrolling | PDF region selection lacks a keyboard drawing interaction |
| Evidence and integrity | 9/10 | Extends rather than replaces the strong historical model; version invariant is explicit | Backend artifact immutability is an assumption |
| Prototype proof | 5/5 | Completion, review, regeneration, re-anchor, accept, history, and replay paths operated cleanly | — |

## Recursive critique log

| Pass | Defect observed in rendered behavior | Lens | Change | Verification |
| --- | --- | --- | --- | --- |
| 1 | Memory's narrow grid compressed the effective-rule list, despite no horizontal overflow | Usability | Switched the narrow effective surface to a scrollable document flow | Re-rendered at 760 × 820; all layers remain readable |
| 1 | Artifact selection rectangle did not cover the chart it claimed to anchor | Product / Aesthetic | Moved and resized the anchor to the changed bars | Re-rendered the stale-v1 edge state |
| 1 | Toast could obscure the primary composer action or stale-version warning | Interaction | Moved transient feedback to the lower navigation area | Re-ran all paths and inspected screenshots |
| 2 | Repeated control IDs made only the first duplicate operable | Prototype integrity | Replaced IDs with shared action attributes and bound all controls | Duplicate-ID check and all interaction paths pass |

## Verification

- Baseline audit: doctype, language, title, viewport, landmark, visible focus, adaptation, reduced motion, button types,
  and non-placeholder links all pass for all three mocks.
- Rendered viewports: **1440 × 900** and **760 × 820**.
- Automated paths: capture/no-Session/attach/send/save/reuse; effective/library/conflict/edit/save/exclude/run receipt;
  completion/review/regenerate/re-anchor/attach/accept/history/replay.
- Result: one active surface per mock, no duplicate IDs, no horizontal document overflow, no relevant console or page
  errors.
- Screenshots and ad hoc QA script were kept under `/tmp`, not committed to the repository.

## Skill change validated by these cases

The skill now requires:

1. an impact map;
2. causal inclusion tests;
3. one of three explicit scopes: isolated, connected set, or system correction;
4. preserve/correct/deprecate decisions for legacy UI;
5. cross-surface identity and invariant continuity;
6. a stop rule that prevents “redesign everything.”

The updated skill passed its structural validator.
