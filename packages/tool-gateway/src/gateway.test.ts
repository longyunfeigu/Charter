import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentStore } from '@pi-ide/document-service';
import { SearchService } from '@pi-ide/search-service';
import { ToolGateway } from './gateway.js';
import { registerReadOnlyTools } from './tools-readonly.js';
import type { ToolCallRequest } from '@pi-ide/agent-contract';

let root: string;
let gateway: ToolGateway;
const audits: Array<{ name: string; state: string }> = [];

function call(toolName: string, input: unknown): ToolCallRequest {
  return { callId: `c_${Math.random()}`, runId: 'r1', taskId: 't1', toolName, input };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pi-ide-gw-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/app.ts'), 'const token = 1;\nexport default token;\n');
  writeFileSync(join(root, 'README.md'), 'hello gateway\n');
  audits.length = 0;
  const documents = new DocumentStore(root, {});
  gateway = new ToolGateway({
    root,
    mode: 'ask',
    audit: (record) => audits.push({ name: record.name, state: record.state }),
  });
  registerReadOnlyTools(gateway, {
    root,
    documents,
    search: () => new SearchService(root, []),
    git: () => null,
  });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('ToolGateway core (TOOL-001..007)', () => {
  it('lists a versioned catalog with JSON schemas', () => {
    const catalog = gateway.catalog('ask');
    const names = catalog.map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('list_directory');
    expect(names).toContain('search_text');
    const readFile = catalog.find((t) => t.name === 'read_file')!;
    expect(readFile.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(readFile.inputJsonSchema).toBeTruthy();
  });

  it('reserves the auto-allow capability lane for terminal tools', async () => {
    const { z } = await import('zod');
    expect(() =>
      gateway.register({
        name: 'fake_write',
        version: 1,
        description: 'pretend write',
        permissionPolicy: 'auto-allow',
        risk: () => ({ level: 'R1', reasons: ['writes'] }),
        inputSchema: z.object({}).strict(),
        preview: async () => ({ summary: 'write' }),
        execute: async () => ({ code: 'OK', summary: 'wrote', data: {} }),
      }),
    ).toThrow(/reserved for terminal\.\*/i);
  });

  it('rejects unknown tools with a structured result, not a crash', async () => {
    const result = await gateway.executeCall(
      call('run_anything', {}),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('TOOL_UNKNOWN');
  });

  it('rejects schema violations including unknown fields (TOOL-004)', async () => {
    const bad = await gateway.executeCall(
      call('read_file', { path: 'README.md', sneaky: true }),
      new AbortController().signal,
    );
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('TOOL_INVALID_INPUT');
  });

  it('reads files through the document store with revision info', async () => {
    const result = await gateway.executeCall(
      call('read_file', { path: 'README.md' }),
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    const data = result.data as { content: string; hash: string; fromBuffer: boolean };
    expect(data.content).toBe('hello gateway\n');
    expect(data.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('blocks path escapes with a stable error code (E2E-021 core)', async () => {
    const result = await gateway.executeCall(
      call('read_file', { path: '../../etc/passwd' }),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('WS_PATH_ESCAPE');
  });

  it('truncates oversized outputs (TOOL-007)', async () => {
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(2 * 1024 * 1024));
    const result = await gateway.executeCall(
      call('read_file', { path: 'big.txt' }),
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    const data = result.data as { content: string; truncated: boolean };
    expect(data.truncated).toBe(true);
    expect(data.content.length).toBeLessThanOrEqual(1024 * 1024);
  });

  it('audits every call lifecycle', async () => {
    await gateway.executeCall(call('list_directory', { path: '' }), new AbortController().signal);
    expect(audits.some((a) => a.name === 'list_directory' && a.state === 'SUCCEEDED')).toBe(true);
  });

  it('in ask mode, any non-R0 tool is denied even if registered (AG-001/E2E-009)', async () => {
    gateway.register({
      name: 'fake_write',
      version: 1,
      description: 'pretend write',
      risk: () => ({ level: 'R1', reasons: ['writes'] }),
      inputSchema: (await import('zod')).z.object({}).strict(),
      preview: async () => ({ summary: 'write' }),
      execute: async () => ({ code: 'OK', summary: 'wrote', data: {} }),
    });
    const result = await gateway.executeCall(call('fake_write', {}), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('PERMISSION_DENIED');
    expect(audits.some((a) => a.name === 'fake_write' && a.state === 'DENIED')).toBe(true);
  });

  it('cancellation yields CANCELLED (TOOL-009)', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await gateway.executeCall(
      call('read_file', { path: 'README.md' }),
      controller.signal,
    );
    expect(result.code).toBe('CANCELLED');
    expect(result.ok).toBe(false);
  });
});

describe('per-task mode resolution (ADR-0006 parallel runs)', () => {
  it('resolves ask/auto per taskId on one shared gateway', async () => {
    const { z } = await import('zod');
    const modes: Record<string, 'ask' | 'edit' | 'auto'> = {
      'task-ask': 'ask',
      'task-auto': 'auto',
    };
    const shared = new ToolGateway({
      root,
      mode: 'ask',
      modeForTask: (taskId) => modes[taskId] ?? 'ask',
      // Auto-allow so the auto-mode call reaches execution.
      permission: { decide: async () => ({ kind: 'allow', scope: 'auto' }) },
    });
    shared.register({
      name: 'fake_write',
      version: 1,
      description: 'pretend write',
      risk: () => ({ level: 'R1', reasons: ['writes'] }),
      inputSchema: z.object({}).strict(),
      preview: async () => ({ summary: 'write' }),
      execute: async () => ({ code: 'OK', summary: 'wrote', data: {} }),
    });

    const denied = await shared.executeCall(
      { callId: 'c1', runId: 'r1', taskId: 'task-ask', toolName: 'fake_write', input: {} },
      new AbortController().signal,
    );
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe('PERMISSION_DENIED');

    const allowed = await shared.executeCall(
      { callId: 'c2', runId: 'r2', taskId: 'task-auto', toolName: 'fake_write', input: {} },
      new AbortController().signal,
    );
    expect(allowed.ok).toBe(true);

    // Unknown tasks fall back to the gateway-wide mode (ask ⇒ read-only).
    const unknown = await shared.executeCall(
      { callId: 'c3', runId: 'r3', taskId: 'task-mystery', toolName: 'fake_write', input: {} },
      new AbortController().signal,
    );
    expect(unknown.ok).toBe(false);
  });
});
