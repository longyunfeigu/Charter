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

## Amendment 3 (2026-07-15) — ended sessions resume through the external CLI

Field failure: the Task Room showed the managed-runtime `Resume` action for an
ended external Task. That action called `task.start`; the host correctly rejects
external Tasks (`TASK_EXTERNAL`), so the button could never continue Claude or
Codex. A second routing defect made Terminal → Room change the visible route
without binding the room's Task as `activeTaskId`, turning some clicks into a
silent no-op. After an application restart, startup ordering made the mismatch
more visible: orphan recovery first marked the Task INTERRUPTED, while external
recovery only closed Tasks still in IN_PROGRESS.

Decision:

1. External metadata records the CLI working directory. Resume reuses the live
   source terminal when it still exists; otherwise it creates a terminal in the
   recorded cwd (legacy rows fall back to the project root).
2. The host, not renderer input, owns the complete executable command map:
   Claude Code uses `claude --continue`; Codex uses `codex resume --last`.
   Custom detected CLI names have no Resume action, avoiding shell injection and
   false promises for tools whose continuation semantics are unknown.
3. Resume keeps the existing external Task, snapshot baseline and change set.
   The Task returns to IN_PROGRESS only for that continuation, and the RPC does
   not report success until foreground-process detection confirms the expected
   CLI. Failure or a 12-second detection timeout returns the Task to
   REVIEW_READY with an actionable error.
4. Restart recovery closes active external Tasks from IN_PROGRESS, INTERRUPTED
   or FAILED into REVIEW_READY. It also repairs historical split-brain rows
   whose external status is already ended while the Task remains IN_PROGRESS,
   INTERRUPTED or FAILED. Terminal/Room actions carry the explicit Task id; the
   room route also synchronizes active Task state for all other controls.

This continues the CLI's latest conversation for the recorded working
directory—the strongest native identity available without transcript/session
database parsing, which remains outside v1's explicit boundary. Same-terminal
immediate continuation is therefore the original just-ended conversation;
after a long gap, the CLI's own current-directory ordering remains authoritative.

## Amendment 4 (2026-07-15) — promoted-panel resize is a real splitter

Field failure: the editor/session boundary looked draggable but exposed only a
5px hit target inside the panel. It was difficult to acquire on a dense
Monaco-minimap boundary, and the implementation listened for bubbling window
`mousemove` events; Monaco or xterm could consume movement after the pointer
crossed into either surface. Users reasonably experienced the divider as a
decorative line that did not move.

Decision: the separator has a 12px invisible hit target, an explicit hover,
keyboard-focus and active-drag line, and Pointer Capture for the entire drag.
While active, the application holds the column-resize cursor and suppresses
accidental text selection. Width remains clamped to 480–900px. The separator
also exposes vertical orientation and min/max/current ARIA values; Left/Right
resize by 16px and Home/End select the bounds. E2E measures the hit box, drags
100px across Monaco/xterm, asserts the rendered panel width changed, and then
checks keyboard resize before continuing the live PTY/session-room flow.

## Amendment 5 (2026-07-15) — promoted external sessions own a single right rail

Field failure: the promoted Claude/Codex terminal opened beside the generic
managed-task Agent Panel. The latter exposed Stop, Replay, +Task and a guidance
composer, but an external CLI has no managed AgentHost run or composer-to-stdin
bridge behind those controls. The result was two competing right rails, less
space for the TUI, and controls that looked relevant to Claude while operating
on a different task model or doing nothing.

Decision: right-rail placement is exclusive. Moving an external session to the
side panel records whether the generic Agent Panel was visible and collapses it.
While the external session remains promoted, rendering also rejects a second
Agent Panel even if its global toggle command is invoked. Return to dock,
terminal close, and workspace change leave the exclusive placement through the
same unpromote path and restore the prior layout; a panel that was already
hidden is not forced open. Managed tasks keep the existing Agent Panel when no
external terminal is promoted.

This is layout ownership only. External session accounting, session end,
Resume, Review, Task Room, terminal lifetime and the unmanaged security boundary
are unchanged.

## Amendment 6 (2026-07-15) — session replay evidence and A–E projections

The original replay treated a session as a short sequence of managed-agent
actions. That model could not honestly represent a 30-minute run, an external
Claude/Codex terminal, or non-coding work spanning tools and applications.

Decision:

1. Replay is a projection of the existing `task_events` ledger and
   content-addressed blobs, not a second transcript database. Pi managed runs
   are `full`; recognized Claude/Codex JSON event streams are `structured`;
   ordinary interactive terminal sessions are `observed`.
