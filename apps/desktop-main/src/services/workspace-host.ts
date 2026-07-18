import { promises as fs } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { shell } from 'electron';
import { DocumentStore, type DocumentSnapshot } from '@pi-ide/document-service';
import {
  WorkspaceWatcher,
  listDirectory,
  openWorkspaceInfo,
  resolveInsideRoot,
  type DirEntry,
} from '@pi-ide/workspace-service';
import type { WorkspaceDto } from '@pi-ide/ipc-contracts';
import { errorMessage, newId, productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import type { StateService } from './state-service.js';
import type { SettingsService } from './settings-service.js';
import { broadcast } from '../broadcast.js';

export interface ActiveWorkspace {
  id: string;
  canonicalPath: string;
  displayName: string;
  trustState: 'untrusted' | 'trusted';
  isGitRepo: boolean;
  hasPiProjectResources: boolean;
  openedAt: string;
  documents: DocumentStore;
  watcher: WorkspaceWatcher;
}

/** Owns the single active workspace: identity row, document store, fs watcher. */
export class WorkspaceHost {
  private active: ActiveWorkspace | null = null;
  private readonly openListeners = new Set<(ws: ActiveWorkspace | null) => void>();

  constructor(
    private readonly state: StateService,
    private readonly settings: SettingsService,
    private readonly logger: Logger,
  ) {}

  get current(): ActiveWorkspace | null {
    return this.active;
  }

  onDidChangeWorkspace(listener: (ws: ActiveWorkspace | null) => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  dto(): WorkspaceDto | null {
    if (!this.active) return null;
    return {
      id: this.active.id,
      path: this.active.canonicalPath,
      displayName: this.active.displayName,
      trustState: this.active.trustState,
      isGitRepo: this.active.isGitRepo,
      openedAt: this.active.openedAt,
      hasPiProjectResources: this.active.hasPiProjectResources,
    };
  }

  async open(path: string): Promise<WorkspaceDto> {
    if (this.active) {
      await this.close();
    }
    const info = await openWorkspaceInfo(path);

    // Stable workspace identity per canonical path.
    const row = this.state.db
      .prepare(
        'SELECT id, trust_state, settings_override_json FROM workspaces WHERE canonical_path = ?',
      )
      .get(info.canonicalPath) as
      { id: string; trust_state: string; settings_override_json: string | null } | undefined;
    const now = new Date().toISOString();
    let id: string;
    let trustState: 'untrusted' | 'trusted' = 'untrusted';
    let overrideRaw: Record<string, unknown> | null = null;
    if (row) {
      id = row.id;
      trustState = row.trust_state === 'trusted' ? 'trusted' : 'untrusted';
      if (row.settings_override_json) {
        try {
          overrideRaw = JSON.parse(row.settings_override_json) as Record<string, unknown>;
        } catch {
          overrideRaw = null;
        }
      }
      this.state.db
        .prepare('UPDATE workspaces SET last_opened_at = ?, display_name = ? WHERE id = ?')
        .run(now, info.displayName, id);
    } else {
      id = newId('ws');
      this.state.db
        .prepare(
          'INSERT INTO workspaces (id, canonical_path, display_name, trust_state, last_opened_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, info.canonicalPath, info.displayName, 'untrusted', now, now);
    }

    const documents = new DocumentStore(info.canonicalPath, {
      largeFileBytes: this.settings.effective.editor.largeFileSizeMb * 1024 * 1024,
    });
    const watcher = new WorkspaceWatcher(info.canonicalPath);

    this.active = {
      id,
      canonicalPath: info.canonicalPath,
      displayName: info.displayName,
      trustState,
      isGitRepo: info.isGitRepo,
      hasPiProjectResources: info.hasPiProjectResources,
      openedAt: now,
      documents,
      watcher,
    };

    this.settings.setWorkspaceOverride(overrideRaw);

    watcher.onBatch((changes) => {
      broadcast('fs.batch', { changes: changes.slice(0, 2000) });
      for (const change of changes) {
        if (change.isDirectory) continue;
        if (!documents.isOpen(change.relativePath)) continue;
        void documents
          .handleExternalChange(change.relativePath)
          .then((snapshot) => {
            if (snapshot) {
              broadcast('doc.changedExternally', { doc: toDto(snapshot) });
            }
          })
          .catch((e) => {
            this.logger.warn('external change handling failed', {
              path: change.relativePath,
              error: errorMessage(e),
            });
          });
      }
    });
    watcher.start();

    this.logger.info('workspace opened', { id, path: info.canonicalPath, git: info.isGitRepo });
    const dto = this.dto()!;
    broadcast('workspace.changed', { workspace: dto });
    for (const listener of this.openListeners) listener(this.active);
    return dto;
  }

  async close(): Promise<void> {
    if (!this.active) return;
    this.active.watcher.dispose();
    this.active.documents.closeAll();
    this.settings.setWorkspaceOverride(null);
    this.logger.info('workspace closed', { id: this.active.id });
    this.active = null;
    broadcast('workspace.changed', { workspace: null });
    for (const listener of this.openListeners) listener(null);
  }

  setTrust(trusted: boolean): WorkspaceDto {
    const ws = this.mustActive();
    ws.trustState = trusted ? 'trusted' : 'untrusted';
    this.state.db
      .prepare('UPDATE workspaces SET trust_state = ? WHERE id = ?')
      .run(ws.trustState, ws.id);
    const dto = this.dto()!;
    broadcast('workspace.changed', { workspace: dto });
    return dto;
  }

  mustActive(): ActiveWorkspace {
    if (!this.active) {
      throw new ProductFailure(
        productError('WS_NONE_OPEN', { userMessage: 'No workspace is open.' }),
      );
    }
    return this.active;
  }

  async listDir(dir: string, showIgnored: boolean): Promise<DirEntry[]> {
    const ws = this.mustActive();
    const extra = this.settings.effective.workspace.ignoreGlobs;
    return listDirectory(ws.canonicalPath, dir, { showIgnored, extraIgnores: extra });
  }

  async createEntry(parentDir: string, name: string, kind: 'file' | 'dir'): Promise<string> {
    const ws = this.mustActive();
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      throw new ProductFailure(
        productError('WS_PATH_INVALID', { userMessage: 'That name is not valid.' }),
      );
    }
    const rel = parentDir === '' ? name : `${parentDir}/${name}`;
    const abs = await resolveInsideRoot(ws.canonicalPath, rel);
    try {
      if (kind === 'dir') {
        await fs.mkdir(abs);
      } else {
        await fs.writeFile(abs, '', { flag: 'wx' });
      }
    } catch (e) {
      throw new ProductFailure(
        productError('WS_CREATE_FAILED', {
          userMessage: `Could not create ${kind === 'dir' ? 'folder' : 'file'} "${name}" (it may already exist).`,
          technicalMessage: errorMessage(e),
        }),
      );
    }
    return rel;
  }

  async renameEntry(path: string, newName: string): Promise<string> {
    const ws = this.mustActive();
    if (newName.includes('/') || newName.includes('\\')) {
      throw new ProductFailure(
        productError('WS_PATH_INVALID', { userMessage: 'That name is not valid.' }),
      );
    }
    const abs = await resolveInsideRoot(ws.canonicalPath, path);
    const target = join(dirname(abs), newName);
    if (!target.startsWith(ws.canonicalPath)) {
      throw new ProductFailure(
        productError('WS_PATH_ESCAPE', { userMessage: 'The new name escapes the workspace.' }),
      );
    }
    try {
      await fs.rename(abs, target);
    } catch (e) {
      throw new ProductFailure(
        productError('WS_RENAME_FAILED', {
          userMessage: `Could not rename to "${newName}".`,
          technicalMessage: errorMessage(e),
        }),
      );
    }
    const parent = dirname(path);
    return parent === '.' ? newName : `${parent}/${newName}`;
  }

  async trashEntry(path: string): Promise<void> {
    const ws = this.mustActive();
    const abs = await resolveInsideRoot(ws.canonicalPath, path);
    if (abs === ws.canonicalPath) {
      throw new ProductFailure(
        productError('WS_PATH_INVALID', { userMessage: 'The workspace root cannot be deleted.' }),
      );
    }
    try {
      await shell.trashItem(abs);
    } catch (e) {
      throw new ProductFailure(
        productError('WS_TRASH_FAILED', {
          userMessage: `Could not move "${basename(path)}" to the trash.`,
          technicalMessage: errorMessage(e),
        }),
      );
    }
  }
}

export function toDto(snapshot: DocumentSnapshot) {
  return { ...snapshot };
}
