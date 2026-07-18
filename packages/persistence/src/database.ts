import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { errorMessage, productError, ProductFailure } from '@pi-ide/foundation';

export interface Migration {
  version: number;
  name: string;
  up: string;
}

export interface SqlDatabase {
  readonly file: string;
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  transaction<T>(fn: () => T): T;
  checkpoint(): void;
  close(): void;
}

export interface OpenDatabaseOptions {
  file: string;
  migrations: Migration[];
  backupDir: string;
}

export interface OpenDatabaseResult {
  db: SqlDatabase;
  appliedVersions: number[];
  backupFile: string | null;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

class Database implements SqlDatabase {
  readonly file: string;
  private readonly raw: DatabaseSync;
  private inTransaction = false;

  constructor(file: string) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    this.raw.exec('PRAGMA synchronous = NORMAL;');
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  prepare(sql: string): StatementSync {
    return this.raw.prepare(sql);
  }

  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn(); // nested: join the outer transaction
    this.raw.exec('BEGIN IMMEDIATE;');
    this.inTransaction = true;
    try {
      const result = fn();
      this.raw.exec('COMMIT;');
      return result;
    } catch (e) {
      try {
        this.raw.exec('ROLLBACK;');
      } catch {
        // rollback failure is secondary; original error wins
      }
      throw e;
    } finally {
      this.inTransaction = false;
    }
  }

  checkpoint(): void {
    this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }

  close(): void {
    try {
      this.checkpoint();
    } catch {
      // best effort
    }
    this.raw.close();
  }
}

function backupNow(db: Database, backupDir: string, fromVersion: number): string {
  mkdirSync(backupDir, { recursive: true });
  db.checkpoint();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(backupDir, `${basename(db.file)}.v${fromVersion}.${stamp}.bak`);
  copyFileSync(db.file, target);
  return target;
}

function restoreBackup(file: string, backupFile: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = `${file}${suffix}`;
    if (suffix !== '' && existsSync(p)) rmSync(p);
  }
  copyFileSync(backupFile, file);
}

/**
 * Open the product database with WAL, checksum-verified migrations and
 * automatic pre-migration backup + restore-on-failure (REL-003 / UPD-004).
 */
export function openDatabase(opts: OpenDatabaseOptions): OpenDatabaseResult {
  const db = new Database(opts.file);
  try {
    const check = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    const quickCheck = check ? Object.values(check)[0] : 'ok';
    if (quickCheck !== 'ok') {
      throw new ProductFailure(
        productError('DB_CORRUPT', {
          userMessage: 'The local database failed its integrity check.',
          severity: 'fatal',
          context: { file: opts.file, quickCheck },
        }),
      );
    }

    db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         checksum TEXT NOT NULL,
         applied_at TEXT NOT NULL
       );`,
    );

    const applied = db
      .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number; name: string; checksum: string }>;

    const sorted = [...opts.migrations].sort((a, b) => a.version - b.version);
    for (const row of applied) {
      const migration = sorted.find((m) => m.version === row.version);
      if (migration && sha256(migration.up) !== row.checksum) {
        throw new ProductFailure(
          productError('DB_MIGRATION_CHECKSUM', {
            userMessage:
              'The database schema history does not match this application version. To protect your data the app stopped before making changes.',
            severity: 'fatal',
            context: { version: row.version, name: row.name },
          }),
        );
      }
    }

    const appliedMax = applied.length > 0 ? applied[applied.length - 1]!.version : 0;
    const pending = sorted.filter((m) => m.version > appliedMax);
    const appliedVersions: number[] = [];
    let backupFile: string | null = null;

    if (pending.length > 0) {
      if (appliedMax > 0) {
        backupFile = backupNow(db, opts.backupDir, appliedMax);
      }
      try {
        for (const migration of pending) {
          db.transaction(() => {
            db.exec(migration.up);
            db.prepare(
              'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
            ).run(
              migration.version,
              migration.name,
              sha256(migration.up),
              new Date().toISOString(),
            );
          });
          appliedVersions.push(migration.version);
        }
      } catch (e) {
        db.close();
        if (backupFile) {
          restoreBackup(opts.file, backupFile);
        }
        throw new ProductFailure(
          productError('DB_MIGRATION_FAILED', {
            userMessage:
              'A database upgrade failed. Your previous data was restored from the automatic backup.',
            severity: 'fatal',
            technicalMessage: errorMessage(e),
            context: { backupRestored: Boolean(backupFile) },
          }),
        );
      }
    }

    return { db, appliedVersions, backupFile };
  } catch (e) {
    try {
      db.close();
    } catch {
      // already closed on some paths
    }
    throw e;
  }
}
