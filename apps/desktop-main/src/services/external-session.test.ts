import { describe, expect, it, vi } from 'vitest';
import type { CodeContextRefDto } from '@pi-ide/ipc-contracts';
import {
  beginObservedTurnPresence,
  codexStartupComposerReady,
  codexStartupTrustGateActive,
  codexStartupUpdateGateActive,
  externalPromptEnterDelayMs,
  externalInjectText,
  isExternalPromptSubmit,
  externalResumeCommand,
  externalTitleFromPrompt,
  isAccountablePath,
  isTerminalViewportRepaint,
  isTerminalViewportScrollInput,
  selectFileAttributionOwner,
  shouldReconcileSnapshotPath,
  ExternalSessionService,
} from './external-session-service.js';
import { ExternalLaunchIntents } from './external-launch-intents.js';

vi.mock('../broadcast.js', () => ({ broadcast: vi.fn(() => 0) }));

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

  it('rejects third-party CLI atomic-write temp files (name.tmp.<pid>.<hex>)', () => {
    expect(isAccountablePath('sub2_script.py.tmp.71895.7fa33abc')).toBe(false);
    expect(isAccountablePath('src/app.ts.tmp.123.9f')).toBe(false);
    expect(isAccountablePath('README.md.TMP.4.ABC')).toBe(false);
  });

  it('keeps real files that merely contain ".tmp." in their name', () => {
    expect(isAccountablePath('notes.tmp.md')).toBe(true);
    expect(isAccountablePath('data.tmp.2.csv')).toBe(true);
    expect(isAccountablePath('src/tmp.7fa33.ts')).toBe(true);
  });
});

describe('external TUI viewport scrolling', () => {
  it('recognizes SGR and legacy X10 wheel reports, including modifier bits', () => {
    expect(isTerminalViewportScrollInput('\u001b[<64;42;18M')).toBe(true);
    expect(isTerminalViewportScrollInput('\u001b[<65;42;18M')).toBe(true);
    expect(isTerminalViewportScrollInput('\u001b[<68;42;18M')).toBe(true);
    expect(
      isTerminalViewportScrollInput(`\u001b[M${String.fromCharCode(32 + 64, 32 + 42, 32 + 18)}`),
    ).toBe(true);
  });

  it('does not confuse clicks, focus/device reports or keyboard input with scrolling', () => {
    expect(isTerminalViewportScrollInput('\u001b[<0;42;18M')).toBe(false);
    expect(isTerminalViewportScrollInput('\u001b[<32;42;18M')).toBe(false);
    expect(isTerminalViewportScrollInput('\u001b[I\u001b[?1;2c')).toBe(false);
    expect(isTerminalViewportScrollInput('finish this task\r')).toBe(false);
  });

  it('distinguishes full-screen repaint controls from ordinary documentary output', () => {
    expect(isTerminalViewportRepaint('\u001b[?2026h\u001b[Hredraw\u001b[2K')).toBe(true);
    expect(isTerminalViewportRepaint('\u001b[24;1Hredraw')).toBe(true);
    expect(isTerminalViewportRepaint('\u001b[32mordinary colored output\u001b[0m\n')).toBe(false);
    expect(isTerminalViewportRepaint('{"type":"turn.completed"}\n')).toBe(false);
  });
});

describe('codexStartupTrustGateActive', () => {
  it('blocks Composer prompt delivery while the directory trust gate is current', () => {
    expect(
      codexStartupTrustGateActive(
        '\u001b[2JDo you trust the contents of this directory? Press enter to continue',
      ),
    ).toBe(true);
  });

  it('unblocks after Codex paints its real composer and ignores old gate scrollback', () => {
    expect(
      codexStartupTrustGateActive(
        'Do you trust the contents of this directory? Press enter to continue' +
          '\u001b[2J>_ OpenAI Codex (v0.145.0) model: loading /model to change',
      ),
    ).toBe(false);
    expect(codexStartupTrustGateActive('>_ OpenAI Codex /model to change')).toBe(false);
  });

  it('does not treat shell echo as a composer and recognizes the real Codex screen', () => {
    expect(codexStartupComposerReady('codex\r\n❯ codex')).toBe(false);
    expect(
      codexStartupComposerReady(
        'Do you trust the contents of this directory? Press enter to continue',
      ),
    ).toBe(false);
    expect(
      codexStartupComposerReady(
        'Press enter to continue\u001b[2J>_ OpenAI Codex (v0.145.0) /model to change',
      ),
    ).toBe(true);
  });
});

describe('codexStartupUpdateGateActive', () => {
  it('recognizes the optional Codex self-update screen before the Composer', () => {
    expect(
      codexStartupUpdateGateActive(
        '✨ Update available! 0.145.0 -> 0.146.0 › 1. Update now 2. Skip ' +
          '3. Skip until next version Press enter to continue',
      ),
    ).toBe(true);
  });

  it('ignores retained update text once the Composer has painted', () => {
    expect(
      codexStartupUpdateGateActive(
        'Update available! 1. Update now 2. Skip\u001b[2J>_ OpenAI Codex /model to change',
      ),
    ).toBe(false);
  });
});

