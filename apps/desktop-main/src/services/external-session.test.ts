import { describe, expect, it } from 'vitest';
import {
  externalResumeCommand,
  externalTitleFromPrompt,
  isAccountablePath,
} from './external-session-service.js';
import { ExternalLaunchIntents } from './external-launch-intents.js';

describe('isAccountablePath (ADR-0017)', () => {
  it('accepts ordinary project files', () => {
    expect(isAccountablePath('src/components/Composer.tsx')).toBe(true);
    expect(isAccountablePath('README.md')).toBe(true);
    expect(isAccountablePath('docs/adr/ADR-0017.md')).toBe(true);
  });

  it('rejects VCS and dependency noise anywhere in the path', () => {
    expect(isAccountablePath('.git/index')).toBe(false);
    expect(isAccountablePath('node_modules/react/index.js')).toBe(false);
    expect(isAccountablePath('packages/a/node_modules/b/x.js')).toBe(false);
  });

  it('rejects OS noise and the product’s own atomic-write temp files', () => {
    expect(isAccountablePath('.DS_Store')).toBe(false);
    expect(isAccountablePath('src/.DS_Store')).toBe(false);
    expect(isAccountablePath('src/.pi-ide-chg.123.456.tmp')).toBe(false);
  });
});

describe('externalResumeCommand', () => {
  it('targets the recorded conversation id when one exists (ADR-0017 amendment)', () => {
    const id = '924241d6-f2e8-444d-8d75-0386362bf52f';
    expect(externalResumeCommand('claude', id)).toBe(`claude --resume ${id}`);
    expect(externalResumeCommand('codex', id)).toBe(`codex resume ${id}`);
  });

  it('degrades to the last-session flag without an id', () => {
    expect(externalResumeCommand('claude')).toBe('claude --continue');
    expect(externalResumeCommand('claude', null)).toBe('claude --continue');
    expect(externalResumeCommand('codex')).toBe('codex resume --last');
  });

  it('never embeds a non-UUID id into PTY input', () => {
    expect(externalResumeCommand('claude', 'abc; rm -rf .')).toBe('claude --continue');
    expect(externalResumeCommand('claude', '$(evil)')).toBe('claude --continue');
    expect(externalResumeCommand('codex', 'not-a-uuid')).toBe('codex resume --last');
  });

  it('does not turn an arbitrary detected program name into shell input', () => {
    expect(externalResumeCommand('fakeagent')).toBeNull();
    expect(externalResumeCommand('claude; rm -rf .')).toBeNull();
  });
});

describe('externalTitleFromPrompt (session named by the first user message)', () => {
  it('uses the first non-empty line, whitespace collapsed', () => {
    expect(externalTitleFromPrompt('hi')).toBe('hi');
    expect(externalTitleFromPrompt('\n\n  fix   the login\t bug \nmore context')).toBe(
      'fix the login bug',
    );
  });

  it('truncates long prompts at 64 chars with an ellipsis', () => {
    const title = externalTitleFromPrompt('x'.repeat(100));
    expect(title).toHaveLength(62);
    expect(title!.endsWith('…')).toBe(true);
  });

  it('returns null for blank prompts so the placeholder title survives', () => {
    expect(externalTitleFromPrompt('')).toBeNull();
    expect(externalTitleFromPrompt('   \n \t ')).toBeNull();
  });
});

describe('ExternalLaunchIntents (product-launch intent handoff)', () => {
  const intent = {
    cli: 'claude',
    sessionId: '924241d6-f2e8-444d-8d75-0386362bf52f',
    prompt: 'hi',
  };

  it('hands the intent to the first matching agent-enter, exactly once', () => {
    const intents = new ExternalLaunchIntents();
    intents.register('term-1', intent);
    expect(intents.consume('term-1', 'claude')).toEqual(intent);
    expect(intents.consume('term-1', 'claude')).toBeNull();
  });

  it('voids the intent when a different CLI shows up on the terminal', () => {
    const intents = new ExternalLaunchIntents();
    intents.register('term-1', intent);
    expect(intents.consume('term-1', 'codex')).toBeNull();
    // One-shot even on mismatch: the launch it described never happened.
    expect(intents.consume('term-1', 'claude')).toBeNull();
  });

  it('never leaks a stale intent into a much later session', () => {
    let now = 0;
    const intents = new ExternalLaunchIntents(() => now);
    intents.register('term-1', intent);
    now = 121_000;
    expect(intents.consume('term-1', 'claude')).toBeNull();
  });

  it('keeps intents per terminal', () => {
    const intents = new ExternalLaunchIntents();
    intents.register('term-1', intent);
    intents.register('term-2', { cli: 'codex', sessionId: null, prompt: null });
    expect(intents.consume('term-2', 'codex')).toEqual({
      cli: 'codex',
      sessionId: null,
      prompt: null,
    });
    expect(intents.consume('term-1', 'claude')).toEqual(intent);
  });
});
