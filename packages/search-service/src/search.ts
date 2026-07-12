import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import ignoreFactory from 'ignore';
import { DEFAULT_IGNORES, resolveInsideRoot } from '@pi-ide/workspace-service';
import { detectBinary } from '@pi-ide/foundation';

export interface TextSearchOptions {
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  includeGlob?: string;
  excludeGlob?: string;
  maxResults: number;
}

export interface SearchMatch {
  line: number; // 1-based
  column: number; // 1-based
  matchText: string;
  previewText: string;
  absoluteStart: number;
  absoluteEnd: number;
}

export interface SearchGroup {
  path: string;
  contentHash: string;
  matches: SearchMatch[];
}

export interface TextSearchResult {
  groups: SearchGroup[];
  truncated: boolean;
  cancelled: boolean;
  usedRipgrep: boolean;
}

export interface ReplacementRequest {
  path: string;
  expectedHash: string;
  edits: Array<{ start: number; end: number; text: string }>;
}

export interface ReplacementOutcome {
  path: string;
  status: 'applied' | 'stale' | 'error';
  detail?: string;
}

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Locate a usable ripgrep binary (ADR-0003): env → @vscode/ripgrep → well-known paths → PATH. */
export function resolveRgPath(): string | null {
  const fromEnv = process.env.PI_IDE_RG_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rgModule = require('@vscode/ripgrep') as { rgPath?: string };
    if (rgModule.rgPath && existsSync(rgModule.rgPath)) return rgModule.rgPath;
  } catch {
    // dependency present but binary download may have been blocked
  }
  for (const candidate of ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg']) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const MAX_SCAN_FILE_BYTES = 4 * 1024 * 1024;

export class SearchService {
  private rgPath: string | null | undefined;

  constructor(
    private readonly root: string,
    private readonly extraIgnores: string[],
  ) {}

  private rg(): string | null {
    if (this.rgPath === undefined) this.rgPath = resolveRgPath();
    return this.rgPath;
  }

  /** Full workspace file list (relative paths) for Quick Open. */
  async listFiles(limit = 60000, signal?: AbortSignal): Promise<string[]> {
    const rg = this.rg();
    if (rg) {
      try {
        return await this.listFilesWithRg(rg, limit, signal);
      } catch {
        // fall back below
      }
    }
    return this.listFilesJs(limit, signal);
  }

  private listFilesWithRg(rg: string, limit: number, signal?: AbortSignal): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const args = ['--files', '--hidden', '--follow', '--glob', '!.git/**'];
      for (const glob of [...DEFAULT_IGNORES, ...this.extraIgnores]) {
        args.push(
          '--glob',
          `!${glob.includes('/') || glob.includes('*') ? glob : `**/${glob}/**`}`,
        );
      }
      const child = spawn(rg, args, { cwd: this.root });
      const files: string[] = [];
      let buffer = '';
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve(files);
      };
      signal?.addEventListener('abort', () => {
        child.kill('SIGTERM');
        finish();
      });
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line) files.push(line);
          if (files.length >= limit) {
            child.kill('SIGTERM');
            finish();
            return;
          }
        }
      });
      child.on('error', reject);
      child.on('close', finish);
    });
  }

  private async listFilesJs(limit: number, signal?: AbortSignal): Promise<string[]> {
    const matcher = ignoreFactory().add(DEFAULT_IGNORES).add(this.extraIgnores);
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      if (signal?.aborted || files.length >= limit) return;
      let entries;
      try {
        entries = await fs.readdir(join(this.root, dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (signal?.aborted || files.length >= limit) return;
        const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
        if (matcher.ignores(entry.isDirectory() ? `${rel}/` : rel) || matcher.ignores(entry.name)) {
          continue;
        }
        if (entry.isDirectory()) await walk(rel);
        else if (entry.isFile()) files.push(rel);
      }
    };
    await walk('');
    return files;
  }

  async textSearch(options: TextSearchOptions, signal?: AbortSignal): Promise<TextSearchResult> {
    if (signal?.aborted) {
      return { groups: [], truncated: false, cancelled: true, usedRipgrep: false };
    }
    // JS engine gives us exact absolute offsets against a content snapshot, which the
    // replace pipeline requires. rg pre-filters candidate files for large workspaces.
    let candidates: string[];
    const rg = this.rg();
    let usedRipgrep = false;
    if (rg) {
      try {
        candidates = await this.rgCandidateFiles(rg, options, signal);
        usedRipgrep = true;
      } catch {
        candidates = await this.listFiles(60000, signal);
      }
    } else {
      candidates = await this.listFiles(60000, signal);
    }

    if (options.includeGlob || options.excludeGlob) {
      const include = options.includeGlob ? ignoreFactory().add(options.includeGlob) : null;
      const exclude = options.excludeGlob ? ignoreFactory().add(options.excludeGlob) : null;
      candidates = candidates.filter((path) => {
        if (include && !include.ignores(path)) return false;
        if (exclude && exclude.ignores(path)) return false;
        return true;
      });
    }

    let regex: RegExp;
    try {
      const source = options.isRegex
        ? options.query
        : options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const wrapped = options.wholeWord ? `\\b(?:${source})\\b` : source;
      regex = new RegExp(wrapped, options.caseSensitive ? 'g' : 'gi');
    } catch (e) {
      throw new Error(`Invalid search pattern: ${e instanceof Error ? e.message : String(e)}`);
    }

    const groups: SearchGroup[] = [];
    let total = 0;
    let truncated = false;
    for (const path of candidates) {
      if (signal?.aborted) {
        return { groups, truncated, cancelled: true, usedRipgrep };
      }
      if (total >= options.maxResults) {
        truncated = true;
        break;
      }
      let raw: Buffer;
      try {
        const abs = await resolveInsideRoot(this.root, path);
        const stat = await fs.stat(abs);
        if (stat.size > MAX_SCAN_FILE_BYTES) continue;
        raw = await fs.readFile(abs);
      } catch {
        continue;
      }
      if (detectBinary(raw)) continue;
      const content = raw.toString('utf8');
      const matches: SearchMatch[] = [];
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(content)) !== null) {
        if (m[0].length === 0) {
          regex.lastIndex += 1;
          continue;
        }
        const before = content.slice(0, m.index);
        const line = before.split('\n').length;
        const lineStart = before.lastIndexOf('\n') + 1;
        const lineEnd = content.indexOf('\n', m.index);
        matches.push({
          line,
          column: m.index - lineStart + 1,
          matchText: m[0],
          previewText: content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).slice(0, 400),
          absoluteStart: m.index,
          absoluteEnd: m.index + m[0].length,
        });
        total++;
        if (total >= options.maxResults) {
          truncated = true;
          break;
        }
      }
      if (matches.length > 0) {
        groups.push({ path, contentHash: sha256(content), matches });
      }
    }
    return { groups, truncated, cancelled: false, usedRipgrep };
  }

  private rgCandidateFiles(
    rg: string,
    options: TextSearchOptions,
    signal?: AbortSignal,
  ): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const args = ['--files-with-matches', '--hidden', '--glob', '!.git/**'];
      for (const glob of [...DEFAULT_IGNORES, ...this.extraIgnores]) {
        args.push(
          '--glob',
          `!${glob.includes('/') || glob.includes('*') ? glob : `**/${glob}/**`}`,
        );
      }
      if (!options.caseSensitive) args.push('--ignore-case');
      if (options.wholeWord) args.push('--word-regexp');
      if (!options.isRegex) args.push('--fixed-strings');
      args.push('--regexp', options.query, './');
      const child = spawn(rg, args, { cwd: this.root });
      const files: string[] = [];
      let buffer = '';
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(files);
      };
      signal?.addEventListener('abort', () => {
        child.kill('SIGTERM');
        finish();
      });
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line) files.push(line.replace(/^\.\//, ''));
        }
      });
      child.on('error', (e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
      child.on('close', finish);
    });
  }

  /** Apply replacements with per-file content-hash verification (SRCH-004). */
  async applyReplacements(requests: ReplacementRequest[]): Promise<ReplacementOutcome[]> {
    const outcomes: ReplacementOutcome[] = [];
    for (const request of requests) {
      try {
        const abs = await resolveInsideRoot(this.root, request.path);
        const content = await fs.readFile(abs, 'utf8');
        if (sha256(content) !== request.expectedHash) {
          outcomes.push({ path: request.path, status: 'stale' });
          continue;
        }
        const sorted = [...request.edits].sort((a, b) => b.start - a.start);
        let next = content;
        for (const edit of sorted) {
          next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
        }
        const tmp = `${abs}.pi-ide-replace.tmp`;
        await fs.writeFile(tmp, next, 'utf8');
        await fs.rename(tmp, abs);
        outcomes.push({ path: request.path, status: 'applied' });
      } catch (e) {
        outcomes.push({
          path: request.path,
          status: 'error',
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return outcomes;
  }
}
