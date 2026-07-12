import React from 'react';
import {
  viewRegistry,
  bottomTabRegistry,
  overlayRegistry,
  editorBannerRegistry,
  statusBarRegistry,
  initRegistry,
} from '../workbench/Workbench.js';
import { registerCommands } from '../commands.js';
import { SearchView, focusSearchView } from '../views/SearchView.js';
import { QuickOpen, useQuickOpenStore, noteRecentFile } from '../views/QuickOpen.js';
import { TerminalPanel, useTerminalStore } from '../views/TerminalPanel.js';
import { ProblemsPanel, initProblems, useProblems, problemCounts } from '../views/ProblemsPanel.js';
import {
  initIntelligence,
  loadProjectModels,
  RenamePreviewOverlay,
  PythonBanner,
  useTsProject,
} from './intelligence.js';
import { onEvent, rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { useEditorStore } from '../store/editorStore.js';

function ProblemsStatusItem(): React.JSX.Element {
  const problems = useProblems();
  const { errors, warnings } = problemCounts(problems);
  const showBottomTab = useAppStore((s) => s.showBottomTab);
  return (
    <button
      className="sb-item"
      data-testid="status-problems"
      title="Show problems"
      onClick={() => showBottomTab('problems')}
    >
      ✖ {errors} ▲ {warnings}
    </button>
  );
}

function TsProjectStatusItem(): React.JSX.Element | null {
  const project = useTsProject();
  if (!project.loaded || project.degraded === false) return null;
  return (
    <span
      className="sb-item"
      title="Large workspace: cross-file TypeScript analysis limited to open files"
    >
      TS: on-demand
    </span>
  );
}

async function loadProject(): Promise<void> {
  const res = await rpcResult('search.allFiles', {});
  if (res.ok) {
    await loadProjectModels(res.data.files);
  }
}

export function registerM4(): void {
  viewRegistry.search = SearchView;
  bottomTabRegistry.problems = ProblemsPanel;
  bottomTabRegistry.terminal = TerminalPanel;
  overlayRegistry.push(QuickOpen, RenamePreviewOverlay);
  editorBannerRegistry.push(PythonBanner);
  statusBarRegistry.left.push(ProblemsStatusItem, TsProjectStatusItem);

  initRegistry.push(() => {
    initProblems();
    initIntelligence();
    useTerminalStore.getState().init();
    onEvent('workspace.changed', ({ workspace }) => {
      if (workspace) {
        setTimeout(() => void loadProject(), 100);
      }
    });
    // Cover the auto-open path where the event fired before subscription.
    void rpcResult('workspace.current', {}).then((res) => {
      if (res.ok && res.data.workspace) void loadProject();
    });
    // Track recent files for Quick Open ranking.
    useEditorStore.subscribe((state, prev) => {
      const active = state.groups[state.activeGroup]?.active;
      const prevActive = prev.groups[prev.activeGroup]?.active;
      if (active && active !== prevActive) noteRecentFile(active);
    });
  });

  registerCommands([
    {
      id: 'quickopen.open',
      title: 'Go to File…',
      category: 'Navigation',
      keybinding: 'mod+p',
      run: () => useQuickOpenStore.getState().setOpen(true),
    },
    {
      id: 'search.global',
      title: 'Search in Workspace',
      category: 'Search',
      keybinding: 'mod+shift+f',
      run: () => focusSearchView(),
    },
    {
      id: 'terminal.new',
      title: 'New Terminal',
      category: 'Terminal',
      keybinding: 'ctrl+backquote',
      run: () => void useTerminalStore.getState().create(),
    },
    {
      id: 'terminal.kill',
      title: 'Kill Active Terminal',
      category: 'Terminal',
      run: () => {
        const store = useTerminalStore.getState();
        if (store.active) void store.requestKill(store.active);
      },
    },
    {
      id: 'view.problems',
      title: 'Show Problems',
      category: 'View',
      run: () => useAppStore.getState().showBottomTab('problems'),
    },
  ]);
}
