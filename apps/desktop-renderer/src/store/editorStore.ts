import { create } from 'zustand';
import type { DocumentDto, OpenTabsState } from '@pi-ide/ipc-contracts';
import { monaco, modelUri } from '../monaco-setup.js';
import { onEvent, rpc, rpcResult } from '../bridge.js';
import { useAppStore } from './appStore.js';
import { useWorkspaceStore } from './workspaceStore.js';

export interface DocMeta {
  path: string;
  dirty: boolean;
  binary: boolean;
  largeFile: boolean;
  editable: boolean;
  readonly: boolean;
  eol: 'lf' | 'crlf';
  encoding: string;
  externalState: 'clean' | 'externallyModified' | 'externallyDeleted';
  sizeBytes: number;
}

export interface Tab {
  path: string;
  pinned: boolean;
}

export interface EditorGroup {
  tabs: Tab[];
  active: string | null;
}

export interface CloseRequest {
  path: string;
  resolve: (choice: 'save' | 'discard' | 'cancel') => void;
}

interface EditorStore {
  groups: EditorGroup[];
  activeGroup: number;
  docs: Record<string, DocMeta>;
  closeRequest: CloseRequest | null;
  compareWith: string | null; // path being compared (conflict view)
  cursor: { line: number; column: number };
  activeLanguage: string | null;

  init(): void;
  openFile(path: string, opts?: { group?: number }): Promise<void>;
  closeTab(path: string, group: number): Promise<void>;
  closeOthers(path: string, group: number): Promise<void>;
  closeSaved(group: number): void;
  setActive(path: string, group: number): void;
  setActiveGroup(group: number): void;
  save(path?: string): Promise<void>;
  saveAll(): Promise<void>;
  split(): void;
  unsplit(): void;
  togglePin(path: string, group: number): void;
  resolveConflict(path: string, choice: 'reload' | 'keep'): Promise<void>;
  setCompareWith(path: string | null): void;
  setEol(path: string, eol: 'lf' | 'crlf'): Promise<void>;
  setCursor(line: number, column: number): void;
  setActiveLanguage(lang: string | null): void;
  restoreTabs(): Promise<void>;
  reset(): void;
  dirtyCount(): number;
}

const updateTimers = new Map<string, ReturnType<typeof setTimeout>>();
const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const savedVersions = new Map<string, number>();
const modelListeners = new Map<string, { dispose(): void }>();

function scheduleTabsPersist(get: () => EditorStore): void {
  clearTimeout(tabsPersistTimer);
  tabsPersistTimer = setTimeout(() => {
    const state = get();
    const tabs: OpenTabsState = {
      schemaVersion: 1,
      groups: state.groups.map((g) => ({
        tabs: g.tabs.map((t) => ({ path: t.path, pinned: t.pinned })),
        active: g.active,
      })),
      activeGroup: Math.min(state.activeGroup, state.groups.length - 1) as 0 | 1,
      splitDirection: state.groups.length > 1 ? 'vertical' : null,
    };
    void rpcResult('tabs.save', { tabs });
  }, 500);
}
let tabsPersistTimer: ReturnType<typeof setTimeout>;

function getModel(path: string): monaco.editor.ITextModel | null {
  return monaco.editor.getModel(modelUri(path));
}

function metaFromDto(doc: DocumentDto): DocMeta {
  return {
    path: doc.relativePath,
    dirty: doc.dirty,
    binary: doc.binary,
    largeFile: doc.largeFile,
    editable: doc.editable,
    readonly: doc.readonly,
    eol: doc.eol,
    encoding: doc.encoding,
    externalState: doc.externalState,
    sizeBytes: doc.sizeBytes,
  };
}