2. The external-session host persists bounded, redacted PTY observations and
   every observed file version. File events carry a change id plus before/after
   hashes, so replay can reconstruct intermediate versions instead of showing
   only the final net diff. PTY replay is capped at 2 MiB per session; file and
   structured evidence continue after that cap.
3. All five views read the same normalized events and evidence. A is the
   default cinematic entry; D is the long-task detail view; E is the approval
   and audit view; B and C are advanced observable-causality and cross-app
   projections. The scrubber uses real event timestamps and supports 1–16×
   playback.
4. Capability is explicit in the UI. Observed sessions never claim hidden
   reasoning, decisions are visually uncertain unless backed by an observable
   event, and application/resource relationships appear only when recorded by
   the source. Structured provider envelopes are parsed before terminal
   persistence; only observable summaries are retained, while `thinking`,
   `redacted_thinking`, reasoning items and partial private JSON are discarded.
5. Replay is available from both managed-agent and external Task Rooms. The
   same source/capture-grade labels and evidence links survive in A–E, so a
   visually richer projection cannot silently strengthen the underlying claim.

No schema migration is required: the ledger and blob store already provide the
durable substrate, and `captureGrade` is optional external-session metadata.
The honest limits are deliberate: bytes printed before foreground-process
detection may be unavailable; historical changes created before content blobs
were retained can expose hashes/patches but not both complete file versions;
and a plain third-party TUI cannot expose private reasoning or semantic
cross-application state. A future first-party app-server/hook launcher may
upgrade those sessions to structured capture, but replay must never infer it.

## Amendment 7 (2026-07-15) — terminal contexts and the reversible focus slot

Field failure: terminal placement and project ownership were coupled to the
currently focused editor workspace. Switching projects could dispose a useful
Claude/Codex PTY or silently redirect its accounting, while the right rail
looked like a Claude-only destination. Requiring every terminal to choose an
editor directory also made unrelated concurrent work awkward.

Decision:

1. The Bottom Panel remains the terminal home. Every terminal stays in its
   session list even while its live xterm is mounted in the right rail, and the
   row exposes `IN SIDE` plus a one-click return path.
2. The right rail is one reversible focus slot, not an agent provider. Shell,
   Claude Code and Codex terminals may enter it. Moving a second terminal there
   atomically swaps the two existing xterms; terminal ids, processes, scrollback
   and external-session accounting are preserved.
3. Terminal creation selects two independent values: launch type (Shell,
   Claude Code or Codex) and working context (focused project, recent project,
   Task/worktree or isolated scratch directory). The host resolves every
   context to a validated cwd and owns the fixed executable map; the renderer
   never submits an arbitrary cwd or command string.
4. A terminal's project/task identity is immutable for its lifetime. Editor
   focus changes do not kill terminals or move their file watcher/accounting
   root. Scratch terminals have no project accounting; Task terminals inherit
   the Task worktree when present.
5. The quick Terminal command reopens the current terminal home and only
   creates a focused Shell when none exists. The split New Terminal control
   keeps one-click focused Shell creation while its menu opens the full
   type/context chooser.

The layout continues Amendment 5's exclusive right-rail ownership: promoting
an external terminal temporarily suppresses the generic Agent Panel, and the
prior panel state returns when the focus slot is cleared.

## Amendment 8 (2026-07-15) — Replay V3: one story, three depths

Amendment 6 established the evidence substrate and shipped A–E as five peer
projections. Field review (`docs/design/session-replay-unified-experience-v3.md`)
concluded that A–E exposed the design exploration as navigation, that numeric
"confidence" percentages were indefensible heuristics, and that one
session-level capture badge silently upgraded mixed evidence.

Decision (supersedes Amendment 6 points 3 and 5; the substrate in points 1–2
and 4 is unchanged):

1. Replay presents **three depths of one position — Recap, Explore, Verify —**
   instead of five peer modes. A's stage and chapters live in Recap, D's dense
   list in Explore, E's evidence table in Verify. B survives only as explicit
   id-backed relation links; C survives as application lanes and filters.
   Depth changes never reset the task, playhead, selected fact or evidence.
2. The default frame is **result-first**: session contract (original goal,
   outcome, verification state, measured coverage), a deterministic result
   card with citations, and no autoplay. `REVIEW_READY` renders as "Agent
   finished, awaiting review", never as an approved result.
