# Adaptive visual forward-test contract

## Frozen behavior

Use the verified user-first SFTP prototype unchanged:

- local and remote folders remain side by side at desktop width;
- selected files drag to the remote pane;
- the visible Upload action provides a safe fallback;
- conflict handling appears only when triggered;
- Transfer Center owns interruption, resume, and 2/2 completion;
- compact layout swaps Local and Remote through tabs.

## Material visual uncertainty

User feedback says the historical warm treatment and the revised technical treatment each have value. The unresolved
decision is not the interaction model; it is the product's visual voice.

| Axis | Range tested | Intended user effect | Task risk |
| --- | --- | --- | --- |
| Surface temperature | parchment warm → cool system neutral | Character and comfort versus perceived precision | Warmth can reduce contrast; cool neutrality can feel generic |
| Typographic voice | editorial serif accent → system sans | Distinct identity versus native familiarity | Too much serif can slow dense scanning |
| Density and spacing | comfortable → compact → balanced | Calm reading versus expert throughput | Compact rows can reduce legibility; comfortable rows show fewer files |
| Material treatment | tactile borders → quiet system hairlines → restrained fusion | Craft and depth versus low visual noise | Excess material competes with file content |

## Why this case presents three directions

The count is evidence-driven, not a quota:

1. **Warm Archive** represents the historical warm/editorial preference pole.
2. **Mac Utility** represents the cool, compact, system-familiar preference pole.
3. **Warm Precision** tests the user's explicit observation that strengths from both poles may be compatible.

A fourth direction was not added because it did not introduce a new supported hypothesis. All three may be rejected.
If the user likes a specific font from one and spacing from another, the next round should isolate that axis instead of
adding more holistic skins.

## Fair-comparison constants

- Same HTML, behavior, copy, data, file counts, selected items, paths, host, conflict, and failure.
- Same desktop and compact viewports.
- Same primary-object area and Transfer Center position.
- Only palette, typographic voice, density, spacing, shape, and surface treatment may vary.
- Every direction must pass the same drag, conflict, resume, completion, focus, and overflow tests.

## Evidence provenance

The interaction model used current external product research. The three specific visual treatments were not selected
from an online UI gallery and should not be represented as externally validated styles.

| Direction | Existing product | User preference | External visual precedent | Design principle | Original design judgment |
| --- | --- | --- | --- | --- | --- |
| Warm Archive | Historical warm Mock treatment | User said the earlier tone, background, and typography had value | No specific visual style adopted | Comfortable density, typographic hierarchy, semantic color | Parchment palette, serif anchors, and tactile borders |
| Mac Utility | Desktop utility context | User also saw value in the cooler technical treatment | General platform guidance only; no single product look adopted | System familiarity, compact scanning, restrained material | Exact cool palette, spacing, and component treatment |
| Warm Precision | Same behavior contract | User suggested strengths from both treatments might coexist | No specific visual style adopted | Coherent synthesis, balanced density, task-first hierarchy | Exact warm-neutral palette and serif/sans balance |

## Direction hypotheses

### Warm Archive

For users who value a crafted desktop tool, parchment surfaces, editorial titles, and comfortable rows should make
long file sessions feel calmer and more memorable, at the cost of lower information density.

### Mac Utility

For users who value speed and familiarity, cool neutrals, system typography, and compact rows should improve scanning
and feel native, at the cost of weaker product distinctiveness.

### Warm Precision

For users who want character without losing operational clarity, warm neutral surfaces, restrained serif anchors,
system-like body text, and balanced density should combine identity with scanability, at the risk of feeling like a
compromise if the principles do not remain coherent.