/** Replace model content without destroying the undo stack; keep selection stable. */
export function replaceModelContent(model: monaco.editor.ITextModel, content: string): void {
  const fullRange = model.getFullModelRange();
  model.pushEditOperations([], [{ range: fullRange, text: content }], () => null);
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  groups: [{ tabs: [], active: null }],
  activeGroup: 0,
  docs: {},
  closeRequest: null,
  compareWith: null,
  cursor: { line: 1, column: 1 },
  activeLanguage: null,

  init() {
    onEvent('doc.changedExternally', ({ doc }) => {
      const meta = metaFromDto(doc);
      const model = getModel(doc.relativePath);
      const locallyDirty =
        model !== null && model.getAlternativeVersionId() !== savedVersions.get(doc.relativePath);
      if (model && doc.externalState === 'clean' && !doc.dirty && locallyDirty) {
        // Main believed the buffer was clean and auto-reloaded, but our model has
        // unsaved edits the debounced mirror had not delivered yet. Never overwrite:
        // escalate to a conflict and resync the true buffer to the main process.
        set({
          docs: {
            ...get().docs,
            [doc.relativePath]: { ...meta, dirty: true, externalState: 'externallyModified' },
          },
        });
        void rpcResult('doc.update', { path: doc.relativePath, content: model.getValue() });
        useAppStore
          .getState()
          .pushToast(
            'warning',
            `${doc.relativePath} changed on disk while you have unsaved edits.`,
          );
        return;
      }
      set({ docs: { ...get().docs, [doc.relativePath]: meta } });
      if (model && doc.externalState === 'clean' && !doc.dirty) {
        // auto-reloaded clean buffer: sync the model text
        if (model.getValue() !== doc.content) {
          replaceModelContent(model, doc.content);
          savedVersions.set(doc.relativePath, model.getAlternativeVersionId());
          set({ docs: { ...get().docs, [doc.relativePath]: { ...meta, dirty: false } } });
        }
      }
      if (doc.externalState !== 'clean') {
        useAppStore
          .getState()
          .pushToast(
            'warning',
            doc.externalState === 'externallyDeleted'
              ? `${doc.relativePath} was deleted on disk — your unsaved buffer is preserved.`
              : `${doc.relativePath} changed on disk while you have unsaved edits.`,
          );
      }
    });
    onEvent('workspace.changed', ({ workspace }) => {
      get().reset();
      if (workspace) void get().restoreTabs();
    });
  },

  async openFile(path, opts = {}) {
    const group = opts.group ?? get().activeGroup;
    const state = get();
    const groups = state.groups.map((g) => ({ ...g, tabs: [...g.tabs] }));
    const targetGroup = groups[Math.min(group, groups.length - 1)]!;

    if (!targetGroup.tabs.some((t) => t.path === path)) {
      const result = await rpcResult('doc.open', { path });
      if (!result.ok) {
        useAppStore.getState().pushToast('error', `${result.error.userMessage}`);
        return;
      }
      const doc = result.data.doc;
      set({ docs: { ...get().docs, [path]: metaFromDto(doc) } });

      if (doc.editable) {
        let model = getModel(path);
        if (!model) {
          model = monaco.editor.createModel(doc.content, undefined, modelUri(path));
          model.setEOL(
            doc.eol === 'crlf'
              ? monaco.editor.EndOfLineSequence.CRLF
              : monaco.editor.EndOfLineSequence.LF,
          );
        } else if (!modelListeners.has(path) && model.getValue() !== doc.content) {
          // Background project model may lag the store's view of the file.
          model.setValue(doc.content);
        }
        if (!modelListeners.has(path)) {
          savedVersions.set(path, model.getAlternativeVersionId());
          const listener = model.onDidChangeContent(() => {
            const meta = get().docs[path];
            if (!meta) return;
            const dirty = model!.getAlternativeVersionId() !== savedVersions.get(path);
            if (dirty !== meta.dirty) {
              set({ docs: { ...get().docs, [path]: { ...meta, dirty } } });
              syncQuitBlockers(get());
              if (dirty) {
                // First keystroke: mirror immediately so the main process knows the
                // buffer is dirty before any external-change arbitration happens.
                void rpcResult('doc.update', { path, content: model!.getValue() });
              }
            }
            // Mirror buffer to the main-process document store (debounced trailing).
            clearTimeout(updateTimers.get(path));
            updateTimers.set(
              path,
              setTimeout(() => {
                void rpcResult('doc.update', { path, content: model!.getValue() });
              }, 150),
            );
            // Autosave after delay.
            const settings = useAppStore.getState().settings;
            if (settings?.editor.autoSave === 'afterDelay') {
              clearTimeout(autosaveTimers.get(path));
              autosaveTimers.set(
                path,
                setTimeout(() => void get().save(path), settings.editor.autoSaveDelayMs),
              );
            }
          });
          modelListeners.set(path, listener);
        }
      }
      targetGroup.tabs.push({ path, pinned: false });
    }
    targetGroup.active = path;
    set({ groups, activeGroup: Math.min(group, groups.length - 1) });
    scheduleTabsPersist(get);
  },

  async closeTab(path, group) {
    const meta = get().docs[path];
    const inOtherGroup = get().groups.some(
      (g, i) => i !== group && g.tabs.some((t) => t.path === path),
    );
    if (meta?.dirty && !inOtherGroup) {
      const choice = await new Promise<'save' | 'discard' | 'cancel'>((resolve) => {
        set({ closeRequest: { path, resolve } });
      });
      set({ closeRequest: null });
      if (choice === 'cancel') return;
      if (choice === 'save') await get().save(path);
    }
    const groups = get().groups.map((g) => ({ ...g, tabs: [...g.tabs] }));
    const targetGroup = groups[group];
    if (!targetGroup) return;
    targetGroup.tabs = targetGroup.tabs.filter((t) => t.path !== path);
    if (targetGroup.active === path) {
      targetGroup.active = targetGroup.tabs.at(-1)?.path ?? null;
    }
    // Detach editing state when the file is closed everywhere. The Monaco model
    // itself stays alive as part of the TS project (cross-file intelligence);
    // fs events keep background models in sync.
    const stillOpen = groups.some((g) => g.tabs.some((t) => t.path === path));
    if (!stillOpen) {
      modelListeners.get(path)?.dispose();
      modelListeners.delete(path);
      savedVersions.delete(path);
      const docs = { ...get().docs };
      delete docs[path];
      set({ docs });
      void rpcResult('doc.close', { path });
    }
    set({ groups });
    syncQuitBlockers(get());
    scheduleTabsPersist(get);
  },

  async closeOthers(path, group) {
    const targetGroup = get().groups[group];
    if (!targetGroup) return;
    for (const tab of [...targetGroup.tabs]) {
      if (tab.path !== path && !tab.pinned) await get().closeTab(tab.path, group);
    }
  },

  closeSaved(group) {
    const targetGroup = get().groups[group];
    if (!targetGroup) return;
    for (const tab of [...targetGroup.tabs]) {
      const meta = get().docs[tab.path];
      if (meta && !meta.dirty && !tab.pinned) void get().closeTab(tab.path, group);
    }
  },

  setActive(path, group) {
    const settings = useAppStore.getState().settings;
    if (settings?.editor.autoSave === 'onFocusChange') void get().saveAll();
    const groups = get().groups.map((g, i) => (i === group ? { ...g, active: path } : g));
    set({ groups, activeGroup: group });
    scheduleTabsPersist(get);
  },

  setActiveGroup(group) {
    set({ activeGroup: Math.min(group, get().groups.length - 1) });
  },

  async save(path) {
    const target = path ?? get().groups[get().activeGroup]?.active ?? null;
    if (!target) return;
    const model = getModel(target);
    if (!model) return;
    clearTimeout(autosaveTimers.get(target));
    const result = await rpcResult('doc.save', { path: target, content: model.getValue() });
    if (result.ok) {
      savedVersions.set(target, model.getAlternativeVersionId());
      set({ docs: { ...get().docs, [target]: metaFromDto(result.data.doc) } });
      syncQuitBlockers(get());
    } else if (result.error.code === 'DOC_SAVE_CONFLICT') {
      const meta = get().docs[target];
      if (meta) {
        set({
          docs: { ...get().docs, [target]: { ...meta, externalState: 'externallyModified' } },
        });
      }
      useAppStore.getState().pushToast('warning', result.error.userMessage);
    } else {
      useAppStore.getState().pushToast('error', result.error.userMessage);
    }
  },

  async saveAll() {
    for (const [path, meta] of Object.entries(get().docs)) {
      if (meta.dirty && meta.externalState === 'clean') await get().save(path);
    }
  },

  split() {
    if (get().groups.length > 1) return;
    const active = get().groups[0]!.active;
    const groups: EditorGroup[] = [
      get().groups[0]!,
      { tabs: active ? [{ path: active, pinned: false }] : [], active: active ?? null },
    ];
    set({ groups, activeGroup: 1 });
    scheduleTabsPersist(get);
  },

  unsplit() {
    if (get().groups.length < 2) return;
    const [first, second] = get().groups;
    const merged: EditorGroup = {
      tabs: [
        ...first!.tabs,
        ...second!.tabs.filter((t) => !first!.tabs.some((f) => f.path === t.path)),
      ],
      active: first!.active ?? second!.active,
    };
    set({ groups: [merged], activeGroup: 0 });
    scheduleTabsPersist(get);
  },

  togglePin(path, group) {
    const groups = get().groups.map((g, i) =>
      i === group
        ? { ...g, tabs: g.tabs.map((t) => (t.path === path ? { ...t, pinned: !t.pinned } : t)) }
        : g,
    );
    set({ groups });
    scheduleTabsPersist(get);
  },

  async resolveConflict(path, choice) {
    if (choice === 'keep') {
      const model = getModel(path);
      if (model) {
        await rpcResult('doc.update', { path, content: model.getValue() });
      }
    }
    const result = await rpcResult('doc.resolveExternal', { path, choice });
    if (!result.ok) {
      useAppStore.getState().pushToast('error', result.error.userMessage);
      return;
    }
    const doc = result.data.doc;
    const model = getModel(path);
    if (model && choice === 'reload') {
      replaceModelContent(model, doc.content);
      savedVersions.set(path, model.getAlternativeVersionId());
    }
    set({ docs: { ...get().docs, [path]: metaFromDto(doc) }, compareWith: null });
    syncQuitBlockers(get());
  },

  setCompareWith(path) {
    set({ compareWith: path });
  },

  async setEol(path, eol) {
    const result = await rpcResult('doc.setEol', { path, eol });
    if (result.ok) {
      const model = getModel(path);
      if (model) {
        model.setEOL(
          eol === 'crlf'
            ? monaco.editor.EndOfLineSequence.CRLF
            : monaco.editor.EndOfLineSequence.LF,
        );
      }
      set({ docs: { ...get().docs, [path]: metaFromDto(result.data.doc) } });
    }
  },

  setCursor(line, column) {
    set({ cursor: { line, column } });
  },
  setActiveLanguage(lang) {
    set({ activeLanguage: lang });
  },

  async restoreTabs() {
    const result = await rpcResult('tabs.get', {});
    if (!result.ok || !result.data.tabs) return;
    const saved = result.data.tabs;
    for (let g = 0; g < saved.groups.length; g++) {
      if (g === 1 && get().groups.length === 1) get().split();
      for (const tab of saved.groups[g]!.tabs) {
        await get().openFile(tab.path, { group: g });
        if (tab.pinned) get().togglePin(tab.path, g);
      }
      const active = saved.groups[g]!.active;
      if (active) get().setActive(active, g);
    }
    set({ activeGroup: Math.min(saved.activeGroup, get().groups.length - 1) });
  },

  reset() {
    for (const listener of modelListeners.values()) listener.dispose();
    modelListeners.clear();
    for (const model of monaco.editor.getModels()) {
      if (model.uri.scheme === 'pi-ws') model.dispose();
    }
    savedVersions.clear();
    set({
      groups: [{ tabs: [], active: null }],
      activeGroup: 0,
      docs: {},
      closeRequest: null,
      compareWith: null,
    });
    syncQuitBlockers(get());
  },

  dirtyCount() {
    return Object.values(get().docs).filter((d) => d.dirty).length;
  },
}));

function syncQuitBlockers(state: EditorStore): void {
  const dirty = Object.values(state.docs).filter((d) => d.dirty).length;
  const blockers = dirty > 0 ? [`${dirty} unsaved file${dirty > 1 ? 's' : ''}`] : [];
  void rpc('app.setQuitBlockers', { blockers }).catch(() => undefined);
}
