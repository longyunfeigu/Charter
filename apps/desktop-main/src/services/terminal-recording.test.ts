import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TerminalInfo } from '@pi-ide/terminal-service';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listTerminalRecordings,
  TerminalRecordingWriter,
  type TerminalCastHeader,
} from './terminal-recording.js';

describe('terminal recording writer', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('writes an asciinema v2 stream containing visible output and resize events only', async () => {
    root = mkdtempSync(join(tmpdir(), 'charter-terminal-recording-'));
    const info: TerminalInfo = {
      id: 'term_recording_test',
      title: 'Claude',
      shell: '/bin/zsh',
      pid: 42,
      cwd: root,
      projectName: 'fixture',
      projectPath: root,
      contextKind: 'task',
      contextLabel: 'Replay fixture',
      contextTaskId: 'task_recording_test',
      launch: 'claude',
      persistence: 'process',
    };
    const writer = new TerminalRecordingWriter(root, info, 91, 27, 'process');
    writer.output('user-visible-prompt\r\n');
    writer.resize(100, 32);
    writer.output('agent-visible-answer\r\n');
    writer.close();

    await vi.waitFor(() => {
      expect(existsSync(`${writer.path}.active`)).toBe(false);
      expect(readFileSync(writer.path, 'utf8')).toContain('agent-visible-answer');
    });

    const lines = readFileSync(writer.path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    const header = lines[0] as TerminalCastHeader;
    const events = lines.slice(1) as Array<[number, string, string]>;
    expect(header).toMatchObject({
      version: 2,
      width: 91,
      height: 27,
      charter: {
        terminalId: info.id,
        contextTaskId: info.contextTaskId,
        launch: 'claude',
        source: 'process',
      },
    });
    expect(events.map((event) => event[1])).toEqual(['o', 'r', 'o']);
    expect(events.some((event) => event[1] === 'i')).toBe(false);
    expect(events.map((event) => event[2]).join('')).toContain('user-visible-prompt');
    expect(events.map((event) => event[2]).join('')).toContain('agent-visible-answer');

    const [catalog] = listTerminalRecordings(root);
    expect(catalog).toMatchObject({
      id: writer.id,
      header: { charter: { terminalId: info.id } },
    });
    expect(catalog!.sizeBytes).toBeGreaterThan(0);
  });
});
