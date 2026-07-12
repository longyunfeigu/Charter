import type { ProductError } from './errors.js';

export type Result<T> = { ok: true; value: T } | { ok: false; error: ProductError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(error: ProductError): Result<T> {
  return { ok: false, error };
}
