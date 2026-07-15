# ADR-0017 — External CLI agent sessions: detection, accounting, room promotion

Date: 2026-07-14 · Status: ACCEPTED (product owner approved the end state via the
mockups `docs/design/external-cli-final-mock.html`,
`docs/design/terminal-placement-directions.html` and
`docs/design/external-cli-terminal-directions.html`, then delegated
implementation)
Relates to: ADR-0009 (multi-mount), ADR-0013 (review v2), ADR-0014 (room/peek),
TERM-005 (user terminals as a separate security domain).

## Context

The user's machine already runs standalone coding-agent CLIs (Claude Code,
Codex CLI). They are ordinary TUI programs living inside a shell: the terminal
is *not* permanently an "agent terminal" — an agent session **starts and ends
inside it** (`claude` ⏎ … `/exit`). The product already has everything such a
session needs to become observable and reviewable: an embedded PTY terminal
(TerminalManager, TERM-001..005), a recursive workspace watcher (WS-008), the
ChangeService baseline/blob/rollback machinery (CHG-001..010), the task state
machine (§6.1) and the room/peek shell (ADR-0014).

What is missing is the connective tissue: knowing *when* a terminal enters an
agent session, capturing a *pre-write* baseline for files the external process
touches (the watcher only fires after the write), and giving the session a
product surface (badges → strip → room) instead of an inert scrollback.

Security framing: external CLIs run **outside** the Tool Gateway and the
Permission Engine. That is not a violation of the "Pi never gets unrestricted
access" rule — these are user-launched processes in the user's own terminal
(TERM-005 already established that domain). But the product must not pretend
otherwise: such sessions are explicitly **unmanaged (EXT)**, and the missing
permission layer is compensated by an automatic entry snapshot, byte-exact
rollback, full change accounting and the normal REVIEW_READY gate.

## Decision

One lifecycle, staged into the existing shell:

1. **Detection — foreground process, nothing else.** TerminalManager polls
   `pty.process` (the PTY's foreground process title, node-pty native) at
   ~700 ms. A match against the known agent CLI list (`claude`, `codex`;
   overridable via `PI_IDE_EXTERNAL_CLIS` for tests) enters *agent state*;
   the title falling back to the shell exits it. OSC titles and
   alternate-screen switches are deliberately **not** signals (Claude Code's
   renderer mode makes them unstable).
2. **Session start = snapshot + task.** On enter, the host creates an
   *external session task* (normal task row + `external_json` marker:
   `{ cli, terminalId, snapshotTree }`) in its terminal's project, transitions
   READY→EXPLORING→IN_PROGRESS, and captures an entry snapshot: a git
   `write-tree` against a **temporary index** (`GIT_INDEX_FILE` + `add -A`) so
   untracked files are covered and the user's real index is untouched.
   Non-git projects degrade honestly: no snapshot, first-seen content becomes
   the baseline, rollback for files that already existed is disabled.
3. **Accounting — watcher + snapshot baselines.** While in agent state, the
   workspace watcher's batches are filtered (`.git/`, ignore globs, the
   product's own artifacts) and every touched path gets, exactly once,
   a ChangeService baseline **from the snapshot tree's blob** (new
   `ensureBaselineFromBytes`), then a change record (`author: 'agent'`,
   `toolCallId: null`). Everything downstream — net change set, review
   presentation, rollback preflight, byte-exact restore — is the existing
   CHG machinery keyed by the external task id. Renderer receives
   `external.sessionChanged` events (session state + accumulating file list).
4. **Shell response (mock: external-cli-final-mock.html).** Terminal tab
   renames to `✳ claude` with an EXT badge and a snapshot toast; the pane
   *promotes* to a right-side vertical panel (same xterm instance, PTY
   uninterrupted; the bottom dock collapses); the panel carries a live
   "session changes" strip; tree rows flash an "外部改动" badge; clicking a
   change row opens the ADR-0014 peek (diff mode, live-following). A room
   button opens the external task's Task Room — terminal column in place of
   the composer/timeline, changes rail, review entry. Session end returns the
   pane to the dock, prints a summary row, and moves the task to REVIEW_READY
   (zero-change sessions follow PIVOT-031 "Answered").
5. **Review semantics unchanged.** REVIEW_READY, never auto-ACCEPTED; accept
   and rollback go through the existing review flow; rollback restores the
   entry baselines byte-exactly.

## Explicitly bounded (v1)

- **No transcript parsing.** Elevating CLI output into native timeline cards
  (Codex app-server, Claude Code stream-json/hooks) is the recorded end-state
  path, not this round.
- **No stdin bridge** from the product composer into the CLI.
- **Worktree terminals are excluded** from external accounting v1: a terminal
  opened via `terminal.create { taskId }` lives in another task's isolated
  worktree; sessions there get detection UI but no accounting task (the
  mount ownership question needs its own design).
