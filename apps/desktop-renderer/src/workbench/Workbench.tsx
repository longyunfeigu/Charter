import React, { useEffect, useRef } from 'react';
import { useAppStore } from '../store/appStore.js';
import { handleGlobalKeydown, registerCommands, executeCommand } from '../commands.js';
import { onEvent, platform, rpcResult } from '../bridge.js';
import { Splitter } from './Splitter.js';
import { CommandPalette } from './CommandPalette.js';
import { WelcomeView } from '../views/WelcomeView.js';
import { SettingsView } from '../views/SettingsView.js';
import { DiagnosticsView } from '../views/DiagnosticsView.js';
import type { BottomTab, SideBarView } from '@pi-ide/ipc-contracts';

const SIDEBAR_VIEWS: Array<{ id: SideBarView; icon: string; label: string }> = [
  { id: 'explorer', icon: '🗂', label: 'Explorer' },
  { id: 'search', icon: '🔎', label: 'Search' },
  { id: 'scm', icon: '⎇', label: 'Source Control' },
  { id: 'tasks', icon: '🤖', label: 'Tasks' },
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
        title: 'About Pi IDE',
        category: 'Help',
        run: () => store.getState().setOverlay('about'),
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
export const statusBarRegistry: { left: React.ComponentType[]; right: React.ComponentType[] } = {
  left: [],
  right: [],
};
export const titleBarRegistry: { center: React.ComponentType[] } = { center: [] };
export const overlayRegistry: React.ComponentType[] = [];
export const editorBannerRegistry: React.ComponentType[] = [];
export const initRegistry: Array<() => void> = [];

function BottomPanelContent({ tab }: { tab: BottomTab }): React.JSX.Element {
  const Component = bottomTabRegistry[tab];
  if (Component) return <Component />;
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
  const pushToast = useAppStore((s) => s.pushToast);
  const appInfo = useAppStore((s) => s.appInfo);

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
    for (const init of initRegistry) init();
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

  return (
    <div className="workbench" data-testid="workbench">
      <header className={`titlebar ${platform() === 'darwin' ? '' : 'not-mac'}`}>
        <span className="tb-title">Pi IDE</span>
        {titleBarRegistry.center.map((C, i) => (
          <C key={i} />
        ))}
        <span className="tb-spacer" />
        <button
          className="tb-chip"
          data-testid="palette-chip"
          onClick={() => useAppStore.getState().setPaletteOpen(true)}
        >
          ⌘⇧P Commands
        </button>
      </header>

      <div className="wb-main">
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
              <span aria-hidden>{v.icon}</span>
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
            ⚙︎
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
                    bottomPanelHeight: Math.min(1200, Math.max(100, bottomStart.current - delta)),
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

        {layout.agentPanelVisible ? (
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
              {AgentMain ? (
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
                  <div style={{ fontSize: 18, fontWeight: 700 }}>Pi IDE {appInfo.appVersion}</div>
                  <div className="text-muted" style={{ fontSize: 12 }}>
                    Electron {appInfo.electron} · Node {appInfo.node} · Chrome {appInfo.chrome}
                    <br />
                    Pi SDK {appInfo.piSdkVersion ?? 'n/a'} · Commit {appInfo.commit ?? 'n/a'} ·{' '}
                    {appInfo.updateChannel}
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
