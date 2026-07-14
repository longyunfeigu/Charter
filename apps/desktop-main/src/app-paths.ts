import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** AppData layout per spec §11.1. All product state lives under Electron userData. */
export interface AppPaths {
  userData: string;
  databaseFile: string;
  settingsFile: string;
  secretsDir: string;
  workspacesDir: string;
  runtimeDir: string;
  backupsDir: string;
  logsDir: string;
  /** Managed skills store (ADR-0015) — imported SKILL.md folders live here. */
  skillsDir: string;
}

export function createAppPaths(userData: string): AppPaths {
  const paths: AppPaths = {
    userData,
    databaseFile: join(userData, 'app.db'),
    settingsFile: join(userData, 'settings.json'),
    secretsDir: join(userData, 'secrets'),
    workspacesDir: join(userData, 'workspaces'),
    runtimeDir: join(userData, 'runtime'),
    backupsDir: join(userData, 'backups'),
    logsDir: join(userData, 'logs'),
    skillsDir: join(userData, 'skills'),
  };
  for (const dir of [
    paths.secretsDir,
    paths.workspacesDir,
    paths.runtimeDir,
    paths.backupsDir,
    paths.logsDir,
    paths.skillsDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  return paths;
}

export function workspaceDataDir(paths: AppPaths, workspaceId: string): string {
  const dir = join(paths.workspacesDir, workspaceId);
  mkdirSync(join(dir, 'checkpoints'), { recursive: true });
  mkdirSync(join(dir, 'attachments'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}
