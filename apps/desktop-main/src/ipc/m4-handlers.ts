import {
  errorMessage,
  fuzzyFilter,
  newId,
  productError,
  ProductFailure,
  type Logger,
} from '@pi-ide/foundation';
import { SearchService } from '@pi-ide/search-service';
import { TerminalManager, type TerminalInfo } from '@pi-ide/terminal-service';
import {
  findPythonServer,
  PythonLspClient,
  PYTHON_INSTALL_HINT,
  type PythonLspStatus,
} from '@pi-ide/language-service';
import { randomUUID } from 'node:crypto';
import { registerHandlers, registerSendHandlers } from './router.js';
import type { WorkspaceHost } from '../services/workspace-host.js';
import type { SettingsService } from '../services/settings-service.js';
import type { ExternalLaunchIntents } from '../services/external-launch-intents.js';
import { isSafeCliSessionId } from '../services/cli-session-locator.js';
import { broadcast } from '../broadcast.js';
import type { TerminalDaemonClient } from '../services/terminal-daemon-client.js';
import { TerminalOutputDispatcher } from '../services/terminal-output-dispatcher.js';

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
  /** ADR-0038: cwd of a discovered CLI session, resolved from the host-owned
   * discovery cache — the renderer only ever names (cli, sessionId). */
  archaeology(
    cli: 'claude' | 'codex',
    sessionId: string,
  ): Promise<TerminalContextResolution | null>;
  /** Prepare a task-owned worktree before a visible external Agent PTY is
   * created. The returned task context is host-resolved; no path chosen by the
   * renderer becomes a terminal cwd directly. */
  prepareExternalWorktree(input: {
    cli: 'claude' | 'codex';
    projectPath: string;
    title: string;
    setupCommand?: string;
  }): Promise<TerminalContextResolution>;
  bindExternalTerminal(taskId: string, terminalId: string): void;
  abortPreparedExternal(taskId: string): Promise<void>;
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
  executable?: string | null,
): string | null {
  const command = executable ? `'${executable.replaceAll("'", "'\\''")}'` : launch;
  if (launch === 'claude') {
    return sessionId && isSafeCliSessionId(sessionId)
      ? `${command} --session-id ${sessionId}`
      : command;
  }
  if (launch === 'codex') return command;
  return null;
}

export class M4Services {
  private search: SearchService | null = null;
  private fileListCache: { at: number; files: string[] } | null = null;
  private readonly activeSearches = new Map<string, ActiveSearch>();
  private lastSearchId: string | null = null;
  readonly terminals: TerminalManager;
  readonly restoredTerminalIds = new Set<string>();
  private python: PythonLspClient | null = null;
  private pythonStatus: PythonLspStatus = {
    available: false,
    serverPath: null,
    running: false,
    hint: PYTHON_INSTALL_HINT,
  };
  private pythonRestarts = 0;
  private readonly terminalOutput: TerminalOutputDispatcher;

