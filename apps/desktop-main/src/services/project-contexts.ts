import { join } from 'node:path';
import type { Logger } from '@pi-ide/foundation';
import { DocumentStore } from '@pi-ide/document-service';
import { BlobStore, ChangeService } from '@pi-ide/change-service';
import type { SqlDatabase } from '@pi-ide/persistence';
import {
  ToolGateway,
  registerReadOnlyTools,
  registerCommandTools,
  registerWriteTools,
  registerVerificationTool,
  registerSkillTool,
  registerTerminalTools,
  createPlanAwarePermission,
  PermissionEngine,
  type AskUserPrompt,
  type PermissionRequestCard,
  type PlanGate,
  type SkillProviderEntry,
  type ToolAuditRecord,
  type TerminalControlPort,
  type VerificationGate,
} from '@pi-ide/tool-gateway';
import { SearchService } from '@pi-ide/search-service';
import { GitService } from '@pi-ide/git-service';
import { VerificationService } from '@pi-ide/verification-service';
import type { AgentMode } from '@pi-ide/agent-contract';
import type { WorkspaceHost } from './workspace-host.js';
import { toDto } from './workspace-host.js';
import type { SettingsService } from './settings-service.js';
import { broadcast } from '../broadcast.js';
import type { AppPaths } from '../app-paths.js';
import { workspaceDataDir } from '../app-paths.js';
import { SqliteChangeRepo } from '../ipc/m5-handlers.js';
import { SqlPermissionStore } from './permission-store.js';
import { SqlVerificationRepo } from './verification-store.js';

/**
 * One mounted agent context (ADR-0009): everything a task needs to execute
 * tools safely against ONE root — the project directory or a task worktree.
 * Contexts live independently of the focused editor workspace, so runs keep
 * working when the user switches projects.
 */
export interface ProjectContext {
  /** Mount root (canonical project path, or a task's worktree path). */
  root: string;
  /** Owning workspace row (worktree contexts share the project's id). */
  wsId: string;
  isGitRepo: boolean;
  documents: DocumentStore;
  blobs: BlobStore;
  changes: ChangeService;
  gateway: ToolGateway;
  permissions: PermissionEngine;
  verifications: VerificationService;
}

/** Callbacks into the task engine — injected to avoid a service cycle. */
export interface ContextHooks {
  modeForTask(taskId: string): AgentMode;
  planApproved(taskId: string): boolean;
  audit(record: ToolAuditRecord): void;
  onPermissionPending(card: PermissionRequestCard, context: ProjectContext): void;
  onPermissionResolved(
    info: {
      requestId: string;
      taskId: string;
      outcome: 'allowed' | 'denied' | 'cancelled' | 'invalidated';
      scope?: 'once' | 'task' | 'workspace' | 'always';
      actor?: string;
      reason?: string;
      card: PermissionRequestCard;
      pendingLeftForTask: number;
    },
    context: ProjectContext,
  ): void;
  askUser(prompt: AskUserPrompt, signal: AbortSignal): Promise<string>;
  planGate(): PlanGate;
  verificationGate(): VerificationGate;
  /** Enabled managed-store skills for load_skill (ADR-0015); resolved per call. */
  skills(): SkillProviderEntry[];
}

/**
 * Documents for an agent context. While the context's root is also the focused
 * editor workspace, reads/writes route through the live editor DocumentStore so
 * dirty-buffer semantics (M8-06) stay exact; otherwise the context's own store
 * (no open buffers → plain atomic disk writes) is used.
 */
class RoutedDocumentStore extends DocumentStore {
  constructor(
    private readonly rootPath: string,
    private readonly host: WorkspaceHost,
    options: { largeFileBytes: number },
  ) {
    super(rootPath, options);
  }

  private live(): DocumentStore | null {
    const ws = this.host.current;
    return ws && ws.canonicalPath === this.rootPath ? ws.documents : null;
  }

  override isOpen(relativePath: string): boolean {
    return this.live()?.isOpen(relativePath) ?? super.isOpen(relativePath);
  }

  override updateBuffer(
    relativePath: string,
    content: string,
  ): ReturnType<DocumentStore['updateBuffer']> {
    const live = this.live();
    return live
      ? live.updateBuffer(relativePath, content)
      : super.updateBuffer(relativePath, content);
  }

  override save(
    relativePath: string,
    options: { force?: boolean } = {},
  ): ReturnType<DocumentStore['save']> {
    const live = this.live();
    return live ? live.save(relativePath, options) : super.save(relativePath, options);
  }

  override readLogical(relativePath: string): ReturnType<DocumentStore['readLogical']> {
    const live = this.live();
    return live ? live.readLogical(relativePath) : super.readLogical(relativePath);
  }

  override handleExternalChange(
    relativePath: string,
  ): ReturnType<DocumentStore['handleExternalChange']> {
    const live = this.live();
    return live
      ? live.handleExternalChange(relativePath)
      : super.handleExternalChange(relativePath);
  }
}

/** Lazily creates and caches per-root agent contexts (ADR-0009). */
export class ProjectContexts {
  private readonly byRoot = new Map<string, ProjectContext>();

