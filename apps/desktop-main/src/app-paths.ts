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
  /** Project-memory scratch (ADR-0028) — external-memory delete backups live here. */
  memoryDir: string;
  /** SSH host-key trust store (ADR-0047) — trusted-hosts.json lives here. */
  sshDir: string;
  /** Encrypted SSH passwords/passphrases (ADR-0047), isolated from provider secrets. */
  sshSecretsDir: string;
  /** Sparse local mirrors backing managed remote Diff/Review sessions. */
  remoteMirrorsDir: string;
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
    memoryDir: join(userData, 'memory'),
    sshDir: join(userData, 'ssh'),
    sshSecretsDir: join(userData, 'secrets', 'ssh'),
    remoteMirrorsDir: join(userData, 'remote-mirrors'),
  };
  for (const dir of [
    paths.secretsDir,
    paths.workspacesDir,
    paths.runtimeDir,
    paths.backupsDir,
    paths.logsDir,
    paths.skillsDir,
    paths.memoryDir,
    paths.sshDir,
    paths.sshSecretsDir,
    paths.remoteMirrorsDir,
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
