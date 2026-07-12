import type { ProductError } from '@pi-ide/foundation';

/** Product-owned Agent Runtime contract (spec §8.2). UI and domain code depend on
 * these types only; Pi types never cross this boundary. */

export type AgentMode = 'ask' | 'edit' | 'auto';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'max';
export type AbortReason = 'user_stop' | 'app_quit' | 'timeout' | 'superseded' | 'error';

export interface ModelRef {
  providerId: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
}

export interface ModelDescriptor {
  providerId: string;
  providerName: string;
  modelId: string;
  displayName: string;
  contextWindow: number | null;
  supportsThinking: boolean;
  /** Whether usable credentials exist for the provider. Never includes the credential itself. */
  configured: boolean;
  authKind: 'api-key' | 'oauth' | 'none' | 'unknown';
}

export interface CredentialCheck {
  providerId: string;
  ok: boolean;
  checkedAt: string;
  errorKind?: 'invalid-credential' | 'network' | 'quota' | 'model-missing' | 'provider-error';
  error?: ProductError;
}

export interface RuntimeInit {
  runtimeDataDir: string;
  appVersion: string;
}

export interface RuntimeInfo {
  runtimeId: 'pi' | 'mock';
  runtimeVersion: string;
}

/** Tool surface offered to the runtime for one session. Execution always happens host-side. */
export interface ToolCatalogEntry {
  name: string;
  description: string;
  schemaVersion: number;
  inputJsonSchema?: unknown;
  promptGuidance?: string;
}

export interface ToolCallRequest {
  callId: string;
  runId: string;
  taskId: string;
  toolName: string;
  input: unknown;
}

export interface ToolResultAttachmentRef {
  id: string;
  kind: string;
  sizeBytes: number;
}

export interface ToolResultPayload {
  callId: string;
  ok: boolean;
  /** Stable machine code, e.g. OK / PERMISSION_DENIED / VERSION_CONFLICT / PATH_ESCAPE / CANCELLED. */
  code: string;
  summary: string;
  data: unknown;
  attachments?: ToolResultAttachmentRef[];
  retryable?: boolean;
}

export type ToolExecutor = (
  call: ToolCallRequest,
  signal: AbortSignal,
) => Promise<ToolResultPayload>;

export interface RuntimeSessionRef {
  sessionId: string;
  runtimeId: string;
  externalSessionId?: string | null;
  externalSessionFile?: string | null;
}

export interface CreateSessionInput {
  taskId: string;
  workspaceRoot: string;
  mode: AgentMode;
  model: ModelRef;
  tools: ToolCatalogEntry[];
  systemPreamble: string;
  resumeRef?: RuntimeSessionRef | null;
  /** Mock-runtime only: force a deterministic scenario. */
  scenario?: string;
}

export interface ContextAttachment {
  kind: 'open_file' | 'selection' | 'diagnostics' | 'git_status' | 'recovery_summary';
  summary: string;
  content?: string;
}

export interface StartRunInput {
  sessionRef: RuntimeSessionRef;
  runId: string;
  prompt: string;
  contextAttachments?: ContextAttachment[];
}

export interface VisibleMessage {
  messageId: string;
  role: 'assistant' | 'user' | 'system';
  text: string;
  at: string;
}

export interface PlanStep {
  id: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped' | 'blocked';
  expectedFiles?: string[];
  verification?: string;
}

export interface TaskPlan {
  version: number;
  summary: string;
  steps: PlanStep[];
}

export interface ModelUsage {
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}

export interface CompactionMetadata {
  reason: string;
  beforeTokens: number | null;
  afterTokens: number | null;
}

export interface ToolCallProposal {
  callId: string;
  toolName: string;
  input: unknown;
  reason?: string;
}

export const AGENT_EVENT_SCHEMA_VERSION = 1 as const;

interface AgentEventBase {
  sequence: number;
  at: string;
  runId: string;
  schemaVersion: typeof AGENT_EVENT_SCHEMA_VERSION;
}

export type AgentEvent =
  | (AgentEventBase & { type: 'run.started' })
  | (AgentEventBase & { type: 'message.delta'; messageId: string; text: string })
  | (AgentEventBase & { type: 'message.completed'; message: VisibleMessage })
  | (AgentEventBase & { type: 'plan.proposed'; plan: TaskPlan })
  | (AgentEventBase & { type: 'plan.updated'; plan: TaskPlan })
  | (AgentEventBase & { type: 'tool.proposed'; call: ToolCallProposal })
  | (AgentEventBase & { type: 'tool.started'; callId: string })
  | (AgentEventBase & { type: 'tool.progress'; callId: string; summary: string })
  | (AgentEventBase & { type: 'tool.completed'; callId: string; result: ToolResultPayload })
  | (AgentEventBase & { type: 'usage.updated'; usage: ModelUsage })
  | (AgentEventBase & { type: 'context.compacted'; metadata: CompactionMetadata })
  | (AgentEventBase & { type: 'runtime.diagnostic'; code: string; detail: string })
  | (AgentEventBase & { type: 'run.completed'; stopReason: string })
  | (AgentEventBase & { type: 'run.failed'; error: ProductError })
  | (AgentEventBase & { type: 'run.aborted'; reason: string });

export interface AgentRuntime {
  initialize(input: RuntimeInit): Promise<RuntimeInfo>;
  createSession(input: CreateSessionInput): Promise<RuntimeSessionRef>;
  resumeSession(ref: RuntimeSessionRef): Promise<RuntimeSessionRef>;
  startRun(input: StartRunInput): AsyncIterable<AgentEvent>;
  steer(runId: string, text: string): Promise<void>;
  followUp(runId: string, text: string): Promise<void>;
  abort(runId: string, reason: AbortReason): Promise<void>;
  listModels(): Promise<ModelDescriptor[]>;
  validateCredential(providerId: string): Promise<CredentialCheck>;
  dispose(): Promise<void>;
}
