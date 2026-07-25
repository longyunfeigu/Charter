# `design-mock-html` parallel + recursive forward test

## Verdict

The revised Skill produced three recommendable Mock HTMLs after evidence-based review:

| Case | Strict baseline | Candidate pass 1 | Recursive result | Gate |
| --- | ---: | ---: | ---: | --- |
| A · Screenshot intent loop | 69 · blocked | 80 · blocked | **92** | PASS |
| B · Effective memory | 63 · blocked | 84 · blocked | **92** | PASS |
| C · Artifact lifecycle | 62 · blocked | **93** | **93** | PASS |

All final candidates exceed 90, reach every category floor, and have no blocker in the tested paths.

This result also corrects the earlier self-review in
[`../mock-html-boundary-validation/evaluation.md`](../mock-html-boundary-validation/evaluation.md), which claimed
93/94/95. Independent operation exposed scope, immutability, version, recovery, and narrow-window contradictions that
the original review missed. The earlier numbers must not be treated as validated scores.

Open the live comparison gallery at [`index.html`](index.html).

## What changed in the Skill

The updated Skill is at
[`design-mock-html/SKILL.md`](/Users/edy/.codex/skills/design-mock-html/SKILL.md).

It now makes one lead agent accountable for four lenses: product, interaction architecture, aesthetic engineering, and
skeptical usability review. The practical changes are:

1. **Problem and behavior gates.** A short feature request becomes a provisional job, object ledger, impact radius,
   behavior contract, and visual brief before styling.
2. **Selective methodology.** Discover/Define is used when the requested widget may hide the problem; alternative
   models are explored only when behavior is uncertain; HEART is used only when the prototype informs measurement.
3. **Design debt boundary.** Existing code is evidence, not truth. The workflow explicitly separates durable identity
   from preserve/correct/deprecate decisions.
4. **Visual-direction method.** Character/anti-character, attention order, structural tokens, semantic roles, state
   matrix, motion intent, breakpoint transformations, and an anti-generic review are frozen before implementation.
5. **Causal connected surfaces.** A second surface is included only for shared identity, propagated state, required
   task transition, invariant, or recovery.
6. **Parallel ownership barriers.** The lead freezes the contract; isolated builders get one-writer directories;
   independent reviewers inspect the same snapshot. Builders must now emit a runnable interaction tracer before
   polish, so planning-only work is visible early.
7. **Forward-test and recursive repair.** Same brief, content, paths, viewports, and rubric; a blocker fails the whole
   gate. The smallest responsible Skill rule is patched, then only the affected case is rerun.
8. **New integrity rules found by this test.**
   - `hidden`-driven state requires `[hidden] { display: none !important; }`, plus computed-visibility checks.
   - Global shortcuts must ignore native controls and text-entry targets.
   - Immutable execution receipts must be separated from future mutable configuration.

The static audit now checks hidden-state integrity in addition to doctype, language, title, viewport, landmarks,
focus, adaptation, reduced motion, button types, and placeholder links.

## How external methods were actually used

The methods were translated into triggers and checks, not copied as visual skins:

| Source method | Trigger in this Skill | Observable use in these cases | Misuse prevented |
| --- | --- | --- | --- |
| Design Council Double Diamond | Requested UI may hide the real job | Freeze job/object/edge state before converging on a model | Mandatory workshop ceremony for a small mock |
| Google HEART / Goals–Signals–Metrics | Mock informs an experiment | Optional `goal → signal → metric → source → confounder` row | Treating HEART as a visual checklist |
| Material 3 layout, states, type, motion | Adaptive layout or consequential controls | Semantic roles, multi-cue states, content-driven breakpoint transforms | Copying Material color, component, dp, or motion skin |
| Nielsen heuristics / Apple HIG | Consequential state and desktop interaction | Visible scope/status, agency, familiarity, recovery, keyboard efficiency | Generic “best practice” labels without behavior |
| WCAG / GOV.UK layout | Keyboard, resizing, understandable status | Focus visibility, semantic controls, truthful hiding, narrow task preservation | Treating accessibility as a final cleanup pass |

Authoritative references are recorded in
[`design-foundations.md`](/Users/edy/.codex/skills/design-mock-html/references/design-foundations.md).

## Frozen benchmark

The exact briefs, product constants, object IDs, edge states, owned directories, and viewports are in
[`contracts.md`](contracts.md).

- Product: Charter Electron desktop workspace.
- Viewports: 1440 × 900 and 760 × 820.
- Same realistic objects and paths for baseline and candidate.
- Baseline diagnosis and its evaluation were hidden from candidate builders.
- Baseline and candidate were operated by independent, read-only reviewers.

