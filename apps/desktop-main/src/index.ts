import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  protocol,
  session,
  shell,
  Tray,
} from 'electron';
import { basename, join, normalize } from 'node:path';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  errorMessage,
  productError,
  toProductError,
  type Logger,
  type ProductError,
} from '@pi-ide/foundation';
import type { UpdateStateDto } from '@pi-ide/ipc-contracts';
import { createAppPaths, type AppPaths } from './app-paths.js';
import { CSP, DEV_CSP } from './csp.js';
import { installGlobalSecurityHandlers, openExternalChecked } from './security.js';
import { registerHandlers } from './ipc/router.js';
import { LogService } from './services/log-service.js';
import { SettingsService } from './services/settings-service.js';
import { StateService } from './services/state-service.js';
import { WindowStateKeeper } from './services/window-state.js';
import { installApplicationMenu } from './menu.js';
import { mainT } from './i18n.js';
import { broadcast } from './broadcast.js';
import { WorkspaceHost } from './services/workspace-host.js';
import { registerWorkspaceHandlers } from './ipc/workspace-handlers.js';
import { M4Services, registerM4Handlers } from './ipc/m4-handlers.js';
import { registerTerminalOpenHandlers } from './ipc/terminal-open-handlers.js';
import { SshService } from './services/ssh-service.js';
import { SshVaultService } from './services/ssh-vault-service.js';
import { GithubVaultService } from './services/github-vault-service.js';
import { GithubIssueService } from './services/github-issue-service.js';
import { SshSftpService } from './services/ssh-sftp-service.js';
import { SshForwardService } from './services/ssh-forward-service.js';
import { RemoteWorkerService } from './services/remote-worker-service.js';
import { LocalFilesService } from './services/local-files-service.js';
import { registerSshHandlers } from './ipc/ssh-handlers.js';
import { M5Services, registerM5Handlers } from './ipc/m5-handlers.js';
import { registerM6Handlers } from './ipc/m6-handlers.js';
import { registerM7Handlers } from './ipc/m7-handlers.js';
import { registerM8Handlers } from './ipc/m8-handlers.js';
import { registerM9Handlers } from './ipc/m9-handlers.js';
import { SecretService } from './services/secret-service.js';
import { SkillStore } from './services/skill-store.js';
import { registerSkillsHandlers } from './ipc/skills-handlers.js';
import { installCharterTerminalSurfaces } from './services/charter-terminal-surfaces.js';
import { CHARTER_TERMINAL_SKILL } from './services/terminal-control-manual.js';
import { CHARTER_ORCHESTRATION_SKILL } from './services/orchestration-manual.js';
import { MemoryService } from './services/memory-service.js';
import { registerMemoryHandlers } from './ipc/memory-handlers.js';
import { ModelCatalogService } from './services/model-catalog.js';
import { AgentHost } from './services/agent-host.js';
import { TaskService } from './services/task-service.js';
import { NotificationService } from './services/notification-service.js';
import { CommandNotificationService } from './services/command-notification-service.js';
import { writeShellIntegrationFiles } from './services/shell-integration-host.js';
import { detectProjectKind } from './services/project-kind.js';
import { registerActivityHandlers } from './ipc/activity-handlers.js';
import { registerReplayHandlers } from './ipc/replay-handlers.js';
import { ReplayService } from './services/replay-service.js';
import { registerTerminalReplayHandlers } from './ipc/terminal-replay-handlers.js';
import { TerminalReplayService } from './services/terminal-replay-service.js';
import { TerminalRecordingCoordinator } from './services/terminal-recording.js';
import { registerImageHandlers } from './ipc/image-handlers.js';
import { registerPreviewHandlers } from './ipc/preview-handlers.js';
import { registerContextAttachmentHandlers } from './ipc/context-attachment-handlers.js';
import { PreviewService } from './services/preview-service.js';
import { ExternalSessionService } from './services/external-session-service.js';
import { ExternalLaunchIntents } from './services/external-launch-intents.js';
import { registerExternalHandlers } from './ipc/external-handlers.js';
import { AgentPresenceService } from './services/agent-presence-service.js';
import { AgentSemanticControlService } from './services/agent-semantic-control-service.js';
import { AgentResultReader } from './services/agent-result-reader.js';
import { registerAgentPresenceHandlers } from './ipc/agent-presence-handlers.js';
import { SessionArchaeologyService } from './services/session-archaeology.js';
import { registerArchaeologyHandlers } from './ipc/archaeology-handlers.js';
import { ScreenshotWatcher } from './services/screenshot-watcher.js';
import { ClipboardScreenshotWatcher } from './services/clipboard-screenshot-watcher.js';
import { registerScreenshotHandlers } from './ipc/screenshot-handlers.js';
import { buildSupportBundle } from './services/support-bundle.js';
import {
  clearHistory,
  crashPreview,
  dataSummary,
  TELEMETRY_TRANSPORT_AVAILABLE,
} from './services/privacy-service.js';
import { join as joinPath } from 'node:path';
import {
  TerminalControlIdentityRegistry,
  TerminalControlService,
} from './services/terminal-control-service.js';
import { CtlServer } from './services/ctl-server.js';
import {
  registerMissionHandlers,
  registerOrchestrationHandlers,
} from './ipc/orchestration-handlers.js';
import { installTerminalControlIntegration } from './services/terminal-control-integration.js';
import { ArtifactService } from './services/artifact-service.js';
import { registerArtifactHandlers } from './ipc/artifact-handlers.js';
import { TerminalDaemonClient } from './services/terminal-daemon-client.js';
import { defaultUpdateChannel, RELEASES_PAGE, UpdateService } from './services/update-service.js';
import { MissionRepository } from '@pi-ide/persistence';
import { MissionOrchestrationService } from './services/mission-orchestration-service.js';
import { OrchestrationOutboxRunner } from './services/orchestration-outbox-runner.js';
import { OrchestrationRuntimeRegistry } from './services/orchestration-runtime-registry.js';
import { VisibleTerminalRuntime, ShellRuntime } from './services/visible-terminal-runtime.js';
import { ManagedAgentRuntime } from './services/managed-agent-runtime.js';
import { MissionToolCallerResolver } from './services/mission-tool-caller-resolver.js';
import { OrchestrationRecoveryService } from './services/orchestration-recovery-service.js';
import {
  AcpProcessPool,
  AcpRuntimeAdapter,
  FallbackRuntimeAdapter,
} from './services/acp-runtime.js';
import { AgentRegistry } from './services/agent-registry.js';
import { AGENT_ADAPTER_ENGINE_VERSION } from './services/agent-adapter-manifest.js';
import { AgentPackService } from './services/agent-pack-service.js';
import { AgentVerificationService } from './services/agent-verification-service.js';
import { registerAgentVerificationHandlers } from './ipc/agent-verification-handlers.js';
import { TerminalImagePasteService } from './services/terminal-image-paste-service.js';
import { WorkItemService } from './services/work-item-service.js';
import { registerWorkItemHandlers } from './ipc/work-item-handlers.js';
import { registerGithubHandlers } from './ipc/github-handlers.js';
import { OutcomeContractService } from './services/outcome-contract-service.js';
import { registerOutcomeContractHandlers } from './ipc/outcome-contract-handlers.js';
import {
  backgroundActivity,
  backgroundActivityLines,
  backgroundTrayTitle,
  rendererCrashAction,
  windowCloseAction,
  type BackgroundActivitySnapshot,
} from './services/background-runtime.js';

const DEV_SERVER_URL = process.env.PI_IDE_DEV_SERVER_URL;
const isDev = Boolean(DEV_SERVER_URL);

const userDataOverride = process.env.PI_IDE_USER_DATA;
if (userDataOverride) {
  app.setPath('userData', userDataOverride);
}

interface Bootstrap {
  paths: AppPaths;
  logs: LogService;
  logger: Logger;
  settings: SettingsService | null;
  state: StateService | null;
  workspaceHost: WorkspaceHost | null;
  startupError: ProductError | null;
}

let boot: Bootstrap | null = null;
let mainWindow: BrowserWindow | null = null;
let updateServiceRef: UpdateService | null = null;
let m4Ref: M4Services | null = null;
let agentVerificationRef: AgentVerificationService | null = null;
let terminalDaemonRef: TerminalDaemonClient | null = null;
let m5Ref: M5Services | null = null;
let agentHostRef: AgentHost | null = null;
let terminalRecordingRef: TerminalRecordingCoordinator | null = null;
let terminalReplayRef: TerminalReplayService | null = null;
let taskServiceRef: TaskService | null = null;
let externalSessionsRef: ExternalSessionService | null = null;
let agentPresenceRef: AgentPresenceService | null = null;
let agentSemanticControlRef: AgentSemanticControlService | null = null;
let archaeologyRef: SessionArchaeologyService | null = null;
let externalLaunchIntents: ExternalLaunchIntents | null = null;
let skillStoreRef: SkillStore | null = null;
let screenshotWatcherRef: ScreenshotWatcher | null = null;
let clipboardWatcherRef: ClipboardScreenshotWatcher | null = null;
let terminalControlRef: TerminalControlService | null = null;
let sshServiceRef: SshService | null = null;
let sshSftpRef: SshSftpService | null = null;
let sshForwardsRef: SshForwardService | null = null;
let remoteWorkerRef: RemoteWorkerService | null = null;
let terminalIdentitiesRef: TerminalControlIdentityRegistry | null = null;
let ctlServerRef: CtlServer | null = null;
let missionOrchestrationRef: MissionOrchestrationService | null = null;
let missionRepositoryRef: MissionRepository | null = null;
let missionRecoveryRef: OrchestrationRecoveryService | null = null;
let acpPoolRef: AcpProcessPool | null = null;
let agentRegistryRef: AgentRegistry | null = null;
let agentPackServiceRef: AgentPackService | null = null;
let terminalImagePasteRef: TerminalImagePasteService | null = null;
let agentPackRuntimeRefreshRef: (() => void) | null = null;
let workItemServiceRef: WorkItemService | null = null;
let outcomeContractRef: OutcomeContractService | null = null;

function refreshAgentPackIntegrations(): void {
  const registry = agentRegistryRef;
  if (!registry) return;
  registry.reload();
  const configured = process.env.PI_IDE_EXTERNAL_CLIS
    ? process.env.PI_IDE_EXTERNAL_CLIS.split(',')
        .map((id) => id.trim().toLowerCase())
        .filter(Boolean)
    : registry.terminalAgentCliIdentities();
  m4Ref?.terminals.setAgentClis(configured);
  agentPresenceRef?.updateManifests(registry.lifecycleManifests());
  const skillHome = process.env.PI_IDE_SKILLS_HOME;
  const sources = registry.skillSources(skillHome);
  skillStoreRef?.updateAgentSources(sources);
  agentPackRuntimeRefreshRef?.();
  if (!process.env.PI_IDE_E2E || Boolean(skillHome) || Boolean(process.env.PI_IDE_AGENT_HOME)) {
    installCharterTerminalSurfaces(sources.map(({ id, root }) => ({ target: id, root })));
  }
}
export function getM5(): M5Services | null {
  return m5Ref;
}
const quitBlockers = new Map<number, string[]>();
let forceQuit = false;
let backgroundMode = false;
let backgroundTray: Tray | null = null;
let backgroundRefreshTimer: ReturnType<typeof setInterval> | null = null;
let closePromptOpen = false;
let stoppingBackgroundWork = false;

