import { describe, expect, it } from 'vitest';
import {
  CommandNotificationService,
  formatDuration,
  type CommandNotificationDeps,
} from './command-notification-service.js';

function setup(overrides: Partial<CommandNotificationDeps> = {}): {
  service: CommandNotificationService;
  shown: Array<{ title: string; body: string; onClick: () => void }>;
  revealed: Array<{ terminalId: string; blockId: string }>;
} {
  const shown: Array<{ title: string; body: string; onClick: () => void }> = [];
  const revealed: Array<{ terminalId: string; blockId: string }> = [];
  const service = new CommandNotificationService({
    enabled: () => true,
    anyWindowFocused: () => false,
    minDurationMs: () => 15_000,
    show: (n, onClick) => shown.push({ ...n, onClick }),
    reveal: (terminalId, blockId) => revealed.push({ terminalId, blockId }),
    ...overrides,
  });
  return { service, shown, revealed };
}

const DONE = {
  terminalId: 'term-1',
  blockId: 'blk-1',
  command: 'npm run test:e2e',
  exitCode: 0,
  durationMs: 134_000,
  contextLabel: 'checkout-web',
};

describe('CommandNotificationService (ADR-0021)', () => {
  it('notifies for an unfocused long command and lands the click on the block', () => {
    const { service, shown, revealed } = setup();
    expect(service.onCommandDone(DONE)).toBe(true);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toContain('npm run test:e2e');
    expect(shown[0]!.body).toContain('2m14s');
    expect(shown[0]!.body).toContain('checkout-web');
    shown[0]!.onClick();
    expect(revealed).toEqual([{ terminalId: 'term-1', blockId: 'blk-1' }]);
  });

  it('failure notifications carry the exit code', () => {
    const { service, shown } = setup();
    service.onCommandDone({ ...DONE, exitCode: 2 });
    expect(shown[0]!.title).toContain('failed');
    expect(shown[0]!.body).toContain('exit 2');
  });

  it('short commands never notify', () => {
    const { service, shown } = setup();
    expect(service.onCommandDone({ ...DONE, durationMs: 14_999 })).toBe(false);
    expect(shown).toHaveLength(0);
  });

  it('a focused window suppresses the banner (tab bell handles it)', () => {
    const { service, shown } = setup({ anyWindowFocused: () => true });
    expect(service.onCommandDone(DONE)).toBe(false);
    expect(shown).toHaveLength(0);
  });

  it('disabled settings (or PI_IDE_E2E) suppress everything', () => {
    const { service, shown } = setup({ enabled: () => false });
    expect(service.onCommandDone(DONE)).toBe(false);
    expect(shown).toHaveLength(0);
  });

  it('one edge = one notification, even on duplicate reports', () => {
    const { service, shown } = setup();
    expect(service.onCommandDone(DONE)).toBe(true);
    expect(service.onCommandDone(DONE)).toBe(false);
    expect(shown).toHaveLength(1);
  });
});

describe('formatDuration', () => {
  it('formats seconds and minutes', () => {
    expect(formatDuration(16_000)).toBe('16s');
    expect(formatDuration(134_000)).toBe('2m14s');
    expect(formatDuration(120_000)).toBe('2m');
  });
});