describe('selectFileAttributionOwner', () => {
  const session = (
    id: string,
    root: string,
    activityAt: number,
    active = true,
    graceUntil = 0,
  ) => ({
    id,
    root,
    ended: false,
    fileAttributionActive: active,
    fileAttributionGraceUntilMs: graceUntil,
    lastAgentActivityAtMs: activityAt,
  });

  it('does not attribute background workspace writes while every terminal is idle', () => {
    const idle = session('idle', '/repo', 100, false);
    expect(selectFileAttributionOwner([idle], '/repo', 1_000)).toBeNull();
  });

  it('assigns a shared-root batch only to the most recently active turn', () => {
    const older = session('older', '/repo', 100);
    const owner = session('owner', '/repo', 200);
    const elsewhere = session('elsewhere', '/other', 300);

    expect(selectFileAttributionOwner([older, owner, elsewhere], '/repo', 250)).toBe(owner);
  });

  it('keeps a short grace window for fs events delivered after turn completion', () => {
    const settling = session('settling', '/repo', 100, false, 1_500);
    expect(selectFileAttributionOwner([settling], '/repo', 1_000)).toBe(settling);
    expect(selectFileAttributionOwner([settling], '/repo', 1_501)).toBeNull();
  });
});

describe('shouldReconcileSnapshotPath', () => {
  it('discovers missed paths for a single external Session root', () => {
    expect(shouldReconcileSnapshotPath(false, false)).toBe(true);
  });

  it('only refreshes watcher-owned paths when external Sessions share a root', () => {
    expect(shouldReconcileSnapshotPath(true, true)).toBe(true);
    expect(shouldReconcileSnapshotPath(true, false)).toBe(false);
  });
});

