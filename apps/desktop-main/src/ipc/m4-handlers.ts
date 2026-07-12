import { fuzzyFilter, newId, productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import { SearchService } from '@pi-ide/search-service';
import { TerminalManager } from '@pi-ide/terminal-service';
import {
  findPythonServer,
  PythonLspClient,
  PYTHON_INSTALL_HINT,
  type PythonLspStatus,
} from '@pi-ide/language-service';
import { registerHandlers } from './router.js';
import type { WorkspaceHost } from '../services/workspace-host.js';
import type { SettingsService } from '../services/settings-service.js';
import { broadcast } from '../broadcast.js';

interface ActiveSearch {
  controller: AbortController;
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
  ) {
    this.terminals = new TerminalManager(
      (id, data) => broadcast('terminal.data', { id, data }),
      (id, exitCode) => broadcast('terminal.exit', { id, exitCode }),
    );

    host.onDidChangeWorkspace((ws) => {
      for (const search of this.activeSearches.values()) search.controller.abort();
      this.activeSearches.clear();
      this.fileListCache = null;
      this.terminals.disposeAll();
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
          hint: `The Python language server failed to start: ${e instanceof Error ? e.message : String(e)}`,
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
        this.logger.warn('search failed', { error: e instanceof Error ? e.message : String(e) });
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
    this.terminals.disposeAll();
    void this.python?.dispose();
  }
}

export function registerM4Handlers(
  services: M4Services,
  host: WorkspaceHost,
  logger: Logger,
): void {
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

      'terminal.create': async ({ cwd }) => {
        const ws = host.mustActive();
        const info = services.terminals.create({
          cwd: cwd ? `${ws.canonicalPath}/${cwd}` : ws.canonicalPath,
          shellPath: undefined,
        });
        return { id: info.id, title: info.title, shell: info.shell, pid: info.pid };
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
        items: services.terminals.list().map((t) => ({
          id: t.id,
          title: t.title,
          shell: t.shell,
          pid: t.pid,
        })),
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
