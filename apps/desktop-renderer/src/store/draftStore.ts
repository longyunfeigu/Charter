import { create } from 'zustand';
import {
  MAX_CODE_CONTEXT_REFS,
  MAX_CODE_CONTEXT_TOTAL_CHARS,
  MAX_FILE_CONTEXT_IMAGES,
  MAX_FILE_CONTEXT_REFS,
  type ArtifactFeedbackRefDto,
  type CodeContextRefDto,
  type FileContextRefDto,
  type PreviewElementContextDto,
} from '@pi-ide/ipc-contracts';

/**
 * Per-task reply drafts (ADR-0014, PIVOT-036): session-scoped, shared by the
 * Task Room composer and the Editor agent panel so a half-typed reply survives
 * room → Editor → room round-trips. Never persisted to disk.
 */
interface DraftStore {
  drafts: Record<string, string>;
  terminalRefs: Record<string, TerminalOutputRef[]>;
  /** ADR-0022 am.2: one pending preview selection per task (replace on re-pick). */
  previewRefs: Record<string, PreviewFeedbackRef>;
  /** Frozen source selections waiting for the next turn, scoped to a Session. */
  codeRefs: Record<string, CodeContextRefDto[]>;
  /** ADR-0024: file / folder / image references waiting for the next turn. */
  fileRefs: Record<string, FileContextRefDto[]>;
  /** Semantic artifact anchors waiting for the next managed Session turn. */
  artifactRefs: Record<string, ArtifactFeedbackRefDto[]>;
  setDraft(taskId: string, text: string): void;
  clearDraft(taskId: string): void;
  addTerminalRef(taskId: string, ref: TerminalOutputRef): void;
  removeTerminalRef(taskId: string, refId: string): void;
  clearTerminalRefs(taskId: string): void;
  setPreviewRef(taskId: string, ref: PreviewFeedbackRef): void;
  clearPreviewRef(taskId: string): void;
  addCodeRef(taskId: string, ref: CodeContextRefDto): 'added' | 'duplicate' | 'limit' | 'too-large';
  removeCodeRef(taskId: string, refId: string): void;
  clearCodeRefs(taskId: string): void;
  addFileRef(
    taskId: string,
    ref: FileContextRefDto,
  ): 'added' | 'duplicate' | 'limit' | 'image-limit';
  removeFileRef(taskId: string, refId: string): void;
  clearFileRefs(taskId: string): void;
  addArtifactRef(taskId: string, ref: ArtifactFeedbackRefDto): 'added' | 'duplicate' | 'limit';
  removeArtifactRef(taskId: string, refId: string): void;
  clearArtifactRefs(taskId: string): void;
}

export interface TerminalOutputRef {
  id: string;
  title: string;
  text: string;
  cwd: string;
  contextLabel: string;
  lineCount: number;
}

/** Stable selector fallback — avoids a new empty array on every Zustand read. */
export const EMPTY_CODE_CONTEXT_REFS: CodeContextRefDto[] = [];

/** Stable selector fallback for file references (ADR-0024). */
export const EMPTY_FILE_REFS: FileContextRefDto[] = [];

export const EMPTY_ARTIFACT_REFS: ArtifactFeedbackRefDto[] = [];

/** A picked element / drawn region from the live preview, waiting in the
 * composer (ADR-0022 am.2). `dataBase64` is null when capture failed —
 * feedback then travels text-only. */
export interface PreviewFeedbackRef {
  id: string;
  dataBase64: string | null;
  thumbDataUrl: string;
  pageUrl: string;
  rect: { x: number; y: number; width: number; height: number };
  selector: string | null;
  elementContext: PreviewElementContextDto | null;
}

