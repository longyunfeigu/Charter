import { promises as fs } from 'node:fs';
import { openSync, writeSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  detectBinary,
  detectEol,
  errorMessage,
  normalizeToEol,
  productError,
  ProductFailure,
  type EolStyle,
} from '@pi-ide/foundation';
import { resolveInsideRoot } from '@pi-ide/workspace-service';

export type ExternalState = 'clean' | 'externallyModified' | 'externallyDeleted';

export interface DocumentSnapshot {
  relativePath: string;
  content: string;
  editable: boolean;
  diskRevision: number;
  bufferRevision: number;
  savedRevision: number;
  contentHash: string;
  diskHash: string | null;
  dirty: boolean;
  eol: EolStyle;
  encoding: 'utf8' | 'utf8-bom';
  binary: boolean;
  largeFile: boolean;
  readonly: boolean;
  externalState: ExternalState;
  sizeBytes: number;
}

interface DocumentEntry extends DocumentSnapshot {
  ownWriteUntil: number;
  ownWriteHash: string | null;
}

export interface DocumentStoreOptions {
  largeFileBytes?: number;
  maxEditableBytes?: number;
}

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

function docError(
  code: string,
  userMessage: string,
  context?: Record<string, unknown>,
): ProductFailure {
  return new ProductFailure(productError(code, { userMessage, context }));
}

const BOM = '﻿';

/**
 * Single source of truth for open documents (spec §6.4): buffer/disk revisions,
 * content hashes, dirty state, external-change arbitration and atomic saves.
 * Agent reads/patches and the Monaco UI both go through this store.
 */
export class DocumentStore {
  private readonly docs = new Map<string, DocumentEntry>();
  private readonly largeFileBytes: number;
  private readonly maxEditableBytes: number;
  private readonly listeners = new Set<(doc: DocumentSnapshot) => void>();

  constructor(
    readonly root: string,
    options: DocumentStoreOptions = {},
  ) {
    this.largeFileBytes = options.largeFileBytes ?? 10 * 1024 * 1024;
    this.maxEditableBytes = options.maxEditableBytes ?? 50 * 1024 * 1024;
  }

