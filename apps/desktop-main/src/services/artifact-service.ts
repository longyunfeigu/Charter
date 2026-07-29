import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { extname } from 'node:path';
import { detectBinary, productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import type { SqlDatabase } from '@pi-ide/persistence';
import { resolveInsideRoot } from '@pi-ide/workspace-service';
import type {
  ArchiveEntryDto,
  ArtifactDescriptorDto,
  ArtifactDiagnosticDto,
  ArtifactFeedbackRefDto,
  ArtifactKind,
  ArtifactOpenResultDto,
  ArtifactVersionDto,
} from '@pi-ide/ipc-contracts';
import type { TaskService } from './task-service.js';

const TEXT_LIMIT = 4 * 1024 * 1024;
const TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_ARCHIVE_ENTRIES = 2000;

interface LedgerRow {
  relative_path: string;
  kind: 'created' | 'modified' | 'deleted' | 'renamed';
  before_hash: string | null;
  after_hash: string | null;
  rename_to: string | null;
  created_at: string;
}

interface RawVersion {
  hash: string;
  createdAt: string;
}

interface ArtifactHistory {
  path: string;
  versions: RawVersion[];
  currentHash: string | null;
  updatedAt: string;
}

interface ResourceGrant {
  taskId: string;
  root: string;
  path: string;
  hash: string;
  mimeType: string;
  kind: ArtifactKind;
  htmlMode: 'safe' | 'interactive';
  nonce: string;
  expiresAt: number;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.aac': 'audio/aac',
  '.avif': 'image/avif',
  '.avi': 'video/x-msvideo',
  '.bmp': 'image/bmp',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.m4v': 'video/mp4',
  '.md': 'text/markdown; charset=utf-8',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.ogv': 'video/ogg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.zip': 'application/zip',
};

const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.css',
  '.go',
  '.h',
  '.hpp',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.log',
  '.md',
  '.mjs',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
]);
const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.heif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
]);
const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.oga', '.ogg', '.wav']);
const VIDEO_EXTENSIONS = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.ogv', '.webm']);
const ARCHIVE_EXTENSIONS = new Set(['.7z', '.gz', '.rar', '.tar', '.tgz', '.zip']);

function artifactFailure(code: string, userMessage: string): ProductFailure {
  return new ProductFailure(productError(code, { userMessage }));
}

export function classifyArtifact(
  path: string,
  bytes: Buffer,
): { kind: ArtifactKind; mimeType: string } {
  const extension = extname(path).toLowerCase();
  const mimeType = MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
  if (extension === '.csv' || extension === '.tsv') return { kind: 'table', mimeType };
  if (extension === '.html' || extension === '.htm') return { kind: 'html', mimeType };
  if (extension === '.pdf') return { kind: 'pdf', mimeType };
  if (IMAGE_EXTENSIONS.has(extension)) return { kind: 'image', mimeType };
  if (AUDIO_EXTENSIONS.has(extension)) return { kind: 'audio', mimeType };
  if (VIDEO_EXTENSIONS.has(extension)) return { kind: 'video', mimeType };
  if (ARCHIVE_EXTENSIONS.has(extension)) return { kind: 'archive', mimeType };
  if (TEXT_EXTENSIONS.has(extension) || !detectBinary(bytes.subarray(0, 64 * 1024))) {
    return {
      kind: 'text',
      mimeType: mimeType === 'application/octet-stream' ? 'text/plain; charset=utf-8' : mimeType,
    };
  }
  return { kind: 'binary', mimeType };
}

/** Lightweight source-level checks for problems a renderer cannot repair. */
export function inspectPdfDiagnostics(bytes: Buffer): ArtifactDiagnosticDto[] {
  const source = bytes.toString('latin1');
  const hasUnicodeMap = /\/ToUnicode\b/u.test(source);
  const hasUnmappedSymbolFont =
    /\/BaseFont\s*\/[^\s/]*(?:ZapfDingbats|Symbol)\b/u.test(source) && !hasUnicodeMap;
  if (!hasUnmappedSymbolFont) return [];
  return [
    {
      code: 'pdf.symbol_font_without_unicode',
      level: 'warning',
      title: 'Source PDF may contain unrecoverable glyph substitutions',
      message:
        'This version uses a symbol font without a Unicode map. If text appears as squares or symbols, those original characters are not present in the PDF and the previewer cannot reconstruct them.',
      repairHint:
        'Regenerate this PDF from the source using an embedded CJK font, then replace this artifact with the corrected PDF.',
    },
  ];
}