- **One active external session per terminal**; a second agent started while
  one session's task is still open starts a new task.
- Rendering hygiene for embedded TUIs (`CLAUDE_CODE_NO_FLICKER`-class env
  injection, xterm 7 upgrade) is tracked as polish, not a gate here.

## Consequences

- New IPC surface (versioned): `external.listSessions`, events
  `terminal.agentState`, `external.sessionChanged`.
- `tasks` table gains a nullable `external_json` column (migration).
  `startTask`/reply guard against dispatching an agent run at external tasks.
- ChangeService gains `ensureBaselineFromBytes` (capture a baseline from
  provided bytes instead of disk) — no behavior change for existing callers.
- GitService gains `snapshotTree()`/`readTreeBlob()` (temp-index write-tree).
- The task list, mission control and notifications treat external tasks as
  ordinary tasks (EXT-labelled); E2E covers the full lifecycle with a fake
  agent CLI driven through the real PTY.

## Amendment (2026-07-15) — detection fallback widened

Field failure: the native claude installer links `~/.local/bin/claude` to a
version-named binary (`…/versions/2.1.209`). The kernel short name node-pty
reports as the foreground title is therefore `2.1.209` — never `claude` — and
the original interpreter-gated descendant scan (node/bun/…) never ran, so
real sessions were invisible.

Detection rule now: when the foreground title misses the CLI list, fall back
to an argv scan of the process tree below the shell **unless** the title is a
shell (known shell names or the session's own shell) — i.e. the terminal is
idle at a prompt. This covers interpreters, version-named installer binaries
and wrapper scripts for every CLI on the list (claude and codex alike). Cost
is bounded: at most one `ps -ax` snapshot per 700 ms tick, shared across all
terminals via `readProcessTable`/`findAgentInTable`, and none while terminals
sit at their prompts.

Recorded boundary: a non-exec shell-script wrapper keeps a shell comm and is
still missed while its title reads as a shell; real installers exec or use
shebangs, so this is accepted. E2E covers the version-named shape with a real
binary (`fakeclaude → versions/9.9.9`) driven on a real PTY. Fixture note
(2026-07-15): the fixture binary is a copy of the running node executable —
the earlier `/bin/zsh` copy never executed (macOS AMFI SIGKILLs copies of
Apple platform binaries), which had silently voided that E2E.

## Amendment 2 (2026-07-15) — 决策 4 revised: decorate in place, promote on intent

Field failure: the automatic promotion shipped unusable — typing `claude` in
the dock yanked the terminal into a 350px column ~700 ms later, and because
xterm 6's `open()` only attaches on the FIRST call (re-open is a no-op that
never re-parents `term.element`), the promoted panel came up EMPTY: the TUI
invisible, keystrokes going nowhere. The same broken re-mount pattern
(`host.innerHTML=''; term.open(host)`) also blanked dock tab switching
(A→B→A), the Home⇄Editor round-trip, and the return-to-dock path
(`active=null`). `external-cli.spec.ts` asserted the moved scrollback and was
red at HEAD — the feature was committed against a failing gate.

Design verdict (product owner approved the redesign via
`docs/design/external-cli-attach-redesign.html`, an interactive film of the
full flow): the approved END STATE stands (side column, changes strip, room,
review); the detection-triggered TRANSITION was the flaw — it moved the
surface the user was typing into, hung a layout mutation on a weak heuristic
signal, sized the column below the TUI's 80-column floor, and offered no way
to decline or undo.

Decision 4 now reads:

1. **Detection only decorates.** Tab badge `✳ <cli> EXT`, a 34 px session bar
   at the top of the terminal pane (snapshot chip, live file counter, ⤢ Room,
   ⇥ Move to side panel), one toast, tree-row badges. Zero layout change,
   zero focus movement. Signal flap can only flicker decoration, never
   layout.
2. **Placement is user intent.** "Move to side panel" (600 px default,
   resizable 480–900, ≥80 columns) and "⤢ Room" are clicks on the bar;
   "⇤ Return to dock" undoes the move at any time. The pref
   `terminal.autoPromoteExternal` (default **off**) restores auto-move for
   those who want it.
3. **Session end moves nothing.** The bar/panel header flip to an ended state
   with a Review entry; the terminal stays where the user put it. The task
   still lands in REVIEW_READY (unchanged).
4. **Substrate: `mountTerminal(host, item)`** — first mount `open()`, every
   re-mount moves the live `term.element` (`replaceChildren`) + fit + refresh
   + focus. Used by the dock, the side panel and the room; fixes the four
   blank-pane paths above. E2E now types INTO the promoted terminal and
   asserts the PTY echo, plus tab-switch / surface round-trip / return
   regressions (`terminal-remount.spec.ts`).