describe('ExternalSessionService force stop', () => {
  it('durably finishes an active task even when its restored PTY has no live service binding', async () => {
    const external: {
      cli: string;
      terminalId: string;
      status: 'active' | 'ended';
      snapshotRef: null;
      captureGrade: 'observed';
    } = {
      cli: 'claude',
      terminalId: 'terminal-orphan',
      status: 'active',
      snapshotRef: null,
      captureGrade: 'observed',
    };
    const task = {
      id: 'task-orphan',
      changedFiles: null,
      external,
    };
    const kill = vi.fn();
    const finishExternalSession = vi.fn(() => {
      task.external.status = 'ended';
      return task;
    });
    const terminals = {
      onAgentState: vi.fn(() => () => {}),
      onDataEvent: vi.fn(() => () => {}),
      onSourcedInputEvent: vi.fn(() => () => {}),
      list: vi.fn(() => []),
      persistsAcrossAppRestart: vi.fn(() => false),
      pollOnce: vi.fn(),
      kill,
    };
    const tasks = {
      getTask: vi.fn(() => task),
      recoverExternalTasks: vi.fn(),
      externalTasksMissingSessionId: vi.fn(() => []),
      finishExternalSession,
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const service = new ExternalSessionService(
      terminals as never,
      tasks as never,
      {} as never,
      logger as never,
    );

    await expect(service.end(task.id, true)).resolves.toEqual({
      terminalId: 'terminal-orphan',
      cli: 'claude',
      ended: true,
    });
    expect(kill).toHaveBeenCalledWith('terminal-orphan');
    expect(finishExternalSession).toHaveBeenCalledWith(task.id, 0, 'observed');
    expect(task.external.status).toBe('ended');

    service.dispose();
  });
});

describe('externalResumeCommand', () => {
  it('targets the recorded conversation id when one exists (ADR-0017 amendment)', () => {
    const id = '924241d6-f2e8-444d-8d75-0386362bf52f';
    expect(externalResumeCommand('claude', id)).toBe(`claude --resume ${id}`);
    expect(externalResumeCommand('codex', id)).toBe(`codex resume ${id}`);
  });

  it('pins Codex to the home that owns the recorded rollout', () => {
    const id = '924241d6-f2e8-444d-8d75-0386362bf52f';
    expect(externalResumeCommand('codex', id, "/Users/o'hara/.codex-app")).toBe(
      `CODEX_HOME='/Users/o'\\''hara/.codex-app' codex resume ${id}`,
    );
  });

  it('keeps Claude fallback but fails closed for Codex without an id', () => {
    expect(externalResumeCommand('claude')).toBe('claude --continue');
    expect(externalResumeCommand('claude', null)).toBe('claude --continue');
    expect(externalResumeCommand('codex')).toBeNull();
    expect(externalResumeCommand('codex', null)).toBeNull();
  });

  it('never embeds a non-UUID id into PTY input', () => {
    expect(externalResumeCommand('claude', 'abc; rm -rf .')).toBe('claude --continue');
    expect(externalResumeCommand('claude', '$(evil)')).toBe('claude --continue');
    expect(externalResumeCommand('codex', 'not-a-uuid')).toBeNull();
  });

  it('does not turn an arbitrary detected program name into shell input', () => {
    expect(externalResumeCommand('fakeagent')).toBeNull();
    expect(externalResumeCommand('claude; rm -rf .')).toBeNull();
  });
});

describe('externalInjectText (ADR-0030: unsent input-line references)', () => {
  const selection = (): CodeContextRefDto => ({
    id: 'ref-1',
    path: 'src/earth.html',
    origin: 'file-peek',
    version: 'working-tree',
    startLine: 42,
    startColumn: 1,
    endLine: 58,
    endColumn: 2,
    text: 'scene.rotation.x = rad;',
    language: 'html',
    contentHash: null,
    selectionHash: 'a'.repeat(64),
    createdAt: '2026-07-20T00:00:00.000Z',
  });

  it('turns a file ref into an @mention with a trailing space to keep typing', () => {
    expect(externalInjectText({ kind: 'file', path: 'src/app.ts', isFolder: false })).toBe(
      '@src/app.ts ',
    );
  });

  it('marks folders with a trailing slash so the CLI mention resolves as a directory', () => {
    expect(externalInjectText({ kind: 'file', path: 'src/views', isFolder: true })).toBe(
      '@src/views/ ',
    );
  });

  it('serializes a selection as the frozen snapshot block, bytes included', () => {
    const text = externalInjectText({ kind: 'selection', code: selection() });
    expect(text.startsWith('<code_context>')).toBe(true);
    expect(text).toContain('scene.rotation.x = rad;');
    expect(text).toContain('path="src/earth.html"');
    expect(text).toContain('range="42:1-58:2"');
    expect(text.endsWith('</code_context>\n')).toBe(true);
  });

  it('never contains a CR — landing unsent is the contract', () => {
    expect(externalInjectText({ kind: 'file', path: 'a.md', isFolder: false })).not.toContain('\r');
    expect(externalInjectText({ kind: 'selection', code: selection() })).not.toContain('\r');
  });

  it('serializes artifact feedback for Claude/Codex without submitting it', () => {
    const text = externalInjectText({
      kind: 'artifact',
      artifact: {
        id: 'artifact-1',
        taskId: 'task-1',
        path: 'reports/data.csv',
        contentHash: 'b'.repeat(64),
        artifactKind: 'table',
        anchor: { type: 'table', startRow: 2, endRow: 3, startColumn: 1, endColumn: 2 },
        note: 'Recalculate these rows.',
        createdAt: '2026-07-22T00:00:00.000Z',
      },
    });
    expect(text).toContain('<artifact_feedback_context>');
    expect(text).toContain('reports/data.csv');
    expect(text).toContain('Recalculate these rows.');
    expect(text).not.toContain('\r');
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

describe('isExternalPromptSubmit', () => {
  it('recognizes Enter without treating multiline pasted content as submitted', () => {
    expect(isExternalPromptSubmit('\r')).toBe(true);
    expect(isExternalPromptSubmit('\u001b[200~line one\nline two\u001b[201~')).toBe(false);
  });
});

describe('externalPromptEnterDelayMs', () => {
  it('keeps ordinary prompts responsive and gives long bracketed pastes time to settle', () => {
    expect(externalPromptEnterDelayMs('hi')).toBe(251);
    expect(externalPromptEnterDelayMs('x'.repeat(4_000))).toBe(1_250);
    expect(externalPromptEnterDelayMs('x'.repeat(40_000))).toBe(3_000);
  });

  it('scales by UTF-8 bytes instead of JavaScript code units', () => {
    expect(externalPromptEnterDelayMs('你'.repeat(1_000))).toBe(1_000);
  });
});

describe('beginObservedTurnPresence', () => {
  it('arms quiet settlement for an argv-submitted first turn', () => {
    const timer = setTimeout(() => undefined, 60_000);
    const state = {
      structuredStream: false,
      presenceTimer: timer,
      presenceAwaitingReply: false,
      presenceSawOutput: true,
    };

    beginObservedTurnPresence(state);

    expect(state).toMatchObject({
      presenceTimer: null,
      presenceAwaitingReply: true,
      presenceSawOutput: false,
    });
  });

  it('leaves protocol-owned structured turns alone', () => {
    const state = {
      structuredStream: true,
      presenceTimer: null,
      presenceAwaitingReply: false,
      presenceSawOutput: false,
    };

    beginObservedTurnPresence(state);

    expect(state.presenceAwaitingReply).toBe(false);
  });
});

describe('ExternalLaunchIntents (product-launch intent handoff)', () => {
  const intent = {
    cli: 'claude',
    sessionId: '924241d6-f2e8-444d-8d75-0386362bf52f',
    prompt: 'hi',
    promptDelivery: 'deferred' as const,
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
    intents.register('term-2', {
      cli: 'codex',
      sessionId: null,
      prompt: null,
      promptDelivery: 'argv',
    });
    expect(intents.consume('term-2', 'codex')).toEqual({
      cli: 'codex',
      sessionId: null,
      prompt: null,
      promptDelivery: 'argv',
    });
    expect(intents.consume('term-1', 'claude')).toEqual(intent);
  });
});
