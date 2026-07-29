import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@pi-ide/foundation';
import {
  compareVersions,
  defaultUpdateChannel,
  type NativeUpdater,
  UpdateService,
} from './update-service.js';

const logger = createLogger('update-test', { write: () => undefined });

function release(version: string, prerelease: boolean): Record<string, unknown> {
  return {
    tag_name: `v${version}`,
    name: `Charter ${version}`,
    html_url: `https://github.com/longyunfeigu/Charter/releases/tag/v${version}`,
    published_at: '2026-07-29T00:00:00.000Z',
    prerelease,
    draft: false,
  };
}

describe('UpdateService', () => {
  it('compares stable and prerelease SemVer without allowing loose tags', () => {
    expect(compareVersions('1.0.0', '1.0.0-beta.9')).toBe(1);
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBe(1);
    expect(compareVersions('2.0.0-alpha.1', '2.0.0-alpha')).toBe(1);
    expect(compareVersions('not-a-version', '1.0.0')).toBe(0);
  });

  it('defaults prerelease builds to their Beta feed without opting Stable into prereleases', () => {
    expect(defaultUpdateChannel('1.0.0-beta.4')).toBe('beta');
    expect(defaultUpdateChannel('1.0.0')).toBe('stable');
    expect(defaultUpdateChannel('1.0.0-rc.1')).toBe('stable');
  });

  it('checks public releases but keeps unsigned installations manual', async () => {
    const emit = vi.fn();
    const service = new UpdateService({
      currentVersion: '1.0.0-beta.3',
      platform: 'darwin',
      isPackaged: true,
      signed: false,
      channel: 'beta',
      autoCheck: false,
      logger,
      emit,
      fetchRelease: async () => ({
        ok: true,
        status: 200,
        json: async () => [
          release('9.0.0-nightly.1', true),
          release('2.0.0-rc.1', true),
          release('1.1.0-beta.1', true),
          release('1.0.0', false),
        ],
      }),
      now: () => new Date('2026-07-29T12:00:00.000Z'),
    });

    await service.start();
    const state = await service.check();

    expect(state).toMatchObject({
      phase: 'available',
      delivery: 'manual',
      availableVersion: '1.1.0-beta.1',
      canInstall: false,
      checkedAt: '2026-07-29T12:00:00.000Z',
    });
    expect(emit).toHaveBeenCalled();
    service.dispose();
  });

  it('filters prereleases from stable and reports the current build as up to date', async () => {
    const service = new UpdateService({
      currentVersion: '1.0.0',
      platform: 'linux',
      isPackaged: true,
      signed: false,
      channel: 'stable',
      autoCheck: false,
      logger,
      emit: () => undefined,
      fetchRelease: async () => ({
        ok: true,
        status: 200,
        json: async () => [release('1.1.0-beta.1', true), release('1.0.0', false)],
      }),
    });

    expect(await service.check()).toMatchObject({
      phase: 'up-to-date',
      delivery: 'manual',
      availableVersion: null,
    });
    service.dispose();
  });

  it('downloads signed desktop updates and backs up before restart installation', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const quitAndInstall = vi.fn();
    const beforeInstall = vi.fn(async () => undefined);
    const updater = {
      autoDownload: false,
      autoInstallOnAppQuit: true,
      autoRunAppAfterInstall: false,
      allowPrerelease: false,
      allowDowngrade: true,
      disableWebInstaller: false,
      channel: null,
      logger: null,
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
      }),
      checkForUpdates: vi.fn(async () => {
        listeners.get('update-available')?.({
          version: '1.1.0',
          releaseName: 'Charter 1.1',
          releaseDate: '2026-07-29T00:00:00.000Z',
        });
        listeners.get('download-progress')?.({
          percent: 52,
          bytesPerSecond: 1000,
          transferred: 52,
          total: 100,
        });
        listeners.get('update-downloaded')?.({ version: '1.1.0' });
      }),
      quitAndInstall,
    } as unknown as NativeUpdater;
    const service = new UpdateService({
      currentVersion: '1.0.0',
      platform: 'win32',
      isPackaged: true,
      signed: true,
      channel: 'stable',
      autoCheck: false,
      logger,
      emit: () => undefined,
      loadNativeUpdater: async () => updater,
      beforeInstall,
      setTimer: (callback) => {
        callback();
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
    });

    await service.start();
    expect(updater.channel).toBe('latest');
    service.syncSettings({ channel: 'beta', autoCheck: false });
    expect(updater).toMatchObject({
      channel: 'beta',
      allowPrerelease: true,
      allowDowngrade: false,
    });
    service.syncSettings({ channel: 'stable', autoCheck: false });
    expect(await service.check()).toMatchObject({
      phase: 'downloaded',
      delivery: 'automatic',
      availableVersion: '1.1.0',
      canInstall: true,
    });
    expect(updater).toMatchObject({
      autoDownload: true,
      autoInstallOnAppQuit: false,
      allowDowngrade: false,
      disableWebInstaller: true,
      channel: 'latest',
    });

    await expect(service.install()).resolves.toBe(true);
    expect(beforeInstall).toHaveBeenCalledWith('1.1.0');
    expect(quitAndInstall).toHaveBeenCalledWith(false, true);
    service.dispose();
  });

  it('keeps the installed application untouched when release checks fail', async () => {
    const service = new UpdateService({
      currentVersion: '1.0.0',
      platform: 'linux',
      isPackaged: true,
      signed: false,
      channel: 'stable',
      autoCheck: false,
      logger,
      emit: () => undefined,
      fetchRelease: async () => ({ ok: false, status: 503, json: async () => null }),
    });

    expect(await service.check()).toMatchObject({
      phase: 'error',
      errorCode: 'UPDATE_CHECK_FAILED',
      canInstall: false,
    });
    service.dispose();
  });
});
