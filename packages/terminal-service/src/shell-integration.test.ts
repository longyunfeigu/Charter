import { describe, expect, it } from 'vitest';
import {
  SHELL_INTEGRATION_FILES,
  shellIntegrationSpawn,
  type ShellIntegrationConfig,
} from './shell-integration.js';

const READY: ShellIntegrationConfig = { dir: '/data/shell-integration', enabled: true };

describe('shellIntegrationSpawn (ADR-0021)', () => {
  it('zsh gets the ZDOTDIR shim and preserves a user ZDOTDIR', () => {
    const plan = shellIntegrationSpawn('/bin/zsh', READY, { ZDOTDIR: '/home/u/.config/zsh' });
    expect(plan.injected).toBe(true);
    expect(plan.args).toEqual([]);
    expect(plan.env.ZDOTDIR).toBe('/data/shell-integration/zsh');
    expect(plan.env.CHARTER_USER_ZDOTDIR).toBe('/home/u/.config/zsh');
  });

  it('zsh without a user ZDOTDIR does not invent one', () => {
    const plan = shellIntegrationSpawn('zsh', READY, {});
    expect(plan.env.ZDOTDIR).toBe('/data/shell-integration/zsh');
    expect(plan.env).not.toHaveProperty('CHARTER_USER_ZDOTDIR');
  });

  it('login-shell style name (-zsh) still matches', () => {
    expect(shellIntegrationSpawn('-zsh', READY, {}).injected).toBe(true);
  });

  it('bash uses --init-file', () => {
    const plan = shellIntegrationSpawn('/bin/bash', READY, {});
    expect(plan.injected).toBe(true);
    expect(plan.args).toEqual([
      '--init-file',
      '/data/shell-integration/bash/charter-integration.bash',
    ]);
    expect(plan.env).toEqual({});
  });

  it('fish prepends the vendor_conf.d data dir', () => {
    const plan = shellIntegrationSpawn('/usr/local/bin/fish', READY, {
      XDG_DATA_DIRS: '/usr/share',
    });
    expect(plan.injected).toBe(true);
    expect(plan.env.XDG_DATA_DIRS).toBe('/data/shell-integration/fish-xdg:/usr/share');
  });

  it('fish keeps standard fallback dirs when XDG_DATA_DIRS was unset', () => {
    const plan = shellIntegrationSpawn('fish', READY, {});
    expect(plan.env.XDG_DATA_DIRS).toBe(
      '/data/shell-integration/fish-xdg:/usr/local/share:/usr/share',
    );
  });

  // Degradation matrix: every branch must spawn exactly like today.
  const plain = { args: [], env: {}, injected: false };
  it('unknown shells degrade to a plain spawn', () => {
    expect(shellIntegrationSpawn('/bin/nu', READY, {})).toEqual(plain);
    expect(shellIntegrationSpawn('pwsh', READY, {})).toEqual(plain);
    expect(shellIntegrationSpawn('cmd.exe', READY, {})).toEqual(plain);
  });
  it('disabled setting degrades to a plain spawn', () => {
    expect(shellIntegrationSpawn('/bin/zsh', { ...READY, enabled: false }, {})).toEqual(plain);
  });
  it('missing script dir degrades to a plain spawn', () => {
    expect(shellIntegrationSpawn('/bin/zsh', { dir: null, enabled: true }, {})).toEqual(plain);
    expect(shellIntegrationSpawn('/bin/zsh', null, {})).toEqual(plain);
  });
});

describe('SHELL_INTEGRATION_FILES', () => {
  it('every script is re-entry guarded and emits all four OSC 133 marks across the set', () => {
    const all = SHELL_INTEGRATION_FILES.map((f) => f.content).join('\n');
    for (const mark of ['133;A', '133;B', '133;C', '133;D']) {
      expect(all).toContain(mark);
    }
    for (const file of SHELL_INTEGRATION_FILES.filter((f) => !f.path.endsWith('.zshenv'))) {
      expect(file.content).toContain('CHARTER_SHELL_INTEGRATION');
    }
  });

  it('shims chain to the user config before hooking', () => {
    const zshrc = SHELL_INTEGRATION_FILES.find((f) => f.path === 'zsh/.zshrc')!.content;
    expect(zshrc.indexOf('.zshrc')).toBeLessThan(zshrc.indexOf('add-zsh-hook'));
    const bash = SHELL_INTEGRATION_FILES.find((f) => f.path.endsWith('.bash'))!.content;
    expect(bash.indexOf('.bashrc')).toBeLessThan(bash.indexOf('PROMPT_COMMAND'));
  });
});
