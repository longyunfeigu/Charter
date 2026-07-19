import {
  errorMessage,
  fuzzyFilter,
  newId,
  productError,
  ProductFailure,
  type Logger,
} from '@pi-ide/foundation';
import { SearchService } from '@pi-ide/search-service';
import { TerminalManager } from '@pi-ide/terminal-service';
import {
  findPythonServer,
  PythonLspClient,
  PYTHON_INSTALL_HINT,
  type PythonLspStatus,
} from '@pi-ide/language-service';
import { randomUUID } from 'node:crypto';
import { registerHandlers } from './router.js';
import type { WorkspaceHost } from '../services/workspace-host.js';
import type { SettingsService } from '../services/settings-service.js';
import type { ExternalLaunchIntents } from '../services/external-launch-intents.js';
import { isSafeCliSessionId } from '../services/cli-session-locator.js';
import { broadcast } from '../broadcast.js';

interface ActiveSearch {
  controller: AbortController;
}

export interface TerminalContextResolution {
  cwd: string;
  projectName: string;
  projectPath: string | null;
  contextKind: 'focused' | 'recent' | 'task' | 'scratch';
  contextLabel: string;
  contextTaskId: string | null;
}

export interface TerminalContextResolvers {
  recent(projectPath: string): TerminalContextResolution | null;
  task(taskId: string): TerminalContextResolution | null;
  scratch(): TerminalContextResolution;
}

/**
 * Product-owned launch map: renderer selects a preset, never shell text.
 * Claude launches carry a pre-assigned conversation id so a later resume can
 * target THIS session deterministically (`claude --resume <id>`) instead of
 * relying on transcript discovery. Only an exact UUID may reach PTY input.
 */
export function terminalLaunchCommand(
  launch: 'shell' | 'claude' | 'codex',
  sessionId?: string | null,
): string | null {
  if (launch === 'claude') {
    return sessionId && isSafeCliSessionId(sessionId)
      ? `claude --session-id ${sessionId}`
      : 'claude';
  }
  if (launch === 'codex') return 'codex';
  return null;
}

export class M4Services {
  private search: SearchService | null = null;
  private fileListCache: { at: number; files: string[] } | null = null;
  private readonly activeSearches = new Map<string, ActiveSearch>();
  private lastSearchId: string | null = null;
  readonly terminals: TerminalManager;
  private python: PythonLspClient | null = null;
  private pythonStatus: PythonLspStatus = {
    available: false,
    serverPath: null,
    running: false,
    hint: PYTHON_INSTALL_HINT,
  };
  private pythonRestarts = 0;

  constructor(
    private readonly host: WorkspaceHost,
    private readonly settings: SettingsService,
    private readonly logger: Logger,
    shellIntegrationDir: string | null = null,
  ) {
    this.terminals = new TerminalManager(
      (id, data) => broadcast('terminal.data', { id, data }),
      (id, exitCode) => broadcast('terminal.exit', { id, exitCode }),
      {
        // ADR-0021: resolved per spawn so a settings flip applies to the next terminal.
        shellIntegration: () => ({
          dir: shellIntegrationDir,
          enabled: this.settings.effective.terminal.shellIntegration,
        }),
      },
    );

    host.onDidChangeWorkspace((ws) => {
      for (const search of this.activeSearches.values()) search.controller.abort();
      this.activeSearches.clear();
      this.fileListCache = null;
      // vNext: terminals are global sessions with their own host-resolved
      // context. Switching the editor lens must not stop their PTYs.
      void this.python?.dispose();
      this.python = null;
      this.pythonRestarts = 0;
      if (ws) {
        this.search = new SearchService(
          ws.canonicalPath,
          this.settings.effective.workspace.ignoreGlobs,
        );
        this.startPython(ws.canonicalPath);
        // Wire python didChange to document store updates.
        ws.documents.onDidChange((doc) => {
          if (doc.relativePath.endsWith('.py') && this.python?.running) {
            this.python.didChange(doc.relativePath, doc.content);
          }
        });
      } else {
        this.search = null;
      }
    });
  }

