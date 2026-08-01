import React, { useEffect, useRef } from 'react';
import {
  navigationSnapshotLabel,
  useAppStore,
  type NavigationSnapshot,
} from '../store/appStore.js';
import { handleGlobalKeydown, registerCommands, executeCommand } from '../commands.js';
import { onEvent, platform, rpcResult } from '../bridge.js';
import { runInitsOnce } from './init.js';
import { CommandPalette } from './CommandPalette.js';
import { SettingsView } from '../views/SettingsView.js';
import { MemoryView } from '../views/MemoryView.js';
import { DiagnosticsView } from '../views/DiagnosticsView.js';
import { Ic } from '../views/home-icons.js';
import { SessionRail } from '../views/SessionRail.js';
import { RemoteRail } from '../views/RemoteRail.js';
import { SkillsView } from '../views/SkillsView.js';
import { ScreenshotQuickCard } from '../views/ScreenshotQuickCard.js';
import { SshPromptHost } from '../views/SshPromptHost.js';
import { TransferCenter } from '../views/TransferCenter.js';
import { UpdateNotice } from '../views/UpdateNotice.js';
import type { BottomTab, SideBarView } from '@pi-ide/ipc-contracts';
import { useTaskStore } from '../store/taskStore.js';
import { stepZoom, ZOOM_DEFAULT } from '../views/ui-zoom.js';
import { useTerminalStore } from '../views/TerminalPanel.js';

function navigationLabel(
  snapshot: NavigationSnapshot | null,
  tasks: ReturnType<typeof useTaskStore.getState>['tasks'],
): string {
  if (snapshot?.taskRoomTaskId) {
    const task = tasks.find((candidate) => candidate.id === snapshot.taskRoomTaskId);
    if (task) return task.title || 'Session';
  }
  return navigationSnapshotLabel(snapshot);
}

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
        id: 'app.openUpdates',
        title: 'Check for Updates',
        category: 'Help',
        run: () => store.getState().openSettings('updates'),
      },
      {
        id: 'navigation.back',
        title: 'Go Back',
        category: 'Navigation',
        keybinding: 'mod+[',
        enabled: () => store.getState().navigationBack.length > 0,
        run: () => store.getState().navigateBack(),
      },
      {
        id: 'navigation.forward',
        title: 'Go Forward',
        category: 'Navigation',
        keybinding: 'mod+]',
        enabled: () => store.getState().navigationForward.length > 0,
        run: () => store.getState().navigateForward(),
      },
      {
        id: 'view.remotes',
        title: 'Open SSH Remotes',
        category: 'View',
        run: () => store.getState().openRemotes(),
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
            if (s.sessionToolsOpen && s.sessionTool === 'file') {
              s.setSessionToolsOpen(false);
            } else {
              s.setSessionTool('file');
              s.setSessionToolExpanded(true);
            }
          } else {
            s.openSessionHome();
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
      {
        id: 'skin.atelier',
        title: 'Skin: Atelier',
        category: 'Preferences',
        run: () => void store.getState().updateSettings('global', { general: { skin: 'atelier' } }),
      },
      {
        id: 'view.zoomIn',
        title: 'Zoom In',
        category: 'View',
        keybinding: 'mod+plus',
        run: () => {
          if (useTerminalStore.getState().zoomFocused('in')) return;
          const s = store.getState().settings?.general.uiScale ?? ZOOM_DEFAULT;
          void store.getState().updateSettings('global', { general: { uiScale: stepZoom(s, 1) } });
        },
      },
      {
        id: 'view.zoomOut',
        title: 'Zoom Out',
        category: 'View',
        keybinding: 'mod+minus',
        run: () => {
          if (useTerminalStore.getState().zoomFocused('out')) return;
          const s = store.getState().settings?.general.uiScale ?? ZOOM_DEFAULT;
          void store.getState().updateSettings('global', { general: { uiScale: stepZoom(s, -1) } });
        },
      },
      {
        id: 'view.zoomReset',
        title: 'Reset Zoom',
        category: 'View',
        keybinding: 'mod+0',
        run: () => {
          if (useTerminalStore.getState().zoomFocused('reset')) return;
          void store.getState().updateSettings('global', { general: { uiScale: ZOOM_DEFAULT } });
        },
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

const MODAL_FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableIn(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE)].filter(
    (element) =>
      element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true',
  );
}

