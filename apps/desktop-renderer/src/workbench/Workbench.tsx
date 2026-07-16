import React, { useEffect, useRef } from 'react';
import { useAppStore } from '../store/appStore.js';
import { useExternalStore } from '../store/externalStore.js';
import { activeTask, useTaskStore } from '../store/taskStore.js';
import { openTaskInEditor } from '../views/openInEditor.js';
import { handleGlobalKeydown, registerCommands, executeCommand } from '../commands.js';
import { onEvent, platform, rpcResult } from '../bridge.js';
import { runInitsOnce } from './init.js';
import { Splitter } from './Splitter.js';
import { CommandPalette } from './CommandPalette.js';
import { WelcomeView } from '../views/WelcomeView.js';
import { SettingsView } from '../views/SettingsView.js';
import { DiagnosticsView } from '../views/DiagnosticsView.js';
import { Ic } from '../views/home-icons.js';
import { SessionRail } from '../views/SessionRail.js';
import type { BottomTab, SideBarView } from '@pi-ide/ipc-contracts';

const SIDEBAR_VIEWS: Array<{ id: SideBarView; icon: string; label: string }> = [
  { id: 'explorer', icon: 'folder', label: 'Explorer' },
  { id: 'search', icon: 'search', label: 'Search' },
  { id: 'scm', icon: 'branch', label: 'Source Control' },
  { id: 'tasks', icon: 'bot', label: 'Tasks' },
];

const BOTTOM_TABS: Array<{ id: BottomTab; label: string }> = [
  { id: 'problems', label: 'Problems' },
  { id: 'output', label: 'Output' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'tests', label: 'Tests' },
  { id: 'agentlog', label: 'Agent Log' },
];

function useRegisterCoreCommands(): void {
  const store = useAppStore;
  useEffect(() => {
    registerCommands([
      {
        id: 'palette.open',
        title: 'Command Palette',
        category: 'View',
        keybinding: 'mod+shift+p',
        run: () => store.getState().setPaletteOpen(true),
      },
      {
        id: 'app.openSettings',
        title: 'Open Settings',
        category: 'Preferences',
        keybinding: 'mod+,',
        run: () => store.getState().setOverlay('settings'),
      },
      {
        id: 'app.openDiagnostics',
        title: 'Open Diagnostics',
        category: 'Help',
        run: () => store.getState().setOverlay('diagnostics'),
      },
      {
        id: 'app.about',
        title: 'About Charter',
        category: 'Help',
        run: () => store.getState().setOverlay('about'),
      },
      {
        // ADR-0008 §2: the Editor is one keystroke away from anywhere.
        // PIVOT-006r (ADR-0014): from a Task Room, ⌘E carries the task's
        // context into the Editor instead of a blind surface flip.
        id: 'surface.toggleEditor',
        title: 'Toggle Home / Editor',
        category: 'View',
        keybinding: 'mod+e',
        run: () => {
          const s = store.getState();
          if (s.surface === 'home') {
            const roomId = s.taskRoomTaskId;
            const task = roomId
              ? useTaskStore.getState().tasks.find((t) => t.id === roomId)
              : undefined;
            if (task) {
              openTaskInEditor(task);
              return;
            }
            s.setSurface('workspace');
          } else {
            s.setSurface('home');
          }
        },
      },
      {
        id: 'layout.toggleSidebar',
        title: 'Toggle Sidebar',
        category: 'View',
        keybinding: 'mod+b',
        run: () => store.getState().toggleSidebar(),
      },
      {
        id: 'layout.toggleAgentPanel',
        title: 'Toggle Agent Panel',
        category: 'View',
        keybinding: 'mod+l',
        run: () => store.getState().toggleAgentPanel(),
      },
      {
        id: 'layout.toggleBottomPanel',
        title: 'Toggle Bottom Panel',
        category: 'View',
        keybinding: 'mod+j',
        run: () => store.getState().toggleBottomPanel(),
      },
      {
        id: 'view.explorer',
        title: 'Show Explorer',
        category: 'View',
        keybinding: 'mod+shift+e',
        run: () => store.getState().showSideBarView('explorer'),
      },
      {
        id: 'view.search',
        title: 'Show Search',
        category: 'View',
        run: () => store.getState().showSideBarView('search'),
      },
      {
        id: 'view.scm',
        title: 'Show Source Control',
        category: 'View',
        keybinding: 'ctrl+shift+g',
        run: () => store.getState().showSideBarView('scm'),
      },
      {
        id: 'view.tasks',
        title: 'Show Tasks',
        category: 'View',
        run: () => store.getState().showSideBarView('tasks'),
      },
      {
        id: 'theme.light',
        title: 'Theme: Light',
        category: 'Preferences',
        run: () => void store.getState().updateSettings('global', { general: { theme: 'light' } }),
      },
      {
        id: 'theme.dark',
        title: 'Theme: Dark',
        category: 'Preferences',
        run: () => void store.getState().updateSettings('global', { general: { theme: 'dark' } }),
      },
      {
        id: 'theme.system',
        title: 'Theme: System',
        category: 'Preferences',
        run: () => void store.getState().updateSettings('global', { general: { theme: 'system' } }),
      },
      {
        id: 'skin.studio',
        title: 'Skin: Studio',
        category: 'Preferences',
        run: () => void store.getState().updateSettings('global', { general: { skin: 'studio' } }),
      },
      {
        id: 'skin.terminal',
        title: 'Skin: Terminal',
        category: 'Preferences',
        run: () =>
          void store.getState().updateSettings('global', { general: { skin: 'terminal' } }),
      },
      {
        id: 'skin.archive',
        title: 'Skin: Archive',
        category: 'Preferences',
        run: () => void store.getState().updateSettings('global', { general: { skin: 'archive' } }),
      },
      {
        id: 'skin.index',
        title: 'Skin: Index',
        category: 'Preferences',
        run: () => void store.getState().updateSettings('global', { general: { skin: 'index' } }),
      },
    ]);
  }, [store]);
}