/** Reads only ZIP central-directory metadata. Entry contents are never extracted. */
export function parseZipManifest(bytes: Buffer): {
  entries: ArchiveEntryDto[];
  truncated: boolean;
} {
  const eocdSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const lowerBound = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= lowerBound; offset -= 1) {
    if (bytes.readUInt32LE(offset) === eocdSignature) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > bytes.length) return { entries: [], truncated: false };
  const declaredEntries = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize > bytes.length || centralOffset > eocd) {
    return { entries: [], truncated: false };
  }
  const entries: ArchiveEntryDto[] = [];
  let cursor = centralOffset;
  let visited = 0;
  while (visited < declaredEntries && cursor + 46 <= centralOffset + centralSize) {
    if (bytes.readUInt32LE(cursor) !== centralSignature) break;
    const compressedBytes = bytes.readUInt32LE(cursor + 20);
    const sizeBytes = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (nameLength === 0 || next > centralOffset + centralSize || next > bytes.length) break;
    const path = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const safePath =
      path.length <= 4000 &&
      !path.includes('\u0000') &&
      !path.startsWith('/') &&
      !/^[A-Za-z]:[\\/]/u.test(path) &&
      !path.split(/[\\/]/u).includes('..');
    if (safePath) {
      if (entries.length < MAX_ARCHIVE_ENTRIES) {
        entries.push({
          path,
          compressedBytes,
          sizeBytes,
          directory: path.endsWith('/'),
        });
      }
    }
    visited += 1;
    cursor = next;
  }
  return { entries, truncated: visited < declaredEntries || declaredEntries > MAX_ARCHIVE_ENTRIES };
}

function rangeFor(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match) return null;
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (!startText && !endText) return null;
  let start: number;
  let end: number;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
  }
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

function pickerScript(nonce: string): string {
  return `<script nonce="${nonce}">(() => {
    let active = false;
    let hovered = null;
    let hoveredOutline = '';
    let selected = null;
    let selectedOutline = '';
    const clearHover = () => {
      if (hovered && hovered !== selected) hovered.style.outline = hoveredOutline;
      hovered = null; hoveredOutline = '';
    };
    const clearSelection = () => {
      if (selected) selected.style.outline = selectedOutline;
      selected = null; selectedOutline = '';
    };
    const setActive = (next) => {
      active = next;
      document.documentElement.style.cursor = next ? 'crosshair' : '';
      if (!next) clearHover();
      parent.postMessage({ type: 'charter-artifact-picker-state', active: next }, '*');
    };
    const selector = (element) => {
      if (element.id) return '#' + CSS.escape(element.id);
      const parts = [];
      let node = element;
      while (node && node.nodeType === 1 && parts.length < 6) {
        let part = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const peers = [...parent.children].filter((item) => item.tagName === node.tagName);
          if (peers.length > 1) part += ':nth-of-type(' + (peers.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(' > ');
    };
    addEventListener('message', (event) => {
      if (event.source !== parent || event.data?.type !== 'charter-artifact-pick') return;
      if (event.data.action === 'clear') {
        clearHover(); clearSelection(); setActive(false); return;
      }
      setActive(event.data.action !== 'cancel');
    });
    addEventListener('keydown', (event) => {
      if (!active || event.key !== 'Escape') return;
      event.preventDefault(); event.stopImmediatePropagation(); setActive(false);
    }, true);
    addEventListener('pointerover', (event) => {
      if (!active || !(event.target instanceof Element)) return;
      clearHover(); hovered = event.target; hoveredOutline = hovered.style.outline;
      hovered.style.outline = '2px dashed #e06a3b';
    }, true);
    addEventListener('click', (event) => {
      if (!active || !(event.target instanceof Element)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      clearHover(); clearSelection(); selected = event.target; selectedOutline = selected.style.outline;
      selected.style.outline = '2px solid #e06a3b';
      const rect = event.target.getBoundingClientRect();
      parent.postMessage({ type: 'charter-artifact-picked', selector: selector(event.target), rect: {
        x: rect.x / innerWidth, y: rect.y / innerHeight,
        width: rect.width / innerWidth, height: rect.height / innerHeight
      }, viewport: { width: innerWidth, height: innerHeight } }, '*');
      setActive(false);
    }, true);
    parent.postMessage({ type: 'charter-artifact-picker-ready' }, '*');
  })();</script>`;
}