  private startPython(rootPath: string): void {
    const server = findPythonServer();
    if (!server) {
      this.pythonStatus = {
        available: false,
        serverPath: null,
        running: false,
        hint: PYTHON_INSTALL_HINT,
      };
      return;
    }
    const client = new PythonLspClient(
      server.path,
      server.kind,
      rootPath,
      (path, diagnostics) => broadcast('lsp.pythonDiagnostics', { path, diagnostics }),
      this.logger.child('pylsp'),
      () => {
        this.pythonStatus.running = false;
        // LSP-006: restart with backoff, stop after repeated failures.
        if (this.pythonRestarts < 3 && this.host.current) {
          this.pythonRestarts += 1;
          const delay = 1000 * 2 ** this.pythonRestarts;
          setTimeout(() => {
            if (this.host.current) this.startPython(this.host.current.canonicalPath);
          }, delay).unref();
        } else {
          this.pythonStatus.hint =
            'The Python language server crashed repeatedly and was disabled for this session. Check Diagnostics.';
        }
      },
    );
    this.python = client;
    client
      .start()
      .then(() => {
        this.pythonStatus = {
          available: true,
          serverPath: server.path,
          running: true,
          hint: '',
        };
        this.logger.info('python lsp started', { server: server.path });
      })
      .catch((e) => {
        this.pythonStatus = {
          available: true,
          serverPath: server.path,
          running: false,
          hint: `The Python language server failed to start: ${errorMessage(e)}`,
        };
      });
  }

  get pythonClient(): PythonLspClient | null {
    return this.python;
  }

  getPythonStatus(): PythonLspStatus {
    return { ...this.pythonStatus, running: this.python?.running ?? false };
  }

  mustSearch(): SearchService {
    if (!this.search) {
      throw new ProductFailure(
        productError('WS_NONE_OPEN', { userMessage: 'No workspace is open.' }),
      );
    }
    return this.search;
  }

  async cachedFiles(): Promise<string[]> {
    const now = Date.now();
    if (this.fileListCache && now - this.fileListCache.at < 8000) {
      return this.fileListCache.files;
    }
    const files = await this.mustSearch().listFiles();
    this.fileListCache = { at: now, files };
    return files;
  }

  startTextSearch(options: Parameters<SearchService['textSearch']>[0]): string {
    const search = this.mustSearch();
    // SRCH-003: a new search cancels the previous one.
    if (this.lastSearchId) {
      this.activeSearches.get(this.lastSearchId)?.controller.abort();
    }
    const searchId = newId('search');
    const controller = new AbortController();
    this.activeSearches.set(searchId, { controller });
    this.lastSearchId = searchId;
    void search
      .textSearch(options, controller.signal)
      .then((result) => {
        broadcast('search.results', {
          searchId,
          groups: result.groups,
          done: true,
          truncated: result.truncated,
          cancelled: result.cancelled,
        });
      })
      .catch((e) => {
        this.logger.warn('search failed', { error: errorMessage(e) });
        broadcast('search.results', {
          searchId,
          groups: [],
          done: true,
          truncated: false,
          cancelled: true,
        });
      })
      .finally(() => {
        this.activeSearches.delete(searchId);
      });
    return searchId;
  }

  cancelSearch(searchId: string): boolean {
    const active = this.activeSearches.get(searchId);
    if (!active) return false;
    active.controller.abort();
    return true;
  }

  dispose(): void {
    this.terminals.dispose();
    void this.python?.dispose();
  }
}

