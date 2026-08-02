# Charter product design system

Charter is a quiet mission-control instrument for observable Agent work. It should feel calm,
precise, and durable: editorial enough to make outcomes readable, operational enough to make
state and authority unmistakable.

This is Charter's own product contract. External galleries may be used to study patterns, but
their screens, copy, assets, token values, and distinctive visual combinations must not be copied
into the product.

## Product visual structure — Signal Desk

Every primary surface uses the same three-layer frame so the product reads as Charter before any
individual feature is understood:

1. **Skin-native command chrome.** The title bar, application taxonomy, status strip, and live
   workspace identity share one operational hierarchy, but their material always comes from the
   active skin. They answer “where am I?” and “what is live?” without flattening five skins into a
   sixth global colour scheme.
2. **Indexed navigation.** Sessions, Missions, Projects, Skills, and retrieval lists sit on the
   active skin's navigation surface. Group labels behave like an editorial index; selection uses
   that skin's active surface and accent locator.
3. **Outcome canvas.** The primary content area carries large regular-weight serif identity,
   hairline divisions, and a single dominant work surface. The Home composer, Mission portfolio,
   Project Center, Skills catalog, and Session canvas all share this hierarchy.

The structure is informed by three reusable mechanisms found in contemporary product references:
fixed taxonomy navigation and modular feeds; editorial scale on quiet canvases; and compact,
hairline operational controls with one action accent. Charter does not reproduce source screens.

## Product principles

1. **Outcome before machinery.** Lead with the Mission, current outcome, and next meaningful
   action. Runtime and transport details belong behind progressive disclosure.
2. **Attention must be explicit.** Amber means an open Action Request assigned to the user. Agent
   communication never borrows that treatment. Red means an Incident. Green means verified or
   recovered work.
3. **One dominant canvas.** Each surface has one primary reading or working area. Contextual rails
   and inspectors support it without competing for visual weight.
4. **Summary first, evidence on demand.** Rows begin with owner, state, current phase, and latest
   outcome. Expand or inspect to see messages, Attempts, runtime events, and evidence.
5. **Motion explains change.** Short transitions may reveal detail, confirm selection, or connect
   one state to the next. Motion is never ambient decoration and respects reduced-motion settings.
6. **Density without tiny type.** Metadata may be compact, but primary labels and decision copy
   must remain comfortably readable at desktop and narrow widths.

## Visual roles

Charter uses the existing theme variables so every skin preserves content semantics. Product chrome
uses a small stable layer above skins so switching skins never changes application identity.

| Role | Token | Use |
| --- | --- | --- |
| Canvas | `--bg-editor` | Main reading and work surface |
| Raised surface | `--bg-card` | Selected work, decisions, menus |
| Supporting surface | `--bg-panel` / `--bg-hover` | Rails, inspectors, compact metadata |
| Ink | `--fg` | Primary content and labels |
| Muted ink | `--fg-muted` / `--fg-faint` | Supporting copy and metadata |
| Product accent | `--accent` | Selection, navigation, primary neutral action |
| User attention | `--warning` | Only explicit work assigned to the user |
| Incident | `--danger` | Runtime or coordination problems |
| Verified | `--success` | Completion, recovery, accepted evidence |
| Communication | `--mission-communication` | Agent-to-Agent communication edges and metadata |
| Command chrome | `--chrome-ink` / `--chrome-ink-raised` | Aliases of the active skin's title and raised surfaces |
| Chrome content | `--chrome-paper` / `--chrome-paper-muted` | Aliases of the active skin's primary and muted ink |
| Skin signal | `--chrome-signal` | Alias of the active skin accent for current location and primary action |

Color is never the only state cue. Every state also has a label, icon, shape, or position.

## Typography

- `--font-display`: page identity, Mission outcomes, project identity, and major review moments.
- `--font-ui`: navigation, controls, descriptions, cards, and all interactive surfaces.
- `--font-mono`: timestamps, runtime identity, counts, event kinds, and machine-readable values.
- Display authority comes from scale and spacing rather than bold weight. Major page titles use
  regular or medium serif weight; dense controls remain compact sans-serif.
- Avoid primary interaction text below 10px at 100% UI scale. Tiny uppercase labels are metadata,
  not the only explanation of a control.

## Mission information hierarchy

1. Mission identity and lifecycle state.
2. `Your actions`, only when at least one explicit user Action Request is open.
3. Issues that affect execution or recovery.
4. Work outline as the default operational view; Graph is the advanced relationship view.
5. Contextual inspector for the selected work item.
6. Team activity and durable Results as dedicated views.

Opening a Mission with user work should land on `Your actions`. A Mission ready for acceptance with
no user Action Request or Incident should land on Results.

## Component contracts

### Your actions

- Show the decision, why it matters, recommendation, author, and concrete options.
- Options may explicitly mark themselves as recommended or dangerous; visual emphasis must never be
  guessed from array order.
- Choice descriptions are visible when they contain meaningful tradeoffs, not hidden in tooltips.

### Work outline

- Every row always shows title, owner, lifecycle state, and latest meaningful update.
- The selected row may reveal goal, dependencies, and wait details; full evidence remains in the
  inspector.
- Recursive ownership is expressed through indentation and connectors, not color alone.

### Team activity

- Default to a chronological summary without heartbeats.
- Offer stable filters for requests, progress, and outcomes, with counts.
- Long bodies and delivery/runtime metadata expand in place. Do not show raw provider streams here.

### Issues

- Incidents remain separate from user actions.
- Show severity, recovery state, affected work, and automatic recovery attempts.
- Inspecting an Issue opens the affected Assignment; a user decision appears only when a Lead has
  created and linked an explicit Action Request.

### Results

- Acceptance criteria and verification evidence precede changed-file inventory.
- Acceptance is a deliberate user action. Revision feedback must state what outcome or evidence is
  missing.

## Motion and responsiveness

- Fast feedback: 120–160ms.
- Panel/detail reveal: 180–220ms.
- Use standard ease-out motion; avoid spring or continuous animation in operational surfaces.
- At narrow widths, preserve the Mission header, actions, and primary canvas before secondary rails.
- Controls wrap or stack; they never clip outside the viewport.
- Under `prefers-reduced-motion: reduce`, reveal content without spatial animation.
- Above the compact breakpoint, the application taxonomy includes visible labels. At narrower
  widths it remains a stable fixed rail and the paper navigation becomes an explicit drawer.

## Avoid

- Decorative glass blur, gradients, or 3D art that compete with Mission state.
- A different decorative color for each Agent.
- Using pills for every label or making every card equally prominent.
- Showing private chain-of-thought. Display committed phase summaries and evidence instead.
- Fake presence, fake live cursors, or activity inferred from a process merely existing.