  constructor(
    private readonly host: WorkspaceHost,
    private readonly settings: SettingsService,
    private readonly logger: Logger,
    shellIntegrationDir: string | null = null,
    terminalEnvironment?: (id: string) => Record<string, string>,
    private readonly terminalDaemon: TerminalDaemonClient | null = null,
  ) {
    this.terminalOutput = new TerminalOutputDispatcher((delivery) => {
      if (broadcast('terminal.data', delivery) === 0) {
        this.terminalOutput.acknowledge(delivery.id, delivery.deliveryId);
      }
    });
    this.terminals = new TerminalManager(
      (id, data, sequence) => this.terminalOutput.push(id, data, sequence),
      (id, exitCode) => {
        this.terminalOutput.flush(id);
        broadcast('terminal.exit', { id, exitCode });
        const release = setTimeout(() => this.terminalOutput.reset(id), 10_000);
        release.unref();
      },
      {
        // ADR-0021: resolved per spawn so a settings flip applies to the next terminal.
        shellIntegration: () => ({
          dir: shellIntegrationDir,
          enabled: this.settings.effective.terminal.shellIntegration,
        }),
        ...(terminalEnvironment ? { envForTerminal: terminalEnvironment } : {}),
        ...(terminalDaemon
          ? { createLocalBackend: (request) => terminalDaemon.createBackend(request) }
          : {}),
        onResync: (id, replay, sequence) => {
          this.terminalOutput.reset(id);
          broadcast('terminal.resync', { id, replay, sequence });
        },
      },
    );

    for (const snapshot of terminalDaemon?.restoredSessions() ?? []) {
      const info = snapshot.info;
      this.terminals.adoptBackend(terminalDaemon!.backendForRestored(snapshot), {
        id: info.id,
        pid: snapshot.pid,
        initialReplay: snapshot.replay,
        ...(snapshot.cols === undefined ? {} : { cols: snapshot.cols }),
        ...(snapshot.rows === undefined ? {} : { rows: snapshot.rows }),
        title: info.title,
        shell: info.shell,
        cwd: info.cwd,
        projectName: info.projectName,
        projectPath: info.projectPath,
        contextKind: info.contextKind,
        contextLabel: info.contextLabel,
        contextTaskId: info.contextTaskId,
        launch: info.launch,
      });
      this.restoredTerminalIds.add(info.id);
    }

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

  async persistentSnapshots(): Promise<Map<string, { replay: string; sequence: number }>> {
    if (!this.terminalDaemon) return new Map();
    try {
      const snapshots = await this.terminalDaemon.currentSnapshots();
      return new Map(
        snapshots.map((snapshot) => [
          snapshot.info.id,
          { replay: snapshot.replay, sequence: snapshot.sequence },
        ]),
      );
    } catch (error) {
      this.logger.warn('terminal daemon snapshot unavailable', { error: errorMessage(error) });
      return new Map();
    }
  }

  dispose(): void {
    this.terminalOutput.dispose();
    this.terminals.dispose();
    this.terminalDaemon?.close();
    void this.python?.dispose();
  }

  noteTerminalInput(id: string): void {
    this.terminalOutput.noteInput(id);
  }

  setActiveTerminal(id: string | null): void {
    this.terminalOutput.setActive(id);
  }

  acknowledgeTerminalOutput(id: string, deliveryId: number): void {
    this.terminalOutput.acknowledge(id, deliveryId);
  }
}

/** ADR-0047: creates a terminal that runs on a remote SSH host. Injected so
 * m4-handlers stays free of ssh2 while terminal.create keeps one code path. */
export interface RemoteTerminalLauncher {
  create(options: { hostId: string; launch: 'shell' | 'claude' | 'codex' }): Promise<TerminalInfo>;
}

export function registerM4Handlers(
  services: M4Services,
  host: WorkspaceHost,
  logger: Logger,
  /** Lazy because TaskService is constructed after handler registration. */
  contextResolvers?: TerminalContextResolvers,
  /** ADR-0017 amendment: launch intents consumed by ExternalSessionService. */
  externalLaunches?: ExternalLaunchIntents,
  /** ADR-0047: present once SshService is assembled; enables ssh targets. */
  remoteTerminals?: RemoteTerminalLauncher,
  /** Host-resolved executable. Never rely on user shell PATH ordering for product launches. */
  localAgentExecutable?: (launch: 'claude' | 'codex') => string | null,
): void {
  const resolveTerminalContext = async (
    requested:
      | { kind: 'focused' }
      | { kind: 'recent'; projectPath: string }
      | { kind: 'task'; taskId: string }
      | { kind: 'scratch' }
      | { kind: 'archaeology'; cli: 'claude' | 'codex'; sessionId: string },
  ): Promise<TerminalContextResolution> => {
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
    if (requested.kind === 'archaeology') {
      const discovered =
        (await contextResolvers?.archaeology(requested.cli, requested.sessionId)) ?? null;
      if (discovered) return discovered;
      throw new ProductFailure(
        productError('TERMINAL_CONTEXT_UNKNOWN', {
          userMessage: 'That discovered session is no longer available. Rescan and try again.',
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

  registerSendHandlers(
    {
      'terminal.write': ({ id, data, userInitiated }) => {
        services.noteTerminalInput(id);
        services.terminals.write(id, data, userInitiated === false ? 'terminal' : 'user');
      },
      'terminal.resize': ({ id, cols, rows }) => services.terminals.resize(id, cols, rows),
      'terminal.active': ({ id }) => services.setActiveTerminal(id),
      'terminal.ack': ({ id, deliveryId }) => services.acknowledgeTerminalOutput(id, deliveryId),
    },
    logger,
  );

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

      'terminal.create': async ({ taskId, context, launch, initialPrompt, worktree, target }) => {
        if (worktree && (launch === 'shell' || target || context || taskId)) {
          throw new ProductFailure(
            productError('TERMINAL_WORKTREE_INVALID', {
              userMessage: 'A new worktree can only be created for a local Claude or Codex launch.',
            }),
          );
        }
        // ADR-0047: a remote target runs on an SSH host — SshService owns the
        // connect + shell channel + adoptBackend, and delivers the CLI launch.
        if (target?.kind === 'ssh') {
          if (!remoteTerminals) {
            throw new ProductFailure(
              productError('SSH_UNAVAILABLE', {
                userMessage: 'SSH support is not available in this session.',
              }),
            );
          }
          return remoteTerminals.create({ hostId: target.hostId, launch });
        }
        let preparedTaskId: string | null = null;
        const resolved = worktree
          ? await (() => {
              if (!contextResolvers) {
                throw new ProductFailure(
                  productError('TERMINAL_CONTEXT_UNKNOWN', {
                    userMessage: 'Worktree launch support is unavailable right now.',
                  }),
                );
              }
              return contextResolvers.prepareExternalWorktree({
                cli: launch === 'claude' ? 'claude' : 'codex',
                projectPath: worktree.projectPath,
                title: worktree.title,
                ...(worktree.setupCommand ? { setupCommand: worktree.setupCommand } : {}),
              });
            })()
          : await resolveTerminalContext(
              context ??
                (taskId ? { kind: 'task' as const, taskId } : { kind: 'focused' as const }),
            );
        if (worktree) preparedTaskId = resolved.contextTaskId;

        let info: TerminalInfo | null = null;
        try {
          info = services.terminals.create({
            ...resolved,
            shellPath: undefined,
            launch,
          });
          if (preparedTaskId) contextResolvers?.bindExternalTerminal(preparedTaskId, info.id);
        } catch (error) {
          if (info) services.terminals.kill(info.id);
          if (preparedTaskId) await contextResolvers?.abortPreparedExternal(preparedTaskId);
          throw error;
        }
        if (!info) throw new Error('Terminal creation did not return a terminal.');
        const sessionId = launch === 'claude' ? randomUUID() : null;
        const command = terminalLaunchCommand(
          launch,
          sessionId,
          launch === 'shell' ? null : localAgentExecutable?.(launch),
        );
        if (command) {
          // The intent (pre-assigned conversation id + composer first prompt)
          // is consumed when agent detection confirms the CLI really started;
          // the prompt is delivered there, never as raw early PTY writes.
          externalLaunches?.register(info.id, {
            cli: launch,
            sessionId,
            prompt: initialPrompt?.trim() ? initialPrompt : null,
            promptDelivery: 'deferred',
          });
          // Let the renderer attach the xterm before the first TUI repaint.
          setTimeout(() => services.terminals.write(info.id, `${command}\r`), 350).unref();
        }
        return info;
      },
      'terminal.setContext': async ({ id, context }) => {
        // ADR-0047: a remote session's cwd lives on the server; retargeting it
        // to a local context is meaningless, so reject it explicitly.
        if (services.terminals.list().find((t) => t.id === id)?.remote) {
          throw new ProductFailure(
            productError('TERMINAL_REMOTE_CONTEXT', {
              userMessage: 'A remote SSH session cannot be moved to a local project context.',
            }),
          );
        }
        if (services.terminals.hasRunningChildren(id)) {
          throw new ProductFailure(
            productError('TERMINAL_CONTEXT_BUSY', {
              userMessage: 'Finish the running command before changing this terminal context.',
            }),
          );
        }
        const info = services.terminals.changeContext(id, await resolveTerminalContext(context));
        if (!info) {
          throw new ProductFailure(
            productError('TERMINAL_NOT_FOUND', {
              userMessage: 'That terminal session is no longer available.',
            }),
          );
        }
        return info;
      },
      'terminal.write': async ({ id, data, userInitiated }) => {
        services.noteTerminalInput(id);
        const ok = await services.terminals.writeAccepted(
          id,
          data,
          userInitiated === false ? 'terminal' : 'user',
        );
        return { ok };
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
      'terminal.list': async () => {
        const items = services.terminals.list();
        return {
          items,
          restoredIds: items
            .filter((item) => services.restoredTerminalIds.has(item.id))
            .map((item) => item.id),
          recentData: Object.fromEntries(
            items.map((item) => [item.id, services.terminals.recentData(item.id)]),
          ),
          sequences: Object.fromEntries(
            items.map((item) => [item.id, services.terminals.sequence(item.id)]),
          ),
        };
      },

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
