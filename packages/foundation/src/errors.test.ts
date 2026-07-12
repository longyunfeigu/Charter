import { describe, expect, it } from 'vitest';
import { isProductError, productError, ProductFailure, toProductError } from './errors.js';

describe('ProductError model', () => {
  it('creates a structured error with stable code and user message', () => {
    const err = productError('WS_NOT_FOUND', {
      userMessage: 'The folder no longer exists.',
      context: { path: '/tmp/x' },
    });
    expect(err.code).toBe('WS_NOT_FOUND');
    expect(err.userMessage).toBe('The folder no longer exists.');
    expect(err.severity).toBe('error');
    expect(err.retryable).toBe(false);
    expect(err.context).toEqual({ path: '/tmp/x' });
  });

  it('recognizes ProductError shapes', () => {
    const err = productError('DB_MIGRATION_FAILED', { userMessage: 'x', severity: 'fatal' });
    expect(isProductError(err)).toBe(true);
    expect(isProductError({ code: 'X' })).toBe(false);
    expect(isProductError(null)).toBe(false);
  });

  it('converts unknown thrown values into ProductError without losing message', () => {
    const err = toProductError(new Error('boom'), 'APP_UNEXPECTED');
    expect(err.code).toBe('APP_UNEXPECTED');
    expect(err.technicalMessage).toContain('boom');
    expect(isProductError(err)).toBe(true);
  });

  it('ProductFailure carries the structured error through throw/catch', () => {
    try {
      throw new ProductFailure(productError('TOOL_PATH_ESCAPE', { userMessage: 'blocked' }));
    } catch (e) {
      const err = toProductError(e, 'APP_UNEXPECTED');
      expect(err.code).toBe('TOOL_PATH_ESCAPE');
      expect(err.userMessage).toBe('blocked');
    }
  });
});
