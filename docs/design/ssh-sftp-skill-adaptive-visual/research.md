# Current product-pattern evidence

Accessed 2026-07-25. Sources are official product sites or product documentation.

## Research capability and scope

This run used the installed `web-access` Skill because the environment required all network operations to route
through it. The same public-source research could use a platform's built-in web search/browse capability in an
environment where that optional Skill is not installed.

The research below primarily informed interaction relationships, state disclosure, and adaptation. It did not select
the exact Warm Archive, Mac Utility, or Warm Precision palette and typography. Those visual treatments came from the
historical Mock, user preference feedback, general design principles, and original design judgment. See
[`contract.md`](./contract.md) for direction-level provenance.

| Source | Target job | Observed pattern | Advantage | Tradeoff | Context gap | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| [WinSCP User Interfaces](https://winscp.net/eng/docs/interfaces) | Transfer between local and remote folders with mouse or keyboard | Commander shows local left and remote right; Explorer uses one remote pane; both support transfer methods | Accommodates familiar mental models and expert keyboard use | A mode choice can create configuration and support cost | Charter embeds file transfer in a broader IDE rather than being a dedicated client | Adopt the dual-pane spatial relationship; reject a setup-time interface choice |
| [WinSCP Transfer Options](https://winscp.net/eng/docs/ui_copy) | Confirm destination and options before a consequential transfer | Optional pre-transfer dialog; drag-initiated dialogs can be suppressed after first use | Makes target and background behavior explicit without forcing permanent chrome | Repeated confirmation can interrupt experts | Charter needs conflict safety, not every advanced transfer option | Adapt to a conflict-only sheet with a safe default |
| [FileZilla Pro layout guidance](https://filezillapro.com/docs/v3/advanced/change-layout/) | Fit local/remote browsing to different displays and preferences | Multiple pane layouts, swappable local/remote positions, configurable log and queue placement | Recognizes that one spatial arrangement does not fit every display or user | Too much configurability can move essential objects and raise support cost | The prototype tests one embedded workflow, not a general-purpose FTP client | Adopt breakpoint adaptation; reject broad layout preferences for now |
| [ForkLift 4 Quick Start](https://binarynights.com/manual) | Copy and move between two locations | Central dual panes, visible path/status, drag, toolbar/menu, and keyboard alternatives; preview/activity/log can occupy a right pane | Keeps primary objects central while supporting novice and expert paths | Dense optional chrome can overwhelm an embedded surface | ForkLift is a full file manager with more vertical and menu space | Adopt direct manipulation plus visible fallback; keep secondary activity visually subordinate |
| [Transmit transfers](https://help.panic.com/transmit/transmit5/transfers/) and [Transfer Queue](https://help.panic.com/transmit/transfer-queue/) | Start, monitor, pause, cancel, and resolve transfer conflicts | Local-to-remote drag; compact progress in the active tab; detailed queue is revealed on demand | Preserves browsing area during ordinary work while keeping detail reachable | Hidden detail can reduce status visibility if the summary is weak | Charter needs cross-surface persistence for some transfers | Adapt: keep a visible Transfer Center summary and reveal details only after activity |

## Saturation decision

Research stopped after these sources because the material hypotheses were covered:

- dual pane versus single pane;
- direct drag plus visible and keyboard fallbacks;
- always-visible versus on-demand activity detail;
- fixed versus configurable/adaptive layout.

Additional products were repeating these patterns. The remaining uncertainty is aesthetic preference, which requires
comparison and user judgment rather than more product browsing.

## Translation boundary

The mock adopts relationships and disclosure strategies only. It does not copy the products' colors, icons, window
chrome, proprietary illustrations, or full design systems.
