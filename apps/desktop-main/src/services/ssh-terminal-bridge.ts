import type { ShellSession } from '@pi-ide/ssh-service';
import type { TerminalBackend } from '@pi-ide/terminal-service';

/**
 * Adapts an ssh2 shell channel to the TerminalManager backend contract
 * (ADR-0047), so a remote session reuses the entire local terminal pipeline
 * (terminal.data/write/resize/exit, rail, SessionTerminalView).
 *
 * processTitle() returns null so the agent-detection poll skips it — remote
 * foreground processes are invisible to the local `ps` snapshot. Remote
 * claude/codex sessions light up instead via an explicit knownAgent marker at
 * adopt time (the CLI is started with `exec`, so it owns the channel to exit).
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
 * The keystrokes that start a remote CLI in an already-open login shell.
 * `exec` replaces the shell so the CLI owns the channel — quitting it ends the
 * session, matching the local direct-launch semantics (knownAgent-until-exit).
 */
export function remoteLaunchSequence(
  cli: string,
  remoteWorkdir: string | null,
  initialPrompt: string | null = null,
): string {
  const cd = remoteWorkdir ? `cd -- ${shellSingleQuote(remoteWorkdir)} && ` : '';
  // Claude Code and Codex both accept the first interactive prompt as a
  // positional argument. Remote sessions cannot reuse the local process
  // detector's deferred composer handshake, so deliver the prompt atomically
  // with the trusted launch instead of racing blind PTY writes after startup.
  const prompt = initialPrompt?.trim() ? ` ${shellSingleQuote(initialPrompt.trim())}` : '';
  return `${cd}exec ${cli}${prompt}\r`;
}
