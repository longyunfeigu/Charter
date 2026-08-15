# ADR-0058: Keep the complete Charter runtime alive when its window closes

- Status: Accepted (user decision 2026-08-11: “OK, do it”)
- Date: 2026-08-11
- Related: ADR-0044 (Session orchestration), ADR-0047 (SSH), ADR-0048 (updates),
  ADR-0050 (continuations), `docs/HERDR_FEATURE_ADOPTION_PLAN.md` capability four

## Context

The terminal daemon already owns local PTYs and can replay them after a controlled Main restart.
That does not make a terminal-only daemon a complete background execution system. External Session
file accounting, managed Agent runs, Mission continuations, SSH/SFTP/forwards, notifications, Tool
Gateway identity, and database writes are still owned by Electron Main. Letting Main exit while only
the PTY survives would present an Agent as running while Charter silently stops observing and
accounting for its work.

Before this decision, closing the last window quit the application on Windows/Linux. macOS retained
Main by platform convention, but exposed no explicit choice, background status, or global stop
control.

## Decision

1. **Window close and application quit are separate intents.** While host-owned work is live,
   closing the window asks whether to keep work running, quit and stop everything, or cancel. A
   remembered choice is stored globally as `general.backgroundOnClose`; Settings always exposes a
   way to change it. Unsaved editor blockers force the decision dialog even when destructive quit
   was previously remembered.
2. **Background mode hides the existing window and keeps Electron Main alive.** The renderer,
   database, AgentHost, terminal daemon connection, ExternalSessionService watchers, Mission
   outbox/continuations, SSH transports, notification services, and authenticated control door keep
   the same identities and subscriptions. Reopening shows and focuses that same window rather than
   reconstructing a partial session.
3. **Main owns one background activity projection.** It counts managed Agent runs, live external
   Agent processes, non-Agent terminal child jobs, non-terminal Missions, connected/reconnecting SSH
   hosts, and renderer-owned unsaved blockers. The projection is available through
   `app.getBackgroundActivity` and drives the close decision, update blockers, tray text, and tests.
4. **A tray/menu-bar surface makes invisible work visible.** It shows the current counts, opens
   Charter, stops all running work, or performs a full quit. Stop-all persists Mission cancellation
   through the normal outbox, aborts managed tasks, ends live Agent/terminal jobs, and disconnects
   SSH while leaving Charter usable.
5. **Quit remains the existing ordered teardown.** Command+Q, tray “Quit and stop all,” update
   installation, and remembered destructive close set a real quit intent. Main then resolves gates,
   shuts down orchestration and watchers, closes SSH, terminates daemon-owned PTYs, stops workers,
   and closes the database last.

## Consequences

- Closing the work window can safely free screen space without losing Agent observation, file
  accounting, Mission progression, notifications, or remote connections.
- Background work remains capable of consuming CPU, network, and model tokens; the decision dialog
  says so explicitly and the tray keeps that state inspectable.
- The hidden renderer remains resident. This costs more memory than destroying and reconstructing
  it, but preserves unsaved state and exact Session identity and avoids a second recovery protocol.
- This decision does **not** promise execution after Electron Main exits or the operating system
  logs out/shuts down. Moving the full runtime into an independent service remains a separate,
  materially larger architecture change.

## Verification

- Pure policy tests cover idle close, ask/keep/quit decisions, activity counts, and the unsaved-file
  destructive-choice override.
- Mission service tests prove stop-all persists cancellation for every live Assignment and delivers
  runtime cancellation without shutting the service down.
- A real Electron/PTY test launches a fake Claude process, arms a delayed workspace edit, hides the
  window, observes the file change while hidden, reactivates the same window, verifies terminal
  output and the ChangeSet ledger, and checks framework/console errors. The scenario is repeated
  three times and also renders the Settings control at a narrow desktop viewport.
