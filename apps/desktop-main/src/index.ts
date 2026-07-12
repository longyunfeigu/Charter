import { app, BrowserWindow, dialog, nativeTheme, net, protocol, session, shell } from 'electron';
import { join, normalize } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { productError, toProductError, type Logger, type ProductError } from '@pi-ide/foundation';
import { createAppPaths, type AppPaths } from './app-paths.js';
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
const quitBlockers = new Map<number, string[]>();
let forceQuit = false;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

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
    const isAppContent =
      details.url.startsWith('app://') ||
      (isDev && DEV_SERVER_URL && details.url.startsWith(DEV_SERVER_URL));
    if (!isAppContent) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] },
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
    show: false,
    title: 'Pi IDE',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 10 } }
      : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f5f5f5',
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
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      buttons: ['Reload Window', 'Quit'],
      defaultId: 0,
      title: 'Window crashed',
      message: 'The Pi IDE window crashed. Your agent tasks and files on disk are unaffected.',
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
          { name: 'agent-worker', status: 'idle' as const, detail: 'starts with first task' },
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
          return result;
        },
        'settings.reset': async ({ scope }) => settings.reset(scope),
        'layout.get': async () => ({ layout: state.getLayout(null) }),
        'layout.save': async ({ layout }) => {
          state.saveLayout(null, layout);
          return { saved: true };
        },
        'workspace.recent': async () => ({ items: state.recentWorkspaces() }),
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
        broadcast('settings.changed', { issues: s.issues, overrideKeys: s.overrideKeys });
      });
    }
    nativeTheme.on('updated', () => {
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
      m4 = new M4Services(workspaceHost, settings, logger.child('m4'));
      m4Ref = m4;
      registerM4Handlers(m4, workspaceHost, logger.child('ipc'));
    }

    // E2E hook: open a workspace directly from the environment.
    const autoOpen = process.env.PI_IDE_OPEN_WORKSPACE;
    if (autoOpen && workspaceHost) {
      workspaceHost.open(autoOpen).catch((e) => {
        logger.error('auto-open workspace failed', {
          error: e instanceof Error ? e.message : String(e),
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

  app.on('quit', () => {
    m4Ref?.dispose();
    boot?.state?.close();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && app.isReady() && boot) {
      mainWindow = createMainWindow(boot);
    }
  });
}
