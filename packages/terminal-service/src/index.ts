import { spawnSync } from 'node:child_process';
import { newId } from '@pi-ide/foundation';
import type { IPty } from 'node-pty';
import * as nodePty from 'node-pty';

export interface TerminalInfo {
  id: string;
  title: string;
  shell: string;
  pid: number;
  cwd: string;
}

export interface CreateTerminalOptions {
  cwd: string;
  shellPath?: string | null;
  cols?: number;
  rows?: number;
  scrollback?: number;
}

interface Session {
  info: TerminalInfo;
  pty: IPty;
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
  return process.env.SHELL ?? (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

/** True when the shell has live child processes (used for close confirmation, TERM-004). */
export function hasChildProcesses(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    const result = spawnSync('pgrep', ['-P', String(pid)], { timeout: 2000 });
    return result.status === 0 && result.stdout.toString().trim().length > 0;
  } catch {
    return false;
  }
}

/** User terminal sessions (separate security domain from agent commands, TERM-005). */
export class TerminalManager {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly onData: (id: string, data: string) => void,
    private readonly onExit: (id: string, exitCode: number) => void,
  ) {}

  create(options: CreateTerminalOptions): TerminalInfo {
    const shell = options.shellPath || defaultShell();
    const id = newId('term');
    const pty = nodePty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cwd: options.cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<
        string,
        string
      >,
    });
    const info: TerminalInfo = {
      id,
      title: shell.split('/').pop() ?? shell,
      shell,
      pid: pty.pid,
      cwd: options.cwd,
    };
    pty.onData((data) => this.onData(id, data));
    pty.onExit(({ exitCode }) => {
      this.sessions.delete(id);
      this.onExit(id, exitCode);
    });
    this.sessions.set(id, { info, pty });
    return info;
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols < 2 || rows < 1 || cols > 1000 || rows > 500) return;
    try {
      this.sessions.get(id)?.pty.resize(cols, rows);
    } catch {
      // resizing a dying pty is harmless
    }
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map((s) => s.info);
  }

  hasRunningChildren(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    return hasChildProcesses(session.info.pid);
  }

  /** Graceful kill with process-tree escalation (CMD-004/TERM-004). */
  kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const pid = session.info.pid;
    try {
      session.pty.kill();
    } catch {
      // already dead
    }
    if (process.platform !== 'win32') {
      // Escalate to the whole process group if anything survives the HUP.
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // group already gone — expected on the happy path
        }
      }, 1500).unref();
    }
    this.sessions.delete(id);
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.kill(id);
    }
  }
}
