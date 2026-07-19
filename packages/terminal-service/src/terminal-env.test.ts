import { describe, expect, it } from 'vitest';
import { sanitizedTerminalEnv } from './index.js';

describe('sanitizedTerminalEnv (agent-session markers never leak into user PTYs)', () => {
  it('strips nested Claude Code session markers', () => {
    const env = sanitizedTerminalEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: '9ffaeaf0-6774-45cf-9cfd-8406f119c1c1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_EXECPATH: '/x/claude.exe',
      CLAUDE_PID: '10197',
      CLAUDE_EFFORT: 'xhigh',
      AI_AGENT: 'claude-code_2-1-215_agent',
      CODEX_SANDBOX: 'seatbelt',
      PATH: '/usr/bin',
      HOME: '/Users/u',
    });
    expect(Object.keys(env).filter((k) => k.startsWith('CLAUDE'))).toEqual([]);
    expect(env.AI_AGENT).toBeUndefined();
    expect(env.CODEX_SANDBOX).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/Users/u');
  });

  it('keeps deliberate user configuration', () => {
    const env = sanitizedTerminalEnv({
      CLAUDE_CONFIG_DIR: '/Users/u/.claude-alt',
      ANTHROPIC_BASE_URL: 'http://10.0.3.248:3000/api',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      PI_IDE_EXTERNAL_CLIS: 'claude,codex',
      ZDOTDIR: '/tmp/bin',
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/u/.claude-alt');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://10.0.3.248:3000/api');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('tok');
    expect(env.PI_IDE_EXTERNAL_CLIS).toBe('claude,codex');
    expect(env.ZDOTDIR).toBe('/tmp/bin');
  });
});