function SideBarContent({ view }: { view: SideBarView }): React.JSX.Element {
  // Real views are contributed by later milestones through the view registry below.
  const Component = viewRegistry[view];
  if (Component) return <Component />;
  return (
    <div className="empty-state">
      <div className="es-title">{view}</div>
      <div>Open a folder to use this view.</div>
    </div>
  );
}

/** Later milestones register their sidebar views here (explorer/search/scm/tasks). */
export const viewRegistry: Partial<Record<SideBarView, React.ComponentType>> = {};
export const bottomTabRegistry: Partial<Record<BottomTab, React.ComponentType>> = {};
export const editorAreaRegistry: { main: React.ComponentType | null } = { main: null };
export const agentPanelRegistry: { main: React.ComponentType | null } = { main: null };
/** ADR-0017 决策 4: the promoted external-session column (renders null unless a session is promoted). */
export const externalPanelRegistry: { main: React.ComponentType | null } = { main: null };
export const statusBarRegistry: { left: React.ComponentType[]; right: React.ComponentType[] } = {
  left: [],
  right: [],
};
export const titleBarRegistry: { center: React.ComponentType[] } = { center: [] };
export const overlayRegistry: React.ComponentType[] = [];
/** Dual-form shell (ADR-0004): the Home task launcher registered by contrib. */
export const homeSurfaceRegistry: { main: React.ComponentType | null } = { main: null };
export const editorBannerRegistry: React.ComponentType[] = [];
export { initRegistry } from './init.js';