export const useDraftStore = create<DraftStore>((set, get) => ({
  drafts: {},
  terminalRefs: {},
  previewRefs: {},
  codeRefs: {},
  fileRefs: {},
  artifactRefs: {},
  setDraft(taskId, text) {
    set({ drafts: { ...get().drafts, [taskId]: text } });
  },
  clearDraft(taskId) {
    const drafts = { ...get().drafts };
    delete drafts[taskId];
    set({ drafts });
  },
  addTerminalRef(taskId, ref) {
    const current = get().terminalRefs[taskId] ?? [];
    set({ terminalRefs: { ...get().terminalRefs, [taskId]: [...current, ref].slice(-4) } });
  },
  removeTerminalRef(taskId, refId) {
    set({
      terminalRefs: {
        ...get().terminalRefs,
        [taskId]: (get().terminalRefs[taskId] ?? []).filter((ref) => ref.id !== refId),
      },
    });
  },
  clearTerminalRefs(taskId) {
    const terminalRefs = { ...get().terminalRefs };
    delete terminalRefs[taskId];
    set({ terminalRefs });
  },
  setPreviewRef(taskId, ref) {
    set({ previewRefs: { ...get().previewRefs, [taskId]: ref } });
  },
  clearPreviewRef(taskId) {
    const previewRefs = { ...get().previewRefs };
    delete previewRefs[taskId];
    set({ previewRefs });
  },
  addCodeRef(taskId, ref) {
    const current = get().codeRefs[taskId] ?? [];
    const duplicate = current.some(
      (item) =>
        item.path === ref.path &&
        item.version === ref.version &&
        item.startLine === ref.startLine &&
        item.startColumn === ref.startColumn &&
        item.endLine === ref.endLine &&
        item.endColumn === ref.endColumn &&
        item.selectionHash === ref.selectionHash,
    );
    if (duplicate) return 'duplicate';
    if (current.length >= MAX_CODE_CONTEXT_REFS) return 'limit';
    const nextChars = current.reduce((sum, item) => sum + item.text.length, 0) + ref.text.length;
    if (nextChars > MAX_CODE_CONTEXT_TOTAL_CHARS) return 'too-large';
    set({ codeRefs: { ...get().codeRefs, [taskId]: [...current, ref] } });
    return 'added';
  },
  removeCodeRef(taskId, refId) {
    set({
      codeRefs: {
        ...get().codeRefs,
        [taskId]: (get().codeRefs[taskId] ?? []).filter((ref) => ref.id !== refId),
      },
    });
  },
  clearCodeRefs(taskId) {
    const codeRefs = { ...get().codeRefs };
    delete codeRefs[taskId];
    set({ codeRefs });
  },
  addFileRef(taskId, ref) {
    const current = get().fileRefs[taskId] ?? [];
    // Path refs dedupe on path; attachment refs on their imported id.
    const duplicate = current.some((item) =>
      ref.path ? item.path === ref.path : item.attachmentId === ref.attachmentId,
    );
    if (duplicate) return 'duplicate';
    if (current.length >= MAX_FILE_CONTEXT_REFS) return 'limit';
    const images = current.filter((item) => item.kind === 'image').length;
    if (ref.kind === 'image' && images >= MAX_FILE_CONTEXT_IMAGES) return 'image-limit';
    set({ fileRefs: { ...get().fileRefs, [taskId]: [...current, ref] } });
    return 'added';
  },
  removeFileRef(taskId, refId) {
    set({
      fileRefs: {
        ...get().fileRefs,
        [taskId]: (get().fileRefs[taskId] ?? []).filter((ref) => ref.id !== refId),
      },
    });
  },
  clearFileRefs(taskId) {
    const fileRefs = { ...get().fileRefs };
    delete fileRefs[taskId];
    set({ fileRefs });
  },
  addArtifactRef(taskId, ref) {
    const current = get().artifactRefs[taskId] ?? [];
    const duplicate = current.some(
      (item) =>
        item.path === ref.path &&
        item.contentHash === ref.contentHash &&
        JSON.stringify(item.anchor) === JSON.stringify(ref.anchor) &&
        item.note === ref.note,
    );
    if (duplicate) return 'duplicate';
    if (current.length >= 4) return 'limit';
    set({ artifactRefs: { ...get().artifactRefs, [taskId]: [...current, ref] } });
    return 'added';
  },
  removeArtifactRef(taskId, refId) {
    set({
      artifactRefs: {
        ...get().artifactRefs,
        [taskId]: (get().artifactRefs[taskId] ?? []).filter((ref) => ref.id !== refId),
      },
    });
  },
  clearArtifactRefs(taskId) {
    const artifactRefs = { ...get().artifactRefs };
    delete artifactRefs[taskId];
    set({ artifactRefs });
  },
}));
