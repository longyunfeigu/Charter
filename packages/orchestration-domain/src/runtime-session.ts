export const RUNTIME_SESSION_STATES = [
  'STARTING',
  'READY',
  'RUNNING',
  'WAITING',
  'PAUSED',
  'ENDED',
  'FAILED',
  'DISCONNECTED',
] as const;

export type RuntimeSessionState = (typeof RUNTIME_SESSION_STATES)[number];
export type RuntimeTransport = 'native' | 'acp' | 'terminal';

export interface OrchestrationRuntimeSession {
  id: string;
  attemptId: string;
  provider: string;
  transport: RuntimeTransport;
  externalSessionId: string | null;
  processKey: string | null;
  state: RuntimeSessionState;
  cwd: string;
  capabilities: Record<string, unknown>;
  lastEventAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestrationRuntimeEvent {
  id: string;
  runtimeSessionId: string;
  attemptId: string;
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type MessageDeliveryState = 'pending' | 'delivered' | 'observed' | 'failed';

export interface OrchestrationMessageDelivery {
  messageId: string;
  assignmentId: string;
  state: MessageDeliveryState;
  attempts: number;
  lastError: string | null;
  deliveredAt: string | null;
  observedAt: string | null;
  updatedAt: string;
}
