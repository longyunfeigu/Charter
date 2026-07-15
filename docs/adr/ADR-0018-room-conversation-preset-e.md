# ADR-0018 — Room conversation presentation: preset E「手记工作台」

Date: 2026-07-15 · Status: ACCEPTED (product owner reviewed seven animated
directions in `docs/design/room-conversation-directions.html`, picked preset E
1:1, and asked for real end-to-end verification against the live gateway)
Amends: ADR-0014 room presentation (mockup-A timeline language); keeps
ADR-0016 (review bar as state) untouched.

## Context

Two frictions in the Task Room conversation layer:

1. **The reply textarea grew a near-black 2px box on focus.** Root cause:
   `theme.css`'s global `:focus-visible { outline: 2px solid var(--focus-ring) }`
   wins over `room.css`'s `.tr-cinput { outline: none }` — `main.tsx` lists its
   CSS imports *after* the component imports, ESM hoisting evaluates
   `theme.css` last, and at equal specificity the later rule takes the
   `outline` property. Home's `.hm-ta:focus-visible` (higher specificity) was
   immune, which is why only the room composer showed the box.

2. **The conversation read as visually flat** — every element (user input,
   agent prose, tool rows, milestones) carried the same visual weight; no
   reading hierarchy, weak evidence presentation.

Seven directions (A–D pure, E–G hybrids, all animated over the same 37s
scripted run, mixable via a Tweaks panel across five skin dimensions) were
mocked in `docs/design/room-conversation-directions.html`. The owner picked
**preset E = spine frame × serif prose × chip user bubble × console worklog ×
card composer**.

## Decision

Port preset E 1:1 into the product room (`room.css` + `RoomTimeline.tsx`):

1. **Spine frame.** The timeline renders inside one centered 640px column
   (`.rt-col`, `padding-left: 30px`) carrying a 1px vertical time spine.
   Milestones anchor their glyph (✓ / pulsing dot / ✕) onto the spine with a
   `--bg-editor` mask; labels run mono 10px uppercase with the existing
   trailing hairline and elapsed meta.

2. **Serif agent prose.** Agent bubbles set `font-family: var(--font-display)`
   (Charter; CJK falls back to the system serif) at 15px/1.9, max-width 96%.
   The user bubble stays a quiet sans chip on the right (`--bg-hover`,
   15/15/5/15 radius, 13.5px). Inline code inside serif prose is pinned to
   11.5px so chips stay at worklog scale.

3. **Console worklog.** Contiguous evidence rows — `tool.call` (except the
   plan channel and version-conflict cards), `verification.completed`,
   `worktree.setup` — collapse into one recessed block (`.rt-worklog`,
   `color-mix(fg 4%)`, testid `tl-worklog`). Rows are mono 11.5px prefixed
   with a `mm:ss.d` clock counted from the room's first event; new rows flash
   in (`rt-login`, reduced-motion aware). Null-rendering events never break a
   group; milestones/bubbles/cards close it. Row testids
   (`tl-tool-*`, `tl-path-*`, `tl-verification-*`, `tl-worktree-setup`) are
   unchanged, so existing E2E flows hold.

4. **Card composer, focus on the card.** `.tr-cinput:focus-visible { outline:
   none }` kills the global outline; `.tr-ccard:focus-within` (and the
   follow-up `.hm-card`) carries focus as a border tint + soft 3px ring. The
   reply card rounds to 16px; review bar and composer ride the same centered
   640 column. The activity strip becomes a mono console ticker with a faint
   ink tint.

## Alternatives considered

A (polish-only), B (pure手记 — evidence rows too soft for an agent IDE's
trust needs), C (pure工作台 — ink bubbles + mono prose too heavy for long
reads), D/G (窄栏留白 — evidence density too low for engineering tasks),
F (A + console worklog only — kept as fallback if serif reads poorly in the
field). E keeps B's reading hierarchy where prose lives and C's log fidelity
where evidence lives.

## Consequences

- ADR-0014's "side carries the speaker" and ADR-0016's review-bar state model
  are preserved; only the presentation layer moved.
- The Editor agent panel is untouched (dense evidence remains its job).
- Verification: 345 unit tests, `npm run check`, room/agent E2E
  (m6-agent-ask, room-peek, room-reviewbar) green. Real end-to-end run against
  the live gateway (`tests/e2e/real-room-e.spec.ts`, credential-gated like
  real-gateway.spec): a real write task + follow-up run on
  anthropic/claude-haiku-4-5 with plan/permission gates auto-decided, writes
  asserted **on disk**, spine/serif/worklog/focus asserted from computed
  styles, screenshots in `/tmp/ui-shots/e-*.png`.