export function registerM4Handlers(
  services: M4Services,
  host: WorkspaceHost,
  logger: Logger,
  /** Lazy because TaskService is constructed after handler registration. */
  contextResolvers?: TerminalContextResolvers,
  /** ADR-0017 amendment: launch intents consumed by ExternalSessionService. */
  externalLaunches?: ExternalLaunchIntents,
): void {
  const resolveTerminalContext = (
    requested:
      | { kind: 'focused' }
      | { kind: 'recent'; projectPath: string }
      | { kind: 'task'; taskId: string }
      | { kind: 'scratch' },
  ): TerminalContextResolution => {
    if (requested.kind === 'focused') {
      const ws = host.mustActive();
      return {
        cwd: ws.canonicalPath,
        projectName: ws.displayName,
        projectPath: ws.canonicalPath,
        contextKind: 'focused',
        contextLabel: ws.displayName,
        contextTaskId: null,
      };
    }
    if (requested.kind === 'recent') {
      const recent = contextResolvers?.recent(requested.projectPath) ?? null;
      if (recent) return recent;
      throw new ProductFailure(
        productError('TERMINAL_CONTEXT_UNKNOWN', {
          userMessage: 'That recent project is no longer available. Refresh and try again.',
        }),
      );
    }
    if (requested.kind === 'task') {
      const taskContext = contextResolvers?.task(requested.taskId) ?? null;
      if (taskContext) return taskContext;
      throw new ProductFailure(
        productError('TERMINAL_CONTEXT_UNKNOWN', {
          userMessage: 'That task context is no longer available.',
        }),
      );
    }
    if (contextResolvers) return contextResolvers.scratch();
    throw new ProductFailure(
      productError('TERMINAL_CONTEXT_UNKNOWN', {
        userMessage: 'Scratch terminals are unavailable right now.',
      }),
    );
  };

  registerHandlers(
    {
      'search.files': async ({ query }) => {
        const files = await services.cachedFiles();
        const ranked = fuzzyFilter(query, files, (f) => f, 200);
        return {
          items: ranked.map((r) => ({ path: r.item, positions: r.positions })),
          total: files.length,
        };
      },
      'search.allFiles': async () => {
        const files = await services.cachedFiles();
        return { files: files.slice(0, 20000), truncated: files.length > 20000 };
      },
      'search.textStart': async (payload) => ({ searchId: services.startTextSearch(payload) }),
      'search.cancel': async ({ searchId }) => ({ cancelled: services.cancelSearch(searchId) }),
      'search.replace': async ({ files }) => {
        const outcomes = await services.mustSearch().applyReplacements(files);
        // Keep open documents in sync with on-disk replacements.
        const ws = host.current;
        if (ws) {
          for (const outcome of outcomes) {
            if (outcome.status === 'applied' && ws.documents.isOpen(outcome.path)) {
              const snapshot = await ws.documents.handleExternalChange(outcome.path);
              if (snapshot) broadcast('doc.changedExternally', { doc: { ...snapshot } });
            }
          }
        }
        return { outcomes };
      },

      'terminal.create': async ({ taskId, context, launch, initialPrompt }) => {
        const requested =
          context ?? (taskId ? { kind: 'task' as const, taskId } : { kind: 'focused' as const });
        const resolved = resolveTerminalContext(requested);
        const info = services.terminals.create({
          ...resolved,
          shellPath: undefined,
          launch,
        });
        const sessionId = launch === 'claude' ? randomUUID() : null;
        const command = terminalLaunchCommand(launch, sessionId);
        if (command) {
          // The intent (pre-assigned conversation id + composer first prompt)
          // is consumed when agent detection confirms the CLI really started;
          // the prompt is delivered there, never as raw early PTY writes.
          externalLaunches?.register(info.id, {
            cli: launch,
            sessionId,
            prompt: initialPrompt?.trim() ? initialPrompt : null,
          });
          // Let the renderer attach the xterm before the first TUI repaint.
          setTimeout(() => services.terminals.write(info.id, `${command}\r`), 350).unref();
        }
        return info;
      },
      'terminal.setContext': async ({ id, context }) => {
        if (services.terminals.hasRunningChildren(id)) {
          throw new ProductFailure(
            productError('TERMINAL_CONTEXT_BUSY', {
              userMessage: 'Finish the running command before changing this terminal context.',
            }),
          );
        }
        const info = services.terminals.changeContext(id, resolveTerminalContext(context));
        if (!info) {
          throw new ProductFailure(
            productError('TERMINAL_NOT_FOUND', {
              userMessage: 'That terminal session is no longer available.',
            }),
          );
        }
        return info;
      },
      'terminal.write': async ({ id, data }) => {
        services.terminals.write(id, data);
        return { ok: true };
      },
      'terminal.resize': async ({ id, cols, rows }) => {
        services.terminals.resize(id, cols, rows);
        return { ok: true };
      },
      'terminal.kill': async ({ id, force }) => {
        if (!force && services.terminals.hasRunningChildren(id)) {
          return { closed: false, needsConfirm: true };
        }
        services.terminals.kill(id);
        return { closed: true, needsConfirm: false };
      },
      'terminal.list': async () => ({
        items: services.terminals.list(),
      }),

      'lsp.status': async () => ({ python: services.getPythonStatus() }),
      'lsp.pythonRequest': async ({ method, path, line, character }) => {
        const client = services.pythonClient;
        if (!client?.running) {
          return { result: null };
        }
        // Ensure the document is open server-side.
        const ws = host.mustActive();
        const doc = ws.documents.get(path);
        if (doc) client.didChange(path, doc.content);
        switch (method) {
          case 'completion':
            return { result: await client.completion(path, line, character) };
          case 'hover':
            return { result: await client.hover(path, line, character) };
          case 'definition':
            return { result: await client.definition(path, line, character) };
          case 'symbols':
            return { result: await client.symbols(path) };
        }
      },
    },
    logger,
  );
}