function VerificationPanel(): React.JSX.Element {
  const store = useTaskStore();
  const task = activeTask(store);
  const latestByLabel = React.useMemo(() => {
    const latest = new Map<string, string>();
    for (const event of store.timeline) {
      if (event.type !== 'verification.completed') continue;
      const run = (event.payload as { run?: { label?: unknown; state?: unknown } }).run;
      if (run && typeof run.label === 'string') latest.set(run.label, String(run.state ?? ''));
    }
    return latest;
  }, [store.timeline]);

  if (!task) {
    return <div className="empty-state">Select an agent task to view or run its checks.</div>;
  }
  if (task.verification.length === 0) {
    return (
      <div className="empty-state" data-testid="tests-verification-empty">
        No verification commands are configured for “{task.title}”.
      </div>
    );
  }

  const canRun = task.state === 'REVIEW_READY';
  return (
    <div style={{ padding: 10, overflow: 'auto' }} data-testid="tests-verification-panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {task.title}
        </b>
        <span style={{ flex: 1 }} />
        <button
          className="btn primary"
          data-testid="tests-run-verification"
          disabled={!canRun}
          title={canRun ? 'Run every configured check' : 'Checks can run when review is ready'}
          onClick={() => void store.runVerification()}
        >
          {latestByLabel.size > 0 ? 'Re-run all checks' : 'Run all checks'}
        </button>
      </div>
      {task.verification.map((command) => {
        const state = latestByLabel.get(command.label);
        return (
          <div
            key={command.label}
            style={{
              display: 'flex',
              gap: 8,
              padding: '5px 0',
              borderTop: '1px solid var(--border-soft)',
            }}
          >
            <span className="mono" style={{ flex: 1 }}>
              {command.label}
            </span>
            <span className={state === 'passed' ? '' : 'text-muted'}>
              {state ? (state === 'passed' ? '✓ passed' : state) : 'configured · not run'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function BottomPanelContent({ tab }: { tab: BottomTab }): React.JSX.Element {
  const Component = bottomTabRegistry[tab];
  if (Component) return <Component />;
  if (tab === 'tests') return <VerificationPanel />;
  const hints: Record<BottomTab, string> = {
    problems: 'Diagnostics appear when a workspace with code intelligence is open.',
    output: 'Command and service output appears here.',
    terminal: 'Terminals require an open workspace.',
    tests: 'Verification results appear when an agent task runs its checks.',
    agentlog: 'Structured agent activity appears when a task runs.',
  };
  return (
    <div className="empty-state">
      <div>{hints[tab]}</div>
    </div>
  );
}

export function Workbench(): React.JSX.Element {
  useRegisterCoreCommands();
  const layout = useAppStore((s) => s.layout);
  const setLayout = useAppStore((s) => s.setLayout);
  const overlay = useAppStore((s) => s.overlay);
  const setOverlay = useAppStore((s) => s.setOverlay);
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);
  const surface = useAppStore((s) => s.surface);
  const pushToast = useAppStore((s) => s.pushToast);
  const appInfo = useAppStore((s) => s.appInfo);
  const externalPanelPromoted = useExternalStore((s) => s.promoted !== null);

  const sidebarStart = useRef(0);
  const agentStart = useRef(0);
  const bottomStart = useRef(0);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (useAppStore.getState().paletteOpen) {
          useAppStore.getState().setPaletteOpen(false);
          return;
        }
        if (useAppStore.getState().overlay !== 'none') {
          setOverlay('none');
          return;
        }
      }
      handleGlobalKeydown(e);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setOverlay]);

  useEffect(() => {
    if (!runInitsOnce()) return;
    // ADR-0013: shared git-status snapshot for explorer/tab/gutter decorations.
    void import('../store/gitStatusStore.js').then(({ useGitStatusStore }) =>
      useGitStatusStore.getState().init(),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return onEvent('app.menuAction', ({ action }) => {
      const ok = executeCommand(action);
      if (!ok) {
        pushToast('info', `"${action}" is not available yet.`);
      }
    });
  }, [pushToast]);

  const EditorMain = editorAreaRegistry.main;
  const AgentMain = agentPanelRegistry.main;
  const ExternalMain = externalPanelRegistry.main;

  return (
    <div className="workbench" data-testid="workbench">
      <header className={`titlebar ${platform() === 'darwin' ? '' : 'not-mac'}`}>
        <span className="tb-title">Charter</span>
        <button
          className="tb-chip"
          data-testid="surface-home"
          title="Open the selected Session"
          onClick={() => useAppStore.getState().setSurface('home')}
        >
          <Ic name="home" size={12} /> Sessions
        </button>
        {titleBarRegistry.center.map((C, i) => (
          <C key={i} />
        ))}
        <span className="tb-spacer" />
        <button
          className="tb-chip tb-quick-console"
          data-testid="quick-console-chip"
          title="Toggle the persistent quick console"
          onClick={() => executeCommand('terminal.quickConsole')}
        >
          <Ic name="terminal" size={12} /> ⌥Space 速召台
        </button>
        <button
          className="tb-chip"
          data-testid="palette-chip"
          onClick={() => useAppStore.getState().setPaletteOpen(true)}
        >
          ⌘⇧P Commands
        </button>
      </header>

      <div className="wb-main">
        <SessionRail />
        {surface === 'workspace' ? (
          <>
            <nav className="activitybar" aria-label="Primary views">
              {SIDEBAR_VIEWS.map((v) => (
                <button
                  key={v.id}
                  className={`ab-btn ${layout.sideBarVisible && layout.sideBarView === v.id ? 'active' : ''}`}
                  title={v.label}
                  aria-label={v.label}
                  data-testid={`activity-${v.id}`}
                  onClick={() => {
                    if (layout.sideBarVisible && layout.sideBarView === v.id) {
                      setLayout({ sideBarVisible: false });
                    } else {
                      setLayout({ sideBarView: v.id, sideBarVisible: true });
                    }
                  }}
                >
                  <Ic name={v.icon} size={19} strokeWidth={1.5} />
                </button>
              ))}
              <span className="ab-spacer" />
              <button
                className="ab-btn"
                title="Settings"
                aria-label="Settings"
                data-testid="activity-settings"
                onClick={() => setOverlay('settings')}
              >
                <Ic name="sliders" size={19} strokeWidth={1.5} />
              </button>
            </nav>

            {layout.sideBarVisible ? (
              <>
                <aside
                  className="sidebar"
                  style={{ width: layout.sideBarWidth }}
                  data-testid="sidebar"
                  aria-label={`${layout.sideBarView} sidebar`}
                >
                  <div className="sidebar-header">{layout.sideBarView}</div>
                  <div className="sidebar-body">
                    <SideBarContent view={layout.sideBarView} />
                  </div>
                </aside>
                <Splitter
                  direction="vertical"
                  ariaLabel="Resize sidebar"
                  onDragStart={() => {
                    sidebarStart.current = layout.sideBarWidth;
                  }}
                  onDrag={(delta) =>
                    setLayout({
                      sideBarWidth: Math.min(800, Math.max(160, sidebarStart.current + delta)),
                    })
                  }
                />
              </>
            ) : null}

            <div className="wb-center">
              <main className="editor-area" data-testid="editor-area">
                {EditorMain ? <EditorMain /> : <WelcomeView />}
              </main>
              {layout.bottomPanelVisible ? (
                <>
                  <Splitter
                    direction="horizontal"
                    ariaLabel="Resize bottom panel"
                    onDragStart={() => {
                      bottomStart.current = layout.bottomPanelHeight;
                    }}
                    onDrag={(delta) =>
                      setLayout({
                        bottomPanelHeight: Math.min(
                          1200,
                          Math.max(100, bottomStart.current - delta),
                        ),
                      })
                    }
                  />
                  <section
                    className="bottom-panel"
                    style={{ height: layout.bottomPanelHeight }}
                    data-testid="bottom-panel"
                    aria-label="Bottom panel"
                  >
                    <div className="bp-tabs" role="tablist">
                      {BOTTOM_TABS.map((t) => (
                        <button
                          key={t.id}
                          role="tab"
                          aria-selected={layout.bottomTab === t.id}
                          className={`bp-tab ${layout.bottomTab === t.id ? 'active' : ''}`}
                          onClick={() => setLayout({ bottomTab: t.id })}
                        >
                          {t.label}
                        </button>
                      ))}
                      <span style={{ flex: 1 }} />
                      <button
                        className="modal-close"
                        aria-label="Close bottom panel"
                        onClick={() => setLayout({ bottomPanelVisible: false })}
                      >
                        ✕
                      </button>
                    </div>
                    <div className="bp-body" role="tabpanel">
                      <BottomPanelContent tab={layout.bottomTab} />
                    </div>
                  </section>
                </>
              ) : null}
            </div>

            {/* ADR-0017「检测升格」: a promoted external session owns the single
            right rail; the generic managed-task panel returns on unpromote. */}
            {ExternalMain ? <ExternalMain /> : null}

            {layout.agentPanelVisible && !externalPanelPromoted ? (
              <>
                <Splitter
                  direction="vertical"
                  ariaLabel="Resize agent panel"
                  onDragStart={() => {
                    agentStart.current = layout.agentPanelWidth;
                  }}
                  onDrag={(delta) =>
                    setLayout({
                      agentPanelWidth: Math.min(1000, Math.max(240, agentStart.current - delta)),
                    })
                  }
                />
                <aside
                  className="agent-panel"
                  style={{ width: layout.agentPanelWidth }}
                  data-testid="agent-panel"
                  aria-label="Agent panel"
                >
                  {/* Mounted only on the Editor surface — the Task Room owns these
                  testids/flows while the Home surface covers the workbench. */}
                  {AgentMain && surface === 'workspace' ? (
                    <AgentMain />
                  ) : (
                    <div className="empty-state">
                      <div className="es-title">Agent</div>
                      <div>Open a workspace to create your first task.</div>
                    </div>
                  )}
                </aside>
              </>
            ) : null}
          </>
        ) : homeSurfaceRegistry.main ? (
          <div className="session-home-host">
            <homeSurfaceRegistry.main />
          </div>
        ) : null}
      </div>

      <footer className="statusbar" aria-label="Status bar">
        {statusBarRegistry.left.map((C, i) => (
          <C key={`l${i}`} />
        ))}
        <span className="sb-spacer" />
        {statusBarRegistry.right.map((C, i) => (
          <C key={`r${i}`} />
        ))}
        <button
          className="sb-item"
          data-testid="status-version"
          onClick={() => setOverlay('about')}
        >
          v{appInfo?.appVersion ?? '…'}
        </button>
      </footer>

      <CommandPalette />

      {overlay !== 'none' ? (
        <div
          className="modal-backdrop"
          onClick={(e) => e.target === e.currentTarget && setOverlay('none')}
        >
          <div
            className={`modal ${overlay === 'about' ? 'small' : ''}`}
            role="dialog"
            aria-label={overlay}
            data-testid={`overlay-${overlay}`}
          >
            <div className="modal-header">
              <span style={{ textTransform: 'capitalize' }}>{overlay}</span>
              <button className="modal-close" aria-label="Close" onClick={() => setOverlay('none')}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              {overlay === 'settings' ? <SettingsView /> : null}
              {overlay === 'diagnostics' ? <DiagnosticsView /> : null}
              {overlay === 'about' && appInfo ? (
                <div style={{ padding: 20, lineHeight: 1.9 }}>
                  <div style={{ fontSize: 18, fontWeight: 700 }}>Charter {appInfo.appVersion}</div>
                  <div className="text-muted" style={{ fontSize: 12 }}>
                    Electron {appInfo.electron} · Node {appInfo.node} · Chrome {appInfo.chrome}
                    <br />
                    Agent engine {appInfo.piSdkVersion ?? 'n/a'} · Commit {appInfo.commit ?? 'n/a'}{' '}
                    · {appInfo.updateChannel}
                  </div>
                  <div className="text-muted" style={{ fontSize: 12 }}>
                    MIT License · Local-first: your code and tasks stay on this machine.
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {overlayRegistry.map((C, i) => (
        <C key={i} />
      ))}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span style={{ flex: 1 }}>{t.message}</span>
            <button aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function setQuitBlockers(blockers: string[]): void {
  void rpcResult('app.setQuitBlockers', { blockers });
}
