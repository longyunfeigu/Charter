# ADR-0061: Interface standards pass — one state once, evidence in place, one page grammar

- Status: Accepted
- Date: 2026-11-16
- Relates to: DESIGN.md (new "Interface standards" section), ADR-0016 (room review bar),
  ADR-0020 (skins), ADR-0022 (checks pane, VER-007), PIVOT-024/037,
  `docs/design/diff-panel-redesign.html` (approved design D)

## Context

A design review of v1.0.0-beta.6 against real Electron captures found problems the user
had felt but could not name. The user accepted these as acceptance standards
(2026-11-16):

1. One state, said once where it is needed.
2. What the user judges is visible without a click.
3. The primary action's colour means "recommended"; red is reserved for real danger.
4. At most three top-level nouns. **Not addressed here** — it needs an information
   architecture decision and its own ADR.
5. One page grammar across the product.
6. The text read most (the Agent's answer) gets the best typography.
7. An empty surface states the next step instead of showing zeros.

Evidence from the captures: after a Session finished, "1 file changed, unverified" was
stated seven times on one screen; the diff took two clicks; the primary button was a
red "Accept without verification…"; at 1440 px the tool tab strip scrolled "Output" to
"tput"; Home, Missions, Projects, Skills and Memory each opened with a different hero
(poster-sized serif titles from 46 px to 76 px, decorative mono eyebrows such as
"PROJECT INTELLIGENCE / LIVE CONTEXT"); Missions and Work showed rows of zeros.

The six skins are a token layer (ADR-0020) and change no layout, so they are unaffected
and all remain.

## Decision

### Session review (standards 1–3)

- The Review panel carries only evidence: the Agent's summary, one file list whose
  heading is the change-set headline ("N files changed +a −d"), the **first changed file's
  diff rendered in place** (rich Markdown/image projections included), recorded checks,
  and risks. The duplicate "Ready to review / N files changed / evidence note" lead block
  is removed.
- The Action Dock is the single place that states the verdict (ready, unverified, failed
  checks, failed request). Its risk line moves from danger red to the warning colour:
  unverified work is a decision for the user (amber), not an incident (red).
- When nothing has run, the checks pane no longer repeats "Unverified". With configured
  commands it lists them with **Run verification as the primary button**; with none it
  renders nothing. VER-007's prominent "Unverified" is satisfied by the dock line beside
  the decision.
- The Done milestone of the turn currently under review omits its diffstat, check count
  and "unverified"; earlier turns keep them as history.
- The Diff tab count badge is hidden while Review or Diff (which state the count) is open.
- Accepting despite missing or failed evidence keeps its two-step confirmation but uses a
  new `ConfirmDangerButton tone="caution"`: neutral button, primary-coloured confirm.
  Rollback and discard keep the red danger treatment.
- After a failed request or failed check, "Request changes" becomes the primary action and
  always sits last in the dock.

Approved design D ("no file expands until the reviewer picks one") now applies to the
Diff tool only. In Review, standard 2 takes precedence by the user's explicit decision.

### Tab strip

The tool tab strip no longer scrolls labels out of view. When the labels do not fit,
inactive tabs collapse to icon + tooltip (the accessible name is unchanged) and the active
tab keeps its label. The full width is measured only while expanded, so the state cannot
oscillate.

### One page grammar and typography (standards 5–6)

- New shared tokens in `theme.css`: `--page-title-size: 30px`, leading, tracking and
  `--page-lede-size`, plus a `.page-head` rule (title + one-line description).
- Home, Missions, Projects, Skills, Memory, Settings and Work titles use the shared scale.
  Hero cards, the Mission Center mark, and the decorative `::after` eyebrows
  ("LIVE ORCHESTRATION / OUTCOMES", "PROJECT INTELLIGENCE / LIVE CONTEXT",
  "CAPABILITY CATALOG / OBSERVED USAGE", "AGENT KNOWLEDGE / PROJECT RULES") and the Home
  "New session brief", Memory and Remote Explorer eyebrows are removed.
- The Project header's Git chip shows the branch only; the change count lives in the
  Working tree metric (and the Changes tab), so the Repository card keeps only Sync.
- Agent answers render at 15 px / 1.72 with a 70-character measure; user messages and UI
  copy keep 14 px.

### Empty states (standard 7)

- Mission Center shows its metric strip only when at least one Mission exists.
- Project Center hides its metric strip for a project with no sessions, no history and a
  clean tree.
- Work hides its summary counters on an empty board and shows one line naming the next
  step; the stage columns (which are drop targets with their own + buttons) remain.

## Consequences

- Acceptance tests that encoded the old presentation were updated to the new single
  statement, not weakened: `room-reviewbar`, `m9-verification`, `home-v2` now assert
  VER-007 at the dock (`review-failed-checks-warning`) and the absence of the duplicate
  block; `signal-desk-visual` asserts the eyebrow is gone; `session-aggregate-diff` reads the
  aggregated count from the Review heading instead of the (now hidden) Diff tab badge. New `ui-standards.spec.ts`
  covers each standard on real surfaces (diff in place, said-once checks, non-red accept,
  unclipped tabs at two widths, 30 px titles, zero-free empty Missions/Work).
- `theme.css` skin overrides that target title classes still apply; skins change the
  title's face and colour, never its size.
- Standard 4 (top-level nouns) remains open.

## Rollback

All changes are renderer-only (no IPC, schema or data change). Reverting the commit
restores the previous presentation.
