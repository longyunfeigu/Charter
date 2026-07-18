export type ErrorSeverity = 'info' | 'warning' | 'error' | 'fatal';

/**
 * Stable, serializable product error. Every user-visible failure in the product
 * must be representable as one of these (code + user message + technical context).
 */
export interface ProductError {
  code: string;
  severity: ErrorSeverity;
  userMessage: string;
  technicalMessage?: string;
  context?: Record<string, unknown>;
  retryable: boolean;
}

export interface ProductErrorOptions {
  userMessage: string;
  severity?: ErrorSeverity;
  technicalMessage?: string;
  context?: Record<string, unknown>;
  retryable?: boolean;
}

export function productError(code: string, opts: ProductErrorOptions): ProductError {
  return {
    code,
    severity: opts.severity ?? 'error',
    userMessage: opts.userMessage,
    ...(opts.technicalMessage !== undefined ? { technicalMessage: opts.technicalMessage } : {}),
    ...(opts.context !== undefined ? { context: opts.context } : {}),
    retryable: opts.retryable ?? false,
  };
}

export function isProductError(value: unknown): value is ProductError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.code === 'string' &&
    typeof v.userMessage === 'string' &&
    typeof v.retryable === 'boolean' &&
    (v.severity === 'info' ||
      v.severity === 'warning' ||
      v.severity === 'error' ||
      v.severity === 'fatal')
  );
}

/** Error class used to throw a ProductError through exception boundaries. */
export class ProductFailure extends Error {
  readonly error: ProductError;
  constructor(error: ProductError) {
    super(error.userMessage);
    this.name = 'ProductFailure';
    this.error = error;
  }
}

/** Plain message of any thrown value — the repo-wide catch-block idiom. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Convert any thrown value into a ProductError, preserving structure when present. */
export function toProductError(value: unknown, fallbackCode: string): ProductError {
  if (value instanceof ProductFailure) return value.error;
  if (isProductError(value)) return value;
  if (value instanceof Error) {
    return productError(fallbackCode, {
      userMessage: 'An unexpected error occurred.',
      technicalMessage: `${value.name}: ${value.message}`,
      context: value.stack ? { stack: value.stack.split('\n').slice(0, 8).join('\n') } : undefined,
    });
  }
  return productError(fallbackCode, {
    userMessage: 'An unexpected error occurred.',
    technicalMessage: String(value),
  });
}
