import type { ShellSession } from '@pi-ide/ssh-service';
import type { TerminalBackend } from '@pi-ide/terminal-service';

/**
 * Adapts an ssh2 shell channel to the TerminalManager backend contract
 * (ADR-0047), so a remote session reuses the entire local terminal pipeline
 * (terminal.data/write/resize/exit, rail, SessionTerminalView).
 *
 * processTitle() returns null so the agent-detection poll skips it — remote
 * foreground processes are invisible to the local `ps` snapshot. Remote
 * Agent sessions light up instead via an explicit canonical knownAgent marker
 * at adopt time (the manifest command is started with `exec`, so it owns the
 * channel to exit).
 */
export function createSshTerminalBackend(
  session: ShellSession,
  options: { beforeExit?: () => Promise<void> } = {},
): TerminalBackend {
  let closed = false;
  let exitDelivered = false;
  return {
    write: (data) => session.write(data),
    resize: (cols, rows) => session.resize(cols, rows),
    kill: () => {
      if (closed) return;
      closed = true;
      session.close();
    },
    hasChildren: () => false,
    processTitle: () => null,
    onData: (cb) => session.onData(cb),
    onExit: (cb) =>
      session.onClose((code) => {
        if (exitDelivered) return;
        exitDelivered = true;
        closed = true;
        // Final Worker reconciliation is the correctness boundary: wait for it
        // before TerminalManager emits the agent-exit edge and closes Review.
        void Promise.resolve(options.beforeExit?.())
          .catch(() => {})
          .finally(() => {
            // A channel that died with the transport reports null; surface -1
            // so the renderer prints an exit line like a killed local PTY.
            cb(code ?? -1);
          });
      }),
  };
}

/** Single-quote a POSIX shell argument so a remote workdir can't be injected. */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Probe a CLI through the same user shell environment as an interactive SSH
 * terminal. The direct lookup keeps ordinary system installs fast; the login
 * and interactive fallbacks load profile-managed PATH entries such as NVM.
 */
export function remoteCliProbeCommand(cli: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(cli)) {
    throw new Error('Remote CLI name contains unsupported characters');
  }
  const lookup = `command -v ${cli}`;
  const quotedLookup = shellSingleQuote(lookup);
  return `if ${lookup} >/dev/null 2>&1; then ${lookup}; elif [ -n "$SHELL" ] && [ -x "$SHELL" ]; then "$SHELL" -l -i -c ${quotedLookup} || "$SHELL" -i -c ${quotedLookup}; else exit 127; fi`;
}

/**
 * ADR-0059 — remote cwd sync. One line typed into a plain remote shell that
 * hooks the prompt (zsh precmd / bash PROMPT_COMMAND) to emit OSC 7
 * (`ESC ]7;file://host/path ESC \`) so the renderer always knows the shell's
 * live working directory (drop-upload target, Files drawer follow).
 *
 * Constraints that shaped it:
 * - It runs in whatever login shell the server gives us, so it must be a
 *   bash/zsh polyglot and degrade to a silent no-op elsewhere (POSIX sh has
 *   neither hook; the guard clauses make the whole line vanish).
 * - It is visibly echoed once at the first prompt — same tradeoff VS Code and
 *   iTerm2 accept for typed integration. The leading space keeps it out of
 *   history on HISTCONTROL/HIST_IGNORE_SPACE setups.
 * - `%s` printf of "$PWD" needs no URL-encoding: the renderer parses our own
 *   emission and splits on the authority's first `/`, so raw paths round-trip.
 */
export function remoteCwdSyncSequence(): string {
  // zsh's array append is a parse error in POSIX shells, and a parse error
  // aborts the whole line before its 2>/dev/null takes effect — so the
  // zsh-only syntax ships inside an eval string that only zsh ever parses.
  const zsh = `__charter_cwd(){ builtin printf '\\e]7;file://%s%s\\e\\\\' "$HOST" "$PWD"; }; eval 'precmd_functions+=(__charter_cwd)'; __charter_cwd`;
  const bash = `__charter_cwd(){ builtin printf '\\e]7;file://%s%s\\e\\\\' "$HOSTNAME" "$PWD"; }; PROMPT_COMMAND="__charter_cwd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; __charter_cwd`;
  return ` { if [ -n "$ZSH_VERSION" ]; then ${zsh}; elif [ -n "$BASH_VERSION" ]; then ${bash}; fi; } 2>/dev/null\r`;
}

/**
 * The keystrokes that start a remote CLI in an already-open login shell.
 * `exec` replaces the shell so the CLI owns the channel — quitting it ends the
 * session, matching the local direct-launch semantics (knownAgent-until-exit).
 */
export function remoteLaunchSequence(
  cli: string,
  remoteWorkdir: string | null,
  args: readonly string[] = [],
): string {
  const cd = remoteWorkdir ? `cd -- ${shellSingleQuote(remoteWorkdir)} && ` : '';
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(cli)) {
    throw new Error('Remote CLI name contains unsupported characters');
  }
  const argv = args.map((value) => ` ${shellSingleQuote(value)}`).join('');
  return `${cd}exec ${cli}${argv}\r`;
}
