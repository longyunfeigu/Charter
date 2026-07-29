import { describe, expect, it } from 'vitest';
import type { UpdateStateDto } from '@pi-ide/ipc-contracts';
import { updateNoticeKey } from './appStore.js';

function updateState({
  phase,
  delivery,
  ...patch
}: Partial<UpdateStateDto> & Pick<UpdateStateDto, 'phase' | 'delivery'>): UpdateStateDto {
  return {
    phase,
    delivery,
    platform: 'darwin',
    channel: 'beta',
    currentVersion: '1.0.0-beta.3',
    availableVersion: '1.0.0-beta.4',
    releaseName: null,
    releaseDate: null,
    releaseUrl: null,
    checkedAt: null,
    progress: null,
    message: null,
    errorCode: null,
    canCheck: true,
    canInstall: false,
    ...patch,
  };
}

describe('updateNoticeKey', () => {
  it('identifies a manual update that is available', () => {
    expect(updateNoticeKey(updateState({ phase: 'available', delivery: 'manual' }))).toBe(
      'manual:1.0.0-beta.4',
    );
  });

  it('identifies an automatic update only after it has downloaded', () => {
    expect(updateNoticeKey(updateState({ phase: 'downloaded', delivery: 'automatic' }))).toBe(
      'automatic:1.0.0-beta.4',
    );
  });

  it('does not show the persistent notice for other update states', () => {
    expect(updateNoticeKey(null)).toBeNull();
    expect(updateNoticeKey(updateState({ phase: 'checking', delivery: 'manual' }))).toBeNull();
    expect(
      updateNoticeKey(updateState({ phase: 'downloading', delivery: 'automatic' })),
    ).toBeNull();
  });

  it('uses the version in the key so a newer release is shown again', () => {
    const beta4 = updateState({ phase: 'available', delivery: 'manual' });
    const beta5 = updateState({
      phase: 'available',
      delivery: 'manual',
      availableVersion: '1.0.0-beta.5',
    });

    expect(updateNoticeKey(beta5)).not.toBe(updateNoticeKey(beta4));
  });
});
