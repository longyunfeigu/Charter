import type { Logger } from '@pi-ide/foundation';
import type { UpdateStateDto } from '@pi-ide/ipc-contracts';

const RELEASES_API = 'https://api.github.com/repos/longyunfeigu/Charter/releases?per_page=20';
export const RELEASES_PAGE = 'https://github.com/longyunfeigu/Charter/releases';
const INITIAL_AUTO_CHECK_MS = 15_000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

type UpdateChannel = 'stable' | 'beta';
type UpdatePlatform = UpdateStateDto['platform'];

interface NativeUpdateInfo {
  version: string;
  releaseName?: string | null;
  releaseDate?: string;
}

interface NativeProgressInfo {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export interface NativeUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  disableWebInstaller: boolean;
  channel: string | null;
  logger: {
    info(message?: unknown): void;
    warn(message?: unknown): void;
    error(message?: unknown): void;
  } | null;
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(event: 'update-available', listener: (info: NativeUpdateInfo) => void): unknown;
  on(event: 'update-not-available', listener: (info: NativeUpdateInfo) => void): unknown;
  on(event: 'download-progress', listener: (info: NativeProgressInfo) => void): unknown;
  on(event: 'update-downloaded', listener: (info: NativeUpdateInfo) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

interface ReleaseResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

interface GitHubRelease {
  version: string;
  name: string;
  prerelease: boolean;
  publishedAt: string | null;
  url: string;
}

export interface UpdateServiceOptions {
  currentVersion: string;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  signed: boolean;
  channel: UpdateChannel;
  autoCheck: boolean;
  logger: Logger;
  emit: (state: UpdateStateDto) => void;
  fetchRelease?: (url: string, init: RequestInit) => Promise<ReleaseResponse>;
  loadNativeUpdater?: () => Promise<NativeUpdater>;
  beforeInstall?: (version: string) => Promise<void>;
  fixturePhase?: UpdateStateDto['phase'] | null;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

function platformName(platform: NodeJS.Platform): UpdatePlatform {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux' ? platform : 'other';
}

function cleanVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

interface ParsedVersion {
  core: [number, number, number];
  prerelease: Array<number | string>;
}

function parseVersion(version: string): ParsedVersion | null {
  const match = cleanVersion(version).match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]
      ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : [],
  };
}

/** SemVer precedence without accepting loose tags or allowing a downgrade. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    const delta = a.core[index]! - b.core[index]!;
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function releaseFrom(value: unknown): GitHubRelease | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (row.draft === true || typeof row.tag_name !== 'string') return null;
  const version = cleanVersion(row.tag_name);
  if (!parseVersion(version) || typeof row.html_url !== 'string') return null;
  return {
    version,
    name: typeof row.name === 'string' && row.name.trim() ? row.name : `Charter ${version}`,
    prerelease: row.prerelease === true,
    publishedAt: typeof row.published_at === 'string' ? row.published_at : null,
    url: row.html_url,
  };
}

function latestRelease(value: unknown, channel: UpdateChannel): GitHubRelease | null {
  if (!Array.isArray(value)) return null;
  return (
    value
      .map(releaseFrom)
      .filter((release): release is GitHubRelease => Boolean(release))
      .filter((release) => {
        if (!release.prerelease) return true;
        const identifier = parseVersion(release.version)?.prerelease[0];
        return (
          channel === 'beta' &&
          typeof identifier === 'string' &&
          identifier.toLowerCase() === 'beta'
        );
      })
      .sort((a, b) => compareVersions(b.version, a.version))[0] ?? null
  );
}

function initialMessage(delivery: UpdateStateDto['delivery'], isPackaged: boolean): string {
  if (!isPackaged) return 'Update checks are available in packaged builds.';
  if (delivery === 'manual') {
    return 'Charter will check for releases and let you open the verified download page.';
  }
  return 'Charter checks in the background and asks before restarting to install.';
}

export class UpdateService {
  private stateValue: UpdateStateDto;
  private channel: UpdateChannel;
  private autoCheck: boolean;
  private nativeUpdater: NativeUpdater | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private readonly delivery: UpdateStateDto['delivery'];
  private readonly now: () => Date;
  private readonly setTimer: NonNullable<UpdateServiceOptions['setTimer']>;
  private readonly clearTimer: NonNullable<UpdateServiceOptions['clearTimer']>;

  constructor(private readonly options: UpdateServiceOptions) {
    this.channel = options.channel;
    this.autoCheck = options.autoCheck;
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    const platform = platformName(options.platform);
    this.delivery =
      options.signed && options.isPackaged && (platform === 'darwin' || platform === 'win32')
        ? 'automatic'
        : 'manual';
    const canCheck = options.isPackaged || Boolean(options.fixturePhase);
    this.stateValue = {
      phase: canCheck ? 'idle' : 'disabled',
      delivery: this.delivery,
      platform,
      channel: this.channel,
      currentVersion: cleanVersion(options.currentVersion),
      availableVersion: null,
      releaseName: null,
      releaseDate: null,
      releaseUrl: null,
      checkedAt: null,
      progress: null,
      message: initialMessage(this.delivery, options.isPackaged),
      errorCode: null,
      canCheck,
      canInstall: false,
    };
  }

  get state(): UpdateStateDto {
    return {
      ...this.stateValue,
      progress: this.stateValue.progress && { ...this.stateValue.progress },
    };
  }

  private update(patch: Partial<UpdateStateDto>): void {
    this.stateValue = { ...this.stateValue, ...patch };
    this.options.emit(this.state);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.options.fixturePhase) {
      const phase = this.options.fixturePhase;
      const hasRelease = ['available', 'downloading', 'downloaded'].includes(phase);
      this.update({
        phase,
        delivery: phase === 'downloaded' ? 'automatic' : this.delivery,
        availableVersion: hasRelease ? '1.1.0-beta.1' : null,
        releaseName: hasRelease ? 'Charter 1.1 Beta 1' : null,
        releaseDate: hasRelease ? this.now().toISOString() : null,
        releaseUrl: hasRelease ? `${RELEASES_PAGE}/tag/v1.1.0-beta.1` : null,
        checkedAt: this.now().toISOString(),
        progress:
          phase === 'downloading'
            ? { percent: 42, bytesPerSecond: 1_200_000, transferred: 42, total: 100 }
            : null,
        message: phase === 'downloaded' ? 'Version 1.1.0-beta.1 is ready to install.' : null,
        canInstall: phase === 'downloaded',
      });
      return;
    }
    if (this.delivery === 'automatic') await this.configureNativeUpdater();
    this.scheduleAutomaticCheck(INITIAL_AUTO_CHECK_MS);
  }

  syncSettings(settings: { channel: UpdateChannel; autoCheck: boolean }): void {
    const channelChanged = settings.channel !== this.channel;
    this.channel = settings.channel;
    this.autoCheck = settings.autoCheck;
    if (this.nativeUpdater) this.configureNativeChannel(this.nativeUpdater);
    this.update({
      channel: this.channel,
      ...(channelChanged
        ? {
            phase: 'idle' as const,
            availableVersion: null,
            releaseName: null,
            releaseDate: null,
            releaseUrl: null,
            progress: null,
            canInstall: false,
            errorCode: null,
            message: initialMessage(this.delivery, this.options.isPackaged),
          }
        : {}),
    });
    this.scheduleAutomaticCheck(INITIAL_AUTO_CHECK_MS);
  }

  private scheduleAutomaticCheck(delayMs: number): void {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (!this.autoCheck || !this.stateValue.canCheck || this.options.fixturePhase) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.check().finally(() => this.scheduleAutomaticCheck(AUTO_CHECK_INTERVAL_MS));
    }, delayMs);
  }

  private async configureNativeUpdater(): Promise<void> {
    try {
      const updater = await (this.options.loadNativeUpdater?.() ??
        import('electron-updater').then((module) => module.autoUpdater as NativeUpdater));
      this.nativeUpdater = updater;
      updater.autoDownload = true;
      // IDE state makes surprise restarts costly; installation always follows an explicit click.
      updater.autoInstallOnAppQuit = false;
      updater.autoRunAppAfterInstall = true;
      updater.disableWebInstaller = true;
      updater.logger = {
        info: (message) => this.options.logger.info('updater', { message: String(message ?? '') }),
        warn: (message) => this.options.logger.warn('updater', { message: String(message ?? '') }),
        error: (message) =>
          this.options.logger.error('updater', { message: String(message ?? '') }),
      };
      this.configureNativeChannel(updater);
      updater.on('checking-for-update', () => this.update({ phase: 'checking', message: null }));
      updater.on('update-available', (info) => {
        const version = cleanVersion(info.version);
        this.update({
          phase: 'available',
          availableVersion: version,
          releaseName: info.releaseName ?? `Charter ${version}`,
          releaseDate: info.releaseDate ?? null,
          releaseUrl: `${RELEASES_PAGE}/tag/v${version}`,
          checkedAt: this.now().toISOString(),
          progress: null,
          message: `Downloading Charter ${version} in the background.`,
          errorCode: null,
          canInstall: false,
        });
      });
      updater.on('update-not-available', () => this.markUpToDate());
      updater.on('download-progress', (progress) => {
        this.update({
          phase: 'downloading',
          progress: {
            percent: Math.min(100, Math.max(0, progress.percent)),
            bytesPerSecond: Math.max(0, progress.bytesPerSecond),
            transferred: Math.max(0, progress.transferred),
            total: Math.max(0, progress.total),
          },
          message: 'Downloading update…',
        });
      });
      updater.on('update-downloaded', (info) => {
        const version = cleanVersion(info.version);
        this.update({
          phase: 'downloaded',
          availableVersion: version,
          releaseName: info.releaseName ?? `Charter ${version}`,
          releaseDate: info.releaseDate ?? null,
          releaseUrl: `${RELEASES_PAGE}/tag/v${version}`,
          checkedAt: this.now().toISOString(),
          progress: null,
          message: `Version ${version} is ready to install.`,
          errorCode: null,
          canInstall: true,
        });
      });
      updater.on('error', (error) => this.markError(error));
    } catch (error) {
      this.markError(error);
    }
  }

  private configureNativeChannel(updater: NativeUpdater): void {
    updater.allowPrerelease = this.channel === 'beta';
    // electron-builder names the stable feed `latest.yml`; prerelease feeds use
    // their channel name (for example `beta.yml`).
    updater.channel = this.channel === 'stable' ? 'latest' : this.channel;
    // Setting channel enables downgrade in electron-updater; Charter never replaces a newer build.
    updater.allowDowngrade = false;
  }

  async check(): Promise<UpdateStateDto> {
    if (!this.stateValue.canCheck) return this.state;
    if (this.stateValue.phase === 'checking' || this.stateValue.phase === 'downloading') {
      return this.state;
    }
    this.update({ phase: 'checking', progress: null, message: null, errorCode: null });
    try {
      if (this.delivery === 'automatic') {
        if (!this.nativeUpdater) await this.configureNativeUpdater();
        if (!this.nativeUpdater) return this.state;
        await this.nativeUpdater.checkForUpdates();
      } else {
        await this.checkReleaseFeed();
      }
    } catch (error) {
      this.markError(error);
    }
    return this.state;
  }

  private async checkReleaseFeed(): Promise<void> {
    const fetchRelease =
      this.options.fetchRelease ??
      ((url: string, init: RequestInit) => fetch(url, init) as Promise<ReleaseResponse>);
    const response = await fetchRelease(RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Charter/${this.stateValue.currentVersion}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) throw new Error(`GitHub Releases returned HTTP ${response.status}.`);
    const release = latestRelease(await response.json(), this.channel);
    if (!release || compareVersions(release.version, this.stateValue.currentVersion) <= 0) {
      this.markUpToDate();
      return;
    }
    this.update({
      phase: 'available',
      availableVersion: release.version,
      releaseName: release.name,
      releaseDate: release.publishedAt,
      releaseUrl: release.url,
      checkedAt: this.now().toISOString(),
      progress: null,
      message:
        this.stateValue.platform === 'linux'
          ? 'A new Linux package is available. Open the release page to download it.'
          : 'This preview checks releases automatically; installing unsigned builds remains manual.',
      errorCode: null,
      canInstall: false,
    });
  }

  private markUpToDate(): void {
    this.update({
      phase: 'up-to-date',
      availableVersion: null,
      releaseName: null,
      releaseDate: null,
      releaseUrl: null,
      checkedAt: this.now().toISOString(),
      progress: null,
      message: `Charter ${this.stateValue.currentVersion} is up to date on the ${this.channel} channel.`,
      errorCode: null,
      canInstall: false,
    });
  }

  private markError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.options.logger.warn('update check failed', { error: message });
    this.update({
      phase: 'error',
      checkedAt: this.now().toISOString(),
      progress: null,
      message: 'Charter could not check for updates. Your current installation was not changed.',
      errorCode: 'UPDATE_CHECK_FAILED',
      canInstall: false,
    });
  }

  async install(): Promise<boolean> {
    if (this.options.fixturePhase === 'downloaded') return true;
    if (!this.nativeUpdater || !this.stateValue.canInstall || !this.stateValue.availableVersion) {
      return false;
    }
    await this.options.beforeInstall?.(this.stateValue.availableVersion);
    this.options.logger.info('installing downloaded update', {
      version: this.stateValue.availableVersion,
    });
    this.setTimer(() => this.nativeUpdater?.quitAndInstall(false, true), 100);
    return true;
  }

  dispose(): void {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }
}
