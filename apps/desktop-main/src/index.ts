import {
  app,
  BrowserWindow,
  dialog,
  nativeTheme,
  net,
  Notification,
  protocol,
  session,
  shell,
} from 'electron';
import { basename, join, normalize } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  errorMessage,
  productError,
  toProductError,
  type Logger,
  type ProductError,
} from '@pi-ide/foundation';
import { createAppPaths, type AppPaths } from './app-paths.js';
import { CSP, DEV_CSP } from './csp.js';
import { installGlobalSecurityHandlers, openExternalChecked } from './security.js';
import { registerHandlers } from './ipc/router.js';
import { LogService } from './services/log-service.js';
import { SettingsService } from './services/settings-service.js';
import { StateService } from './services/state-service.js';
import { WindowStateKeeper } from './services/window-state.js';
import { installApplicationMenu } from './menu.js';
import { broadcast } from './broadcast.js';
import { WorkspaceHost } from './services/workspace-host.js';
import { registerWorkspaceHandlers } from './ipc/workspace-handlers.js';
import { M4Services, registerM4Handlers } from './ipc/m4-handlers.js';
import { registerTerminalOpenHandlers } from './ipc/terminal-open-handlers.js';
import { M5Services, registerM5Handlers } from './ipc/m5-handlers.js';
import { registerM6Handlers } from './ipc/m6-handlers.js';
import { registerM7Handlers } from './ipc/m7-handlers.js';
import { registerM8Handlers } from './ipc/m8-handlers.js';
import { registerM9Handlers } from './ipc/m9-handlers.js';
import { SecretService } from './services/secret-service.js';
import { SkillStore } from './services/skill-store.js';
import { registerSkillsHandlers } from './ipc/skills-handlers.js';
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
import { registerImageHandlers } from './ipc/image-handlers.js';
import { registerPreviewHandlers } from './ipc/preview-handlers.js';
import { registerContextAttachmentHandlers } from './ipc/context-attachment-handlers.js';
import { PreviewService } from './services/preview-service.js';
import { ExternalSessionService } from './services/external-session-service.js';
import { ExternalLaunchIntents } from './services/external-launch-intents.js';
import { registerExternalHandlers } from './ipc/external-handlers.js';
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
import { registerOrchestrationHandlers } from './ipc/orchestration-handlers.js';
import { installTerminalControlIntegration } from './services/terminal-control-integration.js';

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
let m4Ref: M4Services | null = null;
let m5Ref: M5Services | null = null;
let agentHostRef: AgentHost | null = null;
let taskServiceRef: TaskService | null = null;
let externalSessionsRef: ExternalSessionService | null = null;
let archaeologyRef: SessionArchaeologyService | null = null;
let externalLaunchIntents: ExternalLaunchIntents | null = null;
let skillStoreRef: SkillStore | null = null;
let screenshotWatcherRef: ScreenshotWatcher | null = null;
let clipboardWatcherRef: ClipboardScreenshotWatcher | null = null;
let terminalControlRef: TerminalControlService | null = null;
let terminalIdentitiesRef: TerminalControlIdentityRegistry | null = null;
let ctlServerRef: CtlServer | null = null;
export function getM5(): M5Services | null {
  return m5Ref;
}
const quitBlockers = new Map<number, string[]>();
let forceQuit = false;

function windowBackground(skin: string, dark: boolean): string {
  if (skin === 'studio') return dark ? '#1a1917' : '#fbfaf7';
  if (skin === 'terminal') return dark ? '#0d120f' : '#f0f6f1';
  if (skin === 'archive') return dark ? '#291f19' : '#fbf2df';
  if (skin === 'index') return dark ? '#070707' : '#ffffff';
  return dark ? '#1a1917' : '#fbfaf7';
}

