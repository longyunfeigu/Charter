import type { ProductError } from '@pi-ide/foundation';
import type {
  AbortReason,
  AgentEvent,
  CreateSessionInput,
  ModelRef,
  RuntimeSessionRef,
  StartRunInput,
  ToolCallRequest,
  ToolResultPayload,
} from './index.js';

/** Credentials passed main→worker at init; never persisted by the worker. */
export interface WorkerCredential {
  providerId: string;
  kind: 'api-key';
  value: string;
  /** Effective API endpoint (gateways/proxies resolved by main); null = provider default. */
  baseUrl?: string | null;
  /** Wire protocol for non-builtin providers (openrouter/litellm/custom gateways). */
  api?: 'anthropic' | 'openai' | null;
}

export type WorkerInbound =
  | {
      type: 'init';
      reqId: string;
      runtimeKind: 'pi' | 'mock';
      runtimeDataDir: string;
      appVersion: string;
      credentials: WorkerCredential[];
    }
  | { type: 'createSession'; reqId: string; input: CreateSessionInput }
  | { type: 'resumeSession'; reqId: string; ref: RuntimeSessionRef }
  | { type: 'startRun'; taskId: string; input: StartRunInput }
  | { type: 'steer'; runId: string; text: string }
  | { type: 'followUp'; runId: string; text: string }
  /** ADR-0016: request/response — the caller must learn if the switch failed. */
  | { type: 'setSessionModel'; reqId: string; sessionId: string; model: ModelRef }
  | { type: 'abort'; runId: string; reason: AbortReason }
  | { type: 'listModels'; reqId: string }
  | { type: 'validateCredential'; reqId: string; providerId: string }
  | { type: 'toolResult'; callId: string; result: ToolResultPayload }
  | { type: 'shutdown' };

export type WorkerOutbound =
  | { type: 'ready'; pid: number; node: string }
  | { type: 'response'; reqId: string; ok: boolean; data?: unknown; error?: ProductError }
  | { type: 'event'; taskId: string; runId: string; event: AgentEvent }
  | { type: 'runEnded'; taskId: string; runId: string }
  | { type: 'toolRequest'; taskId: string; call: ToolCallRequest }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };
