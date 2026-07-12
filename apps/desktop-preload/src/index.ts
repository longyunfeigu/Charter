import { contextBridge, ipcRenderer } from 'electron';
import {
  CHANNELS,
  EVENT_CHANNELS,
  PROTOCOL_VERSION,
  type ChannelName,
  type EventChannelName,
  type IpcResponse,
} from '@pi-ide/ipc-contracts';

/**
 * Whitelisted, versioned bridge (spec §9.2/§9.3). One concrete function per fixed
 * channel is created here at load time — there is no generic passthrough surface.
 */

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req_${Date.now().toString(36)}_${requestCounter}`;
}

type RpcFunctions = Record<
  string,
  (payload: unknown, workspaceId?: string) => Promise<IpcResponse>
>;

const rpc: RpcFunctions = {};
for (const name of Object.keys(CHANNELS) as ChannelName[]) {
  rpc[name] = (payload: unknown, workspaceId?: string) =>
    ipcRenderer.invoke(`rpc:${name}`, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: nextRequestId(),
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      payload,
    }) as Promise<IpcResponse>;
}

const events = {
  on(channel: string, listener: (payload: unknown) => void): () => void {
    if (!Object.prototype.hasOwnProperty.call(EVENT_CHANNELS, channel)) {
      throw new Error(`Unknown event channel: ${channel}`);
    }
    const wrapped = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(`evt:${channel as EventChannelName}`, wrapped);
    return () => ipcRenderer.removeListener(`evt:${channel}`, wrapped);
  },
};

const api = {
  protocolVersion: PROTOCOL_VERSION,
  platform: process.platform,
  rpc,
  events,
};

contextBridge.exposeInMainWorld('product', api);

export type ProductBridge = typeof api;
