/**
 * External private-memory discovery (ADR-0028): surface Claude Code / Codex
 * memory files for view / edit / delete / promote. Read-only discovery over
 * known path conventions; Charter writes only on an explicit user action,
 * deletes back up first, and never touches session transcripts.
 *
 * Discovery returns opaque ids; every mutating call accepts ONLY those ids —
 * caller-supplied paths never reach the filesystem. Both the logical path and
 * its realpath must stay inside the agent's home root (symlink escapes fail
 * closed), mirroring the SkillStore guards.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { productError, ProductFailure } from '@pi-ide/foundation';
import type { ExternalMemoryAgent, ExternalMemoryFileDto } from '@pi-ide/ipc-contracts';
import { claudeProjectDirName } from '../cli-session-locator.js';
import { isInsidePath, writeFileAtomicDurable } from './fs-utils.js';

const READ_CAP = 512 * 1024;
const SUMMARY_SCAN_BYTES = 4096;
const MAX_MEMORY_NOTES = 200;
const MAX_PROJECT_GROUPS = 100;

interface KnownFile {
  absPath: string;
  agent: ExternalMemoryAgent;
  scope: 'global' | 'project';
  role: 'instructions' | 'memory-index' | 'memory';
}

export interface ExternalMemoryStoreOptions {
  /** Test seam (PI_IDE_MEMORY_HOME) — production uses the real home. */
  homeDir?: string;
  /** Backup directory for deletes (userData/memory/trash). */
  trashDir: string;
  now?: () => Date;
}

export interface KnownWorkspace {
  path: string;
  displayName: string;
}

/** One ~/.claude/projects/<munged>/memory group (IA v3). */
export interface ClaudeProjectGroup {
  key: string;
  displayName: string;
  /** Matched Charter project path; null = Claude-only directory. */
  projectPath: string | null;
  files: ExternalMemoryFileDto[];
}

function fail(code: string, userMessage: string, technicalMessage?: string): ProductFailure {
  return new ProductFailure(
    productError(code, { userMessage, technicalMessage: technicalMessage ?? userMessage }),
  );
}

export class ExternalMemoryStore {
  private readonly home: string;
  private readonly trashDir: string;
  private readonly now: () => Date;
  /** id → file. Accumulates across list() calls; ids are content-addressed and stable. */
  private readonly known = new Map<string, KnownFile>();

  constructor(options: ExternalMemoryStoreOptions) {
    this.home = options.homeDir ?? homedir();
    this.trashDir = options.trashDir;
    this.now = options.now ?? (() => new Date());
  }

  list(projectPath: string): ExternalMemoryFileDto[] {
    const out: ExternalMemoryFileDto[] = [];
    this.collect(out, 'claude', 'global', 'instructions', join(this.home, '.claude', 'CLAUDE.md'));
    this.collectClaudeProjectMemory(out, projectPath);
    this.collect(out, 'codex', 'global', 'instructions', join(this.home, '.codex', 'AGENTS.md'));
    return out;
  }

  /**
   * IA v3 spine: global files per agent + EVERY Claude auto-memory project
   * group under ~/.claude/projects (not just the focused project). Group dirs
   * matching a known Charter workspace (by munged literal or realpath) show
   * its display name; foreign dirs keep the raw munged name.
   */
  listAll(known: KnownWorkspace[]): {
    claudeGlobal: ExternalMemoryFileDto[];
    codexGlobal: ExternalMemoryFileDto[];
    claudeProjects: ClaudeProjectGroup[];
  } {
    const claudeGlobal: ExternalMemoryFileDto[] = [];
    this.collect(
      claudeGlobal,
      'claude',
      'global',
      'instructions',
      join(this.home, '.claude', 'CLAUDE.md'),
    );
    const codexGlobal: ExternalMemoryFileDto[] = [];
    this.collect(
      codexGlobal,
      'codex',
      'global',
      'instructions',
      join(this.home, '.codex', 'AGENTS.md'),
    );

    const byMunged = new Map<string, KnownWorkspace>();
    for (const ws of known) {
      byMunged.set(claudeProjectDirName(ws.path), ws);
      try {
        byMunged.set(claudeProjectDirName(realpathSync(ws.path)), ws);
      } catch {
        // unresolvable path — literal key stands
      }
    }

    const projectsRoot = join(this.home, '.claude', 'projects');
    let dirNames: string[] = [];
    try {
      dirNames = readdirSync(projectsRoot);
    } catch {
      dirNames = [];
    }
    const claudeProjects: ClaudeProjectGroup[] = [];
    // Charter-known projects first, so the group cap never hides them.
    dirNames.sort(
      (a, b) => Number(byMunged.has(b)) - Number(byMunged.has(a)) || a.localeCompare(b),
    );
    for (const dirName of dirNames) {
      if (claudeProjects.length >= MAX_PROJECT_GROUPS) break;
      const files: ExternalMemoryFileDto[] = [];
      this.collectMemoryDir(files, join(projectsRoot, dirName, 'memory'));
      if (files.length === 0) continue;
      const ws = byMunged.get(dirName) ?? null;
      claudeProjects.push({
        key: dirName,
        displayName: ws?.displayName ?? dirName,
        projectPath: ws?.path ?? null,
        files,
      });
    }
    // Matched Charter projects first, then Claude-only dirs; alpha within each.
    claudeProjects.sort(
      (a, b) =>
        Number(b.projectPath !== null) - Number(a.projectPath !== null) ||
        a.displayName.localeCompare(b.displayName),
    );
    return { claudeGlobal, codexGlobal, claudeProjects };
  }

