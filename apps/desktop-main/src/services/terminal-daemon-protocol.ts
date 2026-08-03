import { StringDecoder } from 'node:string_decoder';

export const TERMINAL_DAEMON_PROTOCOL_VERSION = 1;
export const TERMINAL_DAEMON_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export interface DaemonTerminalMetadata {
  id: string;
  title: string;
  shell: string;
  cwd: string;
  projectName: string;
  projectPath: string | null;
  contextKind: 'focused' | 'recent' | 'task' | 'scratch';
  contextLabel: string;
  contextTaskId: string | null;
  launch: string;
}

export interface DaemonTerminalSnapshot {
  info: DaemonTerminalMetadata;
  pid: number;
  processTitle: string;
  hasChildren: boolean;
  sequence: number;
  replay: string;
  /** Added compatibly so a restored headless VT model uses the PTY's real grid. */
  cols?: number;
  rows?: number;
}

export type TerminalDaemonRequest =
  | { requestId: string; type: 'hello'; token: string; version: number }
  | { requestId: string; type: 'list'; includeReplay?: boolean }
  | { requestId: string; type: 'snapshot'; id: string }
  | {
      requestId: string;
      type: 'spawn';
      info: DaemonTerminalMetadata;
      executable: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
      cols: number;
      rows: number;
      scrollback: number;
    }
  | { requestId: string; type: 'updateMetadata'; info: DaemonTerminalMetadata }
  | { requestId: string; type: 'write'; id: string; data: string }
  | { requestId: string; type: 'resize'; id: string; cols: number; rows: number }
  | { requestId: string; type: 'kill'; id: string }
  | { requestId: string; type: 'shutdownIfIdle' };

export type TerminalDaemonRequestInput = TerminalDaemonRequest extends infer Request
  ? Request extends { requestId: string }
    ? Omit<Request, 'requestId'>
    : never
  : never;

export type TerminalDaemonEvent =
  | { type: 'response'; requestId: string; ok: true; result?: unknown }
  | { type: 'response'; requestId: string; ok: false; error: string }
  | { type: 'data'; id: string; sequence: number; data: string }
  | { type: 'exit'; id: string; exitCode: number }
  | {
      type: 'status';
      id: string;
      pid: number;
      processTitle: string;
      hasChildren: boolean;
    };

export function encodeDaemonMessage(message: TerminalDaemonRequest | TerminalDaemonEvent): string {
  return `${JSON.stringify(message)}\n`;
}

export class DaemonMessageDecoder<T> {
  private buffer = '';
  private readonly utf8 = new StringDecoder('utf8');

  push(chunk: Buffer | string): T[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.utf8.write(chunk);
    if (Buffer.byteLength(this.buffer, 'utf8') > TERMINAL_DAEMON_MAX_MESSAGE_BYTES) {
      throw new Error('Terminal daemon message exceeded the protocol limit.');
    }
    const messages: T[] = [];
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      messages.push(JSON.parse(line) as T);
    }
    return messages;
  }
}
