import React, { useEffect, useState } from 'react';
import { create } from 'zustand';
import { monaco, modelUri } from '../monaco-setup.js';
import { onEvent, rpcResult } from '../bridge.js';
import { useEditorStore, replaceModelContent } from '../store/editorStore.js';
import { useAppStore } from '../store/appStore.js';
import { revealPosition } from '../views/SearchView.js';

const CODE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const PROJECT_LOAD_LIMIT = 500;

export function configureTypescriptDefaults(): void {
  const compilerOptions: Parameters<
    typeof monaco.typescript.typescriptDefaults.setCompilerOptions
  >[0] = {
    target: monaco.typescript.ScriptTarget.ESNext,
    module: monaco.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
    jsx: monaco.typescript.JsxEmit.ReactJSX,
    allowJs: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    noEmit: true,
  };
  monaco.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
  monaco.typescript.javascriptDefaults.setCompilerOptions(compilerOptions);
  monaco.typescript.typescriptDefaults.setEagerModelSync(true);
  monaco.typescript.javascriptDefaults.setEagerModelSync(true);
}

interface TsProjectState {
  loaded: boolean;
  degraded: boolean;
  fileCount: number;
}
export const useTsProject = create<TsProjectState>(() => ({
  loaded: false,
  degraded: false,
  fileCount: 0,
}));

async function ensureModel(path: string): Promise<boolean> {
  if (monaco.editor.getModel(modelUri(path))) return true;
  const res = await rpcResult('doc.readDisk', { path });
  if (!res.ok || !res.data.exists) return false;
  try {
    monaco.editor.createModel(res.data.content, undefined, modelUri(path));
    return true;
  } catch {
    return false;
  }
}

export async function loadProjectModels(allFiles: string[]): Promise<void> {
  const code = allFiles.filter((p) => CODE_FILE_RE.test(p) || p.endsWith('.json'));
  const degraded = code.length > PROJECT_LOAD_LIMIT;
  const toLoad = degraded ? [] : code;
  let loaded = 0;
  const batch = 24;
  for (let i = 0; i < toLoad.length; i += batch) {
    await Promise.all(
      toLoad.slice(i, i + batch).map(async (path) => {
        if (await ensureModel(path)) loaded += 1;
      }),
    );
  }
  useTsProject.setState({ loaded: true, degraded, fileCount: loaded });
}

/** Keep project models in sync with fs changes. */
function wireModelSync(): void {
  onEvent('fs.batch', ({ changes }) => {
    for (const change of changes) {
      if (change.isDirectory) continue;
      const model = monaco.editor.getModel(modelUri(change.relativePath));
      if (!model) {
        if (
          change.kind !== 'deleted' &&
          CODE_FILE_RE.test(change.relativePath) &&
          useTsProject.getState().loaded &&
          !useTsProject.getState().degraded
        ) {
          void ensureModel(change.relativePath);
        }
        continue;
      }
      if (change.kind === 'deleted') {
        // Keep models for open tabs (editor handles deletion UX); drop background models.
        const open = useEditorStore
          .getState()
          .groups.some((g) => g.tabs.some((t) => t.path === change.relativePath));
        if (!open) model.dispose();
      } else if (change.kind === 'modified') {
        const open = useEditorStore
          .getState()
          .groups.some((g) => g.tabs.some((t) => t.path === change.relativePath));
        if (!open) {
          void rpcResult('doc.readDisk', { path: change.relativePath }).then((res) => {
            if (res.ok && res.data.exists && model.getValue() !== res.data.content) {
              model.setValue(res.data.content);
            }
          });
        }
      }
    }
  });
}

/** F12-style definition targets open in real editor tabs. */
function wireEditorOpener(): void {
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== 'pi-ws') return false;
      const path = resource.path.slice(1);
      void useEditorStore
        .getState()
        .openFile(path)
        .then(() => {
          if (!selectionOrPosition) return;
          const position =
            'startLineNumber' in selectionOrPosition
              ? {
                  lineNumber: selectionOrPosition.startLineNumber,
                  column: selectionOrPosition.startColumn,
                }
              : selectionOrPosition;
          revealPosition(path, position.lineNumber, position.column);
        });
      return true;
    },
  });
}

