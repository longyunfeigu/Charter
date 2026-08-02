import { describe, expect, it } from 'vitest';
import {
  defaultExternalTerminalTools,
  externalSessionTitle,
  externalTerminalLifecycle,
  isLeakedTerminalReply,
  type ExternalCli,
} from './external-terminal-lifecycle.js';

describe('externalTerminalLifecycle', () => {
  for (const cli of ['codex', 'claude'] as const satisfies readonly ExternalCli[]) {
    const provider = cli === 'codex' ? 'Codex' : 'Claude Code';

    it(`${cli}: distinguishes a running Agent from its live PTY`, () => {
      expect(
        externalTerminalLifecycle({
          cli,
          agent: 'active',
          terminalExited: false,
          shellTitle: 'zsh',
        }),
      ).toMatchObject({
        agentLabel: 'Agent running',
        terminalLabel: 'Terminal live',
        interactive: true,
        summary: `${provider} running · Terminal live`,
      });
    });

    it(`${cli}: keeps the provider identity when the Agent returns to zsh`, () => {
      expect(
        externalTerminalLifecycle({
          cli,
          agent: 'ended',
          terminalExited: false,
          shellTitle: 'zsh',
        }),
      ).toMatchObject({
        agentLabel: 'Agent ended',
        terminalLabel: 'Shell available',
        interactive: true,
        summary: `${provider} ended · Shell available`,
        terminalHeadline: `Shell after ${provider}`,
        terminalDetail: 'zsh ready · process preserved',
      });
      expect(externalSessionTitle(cli, 'zsh')).toBe(`${provider} session`);
    });

    it(`${cli}: reports a terminal end separately from the Agent end`, () => {
      expect(
        externalTerminalLifecycle({ cli, agent: 'ended', terminalExited: true, shellTitle: 'zsh' }),
      ).toMatchObject({
        agentLabel: 'Agent ended',
        terminalLabel: 'Terminal ended',
        interactive: false,
        summary: `${provider} ended · Terminal ended`,
      });
    });

    it(`${cli}: makes an explicitly stopped Agent transcript read-only`, () => {
      expect(
        externalTerminalLifecycle({
          cli,
          agent: 'interrupted',
          terminalExited: false,
          shellTitle: 'zsh',
        }),
      ).toMatchObject({
        agentLabel: 'Agent interrupted',
        terminalLabel: 'Terminal preserved',
        interactive: false,
        terminalHeadline: `Stopped ${provider} transcript`,
        terminalDetail: 'read-only · resume the Session to continue',
      });
    });
  }

  it('preserves a user/task title instead of exposing the underlying shell title', () => {
    expect(externalSessionTitle('codex', 'zsh', 'Fix daemon recovery')).toBe('Fix daemon recovery');
    expect(externalSessionTitle('claude', 'My investigation')).toBe('My investigation');
  });

  it('keeps tools out of the terminal until ended work is ready to review', () => {
    expect(defaultExternalTerminalTools('active', 3)).toEqual({ open: false, tool: 'editor' });
    expect(defaultExternalTerminalTools('ended', 0)).toEqual({ open: false, tool: 'editor' });
    expect(defaultExternalTerminalTools('ended', 3)).toEqual({ open: true, tool: 'changes' });
  });
});

describe('isLeakedTerminalReply', () => {
  it('recognizes the combined color, DA and XTVERSION response leaked into zle', () => {
    expect(
      isLeakedTerminalReply(
        'execute: ffff/ffff/ffff\\[?1;2cP>|xterm.js(6.1.0-beta.287)\\[?1;2c[?202_',
      ),
    ).toBe(true);
  });

  it('does not erase ordinary commands or output that merely mentions xterm', () => {
    expect(isLeakedTerminalReply('npm why @xterm/xterm')).toBe(false);
    expect(isLeakedTerminalReply('theme ffff/ffff/ffff')).toBe(false);
    expect(isLeakedTerminalReply('xterm.js(6.1.0) [?1;2c')).toBe(false);
  });
});