3. Evidence language is categorical and per fact: Verified (successful
   verification / checkable receipt), Recorded (structured ledger event),
   Observed (PTY/FS observation), Inferred (cited narrative), Missing.
   Numeric confidence is removed product-wide. Coverage is a measured
   percentage over intervals and is always labeled coverage.
4. The timeline carries both **Story Time** (repetition grouped, idle folded,
   mandatory facts — failures, denials, approvals, high risk, material
   changes, verification, final result — never skipped) and **Real Time**
   (actual wall-clock gaps). Switching projections keeps the selected fact.
5. Relations render only from recorded ids (`callId`, `requestId`,
   `file_changes.tool_call_id`, provider-emitted parents). Temporal adjacency
   never draws an edge; missing semantics degrade to "surrounding context".
6. The projection engine (`packages/ipc-contracts/src/replay.ts`) is pure and
   shared between the renderer and the main-process ReplayService, and entry
   is an explicit `ReplayRequest { taskId, depth, anchor, liveFollow }` bound
   to the requested task, not to the active-task pointer.

The A–E testids and screens are removed; regression coverage moved to
`tests/e2e/replay-v3.spec.ts` plus the adapted external-CLI and P2 suites.

## Amendment (2026-07-16) — per-session conversation ids and terminal ownership

Field report (acceptance walk of the grouped rail): three sequential Claude
sessions in one terminal produced three accounting tasks whose rooms all
re-parented the same live PTY — clicking session 1/2/3 in the rail showed one
identical center column. And resume was written as `claude --continue` /
`codex resume --last`, which continues the *directory's most recent*
conversation — wrong the moment a directory hosts more than one session.

Two decisions, both engine-level (rail unchanged):

1. **Terminal ownership.** One PTY hosts many sequential sessions; only the
   owning task's room may re-parent it. Ownership is the renderer's existing
   `taskByTerminal` projection: the live session owns its terminal, an ended
   session keeps it until a newer session takes the PTY over. Superseded rooms
   render their own record (changed files, review affordances) with an honest
   "its terminal moved on to a newer session" note instead of someone else's
   conversation.
2. **Conversation ids.** `TaskExternalSchema` gains `sessionId`. Capture is
   layered: structured streams record it the moment Claude's `system/init` /
   `result` events reveal `session_id`; observed (interactive TUI) sessions
   discover it at session end from the CLI's own transcript store, bounded by
   the session's lifetime — Claude `~/.claude/projects/<munged cwd>/<uuid>.jsonl`
   (munge = every non-alphanumeric → `-`, verified against real installs),
   Codex `~/.codex/sessions/YYYY/MM/DD/rollout-…-<uuid>.jsonl`. A startup
   backfill gives recent pre-amendment tasks their ids the same way. Resume
   targets the exact conversation (`claude --resume <id>` /
   `codex resume <id>`); only strict UUIDs are ever written into a PTY, and a
   missing id degrades to the old most-recent flag. Resuming forks a fresh CLI
   conversation, so the id is re-established at the next session end.

