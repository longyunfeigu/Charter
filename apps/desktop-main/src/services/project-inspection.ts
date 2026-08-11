import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { GitService } from '@pi-ide/git-service';
import { productError, ProductFailure } from '@pi-ide/foundation';
import type { ChannelResponse } from '@pi-ide/ipc-contracts';
import { listDirectory, openWorkspaceInfo, resolveInsideRoot } from '@pi-ide/workspace-service';
import type { StateService } from './state-service.js';
import { detectProjectKind } from './project-kind.js';

const PREVIEW_BYTES = 262_144;

interface RegisteredProjectRow {
  canonical_path: string;
  display_name: string;
  trust_state: string;
  last_opened_at: string;
}

function registeredProject(state: StateService, path: string): RegisteredProjectRow {
  const row = state.db
    .prepare(
      `SELECT canonical_path, display_name, trust_state, last_opened_at
       FROM workspaces WHERE canonical_path = ?`,
    )
    .get(path) as RegisteredProjectRow | undefined;
  if (!row) {
    throw new ProductFailure(
      productError('PROJECT_NOT_REGISTERED', {
        userMessage: 'This folder is not a saved Charter project.',
      }),
    );
  }
  return row;
}

function emptyGit(): ChannelResponse<'project.inspect'>['git'] {
  return {
    gitAvailable: true,
    isRepo: false,
    branch: null,
    branches: [],
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    head: null,
    entries: [] as Array<{
      path: string;
      origPath: string | null;
      group: 'staged' | 'changes' | 'untracked' | 'conflict';
      indexState: string;
      workState: string;
    }>,
    stats: [] as Array<{ path: string; insertions: number; deletions: number }>,
  };
}

export async function inspectRegisteredProject(state: StateService, path: string) {
  const row = registeredProject(state, path);
  if (!existsSync(row.canonical_path)) {
    return {
      path: row.canonical_path,
      displayName: row.display_name,
      lastOpenedAt: row.last_opened_at,
      kind: null,
      exists: false,
      trustState: row.trust_state === 'trusted' ? ('trusted' as const) : ('untrusted' as const),
      hasPiProjectResources: false,
      setup: { agentsMd: false, claudeMd: false, agentsDir: false, piDir: false },
      git: emptyGit(),
    };
  }

  const info = await openWorkspaceInfo(row.canonical_path);
  let git = emptyGit();
  if (info.isGitRepo) {
    try {
      const service = new GitService(info.canonicalPath);
      const detected = await service.detect();
      if (!detected.gitAvailable) {
        git = { ...git, gitAvailable: false };
      } else if (detected.isRepo) {
        const [status, stats, branches] = await Promise.all([
          service.status(),
          service.numstat().catch(() => []),
          service.branches().catch(() => []),
        ]);
        git = {
          gitAvailable: true,
          isRepo: true,
          branch: status.branch,
          branches,
          upstream: status.upstream,
          ahead: status.ahead,
          behind: status.behind,
          detached: detected.detached,
          head: detected.head,
          entries: status.entries.map((entry) => ({
            path: entry.path,
            origPath: entry.origPath,
            group: entry.group,
            indexState: entry.indexState,
            workState: entry.workState,
          })),
          stats: stats
            .filter((entry) => !entry.binary)
            .map((entry) => ({
              path: entry.path,
              insertions: entry.insertions,
              deletions: entry.deletions,
            })),
        };
      }
    } catch {
      // Project Center is observational. A broken repository still gets a
      // usable Overview/Files/Setup surface; Changes explains the unavailable data.
      git = { ...emptyGit(), gitAvailable: false, isRepo: true };
    }
  }

  const present = async (name: string): Promise<boolean> =>
    fs
      .stat(join(info.canonicalPath, name))
      .then(() => true)
      .catch(() => false);
  const [agentsMd, claudeMd, agentsDir, piDir] = await Promise.all([
    present('AGENTS.md'),
    present('CLAUDE.md'),
    present('.agents'),
    present('.pi'),
  ]);

  return {
    path: info.canonicalPath,
    displayName: info.displayName,
    lastOpenedAt: row.last_opened_at,
    kind: detectProjectKind(info.canonicalPath),
    exists: true,
    trustState: row.trust_state === 'trusted' ? ('trusted' as const) : ('untrusted' as const),
    hasPiProjectResources: info.hasPiProjectResources,
    setup: { agentsMd, claudeMd, agentsDir, piDir },
    git,
  };
}

export async function listRegisteredProjectDirectory(
  state: StateService,
  path: string,
  dir: string,
  showIgnored: boolean,
) {
  const row = registeredProject(state, path);
  return listDirectory(row.canonical_path, dir, { showIgnored, extraIgnores: [] });
}

export async function readRegisteredProjectFile(
  state: StateService,
  path: string,
  relativeFile: string,
) {
  const row = registeredProject(state, path);
  const absolute = await resolveInsideRoot(row.canonical_path, relativeFile);
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) {
    throw new ProductFailure(
      productError('PROJECT_FILE_INVALID', { userMessage: 'That project entry is not a file.' }),
    );
  }
  const handle = await fs.open(absolute, 'r');
  try {
    const bytesToRead = Math.min(stat.size, PREVIEW_BYTES);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    const slice = buffer.subarray(0, bytesRead);
    const binary = slice.includes(0);
    return {
      content: binary ? '' : slice.toString('utf8'),
      binary,
      truncated: stat.size > PREVIEW_BYTES,
      size: stat.size,
    };
  } finally {
    await handle.close();
  }
}

export function setRegisteredProjectTrust(
  state: StateService,
  path: string,
  trusted: boolean,
): 'trusted' | 'untrusted' {
  registeredProject(state, path);
  const trustState = trusted ? 'trusted' : 'untrusted';
  state.db
    .prepare('UPDATE workspaces SET trust_state = ? WHERE canonical_path = ?')
    .run(trustState, path);
  return trustState;
}