Case A is a transparent exception to clean blind generation: its assigned builder stalled without producing files, so
the lead built that candidate from the frozen contract after baseline defects were already known. It is valid evidence
for recursive repair and final quality, but not an unbiased first-pass generation test. Cases B and C remained blind
forward tests.

## Case A — Screenshot intent loop

Recommended: [`screenshot/index.html`](screenshot/index.html)

| Category | Baseline | Candidate pass 1 | Final |
| --- | ---: | ---: | ---: |
| Product fitness | 16/25 | 19/25 | 23/25 |
| Interaction quality | 16/25 | 19/25 | 23/25 |
| Visual craft | 16/20 | 19/20 | 19/20 |
| Accessibility/adaptation | 11/15 | 12/15 | 14/15 |
| Evidence/integrity | 6/10 | 7/10 | 8/10 |
| Prototype proof | 4/5 | 4/5 | 5/5 |
| **Total** | **69** | **80** | **92** |

### Defects removed

- Baseline allowed Send with no active Session while simultaneously claiming `SS-184 · attached`.
- Candidate pass 1 fixed scope, recovery, tracer continuity, focus, and shortcuts, but Reuse returned to a locked sent
  composer and Enter on Dismiss also triggered the global attach shortcut.
- Recursive repair split current draft state from historical usage, scoped global shortcuts away from controls, made
  direct Assets truthful before save, synchronized annotation metadata, and retained local scope when no Session
  existed.

### Final operated evidence

- No Session → save locally → Assets shows local recovery scope → reuse → choose Session → send.
- Send → Assets → reuse opens an unlocked new draft → second send completes.
- Enter on focused Dismiss only dismisses; capture remains unattached and recoverable.
- Annotation is identical in preview, composer metadata, and ledger.
- Both sent states disable removal; usage history survives reuse.
- No relevant console/page error or horizontal overflow.

Remaining deductions: no distinct list of two immutable send events, no simulated send retry, and narrow detailed views
require vertical scrolling.

## Case B — Effective memory

Recommended: [`memory/index.html`](memory/index.html)

| Category | Baseline | Candidate pass 1 | Final |
| --- | ---: | ---: | ---: |
| Product fitness | 16/25 | 20/25 | 24/25 |
| Interaction quality | 13/25 | 20/25 | 23/25 |
| Visual craft | 13/20 | 18/20 | 18/20 |
| Accessibility/adaptation | 9/15 | 13/15 | 13/15 |
| Evidence/integrity | 9/10 | 9/10 | 9/10 |
| Prototype proof | 3/5 | 4/5 | 5/5 |
| **Total** | **63** | **84** | **92** |

### Defects removed

- Baseline Resolve only hid the conflict; Save did not recalculate effective memory; a one-run exclusion contradicted
  and later mutated the supposedly immutable receipt.
- Candidate pass 1 made those paths real, but `.sent-proof { display: grid }` overrode the DOM `hidden` state, rendering
  Draft and Sent simultaneously. It also froze source editing after execution.
- Recursive repair added the hidden-integrity rule to the Skill and audit, captured an immutable run snapshot, and kept
  future source configuration independently editable.

### Final operated evidence

- Draft has `hidden === true`, computed `display: none`, and no Sent geometry or copy.
- Excluding project yields exactly `2 sources · 4 instructions` and a draft-only receipt.
- Start locks `mem_01K3F · SS-219`, exclusion, effective command, project command, and hash.
- Editing and saving the future source changes current Effective back to conflict without changing any field in the old
  receipt.
- Modal focus wraps, Escape restores the invoking control, and both viewports have no relevant error or overflow.

Remaining deductions: the narrow Start action sits above the source list, some metadata/control targets remain small,
and the locked receipt could explicitly announce that current sources changed after the run.

## Case C — Artifact lifecycle

Recommended: [`artifact/index.html`](artifact/index.html)

| Category | Baseline | Candidate |
| --- | ---: | ---: |
| Product fitness | 15/25 | 24/25 |
| Interaction quality | 13/25 | 24/25 |
| Visual craft | 16/20 | 18/20 |
| Accessibility/adaptation | 9/15 | 13/15 |
| Evidence/integrity | 7/10 | 9/10 |
| Prototype proof | 2/5 | 5/5 |
| **Total** | **62** | **93** |

### Defects removed

