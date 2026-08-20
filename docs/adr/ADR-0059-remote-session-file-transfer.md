# ADR-0059: Remote file transfer lives in the session — drop-to-upload, Files drawer, OSC 7 cwd sync

- Status: Accepted
- Date: 2026-08-20
- Relates to: ADR-0047 (SSH Remotes; SFTP pipeline and dual-pane Files panel,
  both unchanged), ADR-0021 (local shell integration via host-owned rc files —
  the remote variant here deliberately uses a different mechanism)

## Context

Sending a file to a connected SSH host required leaving the session: Remote
Explorer → pick the host → Files tab → find the directory — five steps away
from the terminal the user is already looking at (user acceptance feedback,
2026-08-20: "路径太长"). Every mainstream SSH tool solves this with
"the terminal is the drop target" (iTerm2, XShell, SecureCRT, Termius) plus a
follow-the-shell file sidebar (FinalShell, WindTerm).

Two facts shaped the design:

1. **The transfer pipeline already existed and was entry-limited, not
   capability-limited.** `SshSftpService` (ADR-0047 PR2) streams bytes
   fs↔sftp inside the main process with progress, cancel and retry; the
   renderer only ever sees names and numbers. Nothing new crosses IPC.
2. **"Upload to the current directory" needs the current directory.** A
   remote session's `cwd` was the static host-set context (managed root /
   `remoteWorkdir` / `~`); Charter never learned about a `cd`. Local
   terminals get semantic marks through spawn-time rc injection (ADR-0021),
   but a remote login shell is spawned by sshd from its own config — there is
   no spawn-time hook to own.

## Decision

1. **Drop = upload, on the whole remote session surface.** OS file drags onto
   a remote `SessionTerminalView` show a veil naming the target
   (`host : live cwd`); release uploads via the existing `ssh.sftpUpload`.
   Modifiers: ⌥ pastes the quoted local path(s) into the terminal instead
   (never presses Enter), ⇧ opens the Files drawer first to pick the target
   directory. A session-local toast shows progress/cancel for just the
   transfers this surface started and, when done, offers "Paste remote path"
   and "Open in Files"; the global Transfer Center keeps aggregating
   everything. SFTP is its own channel — uploads never touch the PTY, so they
   work while a full-screen TUI (claude, htop) owns the terminal.
2. **A Files drawer on the session header.** One remote pane (browse,
   download, upload, drop target) that opens at the live cwd and follows the
   terminal's `cd` by default; pinning stops following and a "Terminal cd →
   follow" chip offers one-click catch-up. Heavy operations (rename, delete,
   dual-pane moves) stay in the Remote Explorer Files panel — the drawer is
   deliberately "look, grab, drop" only. It talks to the same SFTP channels
   and shares the per-host channel cache and idle teardown.
3. **Live cwd via OSC 7, injected as one typed line.** For plain-shell remote
   sessions the host writes one line into the PTY after adoption
   (`remoteCwdSyncSequence`): a bash/zsh polyglot that hooks the prompt
   (zsh `precmd` / bash `PROMPT_COMMAND`, chaining any existing hook) to emit
   `OSC 7 file://host/$PWD`. The renderer parses it in the existing xterm OSC
   handler layer (`parseOsc7Cwd`, next to the OSC 133 block marks) into
   `TermInstance.liveCwd`; the context chip shows the live value with a LIVE
   badge, and drops/drawer target it. Notable properties:
   - zsh-only syntax ships inside an `eval '…'` string: a POSIX shell must be
     able to *parse* the whole line (a parse error aborts before
     `2>/dev/null` applies), verified against real bash/zsh/dash in unit
     tests.
   - The line is echoed once at the first prompt — the same tradeoff VS Code
     and iTerm2 accept for typed integration; the leading space keeps it out
     of history under `HISTCONTROL`/`HIST_IGNORE_SPACE`.
   - `settings.ssh.cwdSync` (default true, settings-file level like the other
     ssh options) disables the injection entirely; everything then falls back
     to the static context cwd, and the drop veil says so by dropping the
     LIVE badge.
   - Agent sessions are not injected: their launch `exec`-replaces the shell,
     and their cwd is the managed root by construction. Fish login shells
     will print one error line (bash/zsh polyglot limit) — turn `cwdSync`
     off; a fish variant is future work.
4. **Untranslated identity, translated chrome.** Paths, host labels and file
   names in the new surfaces carry `data-i18n-ignore`/`.mono` per the i18n
   identifier discipline; all new chrome strings are in the zh-CN catalog.

## Consequences

- The five-step transfer path becomes zero steps (drop) or one (Files
  button), without leaving the session or interrupting a running TUI.
- OSC 7 reports now update `TermInstance.liveCwd` for *any* terminal that
  emits them (local shells with user-configured emitters included) — the
  chip is truthful everywhere, not only over SSH.
- The injected line is visible once in the remote scrollback and lives in
  the shell's execution environment. It defines two names
  (`__charter_cwd`, appended prompt hook), never overwrites existing hooks,
  and sends nothing anywhere — it only prints an escape sequence the
  renderer consumes.
- A cd inside a nested context the prompt never sees (e.g. inside a running
  TUI, or a subshell that exits) does not update — the target is "where the
  next prompt will land", which is the honest contract.
- New unit coverage: `parseOsc7Cwd` (URI forms, encoding, control-byte
  rejection) and `remoteCwdSyncSequence` executed in real bash, zsh and dash
  (emission, PROMPT_COMMAND chaining, silent POSIX no-op).