// ---------------- rename with preview + version verification (LSP-008) ----------------

interface RenameEdit {
  path: string;
  start: number;
  end: number;
  newText: string;
  line: number;
  preview: string;
}

interface RenameLocation {
  fileName: string;
  textSpan: { start: number; length: number };
}

interface RenameState {
  open: boolean;
  phase: 'input' | 'preview';
  targetName: string;
  newName: string;
  locations: RenameLocation[];
  edits: RenameEdit[];
  apply: (() => Promise<void>) | null;
}
export const useRenameStore = create<RenameState>(() => ({
  open: false,
  phase: 'input',
  targetName: '',
  newName: '',
  locations: [],
  edits: [],
  apply: null,
}));

/** Bound to F2 by MonacoPane at editor creation (LSP-008 product rename flow). */
export async function triggerRename(): Promise<void> {
  await startRenameFlow();
}

async function startRenameFlow(): Promise<void> {
  const editorState = useEditorStore.getState();
  const activePath = editorState.groups[editorState.activeGroup]?.active;
  if (!activePath || !/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(activePath)) {
    useAppStore.getState().pushToast('info', 'Rename works in TypeScript/JavaScript files.');
    return;
  }
  const model = monaco.editor.getModel(modelUri(activePath));
  const editor = monaco.editor.getEditors().find((e) => e.getModel() === model);
  if (!model || !editor) return;
  const position = editor.getPosition();
  if (!position) return;
  const offset = model.getOffsetAt(position);
  const word = model.getWordAtPosition(position);
  if (!word) return;

  const workerFactory = await monaco.typescript.getTypeScriptWorker();
  const worker = await workerFactory(model.uri);
  const locations = (await worker.findRenameLocations(
    model.uri.toString(),
    offset,
    false,
    false,
    false,
  )) as RenameLocation[] | undefined;
  if (!locations || locations.length === 0) {
    useAppStore.getState().pushToast('info', 'Nothing to rename here.');
    return;
  }

  useRenameStore.setState({
    open: true,
    phase: 'input',
    targetName: word.word,
    newName: word.word,
    locations,
    edits: [],
    apply: null,
  });
}

export function confirmRenameName(newName: string): void {
  const { targetName, locations } = useRenameStore.getState();
  if (!newName || newName === targetName) {
    useRenameStore.setState({ open: false });
    return;
  }
  const edits: RenameEdit[] = [];
  for (const location of locations) {
    const uri = monaco.Uri.parse(location.fileName);
    const targetModel = monaco.editor.getModel(uri);
    if (!targetModel) continue;
    const startPos = targetModel.getPositionAt(location.textSpan.start);
    const lineContent = targetModel.getLineContent(startPos.lineNumber);
    edits.push({
      path: uri.path.slice(1),
      start: location.textSpan.start,
      end: location.textSpan.start + location.textSpan.length,
      newText: newName,
      line: startPos.lineNumber,
      preview: lineContent.trim().slice(0, 160),
    });
  }

  useRenameStore.setState({
    phase: 'preview',
    newName,
    edits,
    apply: async () => {
      // Group by file; apply via models (open docs go through save; background models persisted with hash check).
      const byFile = new Map<string, RenameEdit[]>();
      for (const edit of edits) {
        const list = byFile.get(edit.path) ?? [];
        list.push(edit);
        byFile.set(edit.path, list);
      }
      const editorStore = useEditorStore.getState();
      const openPaths = new Set(editorStore.groups.flatMap((g) => g.tabs.map((t) => t.path)));
      const backgroundWrites: Array<{
        path: string;
        expectedHash: string;
        edits: Array<{ start: number; end: number; text: string }>;
      }> = [];

      for (const [path, fileEdits] of byFile) {
        const targetModel = monaco.editor.getModel(modelUri(path));
        if (!targetModel) continue;
        const sorted = [...fileEdits].sort((a, b) => b.start - a.start);
        if (openPaths.has(path)) {
          targetModel.pushEditOperations(
            [],
            sorted.map((e) => ({
              range: monaco.Range.fromPositions(
                targetModel.getPositionAt(e.start),
                targetModel.getPositionAt(e.end),
              ),
              text: e.newText,
            })),
            () => null,
          );
          await editorStore.save(path);
        } else {
          // Version-checked disk write for files not open in the editor.
          const disk = await rpcResult('doc.readDisk', { path });
          if (!disk.ok || !disk.data.exists) continue;
          if (disk.data.content !== targetModel.getValue()) {
            useAppStore
              .getState()
              .pushToast(
                'warning',
                `${path} changed on disk — rename skipped there. Re-run rename.`,
              );
            continue;
          }
          const hash = await sha256Hex(disk.data.content);
          backgroundWrites.push({
            path,
            expectedHash: hash,
            edits: sorted.map((e) => ({ start: e.start, end: e.end, text: e.newText })),
          });
        }
      }
      if (backgroundWrites.length > 0) {
        const res = await rpcResult('search.replace', { files: backgroundWrites });
        if (res.ok) {
          for (const outcome of res.data.outcomes) {
            if (outcome.status === 'applied') {
              const disk = await rpcResult('doc.readDisk', { path: outcome.path });
              const model = monaco.editor.getModel(modelUri(outcome.path));
              if (model && disk.ok && disk.data.exists) model.setValue(disk.data.content);
            } else {
              useAppStore
                .getState()
                .pushToast('warning', `Rename skipped in ${outcome.path} (${outcome.status}).`);
            }
          }
        }
      }
      useRenameStore.setState({ open: false, edits: [], apply: null });
      useAppStore.getState().pushToast('success', `Renamed to "${newName}".`);
    },
  });
}