  constructor(
    private readonly db: SqlDatabase,
    private readonly paths: AppPaths,
    private readonly settings: SettingsService,
    private readonly host: WorkspaceHost,
    private readonly hooks: ContextHooks,
    private readonly logger: Logger,
    private readonly terminalControl?: {
      control: TerminalControlPort;
      callerTerminalForCall(callId: string): string | null;
    },
  ) {}

  get(root: string): ProjectContext | null {
    return this.byRoot.get(root) ?? null;
  }

  all(): ProjectContext[] {
    return [...this.byRoot.values()];
  }

  /** Drop a context whose root is gone (e.g. a discarded worktree). */
  drop(root: string): void {
    const ctx = this.byRoot.get(root);
    if (!ctx) return;
    ctx.permissions.cancelAll('context disposed');
    this.byRoot.delete(root);
  }

  forRoot(input: { root: string; wsId: string; isGitRepo: boolean }): ProjectContext {
    const existing = this.byRoot.get(input.root);
    if (existing) return existing;

    const documents = new RoutedDocumentStore(input.root, this.host, {
      largeFileBytes: this.settings.effective.editor.largeFileSizeMb * 1024 * 1024,
    });
    const blobs = new BlobStore(
      join(workspaceDataDir(this.paths, input.wsId), 'checkpoints', 'blobs'),
    );
    const changes = new ChangeService({
      root: input.root,
      blobs,
      repo: new SqliteChangeRepo(this.db),
      documents,
      // Agent/task writes to an open file bypass the fs-watcher broadcast:
      // DocumentStore marks its atomic save as an own write. Notify the
      // renderer directly so an already-open clean Monaco model cannot lag.
      onDidWriteOpenDocument: (document) => {
        broadcast('doc.changedExternally', { doc: toDto(document) });
      },
    });

    const contextRef: { current: ProjectContext | null } = { current: null };
    const permissions = new PermissionEngine({
      workspaceId: input.wsId,
      store: new SqlPermissionStore(this.db, input.wsId),
      events: {
        onPending: (card) => this.hooks.onPermissionPending(card, contextRef.current!),
        onResolved: (info) => this.hooks.onPermissionResolved(info, contextRef.current!),
      },
    });

    const gateway = new ToolGateway({
      root: input.root,
      mode: 'ask',
      // ADR-0006: concurrent runs — every call resolves its own task's mode.
      modeForTask: (taskId) => this.hooks.modeForTask(taskId),
      // AG-007: writes in edit/auto are refused until this task's plan is approved.
      permission: createPlanAwarePermission(permissions, {
        planApproved: (taskId) => this.hooks.planApproved(taskId),
      }),
      audit: (record) => this.hooks.audit(record),
    });
    registerReadOnlyTools(gateway, {
      root: input.root,
      documents,
      search: () => new SearchService(input.root, this.settings.effective.workspace.ignoreGlobs),
      git: () => (input.isGitRepo ? new GitService(input.root) : null),
    });
    registerCommandTools(gateway, {
      root: input.root,
      userGate: { ask: (prompt, signal) => this.hooks.askUser(prompt, signal) },
    });
    registerWriteTools(gateway, {
      root: input.root,
      changes: () => changes,
      documents,
      planGate: this.hooks.planGate(),
    });
    registerVerificationTool(gateway, { gate: this.hooks.verificationGate() });
    // ADR-0015: skills load from the managed store only — never this root.
    registerSkillTool(gateway, { skills: () => this.hooks.skills() });
    if (this.settings.effective.orchestration.enabled && this.terminalControl) {
      registerTerminalTools(gateway, {
        root: input.root,
        control: this.terminalControl.control,
        callerTerminalForCall: (callId) => this.terminalControl!.callerTerminalForCall(callId),
      });
    }

    const verifications = new VerificationService({
      root: input.root,
      repo: new SqlVerificationRepo(this.db),
      blobs,
    });

    const context: ProjectContext = {
      root: input.root,
      wsId: input.wsId,
      isGitRepo: input.isGitRepo,
      documents,
      blobs,
      changes,
      gateway,
      permissions,
      verifications,
    };
    contextRef.current = context;
    this.byRoot.set(input.root, context);
    this.logger.info('agent context mounted', { root: input.root, wsId: input.wsId });
    return context;
  }

  syncTerminalTools(enabled: boolean): void {
    const names = [
      'terminal.list',
      'terminal.read',
      'terminal.send',
      'terminal.create',
      'terminal.wait',
      'terminal.kill',
    ];
    for (const context of this.byRoot.values()) {
      if (enabled && this.terminalControl) {
        registerTerminalTools(context.gateway, {
          root: context.root,
          control: this.terminalControl.control,
          callerTerminalForCall: (callId) => this.terminalControl!.callerTerminalForCall(callId),
        });
      } else {
        for (const name of names) context.gateway.unregister(name);
      }
    }
  }

  /** Quit-time teardown: resolve every pending gate before the DB closes. */
  shutdown(reason: string): void {
    for (const ctx of this.byRoot.values()) {
      ctx.permissions.cancelAll(reason);
    }
  }
}