export function Workbench(): React.JSX.Element {
  useRegisterCoreCommands();
  const overlay = useAppStore((s) => s.overlay);
  const setOverlay = useAppStore((s) => s.setOverlay);
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);
  const sessionNotices = useAppStore((s) => s.sessionNotices);
  const taskRoomTaskId = useAppStore((s) => s.taskRoomTaskId);
  const dismissSessionNotice = useAppStore((s) => s.dismissSessionNotice);
  const pushToast = useAppStore((s) => s.pushToast);
  const appInfo = useAppStore((s) => s.appInfo);
  const railView = useAppStore((s) => s.railView);
  const remotesOpen = useAppStore((s) => s.remotesOpen);
  const backTarget = useAppStore((s) => s.navigationBack.at(-1) ?? null);
  const forwardTarget = useAppStore((s) => s.navigationForward.at(-1) ?? null);
  const tasks = useTaskStore((s) => s.tasks);
  const backLabel = navigationLabel(backTarget, tasks);
  const forwardLabel = navigationLabel(forwardTarget, tasks);
  const overlayDialogRef = useRef<HTMLDivElement>(null);
  const overlayWasOpenRef = useRef(false);
  const overlayFocusReturnRef = useRef<HTMLElement | null>(null);
  const overlayFocusReturnTestIdRef = useRef<string | null>(null);

  useEffect(() => {
    const remember = (event: FocusEvent): void => {
      if (useAppStore.getState().overlay !== 'none') return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target) return;
      overlayFocusReturnRef.current = target;
      overlayFocusReturnTestIdRef.current = target.dataset.overlayFocusReturn ?? null;
    };
    document.addEventListener('focusin', remember);
    return () => document.removeEventListener('focusin', remember);
  }, []);

  useEffect(() => {
    const opening = overlay !== 'none';
    const wasOpen = overlayWasOpenRef.current;
    overlayWasOpenRef.current = opening;
    const frame = window.requestAnimationFrame(() => {
      if (opening) {
        const dialog = overlayDialogRef.current;
        if (!dialog) return;
        (focusableIn(dialog)[0] ?? dialog).focus();
        return;
      }
      if (!wasOpen) return;
      const testid = overlayFocusReturnTestIdRef.current;
      const explicit = testid
        ? document.querySelector<HTMLElement>(`[data-testid="${CSS.escape(testid)}"]`)
        : null;
      const fallback = overlayFocusReturnRef.current;
      (explicit ?? (fallback?.isConnected ? fallback : null))?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [overlay]);

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
      <header
        className={`titlebar ${platform() === 'darwin' ? '' : 'not-mac'}`}
        inert={overlay !== 'none'}
      >
        <span className="tb-title">Charter</span>
        <span className="tb-nav" aria-label="Page history">
          <button
            className="tb-nav-button back"
            data-testid="navigation-back"
            disabled={!backTarget}
            aria-label={`Back to ${backLabel}`}
            title={backTarget ? `Back to ${backLabel} (⌘[)` : 'No previous page'}
            onClick={() => useAppStore.getState().navigateBack()}
          >
            <Ic name="chevron" size={12} />
          </button>
          <button
            className="tb-nav-button forward"
            data-testid="navigation-forward"
            disabled={!forwardTarget}
            aria-label={`Forward to ${forwardLabel}`}
            title={forwardTarget ? `Forward to ${forwardLabel} (⌘])` : 'No next page'}
            onClick={() => useAppStore.getState().navigateForward()}
          >
            <Ic name="chevron" size={12} />
          </button>
        </span>
        {backTarget ? (
          <button
            className="tb-history-origin"
            data-testid="navigation-origin"
            title={`Return to ${backLabel}`}
            onClick={() => useAppStore.getState().navigateBack()}
          >
            {backLabel}
          </button>
        ) : null}
        <button
          className="tb-chip"
          data-testid="surface-home"
          title={
            remotesOpen
              ? 'Return to the selected remote host overview'
              : railView === 'skills'
                ? 'Skills usage and installations'
                : 'Open the selected Session'
          }
          onClick={() => {
            if (remotesOpen) {
              useAppStore.getState().setRemoteSubview('overview');
              return;
            }
            if (railView === 'skills') return;
            useAppStore.getState().openSessionHome();
          }}
        >
          <Ic name={remotesOpen ? 'server' : railView === 'skills' ? 'puzzle' : 'home'} size={12} />{' '}
          {remotesOpen ? 'Remote Explorer' : railView === 'skills' ? 'Skills' : 'Sessions'}
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
          <Ic name="terminal" size={12} /> ⌥Space Quick Console
        </button>
        <button
          className="tb-chip"
          data-testid="palette-chip"
          onClick={() => useAppStore.getState().setPaletteOpen(true)}
        >
          ⌘⇧P Commands
        </button>
      </header>

      <div className="wb-main" inert={overlay !== 'none'}>
        {remotesOpen ? <RemoteRail /> : <SessionRail />}
        {railView === 'skills' ? (
          <SkillsView />
        ) : homeSurfaceRegistry.main ? (
          <div className="session-home-host">
            <homeSurfaceRegistry.main />
          </div>
        ) : null}
      </div>

      <footer className="statusbar" aria-label="Status bar" inert={overlay !== 'none'}>
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
            ref={overlayDialogRef}
            className={`modal ${overlay === 'about' ? 'small' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-label={overlay}
            data-testid={`overlay-${overlay}`}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key !== 'Tab') return;
              const dialog = overlayDialogRef.current;
              if (!dialog) return;
              const focusable = focusableIn(dialog);
              if (focusable.length === 0) {
                event.preventDefault();
                dialog.focus();
                return;
              }
              const first = focusable[0]!;
              const last = focusable.at(-1)!;
              const active = document.activeElement;
              if (event.shiftKey && (active === first || !dialog.contains(active))) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
                event.preventDefault();
                first.focus();
              }
            }}
          >
            <div className="modal-header">
              <span style={{ textTransform: 'capitalize' }}>{overlay}</span>
              <button className="modal-close" aria-label="Close" onClick={() => setOverlay('none')}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              {overlay === 'settings' ? <SettingsView /> : null}
              {overlay === 'memory' ? <MemoryView /> : null}
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
        {sessionNotices
          .filter((notice) => notice.taskId !== taskRoomTaskId)
          .map((notice) => (
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

      {/* ADR-0036: fresh OS screenshots pop the quick card here. */}
      <ScreenshotQuickCard />

      {/* ADR-0047: SSH host-key / interactive-auth modals, from any surface. */}
      <SshPromptHost />

      {/* SFTP transfers stay visible across hosts and surfaces (fused mockup). */}
      <TransferCenter />

      <div className={`toasts ${taskRoomTaskId ? 'with-task-room' : ''}`} aria-live="polite">
        <UpdateNotice />
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