// §12.3 CSP — extracted to csp.ts so the directives are unit-pinned (ADR-0022).

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
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
    const blockers = [...quitBlockers.values()].flat();
    if (blockers.length > 0) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['Cancel', 'Quit Anyway'],
        defaultId: 0,
        cancelId: 0,
        title: 'Work in progress',
        message: 'Some work is still in progress:',
        detail: blockers.map((b) => `• ${b}`).join('\n'),
      });
      if (choice === 0) {
        event.preventDefault();
        return;
      }
      forceQuit = true;
    }
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

  win.webContents.on('render-process-gone', (_event, details) => {
    bootstrap.logger.error('renderer crashed', { reason: details.reason });
    bootstrap.state?.recordError(
      'renderer',
      productError('APP_RENDERER_CRASH', {
        userMessage: 'The window crashed and can be reloaded.',
        severity: 'fatal',
        context: { reason: details.reason },
      }),
    );
    if (details.reason === 'clean-exit') return;
    // E2E/soak (M10): recover without a blocking dialog — reload immediately.
    if (process.env.PI_IDE_E2E) {
      win.webContents.reload();
      return;
    }
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      buttons: ['Reload Window', 'Quit'],
      defaultId: 0,
      title: 'Window crashed',
      message: 'The Charter window crashed. Your agent tasks and files on disk are unaffected.',
    });
    if (choice === 0) win.webContents.reload();
    else {
      forceQuit = true;
      app.quit();
    }
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
      'app.openExternal': async ({ url }) => ({ opened: await openExternalChecked(url, logger) }),
      'app.revealPath': async ({ path }) => {
        // Reveal in Finder/Explorer — absolute existing paths only.
        const { isAbsolute } = await import('node:path');
        const { existsSync } = await import('node:fs');
        if (!isAbsolute(path) || !existsSync(path)) return { revealed: false };
        if (!process.env.PI_IDE_E2E) shell.showItemInFolder(path);
        return { revealed: true };
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
          items: state.recentWorkspaces().map((item) => ({
            ...item,
            kind: item.exists ? detectProjectKind(item.path) : null,
          })),
        }),
      },
      logger,
    );
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const paths = createAppPaths(app.getPath('userData'));
    const logs = new LogService(paths.logsDir, {
      level: process.env.PI_IDE_LOG_LEVEL === 'debug' ? 'debug' : 'info',
      console: isDev,
    });
    const logger = logs.logger('main');

    let settings: SettingsService | null = null;
    let state: StateService | null = null;
    let workspaceHost: WorkspaceHost | null = null;
    let startupError: ProductError | null = null;

    try {
      settings = new SettingsService(paths.settingsFile, logger.child('settings'));
      state = new StateService(paths.databaseFile, paths.backupsDir, logger.child('db'));
      workspaceHost = new WorkspaceHost(state, settings, logger.child('workspace'));
    } catch (e) {
      startupError = toProductError(e, 'APP_STARTUP_FAILED');
      logger.error('startup degraded: database unavailable', { code: startupError.code });
    }

    boot = { paths, logs, logger, settings, state, workspaceHost, startupError };

    // Theme (APP-006)
    if (settings) {
      nativeTheme.themeSource = settings.effective.general.theme;
      settings.onChange((s) => {
        nativeTheme.themeSource = s.effective.general.theme;
        mainWindow?.setBackgroundColor(
          windowBackground(s.effective.general.skin, nativeTheme.shouldUseDarkColors),
        );
        broadcast('settings.changed', { issues: s.issues, overrideKeys: s.overrideKeys });
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
    installApplicationMenu({ isDev });
    registerCoreHandlers(boot);
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
      );
      const terminalIntegration = installTerminalControlIntegration({
        userData: paths.userData,
        appPath: app.getAppPath(),
        logger: logger.child('terminal-mcp'),
      });
      m4 = new M4Services(workspaceHost, settings, logger.child('m4'), shellIntegrationDir, (id) =>
        settings.effective.orchestration.enabled
          ? {
              ...terminalIdentitiesRef!.environment(id),
              ...terminalIntegration?.environment(),
            }
          : {},
      );
      m4Ref = m4;
      m4.terminals.onExitEvent(({ id }) => terminalIdentitiesRef?.revokeTerminal(id));
      terminalControlRef = new TerminalControlService(m4.terminals, logger.child('orchestration'), {
        enabled: () => settings.effective.orchestration.enabled,
        maxWorkers: () => settings.effective.orchestration.maxWorkers,
        maxSendsPerMinute: () => settings.effective.orchestration.maxSendsPerMinute,
        launchIntents: externalLaunchIntents,
        taskForTerminal: (id) => externalSessionsRef?.taskIdForTerminal(id) ?? null,
        onChanged: (snapshot) => broadcast('orchestration.changed', snapshot),
        recordEvent: (taskId, type, payload) => taskServiceRef?.recordEvent(taskId, type, payload),
      });
      registerOrchestrationHandlers(terminalControlRef, logger.child('ipc'));
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
        },
        externalLaunchIntents,
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
      const skillStore = new SkillStore(paths.skillsDir, logger.child('skills'), {
        discoverExternal: !process.env.PI_IDE_E2E || Boolean(skillHome),
        ...(skillHome ? { homeDir: skillHome } : {}),
        onDidChange: (event) => broadcast('skills.changed', event),
      });
      skillStoreRef = skillStore;
      skillStore.startWatching();
      registerSkillsHandlers(skillStore, logger.child('ipc'), {
        // Deferred: taskServiceRef is assigned right below (ADR-0037), and
        // archaeologyRef further down (ADR-0040) — empty usage until then.
        events: (windowDays) => taskServiceRef?.skillUsageEvents(windowDays) ?? [],
        externalEvents: async () => (await archaeologyRef?.skillUsageEvents()) ?? [],
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
      );
      taskServiceRef = taskService;
      // ADR-0028: preamble <project_rules> + review-correction capture.
      taskService.attachMemoryHooks(memoryService);
      taskService.markOrphanedRunsInterrupted();
      // ADR-0009 am.2: fire-and-forget cleanup of finished tasks' worktrees.
      void taskService.sweepWorktreeOrphans();
      const modelCatalog = new ModelCatalogService(
        (providerId) => secretService.catalogProvider(providerId),
        logger.child('models'),
      );
      registerM6Handlers(
        taskService,
        agentHostRef,
        secretService,
        settings,
        modelCatalog,
        logger.child('ipc'),
      );
      registerM7Handlers(taskService, logger.child('ipc'));
      registerM8Handlers(taskService, logger.child('ipc'));
      registerM9Handlers(taskService, logger.child('ipc'));
      registerActivityHandlers(taskService, workspaceHost, logger.child('ipc'));
      // Replay V3 (ADR-0017 am.8): main-side projection over the same ledger.
      const replayService = new ReplayService(
        state.db,
        taskService,
        logger.child('replay'),
        app.getVersion(),
      );
      registerReplayHandlers(replayService, logger.child('ipc'));
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
        new PreviewService(logger.child('preview')),
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
      );
      registerExternalHandlers(externalSessionsRef, logger.child('ipc'));
      ctlServerRef = new CtlServer({
        socketPath: ctlSocketPath,
        identities: terminalIdentitiesRef,
        control: terminalControlRef,
        enabled: () => settings.effective.orchestration.enabled,
        taskForTerminal: (id) => externalSessionsRef?.taskIdForTerminal(id) ?? null,
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
        knownSessions: () => taskServiceRef?.externalSessionIndex() ?? new Map(),
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
          const win = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
          if (win) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
          }
          broadcast('app.focusTask', { taskId });
        },
      });
      taskService.onStateChanged((info) => notifications.onTaskState(info));
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
          const win = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
          if (win) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
          }
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
    skillStoreRef?.dispose();
    clipboardWatcherRef?.dispose();
    screenshotWatcherRef?.dispose();
    externalSessionsRef?.dispose(); // before terminals: sessions close into review while the DB is open
    taskServiceRef?.shutdown();
    terminalControlRef?.dispose();
    m4Ref?.dispose();
    terminalIdentitiesRef?.clear();
    const disposal = Promise.all([
      ctlServerRef?.stop() ?? Promise.resolve(),
      agentHostRef?.dispose() ?? Promise.resolve(),
    ]);
    void disposal
      .catch(() => undefined)
      .finally(() => {
        // Re-quitting from inside the canceled quit's unwind is silently
        // ignored by Electron (bites exactly when disposal resolves in the
        // same tick, i.e. no worker was running) — defer one macrotask.
        setTimeout(() => {
          boot?.state?.close();
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
    if (BrowserWindow.getAllWindows().length === 0 && app.isReady() && boot) {
      mainWindow = createMainWindow(boot);
    }
  });
  app.on('browser-window-focus', () => {
    skillStoreRef?.rescan('focus');
  });
}
