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
export function createSshTerminalBackend(session: ShellSession): TerminalBackend {
  let closed = false;
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
        closed = true;
        // A channel that died with the transport reports null; surface -1 so the
        // renderer prints an exit line just like a killed local PTY.
        cb(code ?? -1);
      }),
  };
}

/** Single-quote a POSIX shell argument so a remote workdir can't be injected. */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The keystrokes that start a remote CLI in an already-open login shell.
 * `exec` replaces the shell so the CLI owns the channel — quitting it ends the
 * session, matching the local direct-launch semantics (knownAgent-until-exit).
 */
export function remoteLaunchSequence(cli: string, remoteWorkdir: string | null): string {
  const cd = remoteWorkdir ? `cd -- ${shellSingleQuote(remoteWorkdir)} && ` : '';
  return `${cd}exec ${cli}\r`;
}
