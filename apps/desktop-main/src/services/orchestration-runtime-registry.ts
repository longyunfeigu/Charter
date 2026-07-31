import type {
  Assignment,
  ExecutionAttempt,
  Mission,
  MissionTask,
  RuntimeKind,
} from '@pi-ide/orchestration-domain';

export type OrchestrationRuntimeAdapterKind =
  'visible-terminal' | 'external-cli' | 'managed-agent' | 'shell';

export interface RuntimeSessionBinding {
  runtimeSessionId: string;
  terminalId?: string | null;
  leaseExpiresAt?: string | null;
  transport?: 'native' | 'acp' | 'terminal';
  provider?: string;
  externalSessionId?: string | null;
  processKey?: string | null;
  capabilities?: Record<string, unknown>;
  artifacts?: Array<{
    kind: string;
    label: string;
    reference: Record<string, unknown>;
  }>;
}

export interface RuntimeStartRequest {
  idempotencyKey: string;
  mission: Mission;
  task: MissionTask;
  assignment: Assignment;
  attempt: ExecutionAttempt;
  workspaceRoot: string;
}

export interface RuntimeObservation {
  state: 'starting' | 'running' | 'waiting' | 'ended' | 'missing' | 'unknown';
  detail?: string;
}

export interface RuntimeReconciliation {
  state: 'alive' | 'missing' | 'unknown';
  binding?: RuntimeSessionBinding;
  detail?: string;
}

export interface OrchestrationRuntimeAdapter {
  readonly kind: OrchestrationRuntimeAdapterKind;
  start(input: RuntimeStartRequest, signal: AbortSignal): Promise<RuntimeSessionBinding>;
  activate?(runtimeSessionId: string): Promise<void>;
  deliver?(runtimeSessionId: string, message: string, signal: AbortSignal): Promise<void>;
  steer?(runtimeSessionId: string, text: string, signal: AbortSignal): Promise<void>;
  pause?(runtimeSessionId: string): Promise<void>;
  resume?(runtimeSessionId: string): Promise<void>;
  cancel(runtimeSessionId: string, reason: string): Promise<void>;
  inspect?(runtimeSessionId: string): Promise<RuntimeObservation>;
  reconcile?(runtimeSessionId: string): Promise<RuntimeReconciliation>;
}

export function adapterKindForRuntime(kind: RuntimeKind): OrchestrationRuntimeAdapterKind {
  if (kind === 'managed') return 'managed-agent';
  if (kind === 'shell') return 'shell';
  return 'visible-terminal';
}

export class OrchestrationRuntimeRegistry {
  private readonly adapters = new Map<
    OrchestrationRuntimeAdapterKind,
    OrchestrationRuntimeAdapter
  >();
  private readonly runtimeAdapters = new Map<RuntimeKind, OrchestrationRuntimeAdapter>();

  register(adapter: OrchestrationRuntimeAdapter): () => void {
    this.adapters.set(adapter.kind, adapter);
    return () => {
      if (this.adapters.get(adapter.kind) === adapter) this.adapters.delete(adapter.kind);
    };
  }

  registerForRuntime(kind: RuntimeKind, adapter: OrchestrationRuntimeAdapter): () => void {
    this.runtimeAdapters.set(kind, adapter);
    return () => {
      if (this.runtimeAdapters.get(kind) === adapter) this.runtimeAdapters.delete(kind);
    };
  }

  get(kind: OrchestrationRuntimeAdapterKind): OrchestrationRuntimeAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`No orchestration runtime adapter is registered for ${kind}.`);
    return adapter;
  }

  forRuntime(kind: RuntimeKind): OrchestrationRuntimeAdapter {
    const override = this.runtimeAdapters.get(kind);
    if (override) return override;
    return this.get(adapterKindForRuntime(kind));
  }

  has(kind: OrchestrationRuntimeAdapterKind): boolean {
    return this.adapters.has(kind);
  }
}

/** Deterministic adapter used by control-plane tests and the mock runtime. */
export class MockOrchestrationRuntimeAdapter implements OrchestrationRuntimeAdapter {
  readonly kind: OrchestrationRuntimeAdapterKind;
  readonly starts: RuntimeStartRequest[] = [];
  readonly cancelled: Array<{ runtimeSessionId: string; reason: string }> = [];
  readonly steered: Array<{ runtimeSessionId: string; text: string }> = [];
  readonly delivered: Array<{ runtimeSessionId: string; text: string }> = [];
  readonly paused: string[] = [];
  readonly resumed: string[] = [];
  private readonly bindings = new Map<string, RuntimeSessionBinding>();

  constructor(kind: OrchestrationRuntimeAdapterKind = 'managed-agent') {
    this.kind = kind;
  }

  async start(input: RuntimeStartRequest): Promise<RuntimeSessionBinding> {
    const existing = this.bindings.get(input.idempotencyKey);
    if (existing) return existing;
    this.starts.push(input);
    const binding = { runtimeSessionId: `mock:${input.attempt.id}` };
    this.bindings.set(input.idempotencyKey, binding);
    return binding;
  }

  async cancel(runtimeSessionId: string, reason: string): Promise<void> {
    this.cancelled.push({ runtimeSessionId, reason });
  }

  async steer(runtimeSessionId: string, text: string): Promise<void> {
    this.steered.push({ runtimeSessionId, text });
  }

  async deliver(runtimeSessionId: string, text: string): Promise<void> {
    this.delivered.push({ runtimeSessionId, text });
  }

  async pause(runtimeSessionId: string): Promise<void> {
    this.paused.push(runtimeSessionId);
  }

  async resume(runtimeSessionId: string): Promise<void> {
    this.resumed.push(runtimeSessionId);
  }

  async reconcile(runtimeSessionId: string): Promise<RuntimeReconciliation> {
    const alive = [...this.bindings.values()].some(
      (binding) => binding.runtimeSessionId === runtimeSessionId,
    );
    return { state: alive ? 'alive' : 'missing' };
  }
}
