import { dialog } from 'electron';
import { promises as fs } from 'node:fs';
import { OpenTabsStateSchema } from '@pi-ide/ipc-contracts';
import { resolveInsideRoot } from '@pi-ide/workspace-service';
import { productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import { registerHandlers } from './router.js';
import { createProject } from '../services/project-create.js';
import { toDto, type WorkspaceHost } from '../services/workspace-host.js';
import type { StateService } from '../services/state-service.js';
import {
  inspectRegisteredProject,
  listRegisteredProjectDirectory,
  readRegisteredProjectFile,
  setRegisteredProjectTrust,
} from '../services/project-inspection.js';

export function registerWorkspaceHandlers(
  host: WorkspaceHost,
  state: StateService,
  logger: Logger,
): void {
  registerHandlers(
    {
      'workspace.open': async ({ path }) => ({ workspace: await host.open(path) }),
      'workspace.pickAndOpen': async () => {
        const result = await dialog.showOpenDialog({
          properties: ['openDirectory', 'createDirectory'],
          title: 'Open Folder',
        });
        if (result.canceled || result.filePaths.length === 0) return { workspace: null };
        return { workspace: await host.open(result.filePaths[0]!) };
      },
      'workspace.close': async () => {
        await host.close();
        return { closed: true };
      },
      // ADR-0034: forget a project — the workspace row plus all recorded
      // Sessions leave the app; files on disk are never touched. The open
      // project is closed first so no service keeps a live handle on it.
      'workspace.remove': async ({ path }) => {
        const result = state.removeWorkspace(path);
        if (result.status === 'running') {
          throw new ProductFailure(
            productError('WORKSPACE_REMOVE_BLOCKED', {
              userMessage: `This project still has ${result.running} running session${result.running === 1 ? '' : 's'}. Stop or finish them, then remove the project.`,
            }),
          );
        }
        if (result.status === 'missing') return { removed: false, removedSessions: 0 };
        // Close AFTER the guard passed: a refused removal must not surprise
        // the user by also closing their open project.
        if (host.current?.canonicalPath === path) await host.close();
        logger.info('workspace removed', { path, sessions: result.removedSessions });
        return { removed: true, removedSessions: result.removedSessions };
      },
      'workspace.pickParentDir': async () => {
        const result = await dialog.showOpenDialog({
          properties: ['openDirectory', 'createDirectory'],
          title: 'Choose the project folder',
          buttonLabel: 'Choose',
        });
        return { path: result.canceled ? null : (result.filePaths[0] ?? null) };
      },
      'workspace.createProject': async (input) => {
        const path = await createProject(input, logger);
        return { path, workspace: await host.open(path) };
      },
      'workspace.current': async () => ({ workspace: host.dto() }),
      'workspace.setTrust': async ({ trusted }) => ({ workspace: host.setTrust(trusted) }),
      'project.inspect': async ({ path }) => inspectRegisteredProject(state, path),
      'project.listDir': async ({ path, dir, showIgnored }) => ({
        entries: await listRegisteredProjectDirectory(state, path, dir, showIgnored),
      }),
      'project.readFile': async ({ path, file }) => readRegisteredProjectFile(state, path, file),
      'project.setTrust': async ({ path, trusted }) => {
        if (host.current?.canonicalPath === path) {
          return { trustState: host.setTrust(trusted).trustState };
        }
        return { trustState: setRegisteredProjectTrust(state, path, trusted) };
      },

      'fs.listDir': async ({ dir, showIgnored }) => ({
        entries: await host.listDir(dir, showIgnored),
      }),
      'fs.create': async ({ parentDir, name, kind }) => ({
        path: await host.createEntry(parentDir, name, kind),
      }),
      'fs.rename': async ({ path, newName }) => ({
        newPath: await host.renameEntry(path, newName),
      }),
      'fs.trash': async ({ path }) => {
        await host.trashEntry(path);
        return { trashed: true };
      },
      'fs.openInBrowser': async ({ path }) => {
        await host.openInBrowser(path);
        return { opened: true };
      },

      'doc.open': async ({ path }) => ({
        doc: toDto(await host.mustActive().documents.open(path)),
      }),
      'doc.update': async ({ path, content }) => {
        const snapshot = host.mustActive().documents.updateBuffer(path, content);
        return { dirty: snapshot.dirty, bufferRevision: snapshot.bufferRevision };
      },
      'doc.save': async ({ path, content, force }) => {
        const docs = host.mustActive().documents;
        if (content !== undefined) docs.updateBuffer(path, content);
        return { doc: toDto(await docs.save(path, { force: force ?? false })) };
      },
      'doc.close': async ({ path }) => {
        host.mustActive().documents.close(path);
        return { closed: true };
      },
      'doc.resolveExternal': async ({ path, choice }) => ({
        doc: toDto(await host.mustActive().documents.resolveExternal(path, choice)),
      }),
      'doc.setEol': async ({ path, eol }) => ({
        doc: toDto(host.mustActive().documents.setEol(path, eol)),
      }),
      'doc.readDisk': async ({ path }) => {
        const ws = host.mustActive();
        try {
          const abs = await resolveInsideRoot(ws.canonicalPath, path);
          const content = await fs.readFile(abs, 'utf8');
          return { content, exists: true };
        } catch {
          return { content: '', exists: false };
        }
      },

      'tabs.get': async () => {
        const ws = host.current;
        if (!ws) return { tabs: null };
        const raw = state.getOpenTabs(ws.id);
        const parsed = OpenTabsStateSchema.safeParse(raw);
        return { tabs: parsed.success ? parsed.data : null };
      },
      'tabs.save': async ({ tabs }) => {
        const ws = host.current;
        if (ws) state.saveOpenTabs(ws.id, tabs);
        return { saved: Boolean(ws) };
      },
    },
    logger,
  );
}
