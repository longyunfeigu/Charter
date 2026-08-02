import React from 'react';
import { editorAreaRegistry, statusBarRegistry, overlayRegistry } from '../workbench/Workbench.js';
import { EditorArea } from '../workbench/EditorArea.js';
import { registerCommands } from '../commands.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { useEditorStore } from '../store/editorStore.js';
import { monaco, modelUri } from '../monaco-setup.js';

function activeEditorModelPath(): string | null {
  const state = useEditorStore.getState();
  return state.groups[state.activeGroup]?.active ?? null;
}

function focusedMonaco(): monaco.editor.ICodeEditor | null {
  const editors = monaco.editor.getEditors();
  return editors.find((e) => e.hasTextFocus()) ?? editors[0] ?? null;
}

function CursorItem(): React.JSX.Element | null {
  const cursor = useEditorStore((s) => s.cursor);
  const active = useEditorStore((s) => s.groups[s.activeGroup]?.active);
  if (!active) return null;
  return (
    <span className="sb-item" data-testid="status-cursor">
      Ln {cursor.line}, Col {cursor.column}
    </span>
  );
}

function EolItem(): React.JSX.Element | null {
  const active = useEditorStore((s) => s.groups[s.activeGroup]?.active);
  const docs = useEditorStore((s) => s.docs);
  const setEol = useEditorStore((s) => s.setEol);
  if (!active) return null;
  const meta = docs[active];
  if (!meta || meta.binary) return null;
  return (
    <button
      className="sb-item"
      title="Click to toggle line endings"
      data-testid="status-eol"
      onClick={() => void setEol(active, meta.eol === 'lf' ? 'crlf' : 'lf')}
    >
      {meta.eol.toUpperCase()}
    </button>
  );
}

function EncodingItem(): React.JSX.Element | null {
  const active = useEditorStore((s) => s.groups[s.activeGroup]?.active);
  const docs = useEditorStore((s) => s.docs);
  if (!active) return null;
  const meta = docs[active];
  if (!meta || meta.binary) return null;
  return (
    <span className="sb-item" data-testid="status-encoding">
      {meta.encoding === 'utf8-bom' ? 'UTF-8 BOM' : 'UTF-8'}
    </span>
  );
}

function LanguageItem(): React.JSX.Element | null {
  const lang = useEditorStore((s) => s.activeLanguage);
  const active = useEditorStore((s) => s.groups[s.activeGroup]?.active);
  if (!active || !lang) return null;
  return (
    <span className="sb-item" data-testid="status-language">
      {lang}
    </span>
  );
}

function DirtyItem(): React.JSX.Element | null {
  const docs = useEditorStore((s) => s.docs);
  const dirty = Object.values(docs).filter((d) => d.dirty).length;
  if (dirty === 0) return null;
  return (
    <span className="sb-item text-warning" data-testid="status-dirty">
      ● {dirty} unsaved
    </span>
  );
}

function TrustPrompt(): React.JSX.Element | null {
  const visible = useWorkspaceStore((s) => s.trustPromptVisible);
  const workspace = useWorkspaceStore((s) => s.workspace);
  const setTrust = useWorkspaceStore((s) => s.setTrust);
  const dismiss = useWorkspaceStore((s) => s.dismissTrustPrompt);
  if (!visible || !workspace) return null;
  return (
    <div className="modal-backdrop">
      <div
        className="modal small"
        role="dialog"
        aria-label="Project trust"
        data-testid="trust-prompt"
      >
        <div className="modal-header">Do you trust this project?</div>
        <div style={{ padding: 16, lineHeight: 1.7 }}>
          <p>
            <span className="mono">{workspace.path}</span> contains project-local agent resources (
            <span className="mono">.pi</span> / <span className="mono">.agents</span>): extensions,
            skills or prompts that could run code when an agent session starts.
          </p>
          <p className="text-muted" style={{ fontSize: 12 }}>
            Untrusted (default): the IDE works normally, but agent sessions do not load any
            project-local executable resources. You can change this later from the Command Palette
            with “Workspace: Manage Project Trust”.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              className="btn primary"
              data-testid="trust-keep-untrusted"
              onClick={() => dismiss()}
            >
              Keep untrusted (recommended)
            </button>
            <button className="btn" data-testid="trust-allow" onClick={() => void setTrust(true)}>
              Trust project
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function registerM3(): void {
  editorAreaRegistry.main = EditorArea;
  overlayRegistry.push(TrustPrompt);
  statusBarRegistry.right.push(CursorItem, LanguageItem, EolItem, EncodingItem);
  statusBarRegistry.left.push(DirtyItem);

  registerCommands([
    {
      id: 'workspace.openFolder',
      title: 'Open Folder…',
      category: 'File',
      keybinding: 'mod+o',
      run: () => void useWorkspaceStore.getState().openViaDialog(),
    },
    {
      id: 'workspace.close',
      title: 'Close Workspace',
      category: 'File',
      enabled: () => useWorkspaceStore.getState().workspace !== null,
      run: () => void useWorkspaceStore.getState().closeWorkspace(),
    },
    {
      id: 'editor.save',
      title: 'Save',
      category: 'File',
      keybinding: 'mod+s',
      run: () => void useEditorStore.getState().save(),
    },
    {
      id: 'editor.saveAll',
      title: 'Save All',
      category: 'File',
      keybinding: 'mod+alt+s',
      run: () => void useEditorStore.getState().saveAll(),
    },
    {
      id: 'editor.closeTab',
      title: 'Close Editor Tab',
      category: 'File',
      keybinding: 'mod+w',
      run: () => {
        const state = useEditorStore.getState();
        const active = state.groups[state.activeGroup]?.active;
        if (active) void state.closeTab(active, state.activeGroup);
      },
    },
    {
      id: 'editor.split',
      title: 'Split Editor',
      category: 'View',
      keybinding: 'mod+\\',
      run: () => useEditorStore.getState().split(),
    },
    {
      id: 'editor.unsplit',
      title: 'Join Editors (remove split)',
      category: 'View',
      run: () => useEditorStore.getState().unsplit(),
    },
    {
      id: 'editor.find',
      title: 'Find in File',
      category: 'Editor',
      run: () => {
        if (activeEditorModelPath()) focusedMonaco()?.getAction('actions.find')?.run();
      },
    },
    {
      id: 'editor.gotoLine',
      title: 'Go to Line…',
      category: 'Editor',
      keybinding: 'ctrl+g',
      run: () => {
        if (activeEditorModelPath()) {
          focusedMonaco()?.focus();
          focusedMonaco()?.getAction('editor.action.gotoLine')?.run();
        }
      },
    },
    {
      id: 'workspace.trustSettings',
      title: 'Workspace: Manage Project Trust',
      category: 'Workspace',
      enabled: () => useWorkspaceStore.getState().workspace !== null,
      run: () => {
        const ws = useWorkspaceStore.getState().workspace;
        if (ws) void useWorkspaceStore.getState().setTrust(ws.trustState !== 'trusted');
      },
    },
  ]);
}

// Referenced by EditorArea for conflicts; keep the import graph explicit.
export { modelUri };
