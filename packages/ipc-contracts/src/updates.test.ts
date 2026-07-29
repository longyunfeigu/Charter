import { describe, expect, it } from 'vitest';
import { UpdateStateSchema } from './updates.js';

describe('update IPC state', () => {
  it('accepts bounded progress and rejects executable paths or unknown fields', () => {
    const state = {
      phase: 'downloading',
      delivery: 'automatic',
      platform: 'darwin',
      channel: 'stable',
      currentVersion: '1.0.0',
      availableVersion: '1.1.0',
      releaseName: 'Charter 1.1',
      releaseDate: '2026-07-29T00:00:00.000Z',
      releaseUrl: 'https://github.com/longyunfeigu/Charter/releases/tag/v1.1.0',
      checkedAt: '2026-07-29T00:00:00.000Z',
      progress: { percent: 42, bytesPerSecond: 1000, transferred: 42, total: 100 },
      message: 'Downloading update…',
      errorCode: null,
      canCheck: true,
      canInstall: false,
    };
    expect(UpdateStateSchema.safeParse(state).success).toBe(true);
    expect(
      UpdateStateSchema.safeParse({ ...state, installerPath: '/tmp/update.exe' }).success,
    ).toBe(false);
    expect(
      UpdateStateSchema.safeParse({
        ...state,
        progress: { ...state.progress, percent: 101 },
      }).success,
    ).toBe(false);
  });
});