  read(fileId: string): { content: string; truncated: boolean; path: string; mtimeMs: number } {
    const file = this.resolveKnown(fileId);
    const abs = this.guardedPath(file);
    const info = statSync(abs);
    const { text, sawNul } = readCapped(abs, READ_CAP);
    if (sawNul) {
      throw fail('MEMORY_FILE_BINARY', 'This file looks binary and cannot be viewed as memory.');
    }
    return {
      content: text,
      truncated: info.size > READ_CAP,
      path: this.displayPath(abs),
      mtimeMs: info.mtimeMs,
    };
  }

  write(
    fileId: string,
    content: string,
    expectedMtimeMs: number | null | undefined,
  ): ExternalMemoryFileDto {
    const file = this.resolveKnown(fileId);
    const abs = this.guardedPath(file);
    if (expectedMtimeMs !== null && expectedMtimeMs !== undefined && existsSync(abs)) {
      const current = statSync(abs).mtimeMs;
      if (Math.abs(current - expectedMtimeMs) > 1) {
        throw fail(
          'MEMORY_EXTERNAL_CONFLICT',
          'This file was just modified externally (the CLI may be writing) — reload before editing.',
        );
      }
    }
    writeFileAtomicDurable(abs, content);
    const dto = this.toDto(file, abs);
    if (!dto)
      throw fail('MEMORY_FILE_UNKNOWN', 'The file is no longer available — refresh the list.');
    return dto;
  }

  /** Backup-first delete. Returns the display path of the backup copy. */
  delete(fileId: string): { backedUpTo: string } {
    const file = this.resolveKnown(fileId);
    const abs = this.guardedPath(file);
    mkdirSync(this.trashDir, { recursive: true });
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    const backup = join(this.trashDir, `${stamp}-${file.agent}-${basename(abs)}`);
    copyFileSync(abs, backup);
    rmSync(abs);
    this.known.delete(fileId);
    return { backedUpTo: this.displayPath(backup) };
  }

  /** Promote reads the note body (frontmatter stripped, capped) for a candidate. */
  readForPromote(fileId: string): { text: string; file: KnownFile; displayPath: string } {
    const file = this.resolveKnown(fileId);
    const abs = this.guardedPath(file);
    const { text, sawNul } = readCapped(abs, READ_CAP);
    if (sawNul) {
      throw fail('MEMORY_FILE_BINARY', 'A binary file cannot be promoted to a rule.');
    }
    const body = stripFrontmatter(text).trim();
    const capped = body.length > 1000 ? `${body.slice(0, 1000)}…` : body;
    if (capped.length === 0) {
      throw fail('MEMORY_FILE_EMPTY', 'This file has no content to promote.');
    }
    return { text: capped, file, displayPath: this.displayPath(abs) };
  }

  // ---- internals ----

  private collectClaudeProjectMemory(out: ExternalMemoryFileDto[], projectPath: string): void {
    let real = projectPath;
    try {
      real = realpathSync(projectPath);
    } catch {
      // unopened path — munge the literal value, matching Claude's own cwd use
    }
    this.collectMemoryDir(
      out,
      join(this.home, '.claude', 'projects', claudeProjectDirName(real), 'memory'),
    );
  }

