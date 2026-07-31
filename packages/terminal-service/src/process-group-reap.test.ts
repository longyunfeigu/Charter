import { afterEach, describe, expect, it, vi } from 'vitest';
import { reapTerminalProcessGroup } from './index.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.skipIf(process.platform === 'win32')('terminal process-group cleanup', () => {
  it('hangs up helpers immediately and kills stubborn survivors after the grace period', () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    reapTerminalProcessGroup(4242, 100);
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGHUP');
    expect(kill).not.toHaveBeenCalledWith(-4242, 'SIGKILL');

    vi.advanceTimersByTime(100);
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  it('does not arm a delayed kill when the process group is already gone', () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });

    reapTerminalProcessGroup(4242, 100);
    vi.advanceTimersByTime(100);
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
