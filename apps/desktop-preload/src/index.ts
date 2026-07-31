import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  CHANNELS,
  EVENT_CHANNELS,
  PROTOCOL_VERSION,
  SEND_CHANNELS,
  type ChannelName,
  type EventChannelName,
  type IpcResponse,
  type SendChannelName,
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

type SendFunctions = Record<string, (payload: unknown, workspaceId?: string) => void>;

const send: SendFunctions = {};
for (const name of Object.keys(SEND_CHANNELS) as SendChannelName[]) {
  send[name] = (payload: unknown, workspaceId?: string) => {
    ipcRenderer.send(`send:${name}`, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: nextRequestId(),
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      payload,
    });
  };
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
  send,
  events,
  /**
   * Absolute path of a File dropped from the OS (PIVOT-015). Sandboxed
   * renderers have no File.path; this is the documented Electron bridge for it.
   */
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },
};

contextBridge.exposeInMainWorld('product', api);

export type ProductBridge = typeof api;