  onDidChange(listener: (doc: DocumentSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(doc: DocumentEntry): void {
    const snapshot = this.snapshotOf(doc);
    for (const listener of this.listeners) listener(snapshot);
  }

  private snapshotOf(doc: DocumentEntry): DocumentSnapshot {
    const { ownWriteUntil: _o, ownWriteHash: _h, ...snapshot } = doc;
    return { ...snapshot };
  }

  get(relativePath: string): DocumentSnapshot | null {
    const doc = this.docs.get(relativePath);
    return doc ? this.snapshotOf(doc) : null;
  }

  openDocuments(): DocumentSnapshot[] {
    return [...this.docs.values()].map((d) => this.snapshotOf(d));
  }

  isOpen(relativePath: string): boolean {
    return this.docs.has(relativePath);
  }

  async open(relativePath: string): Promise<DocumentSnapshot> {
    const existing = this.docs.get(relativePath);
    if (existing) return this.snapshotOf(existing);

    const abs = await resolveInsideRoot(this.root, relativePath);
    let buffer: Buffer;
    let readonly = false;
    try {
      buffer = await fs.readFile(abs);
    } catch (e) {
      throw docError('DOC_READ_FAILED', 'The file could not be read.', {
        relativePath,
        cause: errorMessage(e),
      });
    }
    try {
      await fs.access(abs, fs.constants.W_OK);
    } catch {
      readonly = true;
    }

    const binary = detectBinary(buffer);
    const editable = !binary && buffer.length <= this.maxEditableBytes;
    let content = '';
    let encoding: 'utf8' | 'utf8-bom' = 'utf8';
    if (editable) {
      content = buffer.toString('utf8');
      if (content.startsWith(BOM)) {
        encoding = 'utf8-bom';
        content = content.slice(1);
      }
    }
    const diskHash = sha256(buffer);
    const doc: DocumentEntry = {
      relativePath,
      content,
      editable,
      diskRevision: 1,
      bufferRevision: 1,
      savedRevision: 1,
      contentHash: sha256(content),
      diskHash,
      dirty: false,
      eol: binary ? 'lf' : detectEol(content),
      encoding,
      binary,
      largeFile: buffer.length > this.largeFileBytes,
      readonly,
      externalState: 'clean',
      sizeBytes: buffer.length,
      ownWriteUntil: 0,
      ownWriteHash: null,
    };
    this.docs.set(relativePath, doc);
    return this.snapshotOf(doc);
  }

  private mustGet(relativePath: string): DocumentEntry {
    const doc = this.docs.get(relativePath);
    if (!doc) {
      throw docError('DOC_NOT_OPEN', 'The document is not open.', { relativePath });
    }
    return doc;
  }

  updateBuffer(relativePath: string, content: string): DocumentSnapshot {
    const doc = this.mustGet(relativePath);
    if (doc.binary) {
      throw docError('DOC_BINARY', 'Binary files cannot be edited as text.');
    }
    if (content !== doc.content) {
      doc.content = content;
      doc.bufferRevision += 1;
      doc.contentHash = sha256(content);
      doc.dirty = doc.bufferRevision !== doc.savedRevision;
    }
    return this.snapshotOf(doc);
  }

  setEol(relativePath: string, eol: EolStyle): DocumentSnapshot {
    const doc = this.mustGet(relativePath);
    if (doc.eol !== eol) {
      doc.content = normalizeToEol(doc.content, eol);
      doc.eol = eol;
      doc.bufferRevision += 1;
      doc.contentHash = sha256(doc.content);
      doc.dirty = true;
    }
    return this.snapshotOf(doc);
  }

  /** Atomic save: temp file in same directory + fsync + rename (WS-007). */
  async save(relativePath: string, options: { force?: boolean } = {}): Promise<DocumentSnapshot> {
    const doc = this.mustGet(relativePath);
    if (doc.binary) throw docError('DOC_BINARY', 'Binary files cannot be saved as text.');
    if (doc.readonly) {
      throw docError('DOC_READONLY', 'The file is read-only.', { relativePath });
    }
    const abs = await resolveInsideRoot(this.root, relativePath);

    if (!options.force) {
      // Detect disk drift since our last known disk state (save conflict).
      let currentDiskHash: string | null = null;
      try {
        currentDiskHash = sha256(await fs.readFile(abs));
      } catch {
        currentDiskHash = null; // deleted externally
      }
      if (
        doc.externalState === 'externallyModified' ||
        (currentDiskHash !== null && doc.diskHash !== null && currentDiskHash !== doc.diskHash)
      ) {
        doc.externalState = 'externallyModified';
        this.emit(doc);
        throw docError(
          'DOC_SAVE_CONFLICT',
          'The file changed on disk while you were editing. Choose Reload, Compare or Keep before saving.',
          { relativePath },
        );
      }
    }

    const payload = (doc.encoding === 'utf8-bom' ? BOM : '') + doc.content;
    const data = Buffer.from(payload, 'utf8');
    const tmp = join(dirname(abs), `.pi-ide.${process.pid}.${Date.now()}.tmp`);
    try {
      const fd = openSync(tmp, 'w');
      try {
        writeSync(fd, data);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, abs);
    } catch (e) {
      try {
        await fs.rm(tmp, { force: true });
      } catch {
        // best effort cleanup
      }
      throw docError(
        'DOC_SAVE_FAILED',
        'The file could not be saved. The original file is unchanged.',
        {
          relativePath,
          cause: errorMessage(e),
        },
      );
    }

    doc.savedRevision = doc.bufferRevision;
    doc.dirty = false;
    doc.diskRevision += 1;
    doc.diskHash = sha256(data);
    doc.sizeBytes = data.length;
    doc.externalState = 'clean';
    doc.ownWriteUntil = Date.now() + 2500;
    doc.ownWriteHash = doc.diskHash;
    this.emit(doc);
    return this.snapshotOf(doc);
  }

  /** Watcher hook: true when the last disk change was our own atomic save. */
  isOwnWrite(relativePath: string): boolean {
    const doc = this.docs.get(relativePath);
    if (!doc) return false;
    return doc.ownWriteUntil > Date.now();
  }

  /**
   * Called by the file watcher for modified/deleted events. Returns the updated
   * snapshot, or null when the event was our own write (suppressed).
   */
  async handleExternalChange(relativePath: string): Promise<DocumentSnapshot | null> {
    const doc = this.docs.get(relativePath);
    if (!doc) return null;

    const abs = await resolveInsideRoot(this.root, relativePath);
    let buffer: Buffer | null = null;
    try {
      buffer = await fs.readFile(abs);
    } catch {
      buffer = null;
    }

    if (buffer !== null && this.isOwnWrite(relativePath) && sha256(buffer) === doc.ownWriteHash) {
      doc.ownWriteUntil = 0;
      return null;
    }

    if (buffer === null) {
      doc.externalState = 'externallyDeleted';
      doc.diskHash = null;
      doc.dirty = true;
      this.emit(doc);
      return this.snapshotOf(doc);
    }

    const newDiskHash = sha256(buffer);
    if (doc.diskHash === newDiskHash) return null; // no real content change

    if (!doc.dirty) {
      // Clean buffer: auto-reload (§6.4).
      let content = buffer.toString('utf8');
      if (content.startsWith(BOM)) content = content.slice(1);
      doc.content = content;
      doc.contentHash = sha256(content);
      doc.diskHash = newDiskHash;
      doc.diskRevision += 1;
      doc.bufferRevision += 1;
      doc.savedRevision = doc.bufferRevision;
      doc.eol = detectEol(content);
      doc.sizeBytes = buffer.length;
      doc.externalState = 'clean';
      this.emit(doc);
      return this.snapshotOf(doc);
    }

    doc.externalState = 'externallyModified';
    doc.diskRevision += 1;
    doc.diskHash = newDiskHash;
    this.emit(doc);
    return this.snapshotOf(doc);
  }

  /** Resolve an external-change conflict: reload (take disk) or keep (keep buffer). */
  async resolveExternal(
    relativePath: string,
    choice: 'reload' | 'keep',
  ): Promise<DocumentSnapshot> {
    const doc = this.mustGet(relativePath);
    if (choice === 'reload') {
      const abs = await resolveInsideRoot(this.root, relativePath);
      let buffer: Buffer;
      try {
        buffer = await fs.readFile(abs);
      } catch {
        throw docError('DOC_READ_FAILED', 'The file no longer exists on disk.', { relativePath });
      }
      let content = buffer.toString('utf8');
      if (content.startsWith(BOM)) content = content.slice(1);
      doc.content = content;
      doc.contentHash = sha256(content);
      doc.diskHash = sha256(buffer);
      doc.bufferRevision += 1;
      doc.savedRevision = doc.bufferRevision;
      doc.dirty = false;
      doc.eol = detectEol(content);
      doc.externalState = 'clean';
    } else {
      // Keep the buffer: rebase onto current disk state; next save writes deliberately.
      const abs = await resolveInsideRoot(this.root, relativePath);
      try {
        doc.diskHash = sha256(await fs.readFile(abs));
      } catch {
        doc.diskHash = null;
      }
      doc.externalState = 'clean';
      doc.dirty = true;
    }
    this.emit(doc);
    return this.snapshotOf(doc);
  }

  /** Read logical content for tools: open document buffer, else disk (spec: read_file uses the store). */
  async readLogical(relativePath: string): Promise<{
    content: string;
    hash: string;
    fromBuffer: boolean;
    eol: EolStyle;
    binary: boolean;
    sizeBytes: number;
  }> {
    const doc = this.docs.get(relativePath);
    if (doc) {
      return {
        content: doc.content,
        hash: doc.contentHash,
        fromBuffer: doc.dirty,
        eol: doc.eol,
        binary: doc.binary,
        sizeBytes: doc.sizeBytes,
      };
    }
    const abs = await resolveInsideRoot(this.root, relativePath);
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(abs);
    } catch (e) {
      throw docError('DOC_READ_FAILED', 'The file could not be read.', {
        relativePath,
        cause: errorMessage(e),
      });
    }
    const binary = detectBinary(buffer);
    let content = binary ? '' : buffer.toString('utf8');
    if (content.startsWith(BOM)) content = content.slice(1);
    return {
      content,
      hash: sha256(content),
      fromBuffer: false,
      eol: binary ? 'lf' : detectEol(content),
      binary,
      sizeBytes: buffer.length,
    };
  }

  close(relativePath: string): void {
    this.docs.delete(relativePath);
  }

  closeAll(): void {
    this.docs.clear();
  }

  dirtyDocuments(): DocumentSnapshot[] {
    return this.openDocuments().filter((d) => d.dirty);
  }
}