export function RenamePreviewOverlay(): React.JSX.Element | null {
  const state = useRenameStore();
  if (!state.open) return null;
  if (state.phase === 'input') {
    return (
      <div className="modal-backdrop">
        <div
          className="modal small"
          role="dialog"
          aria-label="Rename symbol"
          data-testid="rename-input-dialog"
        >
          <div className="modal-header">
            Rename <span className="mono">&nbsp;{state.targetName}</span>
          </div>
          <div style={{ padding: 16 }}>
            <input
              autoFocus
              data-testid="rename-input"
              defaultValue={state.targetName}
              style={{
                width: '100%',
                background: 'var(--bg-input)',
                border: '1px solid var(--accent)',
                borderRadius: 4,
                padding: '6px 10px',
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter')
                  confirmRenameName((e.target as HTMLInputElement).value.trim());
                if (e.key === 'Escape') useRenameStore.setState({ open: false });
              }}
            />
            <div className="text-muted" style={{ fontSize: 11, marginTop: 8 }}>
              {state.locations.length} location(s) will be shown for preview. Enter to continue.
            </div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-label="Rename preview" data-testid="rename-preview">
        <div className="modal-header">
          <span>
            Rename <span className="mono">{state.targetName}</span> →{' '}
            <span className="mono">{state.newName}</span> ({state.edits.length} locations)
          </span>
          <button
            className="modal-close"
            aria-label="Close"
            onClick={() => useRenameStore.setState({ open: false, apply: null })}
          >
            ✕
          </button>
        </div>
        <div className="modal-body" style={{ fontSize: 12 }}>
          {state.edits.map((edit, i) => (
            <div
              key={i}
              className="mono"
              style={{ padding: '4px 14px', borderBottom: '1px solid var(--border)' }}
            >
              <span className="text-muted">
                {edit.path}:{edit.line}
              </span>{' '}
              {edit.preview}
            </div>
          ))}
        </div>
        <div
          style={{
            padding: 12,
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
            borderTop: '1px solid var(--border)',
          }}
        >
          <button
            className="btn"
            onClick={() => useRenameStore.setState({ open: false, apply: null })}
          >
            Cancel
          </button>
          <button
            className="btn primary"
            data-testid="rename-apply"
            onClick={() => void state.apply?.()}
          >
            Apply rename
          </button>
        </div>
      </div>
    </div>
  );
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------- python providers ----------------

interface PyStatus {
  available: boolean;
  running: boolean;
  hint: string;
}
export const usePythonStatus = create<PyStatus>(() => ({
  available: false,
  running: false,
  hint: '',
}));

function wirePython(): void {
  void rpcResult('lsp.status', {}).then((res) => {
    if (res.ok) usePythonStatus.setState(res.data.python);
  });
  onEvent('workspace.changed', () => {
    setTimeout(() => {
      void rpcResult('lsp.status', {}).then((res) => {
        if (res.ok) usePythonStatus.setState(res.data.python);
      });
    }, 1500);
  });

  onEvent('lsp.pythonDiagnostics', ({ path, diagnostics }) => {
    const model = monaco.editor.getModel(modelUri(path));
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      'pylsp',
      diagnostics.map((d) => ({
        message: d.message,
        severity:
          d.severity === 1
            ? monaco.MarkerSeverity.Error
            : d.severity === 2
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
        startLineNumber: d.startLine + 1,
        startColumn: d.startCharacter + 1,
        endLineNumber: d.endLine + 1,
        endColumn: d.endCharacter + 1,
        source: d.source ?? 'python',
      })),
    );
  });

  const pyRequest = async (
    method: 'completion' | 'hover' | 'definition' | 'symbols',
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ) => {
    const res = await rpcResult('lsp.pythonRequest', {
      method,
      path: model.uri.path.slice(1),
      line: position.lineNumber - 1,
      character: position.column - 1,
    });
    return res.ok ? res.data.result : null;
  };

  monaco.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.'],
    async provideCompletionItems(model, position) {
      const result = (await pyRequest('completion', model, position)) as
        | { items?: Array<{ label: string; kind?: number; insertText?: string; detail?: string }> }
        | Array<{ label: string; kind?: number; insertText?: string; detail?: string }>
        | null;
      const items = Array.isArray(result) ? result : (result?.items ?? []);
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      );
      return {
        suggestions: items.slice(0, 200).map((item) => ({
          label: item.label,
          kind: monaco.languages.CompletionItemKind.Text,
          insertText: item.insertText ?? item.label,
          detail: item.detail,
          range,
        })),
      };
    },
  });

  monaco.languages.registerHoverProvider('python', {
    async provideHover(model, position) {
      const result = (await pyRequest('hover', model, position)) as {
        contents?: unknown;
      } | null;
      if (!result?.contents) return null;
      const contents = result.contents as
        string | { value?: string } | Array<string | { value?: string }>;
      const parts = (Array.isArray(contents) ? contents : [contents]).map((c) =>
        typeof c === 'string' ? c : (c.value ?? ''),
      );
      return { contents: parts.filter(Boolean).map((value) => ({ value })) };
    },
  });

  monaco.languages.registerDefinitionProvider('python', {
    async provideDefinition(model, position) {
      const result = (await pyRequest('definition', model, position)) as Array<{
        path: string;
        range?: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        };
      }> | null;
      if (!result) return null;
      const out: monaco.languages.Location[] = [];
      for (const location of result) {
        if (!location.range) continue;
        await ensureModel(location.path);
        out.push({
          uri: modelUri(location.path),
          range: new monaco.Range(
            location.range.start.line + 1,
            location.range.start.character + 1,
            location.range.end.line + 1,
            location.range.end.character + 1,
          ),
        });
      }
      return out;
    },
  });
}

export function PythonBanner(): React.JSX.Element | null {
  const status = usePythonStatus();
  const active = useEditorStore((s) => s.groups[s.activeGroup]?.active);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => setDismissed(false), [active]);
  if (!active || !active.endsWith('.py') || dismissed) return null;
  if (status.running) return null;
  return (
    <div
      role="status"
      data-testid="python-lsp-banner"
      style={{
        padding: '6px 12px',
        fontSize: 12,
        background: 'var(--bg-card)',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        gap: 8,
        alignItems: 'center',
      }}
    >
      <span style={{ flex: 1 }}>
        {status.hint ||
          'Python language server not detected. Install `python-lsp-server` (pip install python-lsp-server) for diagnostics, completion and go-to-definition.'}
      </span>
      <button className="modal-close" aria-label="Dismiss" onClick={() => setDismissed(true)}>
        ✕
      </button>
    </div>
  );
}

export function initIntelligence(): void {
  configureTypescriptDefaults();
  wireEditorOpener();
  wireModelSync();
  wirePython();

  window.addEventListener('keydown', (e) => {
    if (e.key === 'F2') {
      e.preventDefault();
      void startRenameFlow();
    }
  });
}