function prepareHtml(bytes: Buffer, grant: ResourceGrant): Buffer {
  let source = bytes
    .toString('utf8')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/giu, '');
  if (grant.htmlMode === 'safe') {
    source = source.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, '');
  }
  const injected = pickerScript(grant.nonce);
  const html = /<\/body\s*>/iu.test(source)
    ? source.replace(/<\/body\s*>/iu, `${injected}</body>`)
    : `${source}${injected}`;
  return Buffer.from(html, 'utf8');
}

export class ArtifactService {
  private readonly grants = new Map<string, ResourceGrant>();

  constructor(
    private readonly db: SqlDatabase,
    private readonly tasks: TaskService,
    private readonly logger: Logger,
  ) {}

  private histories(taskId: string): Map<string, ArtifactHistory> {
    this.tasks.getTask(taskId);
    const rows = this.db
      .prepare(
        `SELECT relative_path, kind, before_hash, after_hash, rename_to, created_at
         FROM file_changes WHERE task_id = ? ORDER BY created_at, id`,
      )
      .all(taskId) as unknown as LedgerRow[];
    const histories = new Map<string, ArtifactHistory>();
    const get = (path: string, at: string): ArtifactHistory => {
      const existing = histories.get(path);
      if (existing) return existing;
      const created = { path, versions: [], currentHash: null, updatedAt: at };
      histories.set(path, created);
      return created;
    };
    const push = (history: ArtifactHistory, hash: string | null, at: string): void => {
      if (hash && !history.versions.some((version) => version.hash === hash)) {
        history.versions.push({ hash, createdAt: at });
      }
      history.currentHash = hash;
      history.updatedAt = at;
    };
    for (const row of rows) {
      const history = get(row.relative_path, row.created_at);
      if (history.versions.length === 0 && row.before_hash)
        push(history, row.before_hash, row.created_at);
      if (row.kind === 'renamed') {
        history.currentHash = null;
        history.updatedAt = row.created_at;
        if (row.rename_to && row.after_hash)
          push(get(row.rename_to, row.created_at), row.after_hash, row.created_at);
      } else {
        push(history, row.kind === 'deleted' ? null : row.after_hash, row.created_at);
      }
    }
    return histories;
  }

  private async versions(taskId: string, history: ArtifactHistory): Promise<ArtifactVersionDto[]> {
    const blobs = this.tasks.contextForTask(taskId).blobs;
    return Promise.all(
      history.versions.map(async (version, index) => ({
        contentHash: version.hash,
        version: index + 1,
        sizeBytes: (await blobs.get(version.hash))?.length ?? 0,
        createdAt: version.createdAt,
        isCurrent: version.hash === history.currentHash,
      })),
    );
  }

  private async descriptor(
    taskId: string,
    history: ArtifactHistory,
    hash: string,
  ): Promise<ArtifactDescriptorDto> {
    const task = this.tasks.getTask(taskId);
    const bytes = await this.tasks.contextForTask(taskId).blobs.get(hash);
    if (!bytes)
      throw artifactFailure(
        'ARTIFACT_BLOB_MISSING',
        'This artifact snapshot is no longer available.',
      );
    const classification = classifyArtifact(history.path, bytes);
    const currentIndex = Math.max(
      0,
      history.versions.findIndex((version) => version.hash === history.currentHash),
    );
    return {
      taskId,
      path: history.path,
      contentHash: history.currentHash ?? hash,
      kind: classification.kind,
      mimeType: classification.mimeType,
      sizeBytes: bytes.length,
      currentVersion: currentIndex + 1,
      versionCount: history.versions.length,
      updatedAt: history.updatedAt,
      producer: task.external?.cli ?? 'charter',
      captureGrade: task.external?.captureGrade ?? (task.external ? 'observed' : 'full'),
    };
  }