  private collectMemoryDir(out: ExternalMemoryFileDto[], dir: string): void {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // no auto-memory here — honest empty state
    }
    const noteNames = names
      .filter((name) => name.toLowerCase().endsWith('.md'))
      .sort((a, b) => (a === 'MEMORY.md' ? -1 : b === 'MEMORY.md' ? 1 : a.localeCompare(b)))
      .slice(0, MAX_MEMORY_NOTES);
    for (const name of noteNames) {
      const role = name === 'MEMORY.md' ? 'memory-index' : 'memory';
      this.collect(out, 'claude', 'project', role, join(dir, name));
    }
  }

  private collect(
    out: ExternalMemoryFileDto[],
    agent: ExternalMemoryAgent,
    scope: 'global' | 'project',
    role: 'instructions' | 'memory-index' | 'memory',
    absPath: string,
  ): void {
    let info;
    try {
      info = statSync(absPath);
    } catch {
      return;
    }
    if (!info.isFile()) return;
    const file: KnownFile = { absPath, agent, scope, role };
    try {
      this.guardedPath(file);
    } catch {
      return; // symlink escaping the agent root — skip silently, fail closed
    }
    const dto = this.toDto(file, absPath);
    if (!dto) return;
    this.known.set(dto.id, file);
    out.push(dto);
  }

  private toDto(file: KnownFile, absPath: string): ExternalMemoryFileDto | null {
    let info;
    try {
      info = statSync(absPath);
    } catch {
      return null;
    }
    const { text, sawNul } = readCapped(absPath, SUMMARY_SCAN_BYTES);
    return {
      id: fileIdFor(file.agent, absPath),
      agent: file.agent,
      scope: file.scope,
      role: file.role,
      label: basename(absPath),
      path: this.displayPath(absPath),
      summary: sawNul ? '(binary content)' : summarize(text),
      sizeBytes: info.size,
      updatedAt: new Date(info.mtimeMs).toISOString(),
      readable: !sawNul && info.size <= READ_CAP,
    };
  }

  private resolveKnown(fileId: string): KnownFile {
    const file = this.known.get(fileId);
    if (!file) {
      throw fail('MEMORY_FILE_UNKNOWN', 'The memory file list is stale — refresh and retry.');
    }
    return file;
  }

  /** Both the logical path and its realpath must stay inside the agent root. */
  private guardedPath(file: KnownFile): string {
    const root = join(this.home, file.agent === 'claude' ? '.claude' : '.codex');
    if (!isInsidePath(root, file.absPath)) {
      throw fail('MEMORY_PATH_ESCAPE', 'Path escapes the agent root — refused.', file.absPath);
    }
    let rootReal = root;
    try {
      rootReal = realpathSync(root);
    } catch {
      throw fail('MEMORY_PATH_ESCAPE', 'The agent root directory is unavailable.', root);
    }
    let real = file.absPath;
    try {
      real = realpathSync(file.absPath);
      if (!isInsidePath(rootReal, real) && real !== rootReal) {
        throw fail('MEMORY_PATH_ESCAPE', 'Symlink points outside the agent root — refused.', real);
      }
    } catch (error) {
      if (error instanceof ProductFailure) throw error;
      // File may not exist yet (write creates it) — the logical check above stands.
    }
    return file.absPath;
  }

  private displayPath(absPath: string): string {
    return absPath.startsWith(this.home) ? `~${absPath.slice(this.home.length)}` : absPath;
  }
}

function fileIdFor(agent: ExternalMemoryAgent, absPath: string): string {
  return createHash('sha256').update(`${agent}\0${absPath}`).digest('hex').slice(0, 16);
}

function readCapped(absPath: string, cap: number): { text: string; sawNul: boolean } {
  const fd = openSync(absPath, 'r');
  try {
    const buffer = Buffer.alloc(cap);
    const bytes = readSync(fd, buffer, 0, cap, 0);
    const slice = buffer.subarray(0, bytes);
    return { text: slice.toString('utf8'), sawNul: slice.includes(0) };
  } finally {
    closeSync(fd);
  }
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function summarize(text: string): string {
  const body = stripFrontmatter(text);
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const clean = trimmed.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '');
    if (clean.length === 0) continue;
    return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
  }
  return '(empty file)';
}
