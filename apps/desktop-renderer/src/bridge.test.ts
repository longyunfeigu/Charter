import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMissingIpcHandlerError, rpcResult } from './bridge.js';

afterEach(() => vi.unstubAllGlobals());

function productWithRpc(rpc: Record<string, (payload: unknown) => Promise<unknown>>): void {
  vi.stubGlobal('window', { product: { rpc } });
}

describe('renderer IPC protocol drift', () => {
  it('recognizes Electron missing-handler rejections', () => {
    expect(
      isMissingIpcHandlerError(
        new Error(
          "Error invoking remote method 'rpc:external.endSession': Error: No handler registered for 'rpc:external.endSession'",
        ),
      ),
    ).toBe(true);
    expect(isMissingIpcHandlerError(new Error('connection refused'))).toBe(false);
  });

  it('asks for a restart when Main predates a renderer channel', async () => {
    productWithRpc({
      'external.endSession': async () => {
        throw new Error("No handler registered for 'rpc:external.endSession'");
      },
    });

    const result = await rpcResult('external.endSession', { taskId: 'task-1' });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'APP_RESTART_REQUIRED',
        severity: 'warning',
        userMessage: 'Charter updated while running. Restart Charter to use this action.',
        context: { channel: 'external.endSession' },
      },
    });
  });

  it('asks for a restart when Preload predates a renderer channel', async () => {
    productWithRpc({});

    const result = await rpcResult('external.endSession', { taskId: 'task-1' });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'APP_RESTART_REQUIRED', context: { channel: 'external.endSession' } },
    });
  });
});
