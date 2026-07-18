import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { errorMessage, type Logger } from '@pi-ide/foundation';

export interface PythonDiagnostic {
  message: string;
  severity: number;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  source?: string;
}

export interface PythonLspStatus {
  available: boolean;
  serverPath: string | null;
  running: boolean;
  hint: string;
}

const INSTALL_HINT =
  'Install a Python language server for diagnostics/completion/definition: `pip install python-lsp-server` (pylsp) or `npm i -g pyright`. Then reopen the workspace.';

/** Locate a Python LSP server binary (LSP-003 degradation contract). */
export function findPythonServer(): { path: string; kind: 'pylsp' | 'pyright' } | null {
  const candidates: Array<{ name: string; kind: 'pylsp' | 'pyright' }> = [
    { name: 'pylsp', kind: 'pylsp' },
    { name: 'pyright-langserver', kind: 'pyright' },
  ];
  const dirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    join(process.env.HOME ?? '', '.local/bin'),
  ];
  for (const candidate of candidates) {
    for (const dir of dirs) {
      const full = join(dir, candidate.name);
      if (existsSync(full)) return { path: full, kind: candidate.kind };
    }
    try {
      const which = spawnSync('which', [candidate.name], { timeout: 2000 });
      const out = which.stdout?.toString().trim();
      if (which.status === 0 && out) return { path: out, kind: candidate.kind };
    } catch {
      // ignore
    }
  }
  return null;
}

interface Pending {
  resolve(value: unknown): void;
  reject(reason: Error): void;
}

/**
 * Minimal LSP client over stdio for Python (LSP-001/003). Full-document sync,
 * diagnostics push, completion/hover/definition/symbols requests.
 */
export class PythonLspClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);
  private initialized = false;
  private readonly versions = new Map<string, number>();
  restartCount = 0;

  constructor(
    private readonly serverPath: string,
    private readonly serverKind: 'pylsp' | 'pyright',
    private readonly rootPath: string,
    private readonly onDiagnostics: (path: string, diagnostics: PythonDiagnostic[]) => void,
    private readonly logger: Logger,
    private readonly onCrash: () => void,
  ) {}

  get running(): boolean {
    return this.child !== null && this.initialized;
  }

  async start(): Promise<void> {
    const args = this.serverKind === 'pyright' ? ['--stdio'] : [];
    this.child = spawn(this.serverPath, args, { cwd: this.rootPath });
    this.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on('data', () => undefined);
    this.child.on('exit', (code) => {
      this.logger.warn('python lsp exited', { code });
      this.child = null;
      this.initialized = false;
      for (const pending of this.pending.values()) {
        pending.reject(new Error('language server exited'));
      }
      this.pending.clear();
      this.onCrash();
    });

    const initResult = await this.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(this.rootPath).toString(),
      capabilities: {
        textDocument: {
          synchronization: { didSave: false },
          publishDiagnostics: { relatedInformation: false },
          completion: { completionItem: { snippetSupport: false } },
          hover: { contentFormat: ['markdown', 'plaintext'] },
        },
      },
      workspaceFolders: [{ uri: pathToFileURL(this.rootPath).toString(), name: 'workspace' }],
    });
    void initResult;
    this.notify('initialized', {});
    this.initialized = true;
  }

  private uriFor(relativePath: string): string {
    return pathToFileURL(join(this.rootPath, relativePath)).toString();
  }

  private relFor(uri: string): string {
    try {
      const abs = fileURLToPath(uri);
      return abs.startsWith(this.rootPath) ? abs.slice(this.rootPath.length + 1) : abs;
    } catch {
      return uri;
    }
  }

  didOpen(relativePath: string, content: string): void {
    if (!this.running) return;
    this.versions.set(relativePath, 1);
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri: this.uriFor(relativePath),
        languageId: 'python',
        version: 1,
        text: content,
      },
    });
  }

  didChange(relativePath: string, content: string): void {
    if (!this.running) return;
    if (!this.versions.has(relativePath)) {
      this.didOpen(relativePath, content);
      return;
    }
    const version = (this.versions.get(relativePath) ?? 1) + 1;
    this.versions.set(relativePath, version);
    this.notify('textDocument/didChange', {
      textDocument: { uri: this.uriFor(relativePath), version },
      contentChanges: [{ text: content }],
    });
  }

  didClose(relativePath: string): void {
    if (!this.running) return;
    this.versions.delete(relativePath);
    this.notify('textDocument/didClose', {
      textDocument: { uri: this.uriFor(relativePath) },
    });
  }

  async completion(relativePath: string, line: number, character: number): Promise<unknown> {
    return this.request('textDocument/completion', {
      textDocument: { uri: this.uriFor(relativePath) },
      position: { line, character },
    });
  }

  async hover(relativePath: string, line: number, character: number): Promise<unknown> {
    return this.request('textDocument/hover', {
      textDocument: { uri: this.uriFor(relativePath) },
      position: { line, character },
    });
  }

  async definition(relativePath: string, line: number, character: number): Promise<unknown> {
    const result = await this.request('textDocument/definition', {
      textDocument: { uri: this.uriFor(relativePath) },
      position: { line, character },
    });
    const locations = Array.isArray(result) ? result : result ? [result] : [];
    return locations.map((loc) => {
      const location = loc as {
        uri?: string;
        targetUri?: string;
        range?: unknown;
        targetRange?: unknown;
      };
      return {
        path: this.relFor(location.uri ?? location.targetUri ?? ''),
        range: location.range ?? location.targetRange,
      };
    });
  }

  async symbols(relativePath: string): Promise<unknown> {
    return this.request('textDocument/documentSymbol', {
      textDocument: { uri: this.uriFor(relativePath) },
    });
  }

  async dispose(): Promise<void> {
    if (!this.child) return;
    try {
      await Promise.race([
        this.request('shutdown', null),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
      this.notify('exit', null);
    } catch {
      // force below
    }
    setTimeout(() => {
      try {
        this.child?.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 500).unref();
    this.child = null;
    this.initialized = false;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error('language server not running'));
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`lsp request timeout: ${method}`));
      }, 15000).unref?.();
    });
    this.send({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(message: unknown): void {
    if (!this.child) return;
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private onStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString('utf8');
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(lengthMatch[1]);
      const total = headerEnd + 4 + length;
      if (this.buffer.length < total) return;
      const body = this.buffer.subarray(headerEnd + 4, total).toString('utf8');
      this.buffer = this.buffer.subarray(total);
      try {
        this.handleMessage(JSON.parse(body) as Record<string, unknown>);
      } catch (e) {
        this.logger.warn('lsp message parse failed', {
          error: errorMessage(e),
        });
      }
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(JSON.stringify(message.error).slice(0, 500)));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      const params = message.params as {
        uri: string;
        diagnostics: Array<{
          message: string;
          severity?: number;
          source?: string;
          range: {
            start: { line: number; character: number };
            end: { line: number; character: number };
          };
        }>;
      };
      this.onDiagnostics(
        this.relFor(params.uri),
        params.diagnostics.map((d) => ({
          message: d.message,
          severity: d.severity ?? 1,
          startLine: d.range.start.line,
          startCharacter: d.range.start.character,
          endLine: d.range.end.line,
          endCharacter: d.range.end.character,
          ...(d.source ? { source: d.source } : {}),
        })),
      );
      return;
    }
    if (typeof message.id === 'number' && typeof message.method === 'string') {
      // Server-to-client request (e.g. workspace/configuration): answer with null.
      this.send({ jsonrpc: '2.0', id: message.id, result: null });
    }
  }
}

export { INSTALL_HINT as PYTHON_INSTALL_HINT };
