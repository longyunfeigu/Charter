import type {
  ChannelName,
  ChannelRequest,
  ChannelResponse,
  EventChannelName,
  EventPayload,
  IpcResponse,
} from '@pi-ide/ipc-contracts';
import { errorMessage, productError, ProductFailure, type ProductError } from '@pi-ide/foundation';

interface ProductBridgeShape {
  protocolVersion: number;
  platform: string;
  rpc: Record<string, (payload: unknown, workspaceId?: string) => Promise<IpcResponse>>;
  events: { on(channel: string, listener: (payload: unknown) => void): () => void };
  pathForFile?: (file: File) => string;
}

declare global {
  interface Window {
    product: ProductBridgeShape;
  }
}

function restartRequiredError(channel: string, technicalMessage: string): ProductError {
  return productError('APP_RESTART_REQUIRED', {
    userMessage: 'Charter updated while running. Restart Charter to use this action.',
    severity: 'warning',
    technicalMessage,
    context: { channel },
  });
}

/** Electron rejects before the IPC router when a hot renderer calls an older Main process. */
export function isMissingIpcHandlerError(value: unknown): boolean {
  return /No handler registered for ['"]rpc:[^'"]+['"]/i.test(errorMessage(value));
}

/** Typed access to the preload bridge. Throws ProductFailure on structured errors. */
export async function rpc<N extends ChannelName>(
  channel: N,
  payload: ChannelRequest<N>,
  workspaceId?: string,
): Promise<ChannelResponse<N>> {
  if (!window.product?.rpc) {
    throw new ProductFailure(
      productError('IPC_BRIDGE_MISSING', {
        userMessage: 'The application bridge is unavailable. Please restart the app.',
        severity: 'fatal',
      }),
    );
  }
  const fn = window.product.rpc[channel];
  if (!fn) {
    throw new ProductFailure(
      restartRequiredError(channel, `The preload bridge does not expose rpc:${channel}.`),
    );
  }
  const response = await fn(payload, workspaceId);
  if (!response.ok) {
    throw new ProductFailure(response.error as ProductError);
  }
  return response.data as ChannelResponse<N>;
}

/** Non-throwing variant for flows that render errors inline. */
export async function rpcResult<N extends ChannelName>(
  channel: N,
  payload: ChannelRequest<N>,
  workspaceId?: string,
): Promise<{ ok: true; data: ChannelResponse<N> } | { ok: false; error: ProductError }> {
  try {
    const data = await rpc(channel, payload, workspaceId);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ProductFailure) return { ok: false, error: e.error };
    if (isMissingIpcHandlerError(e)) {
      return { ok: false, error: restartRequiredError(channel, errorMessage(e)) };
    }
    return {
      ok: false,
      error: productError('APP_UNEXPECTED', {
        userMessage: 'An unexpected error occurred.',
        technicalMessage: errorMessage(e),
      }),
    };
  }
}

export function onEvent<N extends EventChannelName>(
  channel: N,
  listener: (payload: EventPayload<N>) => void,
): () => void {
  return window.product.events.on(channel, listener as (payload: unknown) => void);
}

export function platform(): string {
  return window.product?.platform ?? 'unknown';
}

/** Absolute path of an OS-dropped File (sandbox-safe, PIVOT-015); null when unavailable. */
export function pathForDroppedFile(file: File): string | null {
  try {
    return window.product?.pathForFile?.(file) ?? null;
  } catch {
    return null;
  }
}