- Baseline could not open Markdown or CSV even though they appeared interactive.
- After re-anchor, baseline History still reported pending/all-v1 state, contradicting the inspector and toast.
- Its 760px feedback inspector collapsed to roughly 26px of a 364px scroll region, and surface switches left focus in
  hidden content or on Body.
- Candidate makes all three artifacts real, records artifact ID + immutable version + page/region + author +
  `feedback_018`, offers explicit re-anchor and keep-v1 branches, and restores exact review state from History.

### Final operated evidence

- PDF, Markdown, and CSV switch in both viewports with their own content.
- Regeneration creates v2 while the v1 note remains immutable.
- Re-anchor adds a linked-v2 receipt without changing v1; preserve marks `RETAINED ON V1`.
- History retains set ID, artifact count, version relation, region, review state, and producing event; Resume restores the
  correct thread and position.
- Alt+1/2/3, Ctrl+Enter, Tab, and heading focus work; no relevant console/page error or horizontal overflow.

Remaining deductions: the narrow Review is about 1810px tall, with excess document-stage space before Feedback, and
the narrow History title is visually heavy.

## Recursive log

| Pass | Rendered defect | Classification | Skill/schema change | Artifact repair | Result |
| --- | --- | --- | --- | --- | --- |
| A1 | Reuse returns to locked composer | Implementation/state | Reinforce object state and recovery verification | Separate current `sent` from historical `everSent` | Rerun PASS |
| A1 | Enter fires Dismiss and global attach | Method/interaction | Global shortcut boundary rule + blocker | Ignore native controls, inputs, and modifier chords | Rerun PASS |
| A2 | Assets invents saved/Session/annotation state | Product/state | State integrity review of both visible and absent nodes | Add truthful empty/local/saved variants | Rerun PASS |
| B1 | DOM hidden but Sent proof visibly rendered | Method/audit | `[hidden]` integrity rule + automated audit | Add forced hidden rule | Rerun PASS |
| Audit | `aria-hidden` falsely triggers state rule | Audit precision | Detect only real `hidden` attributes or `.hidden =` writes | Refine matcher; gallery audit clean | PASS |
| B1 | Old receipt freezes future configuration | Product model | Separate immutable execution evidence from mutable configuration | Snapshot the sent receipt | Rerun PASS |
| C1 | Baseline supporting artifacts and history are false | Behavior contract | Artifact/version/anchor identity ledger | Candidate implements all artifact and return paths | First candidate PASS |
| Orchestration | Assigned builder plans but emits no file | Parallel protocol | Runnable interaction tracer before polish; reassign at next checkpoint | Lead took Case A ownership | Future stall detectable earlier |

## Parallel execution report

- **Ran in parallel:** official-method research, baseline audit, Memory and Artifact isolated implementation, and
  independent case reviews.
- **Barrier A:** [`contracts.md`](contracts.md) froze briefs, object/state ledgers, paths, visual character, viewports,
  and one-writer directories.
- **Barrier B:** each directory passed formatting, JavaScript syntax, and the Skill baseline audit before read-only QA.
- **Barrier C:** the lead alone deduplicated defects, changed shared Skill rules, repaired affected candidates, and
  requested same-reviewer reruns.
- **Avoided races:** builders owned separate directories; reviewers were read-only; shared Skill and gallery edits were
  lead-owned.
- **Mixed speed result:** independent research/build/review work overlapped and reduced serial waiting. Case A still
  became an implementation bottleneck because its builder produced no artifact; the new tracer checkpoint is the
  concrete orchestration correction. No fabricated wall-clock speedup is claimed.

## Verification

- Skill validator: `Skill is valid!`
- Static audit: all three candidates clean, including `hidden-state-integrity`.
- Formatting: Prettier clean for candidate directories and gallery.
- JavaScript syntax: Node check clean.
- Rendered Electron viewports: 1440 × 900 and true 760 × 820; the latter removed BrowserWindow minimum-width
  interference before measurement.
- No relevant candidate `console.error`, `pageerror`, framework overlay, or document-level horizontal overflow.
- Temporary screenshots and structured QA evidence remain under `/tmp`, not in the repository.

Structured evidence:

- Case A: `/tmp/casea-forward-audit-pass2.json`
- Case B: `/tmp/caseb-forward-audit-pass2.json`
- Case C screenshots: `/tmp/case-c-candidate-1440-reanchored.png`,
  `/tmp/case-c-candidate-760-review-feedback.png`,
  `/tmp/case-c-candidate-760-stale.png`,
  `/tmp/case-c-candidate-760-history.png`