  async list(taskId: string): Promise<ArtifactDescriptorDto[]> {
    const histories = [...this.histories(taskId).values()].filter((history) => history.currentHash);
    const artifacts = await Promise.all(
      histories.map((history) => this.descriptor(taskId, history, history.currentHash!)),
    );
    return artifacts.sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path),
    );
  }

  private history(taskId: string, path: string): ArtifactHistory {
    const history = this.histories(taskId).get(path);
    if (!history || history.versions.length === 0) {
      throw artifactFailure(
        'ARTIFACT_NOT_FOUND',
        'That file is not part of this Session artifact history.',
      );
    }
    return history;
  }

  async validateFeedbackRefs(
    refs: readonly ArtifactFeedbackRefDto[],
  ): Promise<ArtifactFeedbackRefDto[]> {
    const validated: ArtifactFeedbackRefDto[] = [];
    for (const ref of refs) {
      const history = this.history(ref.taskId, ref.path);
      if (!history.versions.some((version) => version.hash === ref.contentHash)) {
        throw artifactFailure(
          'ARTIFACT_HASH_MISMATCH',
          'The referenced artifact version does not belong to this Session.',
        );
      }
      const bytes = await this.tasks.contextForTask(ref.taskId).blobs.get(ref.contentHash);
      if (!bytes || classifyArtifact(ref.path, bytes).kind !== ref.artifactKind) {
        throw artifactFailure(
          'ARTIFACT_KIND_MISMATCH',
          'The referenced artifact type does not match its immutable content.',
        );
      }
      validated.push({ ...ref, staleAtSend: history.currentHash !== ref.contentHash });
    }
    return validated;
  }

  async open(input: {
    taskId: string;
    path: string;
    contentHash?: string;
    htmlMode: 'safe' | 'interactive';
  }): Promise<ArtifactOpenResultDto> {
    const history = this.history(input.taskId, input.path);
    if (!history.currentHash)
      throw artifactFailure('ARTIFACT_DELETED', 'This artifact was deleted in the Session.');
    const requestedHash = input.contentHash ?? history.currentHash;
    if (!history.versions.some((version) => version.hash === requestedHash)) {
      throw artifactFailure(
        'ARTIFACT_HASH_MISMATCH',
        'The requested version does not belong to this artifact.',
      );
    }
    const context = this.tasks.contextForTask(input.taskId);
    const bytes = await context.blobs.get(requestedHash);
    if (!bytes)
      throw artifactFailure(
        'ARTIFACT_BLOB_MISSING',
        'This artifact snapshot is no longer available.',
      );
    const artifact = await this.descriptor(input.taskId, history, history.currentHash);
    const versions = await this.versions(input.taskId, history);
    let text: string | null = null;
    let textTruncated = false;
    if (['text', 'table', 'html'].includes(classifyArtifact(input.path, bytes).kind)) {
      textTruncated = bytes.length > TEXT_LIMIT;
      text = bytes.subarray(0, TEXT_LIMIT).toString('utf8');
    }
    const diagnostics = artifact.kind === 'pdf' ? inspectPdfDiagnostics(bytes) : [];
    let archiveEntries: ArchiveEntryDto[] = [];
    let archiveTruncated = false;
    if (artifact.kind === 'archive' && extname(input.path).toLowerCase() === '.zip') {
      const manifest = parseZipManifest(bytes);
      archiveEntries = manifest.entries;
      archiveTruncated = manifest.truncated;
    }
    const streamable = ['image', 'pdf', 'audio', 'video', 'html'].includes(artifact.kind);
    const assetUrl = streamable
      ? this.issueGrant({
          taskId: input.taskId,
          root: context.root,
          path: input.path,
          hash: requestedHash,
          mimeType: classifyArtifact(input.path, bytes).mimeType,
          kind: classifyArtifact(input.path, bytes).kind,
          htmlMode: input.htmlMode,
        })
      : null;
    return {
      artifact,
      versions,
      requestedHash,
      stale: requestedHash !== history.currentHash,
      text,
      textTruncated,
      assetUrl,
      diagnostics,
      archiveEntries,
      archiveTruncated,
    };
  }

  private issueGrant(input: Omit<ResourceGrant, 'nonce' | 'expiresAt'>): string {
    const now = Date.now();
    for (const [key, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(key);
    const token = randomBytes(24).toString('hex');
    this.grants.set(token, {
      ...input,
      nonce: randomBytes(18).toString('base64url'),
      expiresAt: now + TOKEN_TTL_MS,
    });
    const encodedPath = input.path.split('/').map(encodeURIComponent).join('/');
    return `artifact://asset/${token}/${encodedPath}`;
  }

  async reveal(taskId: string, path: string, action: 'reveal' | 'open'): Promise<void> {
    const history = this.history(taskId, path);
    if (!history.currentHash)
      throw artifactFailure('ARTIFACT_DELETED', 'This artifact was deleted in the Session.');
    const absolutePath = await resolveInsideRoot(this.tasks.contextForTask(taskId).root, path);
    const { shell } = await import('electron');
    if (action === 'reveal') shell.showItemInFolder(absolutePath);
    else {
      const error = await shell.openPath(absolutePath);
      if (error) throw artifactFailure('ARTIFACT_OPEN_FAILED', error);
    }
  }

  async handleResource(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const token = segments.shift();
      const grant = token ? this.grants.get(token) : null;
      if (!grant || grant.expiresAt <= Date.now()) return new Response('expired', { status: 410 });
      const requestedPath = segments.join('/');
      if (!requestedPath) return new Response('not found', { status: 404 });
      let bytes: Buffer;
      let mimeType: string;
      if (requestedPath === grant.path) {
        const stored = await this.tasks.contextForTask(grant.taskId).blobs.get(grant.hash);
        if (!stored) return new Response('not found', { status: 404 });
        bytes = stored;
        mimeType = grant.mimeType;
        if (grant.kind === 'html') bytes = prepareHtml(bytes, grant);
        if (grant.kind === 'image' && /\.(?:heic|heif)$/iu.test(grant.path)) {
          const { nativeImage } = await import('electron');
          const converted = nativeImage.createFromBuffer(bytes).toPNG();
          if (converted.length > 0) {
            bytes = converted;
            mimeType = 'image/png';
          }
        }
      } else {
        const absolutePath = await resolveInsideRoot(grant.root, requestedPath);
        bytes = await fs.readFile(absolutePath);
        mimeType =
          MIME_BY_EXTENSION[extname(requestedPath).toLowerCase()] ?? 'application/octet-stream';
      }
      const headers = new Headers({
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=60',
      });
      if (grant.kind === 'html' && requestedPath === grant.path) {
        const scripts =
          grant.htmlMode === 'interactive' ? `'unsafe-inline' artifact:` : `'nonce-${grant.nonce}'`;
        headers.set(
          'Content-Security-Policy',
          `default-src 'none'; script-src ${scripts}; style-src artifact: 'unsafe-inline'; img-src artifact: data:; media-src artifact:; font-src artifact: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`,
        );
      }
      const requestedRange = request.headers.get('range');
      const range = rangeFor(requestedRange, bytes.length);
      if (requestedRange && !range) {
        headers.set('Content-Range', `bytes */${bytes.length}`);
        return new Response(null, { status: 416, headers });
      }
      if (range) {
        const body = bytes.subarray(range.start, range.end + 1);
        headers.set('Content-Length', String(body.length));
        headers.set('Content-Range', `bytes ${range.start}-${range.end}/${bytes.length}`);
        return new Response(new Uint8Array(body), { status: 206, headers });
      }
      headers.set('Content-Length', String(bytes.length));
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), {
        status: 200,
        headers,
      });
    } catch (error) {
      this.logger.warn('artifact protocol request failed', {
        url: request.url.slice(0, 500),
        error: error instanceof Error ? error.message : String(error),
      });
      return new Response('forbidden', { status: 403 });
    }
  }
}
