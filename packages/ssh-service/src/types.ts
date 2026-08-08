/** Shared types for the SSH service (ADR-0047). Plain TS — no zod, no Electron. */

export type SshConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export type SshAuthMethod = 'agent' | 'key' | 'password';

/** Everything the connection manager needs to reach one host. Assembled by
 * desktop-main from settings.ssh; never contains secret material. */
export interface SshTargetConfig {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  auth: SshAuthMethod;
  identityFile: string | null;
  keepaliveSeconds: number;
  autoReconnect: boolean;
  /** Single-hop jump spec ("alias" or "user@host[:port]"); resolution is
   * injected by the embedder so the host book stays out of this package. */
  proxyJump?: string | null;
}

// ---------------------------------------------------------------------------
// Host keys

export type HostKeyStatus = 'trusted' | 'unknown' | 'mismatch';

export interface HostKeyCheck {
  status: HostKeyStatus;
  /** OpenSSH-style "SHA256:<base64>" fingerprint of the presented key. */
  fingerprintSha256: string;
  keyType: string;
  /** The fingerprint we previously trusted, when status is 'mismatch'. */
  knownFingerprint: string | null;
}

export interface HostKeyStore {
  check(host: string, port: number, keyBlob: Buffer): HostKeyCheck;
  /** Persist a TOFU acceptance into the product trust store. */
  remember(host: string, port: number, keyBlob: Buffer): void;
  /** Drop a trusted entry (mismatch recovery is delete-then-reverify). */
  forget(host: string, port: number): void;
}

// ---------------------------------------------------------------------------
// Interactive bridges (implemented by desktop-main, driven by renderer modals)

export interface HostKeyDecision {
  accept: boolean;
  remember: boolean;
}

export interface AuthAnswer {
  answers: string[];
  /** Persist a password/passphrase answer to the keychain vault. */
  save: boolean;
}

export interface SshPromptBridge {
  hostKey(req: {
    hostId: string;
    host: string;
    port: number;
    keyType: string;
    fingerprintSha256: string;
    status: 'unknown' | 'mismatch';
    knownFingerprint: string | null;
  }): Promise<HostKeyDecision>;
  /** null = user cancelled. */
  auth(req: {
    hostId: string;
    kind: 'password' | 'passphrase' | 'keyboard-interactive';
    prompts: Array<{ prompt: string; echo: boolean }>;
  }): Promise<AuthAnswer | null>;
}

export interface SshSecretsProvider {
  password(hostId: string): Promise<string | null>;
  passphrase(hostId: string): Promise<string | null>;
  /** Called when the user ticked "save" on an interactive prompt. */
  store(hostId: string, kind: 'password' | 'passphrase', value: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Sessions

export interface ShellSessionOptions {
  cols: number;
  rows: number;
  term?: string;
}

export interface ShellSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  onData(cb: (data: string) => void): void;
  /** exitCode is null when the channel died with the transport. */
  onClose(cb: (exitCode: number | null) => void): void;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface SshConnectionSnapshot {
  state: SshConnectionState;
  sessions: number;
  error: string | null;
}

// ---------------------------------------------------------------------------
// SFTP (PR2)

export type SftpEntryType = 'file' | 'dir' | 'symlink' | 'other';

export interface SftpFileEntry {
  name: string;
  type: SftpEntryType;
  /** For symlinks that resolve to a directory the type is 'dir' and this flags
   * the indirection so the UI can still mark it. */
  symlink: boolean;
  size: number;
  mtimeMs: number | null;
  mode: number;
}

export interface SftpTransferOptions {
  onProgress?: (doneBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

/** One SFTP channel on an established connection. All byte streams stay in the
 * main process — the renderer only ever sees paths and progress numbers. */
export interface SftpSession {
  realpath(path: string): Promise<string>;
  list(path: string): Promise<SftpFileEntry[]>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Unlink a file (directories go through rmdir). */
  delete(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  stat(path: string): Promise<{ type: SftpEntryType; size: number }>;
  upload(localPath: string, remotePath: string, opts?: SftpTransferOptions): Promise<void>;
  download(remotePath: string, localPath: string, opts?: SftpTransferOptions): Promise<void>;
  close(): void;
  onClose(cb: () => void): void;
}

// ---------------------------------------------------------------------------
// ~/.ssh/config import

export interface SshConfigEntry {
  alias: string;
  host: string;
  port: number;
  username: string | null;
  identityFile: string | null;
  proxyJump: string | null;
}

export interface SshConfigParseResult {
  hosts: SshConfigEntry[];
  /** Unsupported directives we skipped (Include, Match, …) — surfaced in the UI. */
  warnings: string[];
}