function windowBackground(skin: string, dark: boolean): string {
  if (skin === 'studio') return dark ? '#1a1917' : '#fbfaf7';
  if (skin === 'terminal') return dark ? '#0d120f' : '#f0f6f1';
  if (skin === 'archive') return dark ? '#291f19' : '#fbf2df';
  if (skin === 'index') return dark ? '#070707' : '#ffffff';
  if (skin === 'atelier') return dark ? '#292319' : '#fbf8f0';
  if (skin === 'codex') return dark ? '#191b1a' : '#fcfcfb';
  return dark ? '#1a1917' : '#fbfaf7';
}

function currentBackgroundActivity(): BackgroundActivitySnapshot {
  const externalAgentIds = new Set(
    (agentPresenceRef?.list() ?? [])
      .filter((presence) => presence.processState === 'running')
      .map((presence) => presence.terminalId),
  );
  const terminalJobCount =
    m4Ref?.terminals
      .list()
      .filter(
        (terminal) =>
          !externalAgentIds.has(terminal.id) && m4Ref?.terminals.hasRunningChildren(terminal.id),
      ).length ?? 0;
  const missionCount =
    missionRepositoryRef
      ?.listMissions(200)
      .filter((mission) => ['PLANNING', 'RUNNING', 'BLOCKED', 'VERIFYING'].includes(mission.state))
      .length ?? 0;
  const remoteConnectionCount =
    sshServiceRef?.listHosts().filter((host) => host.connection.state !== 'disconnected').length ??
    0;
  return backgroundActivity({
    managedAgents: agentHostRef?.activeRunCount() ?? 0,
    externalAgents: externalAgentIds.size,
    terminalJobs: terminalJobCount,
    missions: missionCount,
    remoteConnections: remoteConnectionCount,
    blockers: [...quitBlockers.values()].flat(),
  });
}

function createBackgroundTrayIcon() {
  const size = process.platform === 'darwin' ? 18 : 20;
  const center = (size - 1) / 2;
  const outer = size * 0.42;
  const inner = size * 0.24;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      const gap = x > center + size * 0.14 && y < center - size * 0.06;
      if (distance < inner || distance > outer || gap) continue;
      const offset = (y * size + x) * 4;
      pixels[offset] = 111;
      pixels[offset + 1] = 87;
      pixels[offset + 2] = 232;
      pixels[offset + 3] = 255;
    }
  }
  const icon = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 1 });
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  return icon;
}

function localizedBackgroundLines(activity: BackgroundActivitySnapshot): string[] {
  if (boot?.settings?.effective.general.locale !== 'zh-CN')
    return backgroundActivityLines(activity);
  const lines: string[] = [];
  if (activity.agentCount > 0) lines.push(`${activity.agentCount} 个 Agent`);
  if (activity.missionCount > 0) lines.push(`${activity.missionCount} 个编排任务`);
  if (activity.terminalJobCount > 0) lines.push(`${activity.terminalJobCount} 个终端作业`);
  if (activity.remoteConnectionCount > 0)
    lines.push(`${activity.remoteConnectionCount} 个远程连接`);
  lines.push(...activity.blockers);
  return lines;
}

function refreshBackgroundTray(): void {
  if (!backgroundTray) return;
  const activity = currentBackgroundActivity();
  const locale = boot?.settings?.effective.general.locale;
  const lines = localizedBackgroundLines(activity);
  backgroundTray.setToolTip(
    locale === 'zh-CN'
      ? `Charter — ${lines.join('，') || '没有正在运行的工作'}`
      : backgroundTrayTitle(activity),
  );
  if (process.platform === 'darwin') {
    backgroundTray.setTitle(activity.agentCount > 0 ? String(activity.agentCount) : '');
  }
  backgroundTray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: lines.length > 0 ? lines.join(' · ') : mainT(locale, 'No work is currently running'),
        enabled: false,
      },
      { type: 'separator' },
      { label: mainT(locale, 'Open Charter'), click: () => restoreMainWindow('tray-menu') },
      {
        label: mainT(locale, 'Stop all running work'),
        enabled: activity.hasRunningWork && !stoppingBackgroundWork,
        click: () => void stopAllBackgroundWork(),
      },
      { type: 'separator' },
      { label: mainT(locale, 'Quit and stop all'), click: () => quitAndStopAll() },
    ]),
  );
}

function ensureBackgroundTray(): void {
  if (!backgroundTray) {
    backgroundTray = new Tray(createBackgroundTrayIcon());
    backgroundTray.on('click', () => restoreMainWindow('tray-click'));
  }
  refreshBackgroundTray();
}

function stopBackgroundRefresh(): void {
  if (backgroundRefreshTimer) clearInterval(backgroundRefreshTimer);
  backgroundRefreshTimer = null;
}

function enterBackground(win: BrowserWindow): void {
  backgroundMode = true;
  ensureBackgroundTray();
  // AppKit may reactivate an application that remains "active" after its last
  // visible BrowserWindow is hidden. Hide the application as one unit on
  // macOS; a later Dock/tray activation still runs the normal restore path.
  if (process.platform === 'darwin') app.hide();
  else win.hide();
  stopBackgroundRefresh();
  backgroundRefreshTimer = setInterval(refreshBackgroundTray, 2_000);
  backgroundRefreshTimer.unref?.();
  boot?.logger.info('window hidden; runtime continuing in background', {
    ...currentBackgroundActivity(),
  });
}

function restoreMainWindow(source = 'internal'): void {
  const wasBackground = backgroundMode;
  backgroundMode = false;
  stopBackgroundRefresh();
  backgroundTray?.destroy();
  backgroundTray = null;
  if (process.platform === 'darwin') app.show();
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (wasBackground) boot?.logger.info('background window restored', { source });
    return;
  }
  if (app.isReady() && boot) mainWindow = createMainWindow(boot);
}

function quitAndStopAll(): void {
  forceQuit = true;
  stopBackgroundRefresh();
  app.quit();
}

async function stopAllBackgroundWork(): Promise<void> {
  if (stoppingBackgroundWork) return;
  stoppingBackgroundWork = true;
  refreshBackgroundTray();
  try {
    let missionsCancelled = 0;
    try {
      missionsCancelled =
        missionOrchestrationRef?.cancelAll('Stopped from Charter background controls') ?? 0;
    } catch (error) {
      boot?.logger.warn('background stop-all could not cancel every Mission', {
        error: errorMessage(error),
      });
    }
    const activeTasks = taskServiceRef?.listTasks('active', true, 'all') ?? [];
    const taskStops = await Promise.allSettled(
      activeTasks.map((task) => taskServiceRef!.stopTask(task.id)),
    );
    const externalIds = new Set(
      (agentPresenceRef?.list() ?? [])
        .filter((presence) => presence.processState === 'running')
        .map((presence) => presence.terminalId),
    );
    let terminalsStopped = 0;
    for (const terminal of m4Ref?.terminals.list() ?? []) {
      if (externalIds.has(terminal.id) || m4Ref?.terminals.hasRunningChildren(terminal.id)) {
        try {
          m4Ref?.terminals.kill(terminal.id);
          terminalsStopped += 1;
        } catch (error) {
          boot?.logger.warn('background stop-all could not stop terminal', {
            terminalId: terminal.id,
            error: errorMessage(error),
          });
        }
      }
    }
    sshForwardsRef?.stopAll();
    sshSftpRef?.closeAll();
    sshServiceRef?.disconnectAll();
    boot?.logger.info('background stop-all requested', {
      assignments: missionsCancelled,
      tasks: activeTasks.length,
      taskFailures: taskStops.filter((result) => result.status === 'rejected').length,
      terminals: terminalsStopped,
    });
  } finally {
    stoppingBackgroundWork = false;
    refreshBackgroundTray();
  }
}

async function askWindowClose(win: BrowserWindow, bootstrap: Bootstrap): Promise<void> {
  if (closePromptOpen) return;
  closePromptOpen = true;
  try {
    const activity = currentBackgroundActivity();
    const locale = bootstrap.settings?.effective.general.locale;
    const lines = localizedBackgroundLines(activity);
    const result = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: [
        mainT(locale, 'Keep running in background'),
        mainT(locale, 'Quit and stop all'),
        mainT(locale, 'Cancel'),
      ],
      defaultId: 0,
      cancelId: 2,
      title: mainT(locale, 'Work is still running'),
      message: mainT(locale, 'What should Charter do with the work still running?'),
      detail: `${lines.map((line) => `• ${line}`).join('\n')}\n\n${mainT(
        locale,
        'Background work may continue using CPU, network, and model tokens.',
      )}`,
      checkboxLabel: mainT(locale, 'Remember my choice'),
      checkboxChecked: false,
      noLink: true,
    });
    if (result.response === 2 || win.isDestroyed()) return;
    if (result.response === 0) {
      if (result.checkboxChecked) {
        bootstrap.settings?.update('global', { general: { backgroundOnClose: 'keep-running' } });
      }
      enterBackground(win);
      return;
    }
    if (result.checkboxChecked) {
      bootstrap.settings?.update('global', { general: { backgroundOnClose: 'quit' } });
    }
    quitAndStopAll();
  } finally {
    closePromptOpen = false;
  }
}

// §12.3 CSP — extracted to csp.ts so the directives are unit-pinned (ADR-0022).

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
  {
    scheme: 'artifact',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

function registerAppProtocol(rendererDist: string): void {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const target = normalize(join(rendererDist, pathname));
    if (!target.startsWith(normalize(rendererDist))) {
      return new Response('forbidden', { status: 403 });
    }
    if (!existsSync(target)) {
      return new Response('not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(target).toString(), { bypassCustomProtocolHandlers: true });
  });
}

function installCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const isDevContent = Boolean(isDev && DEV_SERVER_URL && details.url.startsWith(DEV_SERVER_URL));
    const isAppContent = details.url.startsWith('app://') || isDevContent;
    if (!isAppContent) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [isDevContent ? DEV_CSP : CSP],
      },
    });
  });
}

function rendererUrl(hash = ''): string {
  if (isDev && DEV_SERVER_URL) return `${DEV_SERVER_URL}${hash ? `#${hash}` : ''}`;
  return `app://bundle/index.html${hash ? `#${hash}` : ''}`;
}

