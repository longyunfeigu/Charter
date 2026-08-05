import { describe, expect, it, vi } from 'vitest';
import type { TerminalControlService } from './terminal-control-service.js';
import { VisibleTerminalRuntime } from './visible-terminal-runtime.js';

function control(): Pick<TerminalControlService, 'closeRuntime'> {
  return { closeRuntime: vi.fn() };
}

describe('VisibleTerminalRuntime cancellation', () => {
  it('settles a tracked External Session before closing its terminal', async () => {
    const terminalControl = control();
    const settle = vi.fn(async () => undefined);
    const runtime = new VisibleTerminalRuntime(terminalControl as TerminalControlService, settle);

    await runtime.cancel('terminal:term-child', 'Mission cancelled');

    expect(settle).toHaveBeenCalledWith('term-child');
    expect(terminalControl.closeRuntime).toHaveBeenCalledWith('term-child');
    expect(settle.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(terminalControl.closeRuntime).mock.invocationCallOrder[0]!,
    );
  });

  it('still closes an untracked Mission terminal directly', async () => {
    const terminalControl = control();
    const runtime = new VisibleTerminalRuntime(terminalControl as TerminalControlService);

    await runtime.cancel('term-untracked', 'Runtime closed');

    expect(terminalControl.closeRuntime).toHaveBeenCalledWith('term-untracked');
  });

  it('does not mark the runtime closed when durable settlement fails', async () => {
    const terminalControl = control();
    const runtime = new VisibleTerminalRuntime(
      terminalControl as TerminalControlService,
      async () => Promise.reject(new Error('settlement failed')),
    );

    await expect(runtime.cancel('terminal:term-child', 'Mission cancelled')).rejects.toThrow(
      'settlement failed',
    );
    expect(terminalControl.closeRuntime).not.toHaveBeenCalled();
  });
});
