import { describe, expect, it } from 'vitest';
import { IpcRequestSchema, IpcResponseSchema, PROTOCOL_VERSION } from './envelope.js';

describe('IPC envelope', () => {
  it('accepts a valid request envelope', () => {
    const parsed = IpcRequestSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'req_123',
      workspaceId: 'ws_1',
      payload: { anything: true },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects wrong protocol versions and missing requestId', () => {
    expect(
      IpcRequestSchema.safeParse({ protocolVersion: 99, requestId: 'r', payload: {} }).success,
    ).toBe(false);
    expect(
      IpcRequestSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, payload: {} }).success,
    ).toBe(false);
  });

  it('response carries either data or a structured error, never both required', () => {
    expect(IpcResponseSchema.safeParse({ requestId: 'r1', ok: true, data: { x: 1 } }).success).toBe(
      true,
    );
    const err = IpcResponseSchema.safeParse({
      requestId: 'r1',
      ok: false,
      error: {
        code: 'IPC_SCHEMA_VIOLATION',
        severity: 'error',
        userMessage: 'Invalid request.',
        retryable: false,
      },
    });
    expect(err.success).toBe(true);
    expect(IpcResponseSchema.safeParse({ requestId: 'r1', ok: false }).success).toBe(false);
  });
});
