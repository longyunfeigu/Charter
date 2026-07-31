import { ipcMain } from 'electron';
import {
  CHANNELS,
  IpcRequestSchema,
  SEND_CHANNELS,
  type ChannelName,
  type ChannelRequest,
  type ChannelResponse,
  type IpcResponse,
  type SendChannelName,
  type SendPayload,
} from '@pi-ide/ipc-contracts';
import { productError, toProductError, ProductFailure, type Logger } from '@pi-ide/foundation';

export interface HandlerMeta {
  requestId: string;
  workspaceId: string | undefined;
  senderId: number;
}

export type ChannelHandler<N extends ChannelName> = (
  payload: ChannelRequest<N>,
  meta: HandlerMeta,
) => Promise<ChannelResponse<N>>;

export type HandlerMap = { [N in ChannelName]?: ChannelHandler<N> };

const registered = new Set<string>();
const registeredSends = new Set<string>();

export type SendHandler<N extends SendChannelName> = (
  payload: SendPayload<N>,
  meta: HandlerMeta,
) => void | Promise<void>;

export type SendHandlerMap = { [N in SendChannelName]?: SendHandler<N> };

/**
 * Registers one ipcMain handler per fixed channel (spec §9.3). The OS-level channel
 * namespace is exactly the enum in ipc-contracts; payloads are validated with the
 * channel's request schema before any handler code runs.
 */
export function registerHandlers(handlers: HandlerMap, logger: Logger): void {
  for (const name of Object.keys(handlers) as ChannelName[]) {
    const handler = handlers[name];
    if (!handler || registered.has(name)) continue;
    registered.add(name);
    const def = CHANNELS[name];
    ipcMain.handle(`rpc:${name}`, async (event, raw): Promise<IpcResponse> => {
      const envelope = IpcRequestSchema.safeParse(raw);
      if (!envelope.success) {
        logger.warn('ipc envelope rejected', { channel: name });
        return {
          requestId:
            typeof (raw as { requestId?: unknown })?.requestId === 'string'
              ? (raw as { requestId: string }).requestId
              : 'invalid',
          ok: false,
          error: productError('IPC_SCHEMA_VIOLATION', {
            userMessage: 'The application sent an invalid internal request.',
            technicalMessage: envelope.error.message.slice(0, 500),
          }),
        };
      }
      const { requestId, workspaceId, payload } = envelope.data;
      const parsed = def.request.safeParse(payload);
      if (!parsed.success) {
        logger.warn('ipc payload rejected', { channel: name });
        return {
          requestId,
          ok: false,
          error: productError('IPC_SCHEMA_VIOLATION', {
            userMessage: 'The application sent an invalid internal request.',
            technicalMessage: parsed.error.message.slice(0, 1000),
            context: { channel: name },
          }),
        };
      }
      try {
        const data = await (handler as ChannelHandler<ChannelName>)(parsed.data as never, {
          requestId,
          workspaceId,
          senderId: event.sender.id,
        });
        const validated = def.response.safeParse(data);
        if (!validated.success) {
          logger.error('ipc response schema violation', { channel: name });
          return {
            requestId,
            ok: false,
            error: productError('IPC_RESPONSE_INVALID', {
              userMessage: 'Internal response validation failed.',
              context: { channel: name },
            }),
          };
        }
        return { requestId, ok: true, data: validated.data };
      } catch (e) {
        const err = e instanceof ProductFailure ? e.error : toProductError(e, 'APP_UNEXPECTED');
        if (err.severity === 'fatal' || err.code === 'APP_UNEXPECTED') {
          logger.error(`ipc handler failed: ${name}`, {
            code: err.code,
            tech: err.technicalMessage,
          });
        }
        return { requestId, ok: false, error: err };
      }
    });
  }
}

/**
 * Registers validated one-way notifications for latency-sensitive traffic.
 * Failures are diagnostic only because the renderer intentionally has no
 * response promise on this path.
 */
export function registerSendHandlers(handlers: SendHandlerMap, logger: Logger): void {
  for (const name of Object.keys(handlers) as SendChannelName[]) {
    const handler = handlers[name];
    if (!handler || registeredSends.has(name)) continue;
    registeredSends.add(name);
    const def = SEND_CHANNELS[name];
    ipcMain.on(`send:${name}`, (event, raw) => {
      const envelope = IpcRequestSchema.safeParse(raw);
      if (!envelope.success) {
        logger.warn('ipc send envelope rejected', { channel: name });
        return;
      }
      const { requestId, workspaceId, payload } = envelope.data;
      const parsed = def.payload.safeParse(payload);
      if (!parsed.success) {
        logger.warn('ipc send payload rejected', {
          channel: name,
          detail: parsed.error.message.slice(0, 1000),
        });
        return;
      }
      try {
        const work = (handler as SendHandler<SendChannelName>)(parsed.data as never, {
          requestId,
          workspaceId,
          senderId: event.sender.id,
        });
        void Promise.resolve(work).catch((error) => {
          const failure = toProductError(error, 'APP_UNEXPECTED');
          logger.error(`ipc send handler failed: ${name}`, {
            code: failure.code,
            tech: failure.technicalMessage,
          });
        });
      } catch (error) {
        const failure = toProductError(error, 'APP_UNEXPECTED');
        logger.error(`ipc send handler failed: ${name}`, {
          code: failure.code,
          tech: failure.technicalMessage,
        });
      }
    });
  }
}