function piSdkVersion(): string | null {
  try {
    const require_ = createRequire(join(app.getAppPath(), 'package.json'));
    const pkg = require_('@earendil-works/pi-coding-agent/package.json') as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function packagedUpdateIsSigned(): boolean {
  if (!app.isPackaged) return false;
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as {
      charterUpdateMode?: unknown;
    };
    return pkg.charterUpdateMode === 'signed';
  } catch {
    return false;
  }
}

function e2eUpdateFixture(): UpdateStateDto['phase'] | null {
  if (!process.env.PI_IDE_E2E) return null;
  const value = process.env.PI_IDE_E2E_UPDATE_STATE;
  const phases: UpdateStateDto['phase'][] = [
    'disabled',
    'idle',
    'checking',
    'available',
    'downloading',
    'downloaded',
    'up-to-date',
    'error',
  ];
  return phases.find((phase) => phase === value) ?? null;
}

function getAppInfo() {
  let commit: string | null = null;
  try {
    const head = readFileSync(join(app.getAppPath(), '.git/HEAD'), 'utf8').trim();
    if (head.startsWith('ref:')) {
      const refPath = join(app.getAppPath(), '.git', head.slice(5).trim());
      commit = existsSync(refPath) ? readFileSync(refPath, 'utf8').trim().slice(0, 12) : null;
    } else {
      commit = head.slice(0, 12);
    }
  } catch {
    commit = null;
  }
  return {
    appVersion: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    node: process.versions.node ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
    commit,
    piSdkVersion: piSdkVersion(),
    updateChannel: boot?.settings?.effective.updates.channel ?? 'stable',
    userDataDir: app.getPath('userData'),
  };
}

function createMainWindow(bootstrap: Bootstrap): BrowserWindow {
  const windowState = new WindowStateKeeper(join(bootstrap.paths.userData, 'window-state.json'));
  const initial = windowState.initialBounds({ width: 1440, height: 900 });
  const win = new BrowserWindow({
    width: initial.width ?? 1440,
    height: initial.height ?? 900,
    ...(initial.x !== undefined && initial.y !== undefined ? { x: initial.x, y: initial.y } : {}),
    minWidth: 1024,
    minHeight: 640,
    // E2E runs on CI use emulated displays smaller than the default bounds
    // (hosted macOS runners report ~1176×885); without this macOS clamps the
    // window and the cramped layout breaks pointer-interception checks.
    ...(process.env.PI_IDE_E2E ? { enableLargerThanScreen: true } : {}),
    show: false,
    title: 'Charter',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 10 } }
      : {}),
    backgroundColor: windowBackground(
      bootstrap.settings?.effective.general.skin ?? 'studio',
      nativeTheme.shouldUseDarkColors,
    ),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(app.getAppPath(), 'apps/desktop-preload/dist/preload.cjs'),
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  windowState.track(win);
  win.once('ready-to-show', () => {
    win.show();
    if (initial.maximized) win.maximize();
  });

  // A11Y-003: restore the persisted UI zoom (true window zoom — Monaco and the
  // terminal scale with it). Applied after the frame loads so it sticks; pinch/
  // ctrl-scroll zoom is disabled so zoom is only ever the explicit setting.
  win.webContents.on('did-finish-load', () => {
    const scale = bootstrap.settings?.effective.general.uiScale ?? 1;
    win.webContents.setZoomFactor(scale);
    void win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => undefined);
  });

  const startHash = bootstrap.startupError
    ? `/startup-error?code=${encodeURIComponent(bootstrap.startupError.code)}&msg=${encodeURIComponent(bootstrap.startupError.userMessage)}`
    : '';
  void win.loadURL(rendererUrl(startHash));

  win.on('close', (event) => {
    if (forceQuit) return;
    const activity = currentBackgroundActivity();
    const action = windowCloseAction(
      bootstrap.settings?.effective.general.backgroundOnClose ?? 'ask',
      activity,
    );
    if (action === 'close') return;
    event.preventDefault();
    if (action === 'keep-running') {
      enterBackground(win);
      return;
    }
    if (action === 'quit') {
      quitAndStopAll();
      return;
    }
    void askWindowClose(win, bootstrap);
  });

  // Dev visibility: renderer console errors/warnings surface in the dev log
  // (a blank window is otherwise undebuggable from the terminal).
  if (isDev) {
    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      if (level >= 2) {
        bootstrap.logger.warn('renderer console', {
          level,
          message: message.slice(0, 500),
          source: `${sourceId}:${line}`,
        });
      }
    });
    win.webContents.on('did-fail-load', (_event, code, description, url) => {
      bootstrap.logger.error('renderer failed to load', { code, description, url });
    });
  }

  let rendererCrashTimes: number[] = [];
  win.webContents.on('render-process-gone', (_event, details) => {
    // A clean renderer exit (normal teardown) is not a crash — never record or
    // react to it. Everything else is fatal for the window's content.
    if (details.reason === 'clean-exit') {
      bootstrap.logger.info('renderer exited cleanly');
      return;
    }
    bootstrap.logger.error('renderer crashed', { reason: details.reason });
    bootstrap.state?.recordError(
      'renderer',
      productError('APP_RENDERER_CRASH', {
        userMessage: 'The window crashed and can be reloaded.',
        severity: 'fatal',
        context: { reason: details.reason },
      }),
    );
    rendererCrashTimes.push(Date.now());
    const verdict = rendererCrashAction(rendererCrashTimes, Date.now());
    rendererCrashTimes = verdict.recentCrashes;
    // Recover in place. A synchronous dialog here blocks the main-process
    // event loop — no IPC, no repaint, a frozen window — which is worse than
    // the crash itself. E2E/soak (M10) always reloads so tests never hang.
    if (verdict.action === 'reload' || process.env.PI_IDE_E2E) {
      win.webContents.reload();
      return;
    }
    // Crash loop: reloading has not stuck. Ask asynchronously — main keeps
    // servicing events (background agents, terminals) while the dialog is up.
    void dialog
      .showMessageBox(win, {
        type: 'error',
        buttons: ['Reload Window', 'Quit'],
        defaultId: 0,
        title: 'Window crashed',
        message:
          'The Charter window keeps crashing. Your agent tasks and files on disk are unaffected.',
      })
      .then(({ response }) => {
        if (response === 0) {
          rendererCrashTimes = [];
          win.webContents.reload();
        } else {
          forceQuit = true;
          app.quit();
        }
      });
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

function registerCoreHandlers(bootstrap: Bootstrap): void {
  const { logger, settings, state, paths } = bootstrap;

  registerHandlers(
    {
      'app.getInfo': async () => getAppInfo(),
      'app.getBackgroundActivity': async () => ({
        ...currentBackgroundActivity(),
        background: backgroundMode,
      }),
      'agents.list': async ({ refresh }) => {
        if (!agentRegistryRef) {
          return {
            agents: [],
            scannedAt: new Date(0).toISOString(),
            engineVersion: AGENT_ADAPTER_ENGINE_VERSION,
            overrideEnabled: false,
            diagnostics: [],
          };
        }
        return refresh ? agentRegistryRef.refresh() : agentRegistryRef.catalog();
      },
      'agents.packs.list': async () => agentPackServiceRef?.catalog() ?? { packs: [] },
      'agents.packs.install': async () => {
        const packs = agentPackServiceRef;
        if (!packs) return { changed: false, catalog: { packs: [] } };
        const win = mainWindow ?? BrowserWindow.getFocusedWindow();
        const options: Electron.OpenDialogOptions = {
          title: 'Install Agent Pack',
          properties: ['openFile'],
          filters: [
            { name: 'Charter Agent Pack', extensions: ['json'] },
            { name: 'All files', extensions: ['*'] },
          ],
        };
        const result = win
          ? await dialog.showOpenDialog(win, options)
          : await dialog.showOpenDialog(options);
        if (result.canceled || !result.filePaths[0]) {
          return { changed: false, catalog: packs.catalog() };
        }
        packs.install(result.filePaths[0]);
        refreshAgentPackIntegrations();
        return { changed: true, catalog: packs.catalog() };
      },
      'agents.packs.setEnabled': async ({ id, enabled }) => {
        const changed = agentPackServiceRef?.setEnabled(id, enabled) ?? false;
        if (changed) refreshAgentPackIntegrations();
        return { changed, catalog: agentPackServiceRef?.catalog() ?? { packs: [] } };
      },
      'agents.packs.rollback': async ({ id }) => {
        const changed = agentPackServiceRef?.rollback(id) ?? false;
        if (changed) refreshAgentPackIntegrations();
        return { changed, catalog: agentPackServiceRef?.catalog() ?? { packs: [] } };
      },
      'agents.packs.remove': async ({ id }) => {
        const changed = agentPackServiceRef?.remove(id) ?? false;
        if (changed) refreshAgentPackIntegrations();
        return { changed, catalog: agentPackServiceRef?.catalog() ?? { packs: [] } };
      },
      'terminal.pasteClipboardImage': async ({ id }) => {
        if (!terminalImagePasteRef) {
          throw new Error('Terminal image paste is unavailable while terminal services start.');
        }
        const result = await terminalImagePasteRef.paste(id);
        agentVerificationRef?.noteImagePasted(id);
        return result;
      },
      'app.openExternal': async ({ url }) => ({ opened: await openExternalChecked(url, logger) }),
      'app.revealPath': async ({ path }) => {
        // Reveal in Finder/Explorer — absolute existing paths only.
        const { isAbsolute } = await import('node:path');
        const { existsSync } = await import('node:fs');
        if (!isAbsolute(path) || !existsSync(path)) return { revealed: false };
        if (!process.env.PI_IDE_E2E) shell.showItemInFolder(path);
        return { revealed: true };
      },
      'updates.getState': async () => updateServiceRef!.state,
      'updates.check': async () => updateServiceRef!.check(),
      'updates.openDownload': async () => ({
        opened: await openExternalChecked(
          updateServiceRef?.state.releaseUrl ?? RELEASES_PAGE,
          logger,
        ),
      }),
      'updates.install': async ({ force }) => {
        const activity = currentBackgroundActivity();
        const blockers = localizedBackgroundLines(activity);
        if (blockers.length > 0 && !force) return { installing: false, blockers };
        return { installing: await updateServiceRef!.install(), blockers: [] };
      },
      'app.reportClientError': async (payload, meta) => {
        logger.error(`renderer error: ${payload.message}`, { code: payload.code });
        state?.recordError(
          'renderer',
          productError(payload.code || 'RENDERER_ERROR', {
            userMessage: payload.message.slice(0, 500),
          }),
        );
        void meta;
        return { logged: true };
      },
      'app.setQuitBlockers': async ({ blockers }, meta) => {
        quitBlockers.set(meta.senderId, blockers);
        return { ok: true };
      },
      'diagnostics.openLogsFolder': async () => {
        await shell.openPath(paths.logsDir);
        return { opened: true };
      },
      'diagnostics.get': async () => ({
        dbOk: Boolean(state),
        dbDetail: state
          ? `schema ok${bootstrap.startupError ? '' : ''} (migrations current)`
          : (bootstrap.startupError?.userMessage ?? 'database unavailable'),
        logsDir: paths.logsDir,
        components: [
          { name: 'main', status: 'ok' as const, detail: `pid ${process.pid}` },
          {
            name: 'database',
            status: state ? ('ok' as const) : ('down' as const),
            detail: state ? paths.databaseFile : 'failed to open',
          },
          {
            name: 'agent-worker',
            status: agentHostRef?.alive ? ('ok' as const) : ('idle' as const),
            detail: agentHostRef?.alive
              ? `pid ${agentHostRef.workerPid() ?? '?'} restarts ${agentHostRef.restartCount}`
              : 'starts with first task',
          },
        ],
        recentErrors: state?.recentErrors() ?? [],
      }),
    },
    logger,
  );

  if (settings && state) {
    registerHandlers(
      {
        'settings.get': async () => settings.state,
        'settings.update': async ({ scope, patch }) => {
          const result = settings.update(scope, patch);
          // A11Y-003: general.uiScale drives real window zoom (Monaco/terminal
          // included) — apply the moment it changes so the setting is live.
          const scale = settings.effective.general.uiScale;
          const win = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
          if (win && win.webContents.getZoomFactor() !== scale) {
            win.webContents.setZoomFactor(scale);
          }
          return result;
        },
        'settings.reset': async ({ scope }) => settings.reset(scope),
        'layout.get': async () => ({ layout: state.getLayout(null) }),
        'layout.save': async ({ layout }) => {
          state.saveLayout(null, layout);
          return { saved: true };
        },
        'workspace.recent': async () => ({
          // Deleted folders disappear from every project picker automatically.
          // Keep their database rows so Session Archive history is not erased.
          items: state
            .recentWorkspaces()
            .filter((item) => item.exists)
            .map((item) => ({
              ...item,
              kind: detectProjectKind(item.path),
            })),
        }),
      },
      logger,
    );
  }
}

function terminalDaemonSocketPath(userData: string): string {
  const identity = createHash('sha256').update(userData).digest('hex').slice(0, 20);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\charter-terminal-${identity}`
    : join(tmpdir(), `charter-terminal-${identity}.sock`);
}

function launchTerminalDaemon(paths: AppPaths, socketPath: string, tokenFile: string): void {
  const appPath = app.getAppPath();
  const daemonRoot = app.isPackaged && appPath.endsWith('.asar') ? `${appPath}.unpacked` : appPath;
  const daemonEntry = join(daemonRoot, 'apps', 'desktop-main', 'dist', 'terminal-daemon.cjs');
  const daemonArgs = [
    `--terminal-daemon-socket=${socketPath}`,
    `--terminal-daemon-token=${tokenFile}`,
    `--terminal-daemon-state=${join(paths.runtimeDir, 'terminal-sessions')}`,
    `--terminal-daemon-recordings=${join(paths.userData, 'terminal-recordings')}`,
    `--terminal-daemon-log=${join(paths.logsDir, 'terminal-daemon.log')}`,
  ];
  const child = spawn(process.execPath, [daemonEntry, ...daemonArgs], {
    cwd: paths.runtimeDir,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  // Connection polling below reports startup failure; never let an async
  // spawn error become an uncaught EventEmitter error in Electron Main.
  child.on('error', () => undefined);
  child.unref();
}

function terminalControlIdentitySecret(runtimeDir: string): Buffer {
  const path = join(runtimeDir, 'terminal-control.key');
  if (!existsSync(path)) writeFileSync(path, randomBytes(32), { mode: 0o600 });
  chmodSync(path, 0o600);
  return readFileSync(path);
}

// Development launches inherit the workspace package name (`pi-ide`). Set the
// product identity before Electron derives native macOS menu labels from it.
app.setName('Charter');
// The terminal service runs in both Electron Main and the detached daemon.
// Publish one stable version value before either side creates a child PTY.
process.env.CHARTER_APP_VERSION = app.getVersion();

const gotLock = app.requestSingleInstanceLock();
// Every live terminal holds one WebGL context. Blink's default active-context
// budget (~16) silently evicts the oldest beyond that, and an evicted xterm
// falls back to the slow DOM renderer until its bounded retry — with dozens of
// Sessions that read as "terminal scrolling got janky over time". Must be set
// before app ready (ADR-0055 follow-up; same lesson ORCA ships).
app.commandLine.appendSwitch('max-active-webgl-contexts', '128');

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    restoreMainWindow('second-instance');
  });

  app.whenReady().then(async () => {
    const paths = createAppPaths(app.getPath('userData'));
    const logs = new LogService(paths.logsDir, {
      level: process.env.PI_IDE_LOG_LEVEL === 'debug' ? 'debug' : 'info',
      console: isDev,
    });
    const logger = logs.logger('main');

    let terminalDaemon: TerminalDaemonClient | null = null;
    const terminalPersistenceEnabled =
      !process.env.PI_IDE_E2E || process.env.PI_IDE_TERMINAL_PERSIST === '1';
    if (terminalPersistenceEnabled) {
      try {
        const socketPath = terminalDaemonSocketPath(paths.userData);
        const tokenFile = join(paths.runtimeDir, 'terminal-daemon.token');
        terminalDaemon = await TerminalDaemonClient.connect({
          socketPath,
          tokenFile,
          launchDaemon: () => launchTerminalDaemon(paths, socketPath, tokenFile),
        });
        terminalDaemonRef = terminalDaemon;
        logger.info('terminal daemon connected', {
          restored: terminalDaemon.restoredSessions().length,
        });
      } catch (error) {
        logger.warn('terminal daemon unavailable; using in-process PTYs', {
          error: errorMessage(error),
        });
      }
    }

    let settings: SettingsService | null = null;
    let state: StateService | null = null;
    let workspaceHost: WorkspaceHost | null = null;
    let startupError: ProductError | null = null;

    try {
      settings = new SettingsService(paths.settingsFile, logger.child('settings'));
      if (!settings.hasExplicitUpdateChannel) {
        settings.update('global', {
          updates: { channel: defaultUpdateChannel(app.getVersion()) },
        });
      }
      state = new StateService(paths.databaseFile, paths.backupsDir, logger.child('db'));
      workspaceHost = new WorkspaceHost(state, settings, logger.child('workspace'));
    } catch (e) {
      startupError = toProductError(e, 'APP_STARTUP_FAILED');
      logger.error('startup degraded: database unavailable', { code: startupError.code });
    }

    const agentHome = process.env.PI_IDE_E2E ? process.env.PI_IDE_AGENT_HOME : undefined;
    agentPackServiceRef = new AgentPackService(paths.agentPacksDir, logger.child('agent-packs'));
    agentRegistryRef = new AgentRegistry(logger.child('agent-registry'), {
      ...(agentHome ? { homeDir: agentHome } : {}),
      userManifestDir:
        process.env.PI_IDE_AGENT_MANIFESTS ??
        join(agentHome ?? app.getPath('home'), '.charter', 'agents'),
      allowOverrides: !app.isPackaged || process.env.PI_IDE_AGENT_ADAPTER_OVERRIDES === '1',
      probeVersions: !process.env.PI_IDE_E2E,
      packManifests: () => agentPackServiceRef?.activeManifests() ?? [],
    });

    boot = { paths, logs, logger, settings, state, workspaceHost, startupError };

    updateServiceRef = new UpdateService({
      currentVersion: app.getVersion(),
      platform: process.platform,
      isPackaged: app.isPackaged,
      signed: packagedUpdateIsSigned(),
      channel: settings?.effective.updates.channel ?? 'stable',
      autoCheck: settings?.effective.updates.autoCheck ?? false,
      logger: logger.child('updates'),
      emit: (updateState) => broadcast('updates.changed', updateState),
      fetchRelease: (url, init) => net.fetch(url, init),
      beforeInstall: async (version) => {
        if (!state) {
          throw new Error('The local database is unavailable; update installation stopped.');
        }
        await state.backupForUpdate(version);
      },
      fixturePhase: e2eUpdateFixture(),
    });

    // Theme (APP-006)
    if (settings) {
      nativeTheme.themeSource = settings.effective.general.theme;
      settings.onChange((s) => {
        nativeTheme.themeSource = s.effective.general.theme;
        mainWindow?.setBackgroundColor(
          windowBackground(s.effective.general.skin, nativeTheme.shouldUseDarkColors),
        );
        broadcast('settings.changed', { issues: s.issues, overrideKeys: s.overrideKeys });
        installApplicationMenu({ isDev, locale: s.effective.general.locale });
        updateServiceRef?.syncSettings(s.effective.updates);
        refreshBackgroundTray();
      });
    }
    nativeTheme.on('updated', () => {
      mainWindow?.setBackgroundColor(
        windowBackground(
          settings?.effective.general.skin ?? 'studio',
          nativeTheme.shouldUseDarkColors,
        ),
      );
      broadcast('app.themeChanged', {
        theme: (settings?.effective.general.theme ?? 'system') as 'light' | 'dark' | 'system',
        effective: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      });
    });

    installGlobalSecurityHandlers(DEV_SERVER_URL, logger);
    installCsp();
    if (!isDev) registerAppProtocol(join(app.getAppPath(), 'apps/desktop-renderer/dist'));
    installApplicationMenu({ isDev, locale: settings?.effective.general.locale ?? 'en' });
    registerCoreHandlers(boot);
    if (state && settings) {
      // Reminders must stay visible without Notification Center authorization —
      // unsigned/dev builds never complete macOS notification registration
      // (ADR-0053 follow-up). The Dock badge counts due-and-unhandled
      // reminders and the icon bounces when one fires in the background;
      // neither needs any system permission.
      const refreshWorkBadge = (): void => {
        app.setBadgeCount(workItemServiceRef?.firedReminderCount() ?? 0);
      };
      workItemServiceRef = new WorkItemService(state.db, logger.child('work-items'), {
        changed: (itemId, reason) => {
          broadcast('workItem.changed', { itemId, reason });
          if (reason.startsWith('reminder')) refreshWorkBadge();
        },
        reminderDue: ({ item, reminder }) => {
          broadcast('workItem.reminderDue', { item, reminder });
          if (!process.env.PI_IDE_E2E && BrowserWindow.getFocusedWindow() === null) {
            app.dock?.bounce('critical');
          }
          const focusItem = (): void => {
            restoreMainWindow('work-reminder');
            broadcast('app.focusWorkItem', { itemId: item.id });
          };
          if (
            settings.effective.notifications.enabled &&
            !process.env.PI_IDE_E2E &&
            BrowserWindow.getFocusedWindow() === null &&
            Notification.isSupported()
          ) {
            const note = new Notification({
              title: item.title,
              body: reminder.message || `Work item reminder · ${item.assignee || 'Unassigned'}`,
            });
            note.on('click', focusItem);
            note.show();
          }
        },
      });
      registerWorkItemHandlers(workItemServiceRef, logger.child('work-item-ipc'));
      workItemServiceRef.start();
      refreshWorkBadge();
      // ADR-0056: read-only GitHub issue import feeding the Work board.
      const githubVault = new GithubVaultService(
        paths.githubSecretsDir,
        logger.child('github-vault'),
      );
      const githubIssues = new GithubIssueService(
        state.db,
        workItemServiceRef,
        githubVault,
        () =>
          state
            .recentWorkspaces()
            .filter((workspace) => workspace.exists)
            .map((workspace) => ({
              path: workspace.path,
              displayName: workspace.displayName,
            })),
        logger.child('github-import'),
      );
      registerGithubHandlers(githubIssues, logger.child('github-ipc'));
    }
    let m4: M4Services | null = null;
    if (workspaceHost && state && settings) {
      registerWorkspaceHandlers(workspaceHost, state, logger.child('ipc'));
      // ADR-0021: OSC 133/9;4 shell integration scripts, written once per launch.
      const shellIntegrationDir = writeShellIntegrationFiles(
        app.getPath('userData'),
        logger.child('shell-integration'),
      );
      // ADR-0017 amendment: product CLI launches register an intent here
      // (pre-assigned conversation id + composer prompt); the external session
      // service consumes it on the detection edge.
      externalLaunchIntents = new ExternalLaunchIntents();
      const ctlSocketPath = join(paths.userData, 'ctl.sock');
      const tokenOverrideAllowed = isDev || Boolean(process.env.PI_IDE_E2E);
      terminalIdentitiesRef = new TerminalControlIdentityRegistry(
        ctlSocketPath,
        tokenOverrideAllowed ? (process.env.CHARTER_CTL_TOKEN_OVERRIDE ?? null) : null,
        terminalControlIdentitySecret(paths.runtimeDir),
      );
      const terminalIntegration = installTerminalControlIntegration({
        userData: paths.userData,
        appPath: app.getAppPath(),
        logger: logger.child('terminal-mcp'),
      });
      const explicitVisibleMcp =
        process.env.PI_IDE_VISIBLE_MCP === '1' || process.env.PI_IDE_ACP === '1';
      const resolveVisibleAgentLaunch = (launch: string, initialPrompt: string | null) => {
        const sessionId = agentRegistryRef!.preassignSessionId(launch) ? randomUUID() : null;
        const spec = agentRegistryRef!.launchSpec(launch, {
          prompt: initialPrompt,
          sessionId,
        });
        if (!spec) return null;
        const orchestrationExecutable =
          settings.effective.orchestration.enabled || explicitVisibleMcp
            ? terminalIntegration?.mcpExecutableFor(launch)
            : null;
        const executable =
          orchestrationExecutable ?? agentRegistryRef!.executableFor(launch) ?? spec.executable;
        return {
          ...spec,
          executable,
          // The MCP wrapper already re-enters the user's interactive shell.
          // Direct visible Sessions can invoke the trusted bare Agent id in
          // their existing login shell, allowing the same alias/function a
          // manual zsh launch would use.
          shellCommand:
            executable === orchestrationExecutable ||
            basename(spec.executable).toLocaleLowerCase() !== launch.toLocaleLowerCase()
              ? null
              : launch,
        };
      };
      const resolveRemoteAgentLaunch = (launch: string, initialPrompt: string | null) => {
        const sessionId = agentRegistryRef!.preassignSessionId(launch) ? randomUUID() : null;
        return agentRegistryRef!.remoteLaunchSpec(launch, {
          prompt: initialPrompt,
          sessionId,
        });
      };
      const missionVirtualTasks = new Map<string, string>();
      const detectedAgentIds = process.env.PI_IDE_EXTERNAL_CLIS
        ? process.env.PI_IDE_EXTERNAL_CLIS.split(',')
            .map((id) => id.trim().toLowerCase())
            .filter(Boolean)
        : agentRegistryRef.terminalAgentCliIdentities();
      m4 = new M4Services(
        workspaceHost,
        settings,
        logger.child('m4'),
        shellIntegrationDir,
        (id) =>
          settings.effective.orchestration.enabled
            ? {
                ...terminalIdentitiesRef!.environment(id),
                ...terminalIntegration?.environment(),
              }
            : {},
        terminalDaemon,
        detectedAgentIds,
      );
      m4Ref = m4;
      terminalRecordingRef = new TerminalRecordingCoordinator(
        m4.terminals,
        join(paths.userData, 'terminal-recordings'),
        () => terminalDaemon?.supportsTerminalRecording() !== true,
      );
      for (const id of m4.restoredTerminalIds) terminalIdentitiesRef.issue(id);
      m4.terminals.onExitEvent(({ id }) => terminalIdentitiesRef?.revokeTerminal(id));
      agentPresenceRef = new AgentPresenceService(m4.terminals, logger.child('agent-presence'), {
        manifests: agentRegistryRef.lifecycleManifests(),
        onChanged: (presence) => {
          broadcast('agentPresence.changed', presence);
          refreshBackgroundTray();
        },
      });
      registerAgentPresenceHandlers(agentPresenceRef, logger.child('agent-presence-ipc'));
      agentVerificationRef = new AgentVerificationService(
        join(paths.agentPacksDir, 'verification-results.json'),
        agentRegistryRef,
        () => agentPackServiceRef?.catalog() ?? { packs: [] },
        m4.terminals,
        agentPresenceRef,
        logger.child('agent-verification'),
      );
      registerAgentVerificationHandlers(
        agentVerificationRef,
        agentRegistryRef,
        logger.child('agent-verification-ipc'),
      );
      terminalControlRef = new TerminalControlService(m4.terminals, logger.child('orchestration'), {
        enabled: () => settings.effective.orchestration.enabled,
        maxWorkers: () => settings.effective.orchestration.maxWorkers,
        maxSendsPerMinute: () => settings.effective.orchestration.maxSendsPerMinute,
        launchIntents: externalLaunchIntents,
        resolveAgentLaunch: resolveVisibleAgentLaunch,
        taskForTerminal: (id) => externalSessionsRef?.taskIdForTerminal(id) ?? null,
        taskTitleForTerminal: (id) => {
          const taskId = externalSessionsRef?.taskIdForTerminal(id);
          if (!taskId || !taskServiceRef) return null;
          try {
            return taskServiceRef.getTask(taskId).title;
          } catch {
            return null;
          }
        },
        onChanged: (snapshot) => broadcast('orchestration.changed', snapshot),
        recordEvent: (taskId, type, payload) => taskServiceRef?.recordEvent(taskId, type, payload),
      });
      agentSemanticControlRef = new AgentSemanticControlService(
        agentPresenceRef,
        terminalControlRef,
        logger.child('agent-semantic-control'),
        {
          resultReader: new AgentResultReader(),
          resultSessionForTerminal: (terminalId, agent) => {
            const task = taskServiceRef?.externalTaskForTerminal(terminalId);
            const external = task?.external;
            if (!task || !external) return null;
            const source = agentRegistryRef?.sessionHistorySource(agent) ?? null;
            const startedAtMs = Date.parse(task.createdAt);
            const updatedAtMs = Date.parse(task.updatedAt);
            return {
              taskId: task.id,
              agent,
              connector: source?.connector ?? null,
              dataHome: source?.dataHome ?? null,
              cwd: external.cwd ?? task.projectPath,
              sessionId: external.sessionId ?? null,
              startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
              endedAtMs:
                external.status === 'active'
                  ? Date.now()
                  : Number.isFinite(updatedAtMs)
                    ? updatedAtMs
                    : Date.now(),
              remote: Boolean(external.remote),
            };
          },
          recordSessionId: (taskId, sessionId) =>
            taskServiceRef?.setExternalSessionId(taskId, sessionId),
        },
      );
      registerOrchestrationHandlers(terminalControlRef, logger.child('ipc'));
      // ADR-0047: SSH Remotes. Vault (keychain) + connection manager + host
      // book; wired into terminal.create as a remote launcher below.
      const sshVault = new SshVaultService(paths.sshSecretsDir, logger.child('ssh-vault'));
      sshServiceRef = new SshService(settings, sshVault, m4.terminals, logger.child('ssh'), {
        sshDir: paths.sshDir,
        resolveAgentLaunch: resolveRemoteAgentLaunch,
        // E2E points config/known_hosts at fixtures (mirrors PI_IDE_SKILLS_HOME).
        ...(process.env.PI_IDE_SSH_CONFIG ? { sshConfigPath: process.env.PI_IDE_SSH_CONFIG } : {}),
        ...(process.env.PI_IDE_SSH_KNOWN_HOSTS
          ? { knownHostsPath: process.env.PI_IDE_SSH_KNOWN_HOSTS }
          : {}),
      });
      const remoteWorkerRuntimeRoot = app.getAppPath().endsWith('app.asar')
        ? `${app.getAppPath()}.unpacked`
        : app.getAppPath();
      remoteWorkerRef = new RemoteWorkerService({
        exec: (hostId, command, input) => sshServiceRef!.execCommand(hostId, command, input),
        probeNode: (hostId) => sshServiceRef!.probeCli(hostId, 'node'),
        openSftp: (hostId) => sshServiceRef!.openSftpSession(hostId),
        bundlePath: join(
          remoteWorkerRuntimeRoot,
          'apps',
          'desktop-main',
          'dist',
          'remote-session-worker.cjs',
        ),
        paths,
        logger: logger.child('remote-worker'),
        isConnected: (hostId) => sshServiceRef!.isConnected(hostId),
      });
      sshServiceRef.attachManagedSessions(remoteWorkerRef, externalLaunchIntents!);
      // PR2/PR3: SFTP panel + local port forwards on the same transports.
      sshSftpRef = new SshSftpService({
        openSession: (hostId) => sshServiceRef!.openSftpSession(hostId),
        chooseSavePath: async (suggestedName) => {
          const win = mainWindow ?? BrowserWindow.getFocusedWindow();
          const options = {
            defaultPath: join(app.getPath('downloads'), suggestedName),
          };
          const res = win
            ? await dialog.showSaveDialog(win, options)
            : await dialog.showSaveDialog(options);
          return res.canceled || !res.filePath ? null : res.filePath;
        },
        emit: (state) => broadcast('ssh.sftpProgress', state),
        logger: logger.child('ssh-sftp'),
      });
      terminalImagePasteRef = new TerminalImagePasteService(
        join(tmpdir(), `charter-image-paste-${process.getuid?.() ?? process.pid}`),
        m4.terminals,
        logger.child('terminal-image-paste'),
        {
          readClipboardImage: () => {
            const image = clipboard.readImage();
            if (image.isEmpty()) return null;
            const { width, height } = image.getSize();
            return { bytes: image.toPNG(), width, height };
          },
          openSftp: (hostId) => sshServiceRef!.openSftpSession(hostId),
          supportsImages: (agentId) =>
            agentRegistryRef?.manifest(agentId)?.capabilities.images === true,
        },
      );
      sshForwardsRef = new SshForwardService({
        getForward: (hostId, forwardId) => sshServiceRef!.getForward(hostId, forwardId),
        openStream: (hostId, dstHost, dstPort) =>
          sshServiceRef!.openForwardStream(hostId, dstHost, dstPort),
        connect: (hostId) => sshServiceRef!.connect(hostId),
        hold: (hostId, token) => sshServiceRef!.holdConnection(hostId, token),
        release: (hostId, token) => sshServiceRef!.releaseConnection(hostId, token),
        emit: (state) => broadcast('ssh.forwardState', state),
        logger: logger.child('ssh-fwd'),
      });
      registerSshHandlers(
        sshServiceRef,
        remoteWorkerRef,
        sshSftpRef,
        sshForwardsRef,
        new LocalFilesService(),
        logger.child('ipc'),
      );
      registerM4Handlers(
        m4,
        workspaceHost,
        logger.child('ipc'),
        {
          recent(projectPath) {
            const project = state
              .recentWorkspaces()
              .find((item) => item.exists && item.path === projectPath);
            if (!project) return null;
            return {
              cwd: project.path,
              projectName: project.displayName,
              projectPath: project.path,
              contextKind: 'recent' as const,
              contextLabel: project.displayName,
              contextTaskId: null,
            };
          },
          task(taskId) {
            try {
              const task = taskServiceRef?.getTask(taskId);
              if (!task) return null;
              const worktree = task.worktree && !task.worktree.missing ? task.worktree : null;
              return {
                cwd: worktree?.path ?? task.external?.cwd ?? task.projectPath,
                projectName: task.projectName,
                projectPath: task.projectPath,
                contextKind: 'task' as const,
                contextLabel: task.title,
                contextTaskId: task.id,
              };
            } catch {
              return null;
            }
          },
          scratch() {
            const root = join(paths.runtimeDir, 'scratch');
            mkdirSync(root, { recursive: true });
            const cwd = mkdtempSync(join(root, 'terminal-'));
            return {
              cwd,
              projectName: 'Scratch',
              projectPath: null,
              contextKind: 'scratch' as const,
              contextLabel: 'Temporary commands',
              contextTaskId: null,
            };
          },
          // ADR-0038: adoption terminals — cwd comes from the discovery cache,
          // never from the renderer. Deferred: archaeologyRef is assigned below.
          async archaeology(cli, sessionId) {
            const found = (await archaeologyRef?.lookup(cli, sessionId)) ?? null;
            if (!found) return null;
            const projectPath = found.projectPath ?? found.cwd;
            return {
              cwd: found.cwd,
              projectName: basename(projectPath) || projectPath,
              projectPath,
              contextKind: 'recent' as const,
              contextLabel: basename(projectPath) || projectPath,
              contextTaskId: null,
            };
          },
          async prepareExternalWorktree({ cli, projectPath, title, setupCommand }) {
            if (!taskServiceRef) throw new Error('Task service is not ready.');
            const task = await taskServiceRef.createExternalTask({
              cli,
              terminalId: 'pending',
              cwd: projectPath,
              projectPath,
              isolation: 'worktree',
              ...(setupCommand ? { worktreeSetup: setupCommand } : {}),
              title,
            });
            const worktree = task.worktree && !task.worktree.missing ? task.worktree : null;
            if (!worktree) {
              await taskServiceRef.abortPreparedExternalTask(task.id);
              throw new Error('The external Session worktree was not created.');
            }
            return {
              cwd: worktree.path,
              projectName: task.projectName,
              projectPath: task.projectPath,
              contextKind: 'task' as const,
              contextLabel: task.title,
              contextTaskId: task.id,
            };
          },
          bindExternalTerminal(taskId, terminalId) {
            if (!taskServiceRef) throw new Error('Task service is not ready.');
            taskServiceRef.bindExternalTaskTerminal(taskId, terminalId);
          },
          async abortPreparedExternal(taskId) {
            await taskServiceRef?.abortPreparedExternalTask(taskId);
          },
        },
        externalLaunchIntents,
        {
          create: (options) => sshServiceRef!.createRemoteTerminal(options),
        },
        resolveVisibleAgentLaunch,
      );
      registerTerminalOpenHandlers(m4, workspaceHost, logger.child('ipc'));
      m5Ref = new M5Services(workspaceHost, state, paths, logger.child('m5'));
      registerM5Handlers(m5Ref, workspaceHost, logger.child('ipc'));

      const secretService = new SecretService(paths.secretsDir, logger.child('secrets'));
      agentHostRef = new AgentHost(
        joinPath(paths.runtimeDir, 'agent'),
        secretService,
        logger.child('agent-host'),
      );
      // ADR-0019: discover user-level Agent/Codex/Claude sources while keeping
      // project directories opt-in (AG-014). E2E only discovers an explicitly
      // supplied fake home, never the developer machine's real home folder.
      const skillHome = process.env.PI_IDE_SKILLS_HOME;
      const charterAgentSurfaces = agentRegistryRef.skillSources(skillHome).map(({ id, root }) => ({
        target: id,
        root,
      }));
      // These two generated Skills are part of Charter's control protocol, not
      // user-authored content. Keep detected Agent surfaces current before any
      // new external Session can select terminal.create over Mission promotion.
      // E2E never writes to a developer home unless the test supplied an
      // isolated Agent/Skills home explicitly.
      if (!process.env.PI_IDE_E2E || Boolean(skillHome) || Boolean(process.env.PI_IDE_AGENT_HOME)) {
        const synchronized = installCharterTerminalSurfaces(charterAgentSurfaces);
        const failed = synchronized.filter((surface) => surface.error);
        if (failed.length > 0) {
          logger.warn('charter Agent control Skills partially synchronized', {
            failed: failed.map((surface) => surface.target),
          });
        } else {
          logger.info('charter Agent control Skills synchronized', {
            targets: synchronized.map((surface) => surface.target),
          });
        }
      }
      const skillStore = new SkillStore(paths.skillsDir, logger.child('skills'), {
        discoverExternal: !process.env.PI_IDE_E2E || Boolean(skillHome),
        ...(skillHome ? { homeDir: skillHome } : {}),
        agentSources: agentRegistryRef.skillSources(skillHome),
        onDidChange: (event) => broadcast('skills.changed', event),
      });
      skillStore.installManaged('charter-terminal', CHARTER_TERMINAL_SKILL);
      skillStore.installManaged('charter-orchestration', CHARTER_ORCHESTRATION_SKILL);
      skillStoreRef = skillStore;
      skillStore.startWatching();
      registerSkillsHandlers(skillStore, logger.child('ipc'), {
        // Deferred: taskServiceRef is assigned right below (ADR-0037), and
        // archaeologyRef further down (ADR-0040) — empty usage until then.
        events: (windowDays) => taskServiceRef?.skillUsageEvents(windowDays) ?? [],
        externalEvents: async (windowDays) =>
          (await archaeologyRef?.skillUsageEvents(windowDays)) ?? [],
        agentSurfaces: () =>
          agentRegistryRef!.skillSources(skillHome).map(({ id, root }) => ({
            target: id,
            root,
          })),
      });
      // ADR-0028: project memory — shared rules source, review-correction
      // capture, managed-block sync, external private-memory management.
      // E2E only discovers an explicitly supplied fake home (PI_IDE_MEMORY_HOME).
      const memoryHome = process.env.PI_IDE_MEMORY_HOME;
      const memoryService = new MemoryService({
        db: state.db,
        logger: logger.child('memory'),
        trashDir: joinPath(paths.memoryDir, 'trash'),
        ...(memoryHome ? { homeDir: memoryHome } : {}),
        discoverExternal: !process.env.PI_IDE_E2E || Boolean(memoryHome),
        broadcast: (payload) => broadcast('memory.changed', payload),
        captureEnabled: () => settings.effective.memory.captureEnabled,
        // Deferred: taskServiceRef is assigned right below.
        recordTaskEvent: (taskId, type, payload) => {
          taskServiceRef?.recordEvent(taskId, type, payload);
        },
      });
      registerMemoryHandlers(memoryService, logger.child('ipc'));
      const taskService = new TaskService(
        state.db,
        agentHostRef,
        workspaceHost,
        settings,
        skillStore,
        paths,
        logger.child('tasks'),
        terminalControlRef,
        agentSemanticControlRef,
      );
      taskServiceRef = taskService;
      outcomeContractRef = new OutcomeContractService(state.db, logger.child('outcome-contracts'));
      registerOutcomeContractHandlers(
        outcomeContractRef,
        taskService,
        workItemServiceRef!,
        agentRegistryRef,
        agentSemanticControlRef,
        logger.child('outcome-contract-ipc'),
      );
      remoteWorkerRef.attachTaskLookup((taskId) => taskService.getTask(taskId));
      remoteWorkerRef.attachChangedPathLookup(async (taskId) =>
        (await taskService.changeSetForReview(taskId)).files.map((file) => ({
          path: file.path,
          currentHash: file.currentHash,
        })),
      );
      const missionRepository = new MissionRepository(state.db);
      missionRepositoryRef = missionRepository;
      const missionRuntimes = new OrchestrationRuntimeRegistry();
      const settleVisibleMissionSession = async (terminalId: string): Promise<void> => {
        const sessions = externalSessionsRef;
        if (!sessions) return;
        const taskId =
          sessions.taskIdForTerminal(terminalId) ??
          taskService.activeExternalTaskForTerminal(terminalId)?.id ??
          null;
        if (taskId) await sessions.end(taskId, true);
      };
      const visibleMissionRuntime = new VisibleTerminalRuntime(
        terminalControlRef,
        settleVisibleMissionSession,
      );
      missionRuntimes.register(visibleMissionRuntime);
      missionRuntimes.register(new ShellRuntime(terminalControlRef, settleVisibleMissionSession));
      missionRuntimes.register(new ManagedAgentRuntime(taskService, settings));
      const acpCompatibilityEnabled =
        Boolean(terminalIntegration) &&
        process.env.PI_IDE_ACP !== '0' &&
        (!process.env.PI_IDE_E2E || process.env.PI_IDE_ACP === '1');
      if (acpCompatibilityEnabled && terminalIntegration) {
        const runtimeAppPath = app.getAppPath().endsWith('app.asar')
          ? `${app.getAppPath()}.unpacked`
          : app.getAppPath();
        const pool = new AcpProcessPool((provider) => {
          const command = agentRegistryRef!.acpCommand(provider, {
            runtimeAppPath,
            nodeExecutable: terminalIntegration.nodeExecutable,
            env: terminalIntegration.environment(),
          });
          if (!command) throw new Error(`ACP Agent ${provider} is not available.`);
          return command;
        }, logger.child('acp-pool'));
        acpPoolRef = pool;
        const options = {
          missionMcp: (
            input: import('./services/orchestration-runtime-registry.js').RuntimeStartRequest,
            identity: string,
          ) => {
            const taskId = input.mission.originConversationTaskId;
            if (!taskId) throw new Error('ACP Mission sessions require an origin conversation.');
            missionVirtualTasks.set(identity, taskId);
            return {
              command: terminalIntegration.nodeExecutable,
              args: [terminalIntegration.mcpServerPath],
              env: {
                ...terminalIntegration.environment(),
                ...terminalIdentitiesRef!.environment(identity),
              },
            };
          },
          bindVirtualIdentity: (
            identity: string,
            input: import('./services/orchestration-runtime-registry.js').RuntimeStartRequest,
          ) => {
            const taskId = input.mission.originConversationTaskId;
            if (taskId) missionVirtualTasks.set(identity, taskId);
            terminalIdentitiesRef!.issue(identity);
          },
          releaseVirtualIdentity: (identity: string) => {
            missionVirtualTasks.delete(identity);
            terminalIdentitiesRef!.revokeTerminal(identity);
          },
        };
        const useAcpForNewMissions = process.env.PI_IDE_ACP === '1';
        const registeredAcpProviders = new Set<string>();
        const syncAcpRuntimes = (): void => {
          for (const provider of agentRegistryRef!.acpAgentIds()) {
            if (registeredAcpProviders.has(provider)) continue;
            const acpRuntime = new AcpRuntimeAdapter(
              provider,
              pool,
              missionRepository,
              options,
              logger.child(`acp-${provider}`),
            );
            missionRuntimes.registerForRuntime(
              provider,
              new FallbackRuntimeAdapter(acpRuntime, visibleMissionRuntime, {
                startWith: useAcpForNewMissions ? 'primary' : 'fallback',
                // Native PTY is the product path. If it cannot start, surface the
                // real launch error instead of silently changing interaction
                // semantics to the experimental ACP transport.
                fallbackOnStartFailure: useAcpForNewMissions,
              }),
            );
            registeredAcpProviders.add(provider);
          }
        };
        syncAcpRuntimes();
        // Pack removal stops new selection through the catalog. Runtime
        // adapters already registered stay alive until quit so an in-flight
        // ACP Mission can still be steered/cancelled safely.
        agentPackRuntimeRefreshRef = syncAcpRuntimes;
      }
      const missionOutbox = new OrchestrationOutboxRunner(missionRepository, missionRuntimes, {
        onChanged: (missionId) => {
          broadcast('mission.changed', missionRepository.snapshot(missionId));
          refreshBackgroundTray();
        },
      });
      const missionOrchestration = new MissionOrchestrationService(
        missionRepository,
        missionOutbox,
        (missionId) => {
          broadcast('mission.changed', missionRepository.snapshot(missionId));
          refreshBackgroundTray();
        },
        {
          maxPromotionWorkers: () => settings.effective.orchestration.maxWorkers,
          runtimeCatalog: () => [
            {
              id: 'managed',
              displayName: 'Charter Agent',
              available: true,
              installed: true,
              transport: 'native' as const,
              capabilities: { steer: true, pause: true, resume: true, worktree: true },
            },
            {
              id: 'shell',
              displayName: 'Shell Agent',
              available: true,
              installed: true,
              transport: 'terminal' as const,
              capabilities: { steer: true, pause: true, resume: true, worktree: false },
            },
            ...agentRegistryRef!.catalog().agents.map((agent) => {
              const available =
                agent.installed &&
                (agent.capabilities.terminal ||
                  (acpCompatibilityEnabled && agent.capabilities.acp));
              return {
                id: agent.id,
                displayName: agent.displayName,
                available,
                installed: agent.installed,
                transport:
                  process.env.PI_IDE_ACP === '1' && agent.capabilities.acp
                    ? ('acp' as const)
                    : ('terminal' as const),
                capabilities: {
                  terminal: agent.capabilities.terminal,
                  acp: agent.capabilities.acp,
                  mcp: agent.capabilities.mcp,
                  exactResume: agent.capabilities.exactResume,
                  worktree: false,
                },
                unavailableReason: available
                  ? null
                  : agent.installed
                    ? `${agent.displayName} has no enabled Mission transport.`
                    : `${agent.displayName} is not installed or was not found on PATH.`,
              };
            }),
          ],
        },
      );
      missionOrchestrationRef = missionOrchestration;
      missionRecoveryRef = new OrchestrationRecoveryService(
        missionRepository,
        missionRuntimes,
        logger.child('mission-recovery'),
        {
          onChanged: (missionId) =>
            broadcast('mission.changed', missionRepository.snapshot(missionId)),
        },
      );
      missionRecoveryRef.start();
      const missionCaller = new MissionToolCallerResolver(
        missionOrchestration,
        taskService,
        agentHostRef,
        terminalControlRef,
        (agentId) => agentRegistryRef!.isKnown(agentId),
      );
      taskService.attachOrchestrationTools({
        control: missionOrchestration,
        callerForCall: (call) => missionCaller.resolve(call),
        promoteForCall: (call, input) => missionCaller.promote(call, input),
      });
      missionOrchestration.start();
      registerMissionHandlers(missionOrchestration, taskService, logger.child('mission-ipc'));
      const artifactService = new ArtifactService(state.db, taskService, logger.child('artifacts'));
      protocol.handle('artifact', (request) => artifactService.handleResource(request));
      registerArtifactHandlers(artifactService, logger.child('ipc'));
      // ADR-0028: preamble <project_rules> + review-correction capture.
      taskService.attachMemoryHooks(memoryService);
      taskService.markOrphanedRunsInterrupted(m4.restoredTerminalIds);
      // ADR-0009 am.2: fire-and-forget cleanup of finished tasks' worktrees.
      void taskService.sweepWorktreeOrphans();
      const modelCatalog = new ModelCatalogService(
        (providerId) => secretService.catalogProvider(providerId),
        logger.child('models'),
        undefined,
        { cacheFile: join(paths.userData, 'verified-models.json') },
      );
      registerM6Handlers(
        taskService,
        agentHostRef,
        secretService,
        settings,
        modelCatalog,
        logger.child('ipc'),
        artifactService,
        remoteWorkerRef,
        outcomeContractRef,
      );
      registerM7Handlers(taskService, logger.child('ipc'));
      registerM8Handlers(taskService, logger.child('ipc'), remoteWorkerRef);
      registerM9Handlers(taskService, logger.child('ipc'), remoteWorkerRef);
      registerActivityHandlers(taskService, workspaceHost, logger.child('ipc'));
      // Replay V3 (ADR-0017 am.8): main-side projection over the same ledger.
      const replayService = new ReplayService(
        state.db,
        taskService,
        logger.child('replay'),
        app.getVersion(),
      );
      registerReplayHandlers(replayService, logger.child('ipc'));
      terminalReplayRef = new TerminalReplayService(
        state.db,
        taskService,
        m4.terminals,
        join(paths.userData, 'terminal-recordings'),
        logger.child('terminal-replay'),
      );
      registerTerminalReplayHandlers(terminalReplayRef, logger.child('ipc'));
      registerImageHandlers(workspaceHost, logger.child('ipc'));
      // ADR-0022: preview gate — port detection, capture, PR draft. The PR
      // draft cites the replay receipt hash, so the provider is wired here.
      taskService.setReceiptProvider((taskId) => {
        try {
          return replayService.receipt(taskId).manifestSha256;
        } catch {
          return null;
        }
      });
      registerPreviewHandlers(
        taskService,
        new PreviewService(logger.child('preview'), {
          executable: process.execPath,
          serverEntry: join(
            app.getAppPath().endsWith('app.asar')
              ? `${app.getAppPath()}.unpacked`
              : app.getAppPath(),
            'apps',
            'desktop-main',
            'dist',
            'static-preview-server.cjs',
          ),
          runAsNode: true,
        }),
        logger.child('ipc'),
      );
      // ADR-0024: out-of-project image imports for context-feeding chips.
      registerContextAttachmentHandlers(taskService, logger.child('ipc'));

      // ADR-0036: screenshot quick card — watch the OS screenshot directory.
      // E2E never watches the developer's real Desktop: it either supplies an
      // explicit directory (PI_IDE_SCREENSHOT_DIR, deterministic always-true
      // probe) or the feature stays off. Non-mac hosts are override-only too.
      const screenshotDirOverride = process.env.PI_IDE_SCREENSHOT_DIR;
      if (screenshotDirOverride || (process.platform === 'darwin' && !process.env.PI_IDE_E2E)) {
        screenshotWatcherRef = new ScreenshotWatcher({
          logger: logger.child('screenshots'),
          broadcast: (capture) => broadcast('screenshot.captured', capture),
          dir: screenshotDirOverride ?? null,
          ...(screenshotDirOverride ? { isScreenshot: async () => true } : {}),
        });
        void screenshotWatcherRef.start();
        registerScreenshotHandlers(screenshotWatcherRef, workspaceHost, logger.child('ipc'));

        // ADR-0039: clipboard image card — WeChat/Snipaste-style captures
        // never hit the disk, so a metadata-first clipboard poll feeds the
        // same card pipeline. macOS-only, never under E2E (the OS clipboard
        // is not test-controllable), env kill switch for opt-out.
        const cardFunnel = screenshotWatcherRef;
        if (
          process.platform === 'darwin' &&
          !process.env.PI_IDE_E2E &&
          process.env.PI_IDE_CLIPBOARD_CAPTURE !== '0'
        ) {
          clipboardWatcherRef = new ClipboardScreenshotWatcher({
            logger: logger.child('clipboard'),
            captureDir: join(app.getPath('userData'), 'clipboard-captures'),
            announce: (capture) => cardFunnel.announce(capture),
          });
          void clipboardWatcherRef.start();
        }
      }

      // ADR-0017: external CLI agent sessions (claude/codex in user terminals).
      externalSessionsRef = new ExternalSessionService(
        m4.terminals,
        taskService,
        workspaceHost,
        logger.child('external'),
        externalLaunchIntents,
        ({ terminalId, taskId, status, source }) => {
          agentPresenceRef?.notifyTurnSettled({ terminalId, taskId, status, source });
          terminalControlRef?.notifyTurnSettled(terminalId, {
            taskId,
            status,
            source,
          });
        },
        ({ terminalId, taskId, source }) => {
          agentPresenceRef?.notifyTurnStarted({ terminalId, taskId });
          terminalControlRef?.notifyTurnStarted(terminalId, {
            taskId,
            source,
          });
        },
        ({ terminalId, taskId }) => {
          agentPresenceRef?.bindTask(terminalId, taskId);
          terminalControlRef?.bindWorkerTask(terminalId, taskId);
          remoteWorkerRef?.bindTask(terminalId, taskId);
        },
        async ({ sourceTaskId, targetTaskId, commanderTerminalId }) => {
          const control = terminalControlRef;
          if (!control) {
            return { requested: 0, resumed: 0, reused: 0, failed: [] };
          }
          return control.resumeFleet({
            sourceTaskId,
            targetTaskId,
            commanderTerminalId,
            members: taskService.orchestrationFleetForTask(sourceTaskId),
            resumeWorker: async (workerTaskId, terminalId) => {
              const sessions = externalSessionsRef;
              if (!sessions) throw new Error('External session service is unavailable.');
              const resumed = await sessions.resume(workerTaskId, terminalId, {
                resumeFleet: false,
              });
              return { taskId: resumed.taskId, cli: resumed.cli };
            },
          });
        },
        agentRegistryRef,
      );
      remoteWorkerRef.attachExternalSessions(externalSessionsRef);
      externalSessionsRef.attachRemoteReconcile((taskId) => remoteWorkerRef!.syncTask(taskId));
      externalSessionsRef.attachRemoteMirrorPush((taskId, paths) =>
        remoteWorkerRef!.pushMirrorPaths(taskId, paths),
      );
      externalSessionsRef.attachRemoteSessionBridge({
        discoverIdentity: (taskId, cli, options) =>
          remoteWorkerRef!.discoverCliSession(taskId, cli, options),
        prepareResume: (task) => sshServiceRef!.prepareRemoteResume(task),
      });
      registerExternalHandlers(externalSessionsRef, logger.child('ipc'), artifactService);
      // Daemon-backed PTYs outlive Electron, while worker relationships are a
      // main-process projection. Run after external-session polling has been
      // queued so both the rail hierarchy and its activity signal restore.
      queueMicrotask(() => {
        const control = terminalControlRef;
        if (!control) return;
        const restored = control.restoreFleetRelations(
          taskService.liveOrchestrationWorkers(m4!.terminals.list().map((terminal) => terminal.id)),
        );
        if (restored > 0) logger.info('orchestration fleet restored', { workers: restored });
        void missionRecoveryRef?.reconcileAll();
      });
      ctlServerRef = new CtlServer({
        socketPath: ctlSocketPath,
        identities: terminalIdentitiesRef,
        control: terminalControlRef,
        enabled: () => settings.effective.orchestration.enabled,
        taskForTerminal: (id) =>
          missionVirtualTasks.get(id) ?? externalSessionsRef?.taskIdForTerminal(id) ?? null,
        gatewayForTask: (taskId) => taskService.gatewayForTask(taskId),
        prepareCaller: (taskId, terminalId) =>
          void taskService.ensureTerminalControlRun(taskId, terminalId),
        logger: logger.child('ctl'),
      });
      if (settings.effective.orchestration.enabled) {
        void ctlServerRef.start().catch((error) => {
          logger.warn('terminal control door failed to start', { error: errorMessage(error) });
        });
      }
      settings.onChange((next) => {
        terminalControlRef?.publishSnapshot();
        if (next.effective.orchestration.enabled) {
          void ctlServerRef?.start().catch((error) => {
            logger.warn('terminal control door failed to start', { error: errorMessage(error) });
          });
        } else {
          terminalIdentitiesRef?.clear();
          void ctlServerRef?.stop();
        }
      });

      // ADR-0038: session archaeology — read-only discovery over the CLI
      // agents' own stores. E2E only ever scans an explicitly supplied fake
      // home (PI_IDE_ARCHAEOLOGY_HOME), never the developer machine's.
      const archaeologyHome = process.env.PI_IDE_ARCHAEOLOGY_HOME;
      archaeologyRef = new SessionArchaeologyService({
        logger: logger.child('archaeology'),
        ...(archaeologyHome ? { homeDir: archaeologyHome } : {}),
        enabled: !process.env.PI_IDE_E2E || Boolean(archaeologyHome),
        agentSources: agentRegistryRef.historySources(archaeologyHome),
        knownSessions: () => taskServiceRef?.externalSessionIndex() ?? new Map(),
        ignoredSessions: () => taskServiceRef?.deletedExternalSessionKeys() ?? new Set(),
        projects: () =>
          state
            .recentWorkspaces()
            .filter((item) => item.exists)
            .map((item) => item.path),
      });
      registerArchaeologyHandlers(archaeologyRef, externalSessionsRef, logger.child('ipc'));

      // PIVOT-014: system notifications on attention-worthy task states.
      // E2E runs must not spray real OS banners (they disturb focus/timing).
      const notifications = new NotificationService({
        enabled: () => settings.effective.notifications.enabled && !process.env.PI_IDE_E2E,
        anyWindowFocused: () => BrowserWindow.getFocusedWindow() !== null,
        show: (n, onClick) => {
          if (!Notification.isSupported()) return;
          const note = new Notification({ title: n.title, body: n.body });
          note.on('click', onClick);
          note.show();
        },
        focusTask: (taskId) => {
          restoreMainWindow('task-notification');
          broadcast('app.focusTask', { taskId });
        },
      });
      taskService.onStateChanged((info) => {
        notifications.onTaskState(info);
        refreshBackgroundTray();
      });
      taskService.onAttention((info) => notifications.pingAttention(info));

      // ADR-0021: command-finish notifications — same hygiene as PIVOT-014,
      // finer grain: the click lands on the command's block, not just the app.
      const terminalsForNotify = m4.terminals;
      const commandNotifications = new CommandNotificationService({
        enabled: () => settings.effective.notifications.enabled && !process.env.PI_IDE_E2E,
        anyWindowFocused: () => BrowserWindow.getFocusedWindow() !== null,
        minDurationMs: () => settings.effective.terminal.longCommandSeconds * 1000,
        show: (n, onClick) => {
          if (!Notification.isSupported()) return;
          const note = new Notification({ title: n.title, body: n.body });
          note.on('click', onClick);
          note.show();
        },
        reveal: (terminalId, blockId) => {
          restoreMainWindow('command-notification');
          broadcast('terminal.revealBlock', { id: terminalId, blockId });
        },
      });
      registerHandlers(
        {
          'terminal.commandDone': async (payload) => {
            const info = terminalsForNotify.list().find((t) => t.id === payload.id);
            if (!info) return { notified: false };
            return {
              notified: commandNotifications.onCommandDone({
                terminalId: payload.id,
                blockId: payload.blockId,
                command: payload.command,
                exitCode: payload.exitCode,
                durationMs: payload.durationMs,
                contextLabel: info.projectName,
              }),
            };
          },
          'terminal.progress': async ({ value }) => {
            // Same number the tab ring and status bar show; -1 clears the
            // macOS Dock / Windows taskbar progress.
            const win = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
            win?.setProgressBar(value === null ? -1 : Math.min(1, Math.max(0, value)));
            return { ok: true };
          },
        },
        logger.child('ipc'),
      );

      // M10/E2E-022: redacted support bundle export.
      registerHandlers(
        {
          'diagnostics.supportBundle': async () => {
            const info = getAppInfo();
            const ws = workspaceHost.current;
            const json = await buildSupportBundle({
              app: {
                appVersion: info.appVersion,
                electron: info.electron,
                node: info.node,
                chrome: info.chrome,
                platform: info.platform,
                arch: info.arch,
                commit: info.commit,
                updateChannel: info.updateChannel,
                agentEngine: info.piSdkVersion,
              },
              settingsEffective: settings.effective,
              db: state.db,
              appliedMigrations: state.appliedMigrations ?? null,
              recentErrors: state.recentErrors() as Array<Record<string, unknown>>,
              workspace: ws
                ? {
                    id: ws.id,
                    isGitRepo: ws.isGitRepo,
                    trustState: ws.trustState,
                    path: ws.canonicalPath,
                  }
                : null,
              providers: secretService
                .list()
                .map((p) => ({ providerId: p.providerId, configured: p.configured })),
              worker: {
                alive: agentHostRef?.alive ?? false,
                restarts: agentHostRef?.restartCount ?? 0,
                degraded: agentHostRef?.degraded ?? false,
              },
              logsDir: paths.logsDir,
              userDataDir: paths.userData,
            });
            const dir = join(paths.userData, 'support');
            mkdirSync(dir, { recursive: true });
            const file = join(dir, `charter-support-${Date.now()}.json`);
            writeFileSync(file, json, 'utf8');
            if (!process.env.PI_IDE_E2E) shell.showItemInFolder(file);
            return { path: file };
          },
          // PRIV-003: local data transparency.
          'privacy.dataSummary': async () => dataSummary(paths, state.db),
          // PRIV-002: redacted crash-report sample from real state.
          'privacy.crashPreview': async () => {
            const info = getAppInfo();
            return {
              text: crashPreview({
                appVersion: info.appVersion,
                platform: info.platform,
                arch: info.arch,
                updateChannel: info.updateChannel,
                logsDir: paths.logsDir,
              }),
              transportAvailable: TELEMETRY_TRANSPORT_AVAILABLE,
            };
          },
          // PRIV-003: one-click delete of history + caches.
          'privacy.clearHistory': async () => {
            const result = clearHistory(paths, state.db);
            // Nudge the renderer to re-read the (now-empty) task list.
            broadcast('workspace.changed', { workspace: workspaceHost.dto() });
            return result;
          },
        },
        logger.child('ipc'),
      );
    }

    // E2E hook: open a workspace directly from the environment.
    const autoOpen = process.env.PI_IDE_OPEN_WORKSPACE;
    if (autoOpen && workspaceHost) {
      workspaceHost.open(autoOpen).catch((e) => {
        logger.error('auto-open workspace failed', {
          error: errorMessage(e),
        });
      });
    }

    logger.info('app ready', {
      dev: isDev,
      dbOk: Boolean(state),
      migrations: state?.appliedMigrations ?? [],
    });
    mainWindow = createMainWindow(boot);
    void updateServiceRef?.start();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || process.env.PI_IDE_E2E) {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    forceQuit = true;
  });

  // Ordered teardown (M10/REL): resolve every pending gate first, stop the
  // agent worker fully, and close the database LAST — a late worker-exit
  // abort callback must never write to a closed database (fixes the
  // "database is not open" uncaught exception on quit).
  let cleanupDone = false;
  app.on('will-quit', (event) => {
    if (cleanupDone) return;
    event.preventDefault();
    backgroundMode = false;
    stopBackgroundRefresh();
    backgroundTray?.destroy();
    backgroundTray = null;
    skillStoreRef?.dispose();
    workItemServiceRef?.dispose();
    outcomeContractRef = null;
    updateServiceRef?.dispose();
    clipboardWatcherRef?.dispose();
    screenshotWatcherRef?.dispose();
    agentSemanticControlRef = null;
    agentVerificationRef?.dispose();
    agentVerificationRef = null;
    agentPresenceRef?.dispose();
    externalSessionsRef?.dispose(); // before terminals: sessions close into review while the DB is open
    missionOrchestrationRef?.shutdown();
    missionRecoveryRef?.stop();
    taskServiceRef?.shutdown();
    terminalControlRef?.dispose();
    terminalRecordingRef?.dispose();
    terminalRecordingRef = null;
    sshForwardsRef?.stopAll(); // listeners first, so nothing re-dials mid-quit
    sshSftpRef?.closeAll();
    const imageCleanup = terminalImagePasteRef?.dispose() ?? Promise.resolve();
    // Release M4's timers/listeners immediately, but keep the authenticated
    // daemon socket open for the shutdown request below.
    m4Ref?.dispose({ closeTerminalDaemon: false });
    terminalIdentitiesRef?.clear();
    // Recovery tests model an explicit "keep terminals while Main restarts"
    // intent. It is deliberately unavailable outside E2E; Command+Q and
    // update/install exits always satisfy TERM-004 by shutting the daemon down.
    const preserveTerminalDaemon =
      process.env.PI_IDE_E2E === '1' && process.env.PI_IDE_TERMINAL_PRESERVE_ON_QUIT === '1';
    const disposal = Promise.all([
      preserveTerminalDaemon
        ? Promise.resolve()
        : (terminalDaemonRef?.shutdown() ?? Promise.resolve()),
      ctlServerRef?.stop() ?? Promise.resolve(),
      acpPoolRef?.shutdown() ?? Promise.resolve(),
      agentHostRef?.dispose() ?? Promise.resolve(),
      terminalReplayRef?.dispose() ?? Promise.resolve(),
      imageCleanup.finally(() => sshServiceRef?.disconnectAll()),
    ]);
    void disposal
      .catch(() => undefined)
      .finally(() => {
        // Re-quitting from inside the canceled quit's unwind is silently
        // ignored by Electron (bites exactly when disposal resolves in the
        // same tick, i.e. no worker was running) — defer one macrotask.
        setTimeout(() => {
          boot?.state?.close();
          terminalDaemonRef = null;
          missionRepositoryRef = null;
          cleanupDone = true;
          boot?.logger.info('teardown complete, quitting');
          app.quit();
        }, 0);
      });
  });
  app.on('quit', () => {
    if (!cleanupDone) {
      cleanupDone = true;
      boot?.state?.close();
    }
  });

  app.on('activate', () => {
    restoreMainWindow('app-activate');
  });
  app.on('browser-window-focus', () => {
    skillStoreRef?.rescan('focus');
  });
}
