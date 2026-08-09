import React, { useCallback, useEffect, useRef, useState } from 'react';
import { monaco, modelUri, monacoFontFamily, monacoThemeName } from '../monaco-setup.js';
import { onEvent, rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { useEditorStore } from '../store/editorStore.js';
import { diffTabId, type DiffTab } from '../store/editor-tabs.js';
import { editorFontFamily } from '../appearance.js';
import { Ic } from '../views/home-icons.js';

/**
 * Git diff as a first-class editor tab (ADR-0057) — the SCM "open diff"
 * surface. Never a modal: it lives in the editor group beside the change list,
 * exactly where a file tab would render.
 *
 * Working-tree diffs put the REAL document buffer on the modified side, so the
 * right pane is live and editable and ⌘S saves through the normal document
 * path. Staged diffs (HEAD ↔ index) are read-only on both sides.
 */

/** Scroll/selection state per diff tab, surviving tab switches. */
const diffViewStates = new Map<string, monaco.editor.IDiffEditorViewState | null>();

/** Users toggling inline stay inline for the next diff they open. */
let preferInline: boolean | null = null;

interface GitSides {
  original: string;
  /** null = use the live document buffer (working-tree diff). */
  modified: string | null;
}

function looksBinary(content: string): boolean {
  return content.includes('\u0000');
}

async function loadSides(path: string, staged: boolean): Promise<GitSides> {
  if (staged) {
    const [head, index] = await Promise.all([
      rpcResult('git.show', { path, ref: 'HEAD' }),
      rpcResult('git.show', { path, ref: ':0' }),
    ]);
    if (!head.ok) throw new Error(head.error.userMessage);
    if (!index.ok) throw new Error(index.error.userMessage);
    return { original: head.data.content, modified: index.data.content };
  }
  // `git diff` semantics: index (or HEAD content when nothing is staged) vs
  // the working tree. `:0` is the index entry; missing entries come back ''.
  const index = await rpcResult('git.show', { path, ref: ':0' });
  if (!index.ok) throw new Error(index.error.userMessage);
  return { original: index.data.content, modified: null };
}

function sideModel(scheme: string, path: string, content: string): monaco.editor.ITextModel {
  const uri = monaco.Uri.from({ scheme, path: `/${path}` });
  const existing = monaco.editor.getModel(uri);
  if (existing) {
    if (existing.getValue() !== content) existing.setValue(content);
    return existing;
  }
  return monaco.editor.createModel(content, undefined, uri);
}

export function GitDiffPane({
  tab,
  groupIndex,
}: {
  tab: DiffTab;
  groupIndex: number;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const settings = useAppStore((s) => s.settings);
  const docs = useEditorStore((s) => s.docs);
  const setCursor = useEditorStore((s) => s.setCursor);
  const setActiveGroup = useEditorStore((s) => s.setActiveGroup);
  const openFile = useEditorStore((s) => s.openFile);
  const meta = docs[tab.path];

  const id = diffTabId(tab.path, tab.staged);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [binary, setBinary] = useState(false);
  const [inline, setInline] = useState<boolean | null>(preferInline);
  const [stats, setStats] = useState<{ additions: number; deletions: number } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const inlineRef = useRef(inline);
  inlineRef.current = inline;

  // The modified side of a working-tree diff is the shared workspace buffer —
  // editable exactly like the file tab, saved through the same document path.
  const bufferEditable = !tab.staged && meta?.editable === true && meta?.readonly !== true;

  // Side models are pane-private (keyed by group) so a split showing the same
  // diff twice never disposes the other pane's models; the live buffer model
  // is shared and never disposed here.
  const ownedModels = useRef(new Set<monaco.editor.ITextModel>());

  useEffect(() => {
    let alive = true;
    setPhase('loading');
    void loadSides(tab.path, tab.staged)
      .then(async (sides) => {
        let modifiedContent = sides.modified;
        let modifiedModel: monaco.editor.ITextModel | null = null;
        if (modifiedContent === null) {
          modifiedModel = monaco.editor.getModel(modelUri(tab.path));
          if (!modifiedModel) {
            // No live buffer (deleted, binary or oversized file): fall back to
            // the on-disk content, read-only.
            const disk = await rpcResult('doc.readDisk', { path: tab.path });
            modifiedContent = disk.ok && disk.data.exists ? disk.data.content : '';
          }
        }
        if (!alive || !hostRef.current) return;
        if (looksBinary(sides.original) || looksBinary(modifiedContent ?? '')) {
          setBinary(true);
          setPhase('ready');
          return;
        }
        setBinary(false);

        const sidePath = `${groupIndex}/${tab.path}`;
        const original = sideModel(tab.staged ? 'git-head' : 'git-index', sidePath, sides.original);
        ownedModels.current.add(original);
        let modified: monaco.editor.ITextModel;
        if (modifiedModel) {
          modified = modifiedModel; // shared 'pi-ws' buffer — never disposed here
        } else {
          modified = sideModel(
            tab.staged ? 'git-index' : 'git-disk',
            sidePath,
            modifiedContent ?? '',
          );
          ownedModels.current.add(modified);
        }

        // First open of a new file: the original side is empty, a split view
        // would waste half the pane on hatching. Default to inline there.
        const renderSideBySide =
          inlineRef.current === null ? sides.original !== '' : !inlineRef.current;
        if (inlineRef.current === null) setInline(!renderSideBySide);

        if (!diffRef.current) {
          const fontSize = settings?.editor.fontSize ?? 13;
          const editor = monaco.editor.createDiffEditor(hostRef.current, {
            automaticLayout: true,
            readOnly: true,
            originalEditable: false,
            renderSideBySide,
            hideUnchangedRegions: { enabled: true },
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            renderOverviewRuler: false,
            fontSize,
            fontFamily: editorFontFamily(settings?.editor.fontFamily) || monacoFontFamily(),
            lineHeight: Math.round(fontSize * (settings?.editor.lineHeight ?? 1.55)),
            theme: monacoThemeName(),
          });
          diffRef.current = editor;
          editor.onDidUpdateDiff(() => {
            const changes = editor.getLineChanges() ?? [];
            let additions = 0;
            let deletions = 0;
            for (const change of changes) {
              if (change.modifiedEndLineNumber >= change.modifiedStartLineNumber) {
                additions += change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1;
              }
              if (change.originalEndLineNumber >= change.originalStartLineNumber) {
                deletions += change.originalEndLineNumber - change.originalStartLineNumber + 1;
              }
            }
            setStats({ additions, deletions });
          });
          const modifiedEditor = editor.getModifiedEditor();
          modifiedEditor.onDidChangeCursorPosition((e) => {
            setCursor(e.position.lineNumber, e.position.column);
          });
          modifiedEditor.onDidFocusEditorText(() => {
            setActiveGroup(groupIndex);
            const model = modifiedEditor.getModel();
            useEditorStore.getState().setActiveLanguage(model ? model.getLanguageId() : null);
          });
          editor.getOriginalEditor().onDidFocusEditorText(() => setActiveGroup(groupIndex));
          // Monaco swallows ⌘S while focused — route it to the document save.
          modifiedEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
            void useEditorStore.getState().save(tab.path);
          });
        }
        diffRef.current.setModel({ original, modified });
        diffRef.current.updateOptions({ readOnly: !bufferEditable });
        const viewState = diffViewStates.get(id);
        if (viewState) diffRef.current.restoreViewState(viewState);
        setPhase('ready');
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase('error');
      });
    return () => {
      alive = false;
      if (diffRef.current) diffViewStates.set(id, diffRef.current.saveViewState());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.path, tab.staged, attempt]);

  // Staging, committing or agent writes move the git side under us — refresh.
  useEffect(() => {
    return onEvent('git.changed', () => setAttempt((n) => n + 1));
  }, []);

  // Editability can arrive after the async doc.open completes.
  useEffect(() => {
    diffRef.current?.updateOptions({ readOnly: !bufferEditable });
  }, [bufferEditable]);

  useEffect(() => {
    if (!settings) return;
    diffRef.current?.updateOptions({
      fontSize: settings.editor.fontSize,
      fontFamily: editorFontFamily(settings.editor.fontFamily) || monacoFontFamily(),
      lineHeight: Math.round(settings.editor.fontSize * settings.editor.lineHeight),
    });
  }, [settings]);

  useEffect(() => {
    const owned = ownedModels.current;
    return () => {
      diffRef.current?.dispose();
      diffRef.current = null;
      // Dispose only the pane-private git-side models; the shared workspace
      // buffer ('pi-ws') never enters this set.
      for (const model of owned) {
        if (!model.isDisposed()) model.dispose();
      }
      owned.clear();
    };
  }, []);

  const toggleInline = useCallback((): void => {
    const next = !(inlineRef.current ?? false);
    setInline(next);
    preferInline = next;
    diffRef.current?.updateOptions({ renderSideBySide: !next });
  }, []);

  const name = tab.path.split('/').pop();
  const unchanged = stats !== null && stats.additions === 0 && stats.deletions === 0;

  return (
    <div className="git-diff-pane" data-testid="git-diff-pane">
      <div className="gd-head">
        <span className="gd-title">
          <Ic name="branch" size={12} />
          <span className="gd-name" data-i18n-ignore title={tab.path}>
            {name}
          </span>
          <span className="gd-scope">{tab.staged ? 'Staged' : 'Working tree'}</span>
        </span>
        {stats && !unchanged ? (
          <span className="gd-stats mono" data-testid="diff-stats">
            <i className="plus">+{stats.additions}</i> <i className="minus">−{stats.deletions}</i>
          </span>
        ) : null}
        {unchanged && phase === 'ready' && !binary ? (
          <span className="gd-clean" data-testid="diff-clean">
            No differences
          </span>
        ) : null}
        <span className="gd-sp" />
        {bufferEditable ? (
          <span
            className="gd-live"
            title="The right side is your live buffer — edits save normally"
          >
            editable
          </span>
        ) : (
          <span className="gd-ro">read-only</span>
        )}
        <button
          className="ghostbtn"
          data-testid="diff-inline-toggle"
          title="Toggle between split and inline diff"
          onClick={toggleInline}
        >
          <Ic name="layout" size={11} />
          {inline ? 'Side by side' : 'Inline'}
        </button>
        <button
          className="ghostbtn"
          data-testid="diff-open-file"
          title="Open the file itself in a normal editor tab"
          onClick={() => void openFile(tab.path)}
        >
          <Ic name="file" size={11} />
          Open file
        </button>
      </div>
      <div className="gd-body">
        <div
          ref={hostRef}
          className="gd-monaco"
          data-testid="diff-monaco"
          style={{ display: phase === 'ready' && !binary ? undefined : 'none' }}
        />
        {phase === 'loading' ? <div className="gd-note">Computing the diff…</div> : null}
        {phase === 'error' ? (
          <div className="gd-note" data-testid="diff-error">
            <span>Could not load this diff: {error}</span>
            <button className="btn" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </button>
          </div>
        ) : null}
        {phase === 'ready' && binary ? (
          <div className="gd-note" data-testid="diff-binary">
            Binary file — no text diff.
          </div>
        ) : null}
      </div>
    </div>
  );
}
