import React, { useEffect } from 'react';
import { useAppStore } from '../store/appStore.js';
import { handleGlobalKeydown, registerCommands, executeCommand } from '../commands.js';
import { onEvent, platform, rpcResult } from '../bridge.js';
import { runInitsOnce } from './init.js';
import { CommandPalette } from './CommandPalette.js';
import { SettingsView } from '../views/SettingsView.js';
import { DiagnosticsView } from '../views/DiagnosticsView.js';
import { Ic } from '../views/home-icons.js';
import { SessionRail } from '../views/SessionRail.js';
import type { BottomTab, SideBarView } from '@pi-ide/ipc-contracts';
import { useTaskStore } from '../store/taskStore.js';

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
        // The File tool expands in place; the Session rail and conversation
        // never unmount.
        id: 'surface.toggleEditor',
        title: 'Toggle Session File Tool',
        category: 'View',
        keybinding: 'mod+e',
        run: () => {
          const s = store.getState();
          if (s.taskRoomTaskId) {
            s.setSessionTool(s.sessionTool === 'file' ? 'summary' : 'file');
            s.setSessionToolExpanded(s.sessionTool !== 'file');
          } else {
            s.setSurface('home');
            s.focusComposer();
          }
        },
      },
      {
        id: 'layout.toggleSidebar',
        title: 'Focus Sessions',
        category: 'View',
        keybinding: 'mod+b',
        run: () => store.getState().toggleSidebar(),
      },
      {
        id: 'layout.toggleAgentPanel',
        title: 'Toggle Session Summary',
        category: 'View',
        keybinding: 'mod+l',
        run: () => store.getState().toggleAgentPanel(),
      },
      {
        id: 'layout.toggleBottomPanel',
        title: 'Toggle Session Terminal',
        category: 'View',
        keybinding: 'mod+j',
        run: () => store.getState().toggleBottomPanel(),
      },
      {
        id: 'view.explorer',
        title: 'Show Session Files',
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
        title: 'Show Session Diff',
        category: 'View',
        keybinding: 'ctrl+shift+g',
        run: () => store.getState().showSideBarView('scm'),
      },
      {
        id: 'view.tasks',
        title: 'Show Session Summary',
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

/** Compatibility registries for contributed tools while they migrate into SessionToolCanvas. */
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

export function Workbench(): React.JSX.Element {
  useRegisterCoreCommands();
  const overlay = useAppStore((s) => s.overlay);
  const setOverlay = useAppStore((s) => s.setOverlay);
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);
  const sessionNotices = useAppStore((s) => s.sessionNotices);
  const dismissSessionNotice = useAppStore((s) => s.dismissSessionNotice);
  const pushToast = useAppStore((s) => s.pushToast);
  const appInfo = useAppStore((s) => s.appInfo);

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
        {homeSurfaceRegistry.main ? (
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

      <div className="session-notices" aria-live="polite" aria-label="Session updates">
        {sessionNotices.map((notice) => (
          <article
            key={notice.id}
            className={`session-notice ${notice.tone}`}
            data-testid="session-completion-notice"
            data-kind={notice.kind}
            data-task-id={notice.taskId}
            data-state={notice.state}
          >
            <button
              className="session-notice-open"
              aria-label={`Open Session ${notice.title}`}
              onClick={() => {
                dismissSessionNotice(notice.id);
                void useTaskStore.getState().openTask(notice.taskId);
                useAppStore.getState().revealTaskSession(notice.taskId);
              }}
            >
              <span className="session-notice-icon" aria-hidden="true">
                <Ic
                  name={
                    notice.tone === 'error'
                      ? 'xCircle'
                      : notice.tone === 'warning'
                        ? 'alert'
                        : 'checkCircle'
                  }
                  size={16}
                />
              </span>
              <span className="session-notice-copy">
                <span className="session-notice-kicker">
                  <b>{notice.label}</b>
                  <span>{notice.projectName}</span>
                </span>
                <strong>{notice.title}</strong>
                <small>{notice.body}</small>
              </span>
            </button>
            <button
              className="session-notice-close"
              aria-label="Dismiss Session notification"
              onClick={() => dismissSessionNotice(notice.id)}
            >
              <Ic name="x" size={12} />
            </button>
          </article>
        ))}
      </div>

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
