import { ipcMain } from 'electron';
import {
  CHANNELS,
  IpcRequestSchema,
  type ChannelName,
  type ChannelRequest,
  type ChannelResponse,
  type IpcResponse,
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
