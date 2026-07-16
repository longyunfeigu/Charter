# ADR-0021 — Legible terminal: shell-integration blocks, sourced progress, command notifications

Date: 2026-07-16 · Status: ACCEPTED (product owner reviewed the discussion
mockup `docs/design/inspo-ghostty-legible-terminal.html`, confirmed the user
stories, then delegated implementation)
Relates to: ADR-0017 (external CLI sessions), TERM-001..006, PIVOT-014
(notification hygiene), VER-005 (superseded semantics), VER-007 (honest
verification states), 研究稿① quick console (`draftStore.addTerminalRef`).

## Context

The bottom-dock terminal is an opaque scrollback: finding "the previous
command's output" is visual archaeology, a ten-minute E2E run is a black box,
and a command that finishes while the user is editing goes unnoticed. Ghostty
solved this family of problems in a plain terminal emulator with shell
integration (OSC 133 semantic prompts), progress reporting (OSC 9;4),
command-finish notifications and unfocused dimming. The discussion mockup
ports these into Charter and extends them to our unique surface: external
claude/codex sessions.

## Decision

### 1. Block model — a product-level unit, parsed in the renderer

A **block** is the user-relevant minimal unit of terminal output. Two block
kinds exist in V1:

- `command` — one shell command: prompt → command line → output → exit code
  and duration. Sourced from OSC 133 `A`/`B`/`C`/`D;<exit>` (FinalTerm
  lineage; same dialect Ghostty, VS Code and WezTerm speak).
- `turn` — an external agent session boundary (see §5).

Parsing happens **in the renderer**, via xterm's `registerOscHandler` on each
terminal's live `Terminal` instance (which receives PTY data whether or not it
is mounted). Block positions are xterm **markers**, so they survive scrolling
and are disposed naturally with scrollback trimming. The command text is read
back from the buffer between the `B` marker (with its recorded cursor column)
and the cursor position at `C` time — no private escape sequence carries
command text, which keeps us compatible with any pre-existing OSC 133
integration the user's shell already has (Ghostty's, VS Code's, a dotfile
plugin). Rationale for renderer-side parsing: markers/selection/scroll all
live in xterm; the main process would need a second stateful VT parser and a
protocol to mirror buffer coordinates it cannot know.

### 2. Shell integration injection — host-owned, per shell, off-able

`packages/terminal-service` owns the integration scripts as string constants
and a pure `shellIntegrationSpawn()` helper that maps `(shell, dir, enabled)`
→ `{args, env}`. The desktop-main process writes the scripts once per launch
under `userData/shell-integration/` and passes the directory into
`TerminalManager`.

- **zsh** — `ZDOTDIR` shim: our `.zshenv` records the user's `ZDOTDIR` and
  restores it, our `.zshrc` sources the user's rc then registers
  `precmd`/`preexec` hooks emitting `133;D;$?` + `133;A`, a `%{133;B%}`
  PS1 suffix, and `133;C` before execution.
- **bash** — `--init-file` shim sourcing the user's profile then installing
  `PROMPT_COMMAND` + `DEBUG` trap equivalents.
- **fish** — `XDG_DATA_DIRS` prepend with a `vendor_conf.d` snippet using
  fish's event handlers.

Guards: the scripts no-op when `CHARTER_SHELL_INTEGRATION` is already set
(re-entry, nested shells) and skip the OSC emission when an existing
integration variable of the host terminal family is present. Any other shell
(or `settings.terminal.shellIntegration = false`) spawns exactly as today —
**the terminal degrades to plain scrollback, features disappear, nothing
errors** (TERM-003 diagnosability preserved).

### 3. Progress — one source, three surfaces, never invented

Priority per running block: **OSC 9;4** (`ESC ] 9;4;<state>;<pct> BEL`,
ConEmu dialect) → **known-format parse** of plain output (conservative
`12/96`-style counters recognized only for known test/build runners) →
**indeterminate** ("running · elapsed", no percentage shown, ever).

The same number feeds three surfaces: the terminal-row progress ring (dock),
the status-bar progress item, and the macOS Dock icon via
`BrowserWindow.setProgressBar` (throttled IPC `terminal.progress`). A
determinate value that stops updating for 20 s falls back to indeterminate
(Ghostty's expiry insight: a crashed process must never leave a frozen
progress bar); block end or PTY exit always clears.

### 4. Command-finish notification — pulls you back to the block

When a `command` block ends after ≥ `settings.terminal.longCommandSeconds`
(default 15) the renderer reports `terminal.commandDone` (versioned RPC).
The main process applies PIVOT-014 hygiene — `notifications.enabled`, muted
under `PI_IDE_E2E`, suppressed while any window is focused, one edge = one
notification (dedup by blockId) — and shows a system notification whose click
focuses the window and broadcasts `terminal.revealBlock`; the renderer opens
the terminal tab, activates the terminal, scrolls to the block start and
flashes it. While focused, a finished long command only sets a bell marker on
its terminal row (cleared on activation). Same switchboard, finer grain: task
→ Room was PIVOT-014; command → block is this ADR.

### 5. External sessions — turns become blocks, honestly

Purple blocks on the same rail, same gestures. Sources, strictest first:

- `structured` capture (ADR-0017): the live parser already yields turn
  boundaries — Codex `turn.completed`, Claude `result`. The session service
  broadcasts a new `external.turn` event; the renderer appends a `turn` block
  at the current buffer position.
- `observed` capture: only session **enter/exit** edges become blocks
  (already broadcast as `terminal.agentState`). We do not fabricate turn
  boundaries from TUI heuristics.

Block actions on any block: **copy output**, **save as attachment**, **send
to Room** (reuses 研究稿①'s `draftStore.addTerminalRef`, authored YOU,
TERM-006), **rerun** (command blocks only). Rerun writes the recorded command
to the same PTY — a user-domain action, no agent approval (TERM-005) — and the
new block links back via `rerunOf` (VER-005 superseded semantics: history is
never overwritten).

### 6. Explicitly not ported

- Kitty graphics protocol — the IDE has a real image viewer (PIVOT-020).
- GLSL cursor shaders — animation budget stays with Live Board (PIVOT-025r).
- Focus dimming shipped minimal: the dock already communicates focus via the
  existing focus ring; a dedicated dim layer is deferred until the one-canvas
  shell lands.

## Consequences

- New settings: `terminal.shellIntegration` (default on),
  `terminal.longCommandSeconds` (default 15, min 5). Workspace-overridable
  with the rest of the `terminal` section (WS-014).
- New channels (versioned, strict): RPC `terminal.commandDone`,
  `terminal.progress`; events `terminal.revealBlock`, `external.turn`.
- The renderer keeps block state per `TermInstance` (markers are not
  serializable); a monotonic version counter drives React updates.
- Degradation matrix (all must stay error-free): integration off / foreign
  shell → no blocks; no OSC 9;4 and unknown output → indeterminate progress;
  notifications disabled or E2E → bell markers only; scrollback trimming →
  markers dispose, rail dots disappear oldest-first.
- Acceptance mapping: TERM-007 blocks & navigation, TERM-008 marker rail,
  TERM-009 sourced progress, TERM-010 command notifications, TERM-011
  degradation (IDs registered in `docs/IMPLEMENTATION_STATUS.md`).
