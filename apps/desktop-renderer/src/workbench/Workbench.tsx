import React, { useEffect, useLayoutEffect, useRef } from 'react';
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
import { HomeShell } from '../views/HomeShell.js';
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
import { WorkView } from '../views/WorkView.js';
import { ForYouView } from '../views/ForYouView.js';
import { WorkReminderHost } from '../views/WorkReminderHost.js';
import { t } from '../i18n.js';
import { observeLocalizedChrome } from '../i18n-dom.js';

function navigationLabel(
  snapshot: NavigationSnapshot | null,
  tasks: ReturnType<typeof useTaskStore.getState>['tasks'],
): string {
  if (snapshot?.taskRoomTaskId) {
    const task = tasks.find((candidate) => candidate.id === snapshot.taskRoomTaskId);
    if (task) return task.title || t('Session');
  }
  return t(navigationSnapshotLabel(snapshot));
}

function useRegisterCoreCommands(): void {
  const store = useAppStore;
  useEffect(() => {
    registerCommands([
      {
        id: 'palette.open',
        title: t('Command Palette'),
        category: t('View'),
        keybinding: 'mod+shift+p',
        run: () => store.getState().setPaletteOpen(true),
      },
      {
        id: 'app.openSettings',
        title: t('Open Settings'),
        category: t('Preferences'),
        keybinding: 'mod+,',
        run: () => store.getState().openSettings(),
      },
      {
        id: 'app.openDiagnostics',
        title: t('Open Diagnostics'),
        category: t('Help'),
        run: () => store.getState().setOverlay('diagnostics'),
      },
      {
        id: 'app.openUpdates',
        title: t('Check for Updates'),
        category: t('Help'),
        run: () => store.getState().openSettings('updates'),
      },
      {
        id: 'navigation.back',
        title: t('Go Back'),
        category: t('Navigation'),
        keybinding: 'mod+[',
        enabled: () => store.getState().navigationBack.length > 0,
        run: () => store.getState().navigateBack(),
      },
      {
        id: 'navigation.forward',
        title: t('Go Forward'),
        category: t('Navigation'),
        keybinding: 'mod+]',
        enabled: () => store.getState().navigationForward.length > 0,
        run: () => store.getState().navigateForward(),
      },
      {
        id: 'view.remotes',
        title: t('Open SSH Remotes'),
        category: t('View'),
        run: () => store.getState().openRemotes(),
      },
      {
        id: 'app.about',
        title: t('About Charter'),
        category: t('Help'),
        run: () => store.getState().setOverlay('about'),
      },
      {
        // The File tool expands in place; the Session rail and conversation
        // never unmount.
        id: 'surface.toggleEditor',
        title: t('Toggle Session File Tool'),
        category: t('View'),
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
        title: t('Toggle Navigation Sidebar'),
        category: t('View'),
        keybinding: 'mod+b',
        run: () => store.getState().toggleSidebar(),
      },
      {
        id: 'layout.toggleAgentPanel',
        title: t('Toggle Session Summary'),
        category: t('View'),
        keybinding: 'mod+l',
        run: () => store.getState().toggleAgentPanel(),
      },
      {
        id: 'layout.toggleBottomPanel',
        title: t('Toggle Session Terminal'),
        category: t('View'),
        keybinding: 'mod+j',
        run: () => store.getState().toggleBottomPanel(),
      },
      {
        id: 'view.explorer',
        title: t('Show Session Files'),
        category: t('View'),
        keybinding: 'mod+shift+e',
        run: () => store.getState().showSideBarView('explorer'),
      },
      {
        id: 'view.search',
        title: t('Show Search'),
        category: t('View'),
        run: () => store.getState().showSideBarView('search'),
      },
      {
        id: 'view.scm',
        title: t('Show Session Diff'),
        category: t('View'),
        keybinding: 'ctrl+shift+g',
        run: () => store.getState().showSideBarView('scm'),
      },
      {
        id: 'view.tasks',
        title: t('Show Session Summary'),
        category: t('View'),
        run: () => store.getState().showSideBarView('tasks'),
      },
      {
        id: 'theme.light',
        title: t('Theme: Light'),
        category: t('Preferences'),
        run: () => void store.getState().updateSettings('global', { general: { theme: 'light' } }),
      },
      {
        id: 'theme.dark',
        title: t('Theme: Dark'),
        category: t('Preferences'),
        run: () => void store.getState().updateSettings('global', { general: { theme: 'dark' } }),
      },
      {
        id: 'theme.system',
        title: t('Theme: System'),
        category: t('Preferences'),
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
        id: 'skin.codex',
        title: 'Skin: Codex',
        category: 'Preferences',
        run: () => void store.getState().updateSettings('global', { general: { skin: 'codex' } }),
      },
      {
        id: 'view.zoomIn',
        title: t('Zoom In'),
        category: t('View'),
        keybinding: 'mod+plus',
        run: () => {
          if (useTerminalStore.getState().zoomFocused('in')) return;
          const s = store.getState().settings?.general.uiScale ?? ZOOM_DEFAULT;
          void store.getState().updateSettings('global', { general: { uiScale: stepZoom(s, 1) } });
        },
      },
      {
        id: 'view.zoomOut',
        title: t('Zoom Out'),
        category: t('View'),
        keybinding: 'mod+minus',
        run: () => {
          if (useTerminalStore.getState().zoomFocused('out')) return;
          const s = store.getState().settings?.general.uiScale ?? ZOOM_DEFAULT;
          void store.getState().updateSettings('global', { general: { uiScale: stepZoom(s, -1) } });
        },
      },
      {
        id: 'view.zoomReset',
        title: t('Reset Zoom'),
        category: t('View'),
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
export const overlayRegistry: React.ComponentType[] = [];
/** Dual-form shell (ADR-0004): the Home task launcher registered by contrib. */
// Home is the product's required primary surface, not an optional contribution.
// Keep a concrete fallback here so a Vite hot update that re-evaluates this
// module cannot reset the registry to `null` and leave the whole content pane
// blank while the persistent Session rail continues to respond.
export const homeSurfaceRegistry: { main: React.ComponentType | null } = { main: HomeShell };
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
  const workbenchRef = useRef<HTMLDivElement>(null);
  useRegisterCoreCommands();
  const overlay = useAppStore((s) => s.overlay);
  const setOverlay = useAppStore((s) => s.setOverlay);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);
  const sessionNotices = useAppStore((s) => s.sessionNotices);
  const taskRoomTaskId = useAppStore((s) => s.taskRoomTaskId);
  const dismissSessionNotice = useAppStore((s) => s.dismissSessionNotice);
  const pushToast = useAppStore((s) => s.pushToast);
  const appInfo = useAppStore((s) => s.appInfo);
  const sideBarVisible = useAppStore((s) => s.layout.sideBarVisible);
  const railView = useAppStore((s) => s.railView);
  const remotesOpen = useAppStore((s) => s.remotesOpen);
  const backTarget = useAppStore((s) => s.navigationBack.at(-1) ?? null);
  const forwardTarget = useAppStore((s) => s.navigationForward.at(-1) ?? null);
  const tasks = useTaskStore((s) => s.tasks);
  const backLabel = navigationLabel(backTarget, tasks);
  const forwardLabel = navigationLabel(forwardTarget, tasks);
  const destination = settingsOpen
    ? { label: t('Settings'), icon: 'sliders', title: t('Application settings') }
    : remotesOpen
      ? { label: t('Remote Explorer'), icon: 'server', title: t('Selected remote host overview') }
      : railView === 'missions'
        ? { label: t('Missions'), icon: 'compass', title: t('Mission overview') }
        : railView === 'work'
          ? { label: t('Work'), icon: 'kanban', title: t('Task board') }
          : railView === 'projects'
            ? { label: t('Projects'), icon: 'folder', title: t('Project browser') }
            : railView === 'inbox'
              ? { label: t('For you'), icon: 'inbox', title: t('Work needing your attention') }
              : railView === 'memory'
                ? { label: t('Memory'), icon: 'brain', title: t('Agent and project memory') }
                : railView === 'skills'
                  ? {
                      label: t('Skills'),
                      icon: 'puzzle',
                      title: t('Skills usage and installations'),
                    }
                  : { label: t('Sessions'), icon: 'sessions', title: t('Session workspace') };

  useLayoutEffect(() => {
    const root = workbenchRef.current;
    return root ? observeLocalizedChrome(root) : undefined;
  }, []);
  const openDestination =
    !settingsOpen &&
    (remotesOpen || railView === 'missions' || railView === 'sessions' || railView === 'files')
      ? (): void => {
          if (remotesOpen) {
            useAppStore.getState().setRemoteSubview('overview');
          } else if (railView === 'missions') {
            useAppStore.getState().openMission(null);
          } else {
            useAppStore.getState().openSessionHome();
          }
        }
      : null;
  const overlayDialogRef = useRef<HTMLDivElement>(null);
  const overlayWasOpenRef = useRef(false);
  const overlayFocusReturnRef = useRef<HTMLElement | null>(null);
  const overlayFocusReturnTestIdRef = useRef<string | null>(null);

  useEffect(() => {
    const remember = (event: FocusEvent): void => {
      const state = useAppStore.getState();
      if (state.overlay !== 'none') return;
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
        if (useAppStore.getState().settingsOpen) {
          closeSettings();
          return;
        }
      }
      handleGlobalKeydown(e);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [closeSettings, setOverlay]);

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
    <div
      ref={workbenchRef}
      className={`workbench ${settingsOpen ? 'settings-open' : ''}`}
      data-testid="workbench"
    >
      <header
        className={`titlebar ${platform() === 'darwin' ? '' : 'not-mac'}`}
        inert={overlay !== 'none'}
      >
        <span className="tb-brand-lockup" aria-label={t('Charter agent operations')}>
          <span className="tb-brand-mark" aria-hidden="true">
            <Ic name="flag" size={13} />
          </span>
          <span className="tb-title">
            <b>Charter</b>
            <small>{t('Agent operations')}</small>
          </span>
        </span>
        <button
          type="button"
          className="tb-sidebar-toggle"
          data-testid="sidebar-toggle"
          hidden={settingsOpen}
          aria-label={t(sideBarVisible ? 'Hide navigation sidebar' : 'Show navigation sidebar')}
          aria-pressed={!sideBarVisible}
          title={`${t(sideBarVisible ? 'Hide navigation sidebar' : 'Show navigation sidebar')} (⌘B)`}
          onClick={() => useAppStore.getState().toggleSidebar()}
        >
          <Ic name="sidebar" size={15} />
        </button>
        <span className="tb-nav" aria-label={t('Page history')}>
          <button
            className="tb-nav-button back"
            data-testid="navigation-back"
            disabled={settingsOpen || !backTarget}
            aria-label={`Back to ${backLabel}`}
            title={backTarget ? `${t('Back to')} ${backLabel} (⌘[)` : t('No previous page')}
            onClick={() => useAppStore.getState().navigateBack()}
          >
            <Ic name="chevron" size={12} />
          </button>
          <button
            className="tb-nav-button forward"
            data-testid="navigation-forward"
            disabled={settingsOpen || !forwardTarget}
            aria-label={`Forward to ${forwardLabel}`}
            title={forwardTarget ? `${t('Forward to')} ${forwardLabel} (⌘])` : t('No next page')}
            onClick={() => useAppStore.getState().navigateForward()}
          >
            <Ic name="chevron" size={12} />
          </button>
        </span>
        {openDestination ? (
          <button
            className="tb-chip"
            data-testid="surface-home"
            title={destination.title}
            onClick={openDestination}
          >
            <Ic name={destination.icon} size={12} /> {destination.label}
          </button>
        ) : (
          <span
            className="tb-chip current-page"
            data-testid="surface-home"
            title={destination.title}
            aria-current="page"
          >
            <Ic name={destination.icon} size={12} /> {destination.label}
          </span>
        )}
        <span className="tb-spacer" />
        <button
          className="tb-chip tb-quick-console"
          data-testid="quick-console-chip"
          title={t('Toggle the persistent quick console')}
          onClick={() => executeCommand('terminal.quickConsole')}
        >
          <Ic name="terminal" size={12} /> ⌥Space {t('Quick Console')}
        </button>
        <button
          className="tb-chip"
          data-testid="palette-chip"
          onClick={() => useAppStore.getState().setPaletteOpen(true)}
        >
          ⌘⇧P {t('Commands')}
        </button>
      </header>

      <div
        className={`wb-main ${sideBarVisible ? '' : 'rail-collapsed'}`}
        data-sidebar-visible={sideBarVisible}
        inert={overlay !== 'none' || settingsOpen}
      >
        {remotesOpen ? <RemoteRail /> : <SessionRail />}
        {railView === 'work' ? (
          <WorkView />
        ) : railView === 'inbox' ? (
          <ForYouView />
        ) : railView === 'memory' ? (
          <MemoryView />
        ) : railView === 'skills' ? (
          <SkillsView />
        ) : homeSurfaceRegistry.main ? (
          <div className="session-home-host">
            <homeSurfaceRegistry.main />
          </div>
        ) : null}
      </div>

      {settingsOpen ? <SettingsView /> : null}

      <footer
        className="statusbar"
        aria-label={t('Status bar')}
        inert={overlay !== 'none' || settingsOpen}
        hidden={settingsOpen}
      >
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
      <WorkReminderHost />

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
              <button
                className="modal-close"
                aria-label={t('Close')}
                onClick={() => setOverlay('none')}
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              {overlay === 'diagnostics' ? <DiagnosticsView /> : null}
              {overlay === 'about' && appInfo ? (
                <div style={{ padding: 20, lineHeight: 1.9 }}>
                  <div style={{ fontSize: 18, fontWeight: 700 }}>Charter {appInfo.appVersion}</div>
                  <div className="text-muted" style={{ fontSize: 12 }}>
                    Electron {appInfo.electron} · Node {appInfo.node} · Chrome {appInfo.chrome}
                    <br />
                    {t('Agent engine')} {appInfo.piSdkVersion ?? 'n/a'} · {t('Commit')}{' '}
                    {appInfo.commit ?? 'n/a'} · {appInfo.updateChannel}
                  </div>
                  <div className="text-muted" style={{ fontSize: 12 }}>
                    {t('MIT License · Local-first: your code and tasks stay on this machine.')}
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

      <div className="session-notices" aria-live="polite" aria-label={t('Session updates')}>
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
                aria-label={t('Dismiss Session notification')}
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
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            <span style={{ flex: 1 }}>{toast.message}</span>
            <button aria-label={t('Dismiss')} onClick={() => dismissToast(toast.id)}>
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
