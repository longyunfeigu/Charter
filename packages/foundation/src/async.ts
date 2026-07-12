import { productError, ProductFailure } from './errors.js';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Resolves after ms, or earlier (resolved, not rejected) when the signal aborts. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export function isAbortError(e: unknown): boolean {
  return (
    (e instanceof Error && e.name === 'AbortError') ||
    (e instanceof ProductFailure && e.error.code === 'APP_ABORTED')
  );
}

export function abortFailure(message = 'The operation was cancelled.'): ProductFailure {
  return new ProductFailure(
    productError('APP_ABORTED', { userMessage: message, severity: 'info' }),
  );
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  code = 'APP_TIMEOUT',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ProductFailure(
                productError(code, {
                  userMessage: `The operation timed out after ${ms} ms.`,
                  retryable: true,
                }),
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