Honest limits: discovery is best-effort mtime-window matching (no id when the
CLI wrote no transcript — e.g. the e2e fake agents); two sessions ending inside
the same window could mis-attribute (not observed in practice; the window is
one session's lifetime); custom CLIs still have no resume command at all.

## Amendment (2026-07-19) — launch intents: pre-assigned ids, host-delivered first prompt, honest end state

Field report (user test drive, three defects in one flow): ① composer-launched
Claude sessions were listed as `Session <id>` instead of what the user asked;
② the composer's first message appeared inside Claude's input box but was
never sent — the renderer blind-wrote `paste + \r` 350 ms after create, racing
the TUI startup (early: the escapes echo as garbage; late enough to paste but
the CR inside the paste chunk reads as pasted text, so the message just sits
there); ③ resume ran `claude --continue` and failed with "No conversation
found" — the aborted first message meant no transcript ever existed, so
discovery had nothing to find, and the ended session read as green "Answered".

Decisions:

1. **Launch intents.** `terminal.create` (v3) accepts `initialPrompt`. Product
   launches register a one-shot, TTL-bounded intent (`ExternalLaunchIntents`)
   keyed by terminal: the CLI, a pre-assigned conversation id, and the prompt.
   `ExternalSessionService` consumes it on the detection edge — an aborted
   launch can never leak a prompt or id into a later session on that terminal.
2. **Pre-assigned conversation ids.** Claude launches run
   `claude --session-id <uuid>` (host-generated, strict-UUID-guarded like every
   PTY-written id). The task is resumable by exact id from its first moment —
   no transcript discovery needed on the golden path. Codex has no equivalent
   flag and keeps rollout discovery. Correction to the 2026-07-16 amendment:
   `claude --resume <id>` continues the SAME conversation id (no fork unless
   `--fork-session`), so resume now seeds the live session with the recorded id
   instead of re-discovering it.
3. **Host-delivered first prompt.** The renderer never writes launch PTY bytes.
   The main process delivers the prompt after the TUI's first paint settles
   (600 ms quiet, 8 s deadline), as a bracketed paste followed by a *separate*
   Enter write (`sendMessage` now does the same). The delivery records the
   same `user.message` ledger event as in-room sends.
4. **Sessions are named by the user.** The external task title is the first
   user message (composer prompt at creation; first in-room send as fallback),
   exactly like Pi sessions. `Session <id>` remains only for hand-typed
   sessions that never received a product-path message.
5. **Ended, not Answered.** A zero-change external session that exits presents
   as "Session ended" (rail badge `Ended`, neutral tone) across rail, room
   dock, timeline milestone and completion notice. "Answered" remains the
   Pi-run veneer; external REVIEW_READY with changes keeps the review weight.

Honest limits: a session whose only message was never submitted (pre-fix
strandings) still has no transcript — resume by id then fails inside the CLI
itself, same end state as `--continue`, now with a precise cause. Hand-typed
first messages are not captured for titles (keystroke reconstruction is not
attempted; transcripts are read for names/mtimes only, never content).
First-run TUI dialogs (claude folder trust, codex onboarding) can swallow the
delivered prompt — the Enter may answer the dialog instead; the message is in
the ledger but must be retyped in that rare case (observed-grade capture
cannot distinguish a dialog from a ready input box). Real-CLI verification
(claude 2.1.214): `--session-id <uuid>` names the transcript exactly
`<uuid>.jsonl` under the realpath-munged project dir, and `--resume <uuid>`
continues it; print-mode (`-p`) resumes fork a new transcript id, interactive
resumes keep it — the product path is interactive.

## Amendment (2026-07-19, second) — PTY environment hygiene; reply notices name the message they answer

Field report, same test drive: resume STILL failed ("No conversation found
with session ID …") even though the launch carried `--session-id`. Root cause
established by controlled PTY experiments on the user's machine: the Charter
dev app had been started from inside a Claude Code session, so the Electron
process — and therefore every Charter PTY — inherited that session's markers
(`CLAUDECODE=1`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`,
`CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_PID`, …). An interactive claude that sees
those markers treats itself as a nested/child agent session and writes NO
transcript at all (print mode still writes one, which is why the earlier
`-p` verification passed). No transcript → nothing to resume, by any flag.

Decision: user terminals get a sanitized environment.
`sanitizedTerminalEnv()` in terminal-service strips ambient agent-session
markers (prefix `CLAUDE*` minus an explicit `CLAUDE_CONFIG_DIR` allowlist,
plus `AI_AGENT`, `CODEX_SANDBOX`) from the PTY env. Deliberate configuration
(`ANTHROPIC_*` auth/base-url, `CLAUDE_CONFIG_DIR`) passes through, and
anything a user exports in their own shell profile is restored by the login
shell the PTY spawns. Verified on the user's machine: with markers stripped,
the same interactive session writes its transcript LIVE (during the session,
not at exit) under exactly the pre-assigned `--session-id` uuid.

Also in this amendment, two reply-notice fixes from the same session:

1. **Notices name the message they answer.** The reply banner titled itself
   with the session title (the FIRST message — "hi") even when the settled
   reply answered "who are you". Sessions now track the last submitted user
   line: product-path sends record their exact text; TUI-typed input is
   reconstructed best-effort from raw PTY bytes (`TypedLineTracker`:
   printables, backspace, kill-line, bracketed paste; escape sequences
   skipped) — notification copy only, never Replay evidence or a persisted
   message. `external.turn` / `external.activitySettled` (v2) carry
   `lastUserMessage`; the renderer titles the notice with it and falls back
   to the session title when unknown. Product-owned PTY writes (prompt
   injection, resume command) are invisible to the tracker.
2. **Settle window 1.8s → 1s.** Interactive TUIs animate a spinner while
   working, so output only goes quiet when the reply is really done; 1.8s of
   mandatory quiet read as "the notification lags the agent".
