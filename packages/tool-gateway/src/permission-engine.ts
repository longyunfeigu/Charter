import { createHash } from 'node:crypto';
import { newId, redactObject } from '@pi-ide/foundation';
import type {
  PermissionDecider,
  PermissionDecision,
  RiskAssessment,
  RiskLevel,
  ToolPreview,
} from './gateway.js';

export type PermissionRequestState = 'PENDING' | 'ALLOWED' | 'DENIED' | 'CANCELLED' | 'INVALIDATED';

export interface StandingRule {
  id: string;
  workspaceId: string;
  /** null = workspace scope; set = grant limited to that task. */
  taskId: string | null;
  kind: 'allow' | 'deny';
  ruleKey: string;
  risk: RiskLevel;
  createdAt: string;
}

export interface StoredPermissionRequest {
  id: string;
  toolCallId: string;
  taskId: string;
  state: PermissionRequestState;
  risk: RiskLevel;
  previewJson: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface StoredPermissionDecision {
  id: string;
  requestId: string;
  workspaceId: string;
  taskId: string;
  decision: 'allow' | 'deny';
  scope: 'once' | 'task' | 'workspace' | 'always';
  actor: string;
  reason: string | null;
  createdAt: string;
}

export interface PermissionStore {
  saveRequest(request: StoredPermissionRequest): void;
  resolveRequest(requestId: string, state: PermissionRequestState, resolvedAt: string): void;
  saveDecision(decision: StoredPermissionDecision): void;
  listRules(workspaceId: string): StandingRule[];
  saveRule(rule: StandingRule): void;
}

export interface PermissionRequestCard {
  requestId: string;
  callId: string;
  runId: string;
  taskId: string;
  workspaceId: string;
  tool: { name: string; version: number; description: string };
  risk: RiskAssessment;
  preview: ToolPreview;
  /** Redacted tool input for display (PERM-004/010). */
  input: unknown;
  paramsHash: string;
  ruleKey: string;
  options: {
    allowScopes: Array<'once' | 'task' | 'workspace'>;
    denyScopes: Array<'once' | 'always'>;
  };
  createdAt: string;
}

export interface PermissionResolvedInfo {
  requestId: string;
  taskId: string;
  outcome: 'allowed' | 'denied' | 'cancelled' | 'invalidated';
  scope?: 'once' | 'task' | 'workspace' | 'always';
  actor?: string;
  reason?: string;
  card: PermissionRequestCard;
  pendingLeftForTask: number;
}

export interface PermissionEngineEvents {
  onPending(card: PermissionRequestCard): void;
  onResolved(info: PermissionResolvedInfo): void;
}

export interface UserPermissionDecision {
  requestId: string;
  kind: 'allow' | 'deny';
  scope: 'once' | 'task' | 'workspace' | 'always';
  /** Hash shown on the card the user acted on — mismatch invalidates (PERM-007). */
  expectedParamsHash: string;
  reason?: string;
  applyToSimilar?: boolean;
  actor: string;
}

interface PendingEntry {
  card: PermissionRequestCard;
  resolve: (decision: PermissionDecision) => void;
  cleanup: () => void;
  /** Re-issues a fresh request for the same waiting call (PERM-007 invalidation). */
  reopen?: () => PermissionRequestCard;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

export function hashParams(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

/**
 * The permission decision engine (PERM-001..010): standing user grants with
 * once/task/workspace scopes, mode auto-allow policy, interactive approval
 * with parameter binding, cancellation and full audit persistence.
 */
export class PermissionEngine implements PermissionDecider {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly workspaceId: string;
  private readonly store: PermissionStore;
  private readonly events: PermissionEngineEvents;
  private readonly now: () => string;

  constructor(options: {
    workspaceId: string;
    store: PermissionStore;
    events: PermissionEngineEvents;
    now?: () => string;
  }) {
    this.workspaceId = options.workspaceId;
    this.store = options.store;
    this.events = options.events;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async decide(input: Parameters<PermissionDecider['decide']>[0]): Promise<PermissionDecision> {
    const { call, tool, risk, preview, mode, signal, onWaiting } = input;
    if (risk.level === 'R0') return { kind: 'allow', scope: 'auto' };
    if (risk.level === 'R4') {
      // The gateway refuses R4 before consulting the engine — defense in depth.
      return {
        kind: 'deny',
        reason: 'This action is forbidden by product policy.',
        permanent: true,
      };
    }

    const ruleKey = preview.ruleKey ?? `tool:${tool.name}`;
    const paramsHash = hashParams(call.input);
    const rules = this.store.listRules(this.workspaceId);
    const matches = (rule: StandingRule) =>
      rule.ruleKey === ruleKey && (rule.taskId === null || rule.taskId === call.taskId);

    const denyRule = rules.find((r) => r.kind === 'deny' && matches(r));
    if (denyRule) {
      return {
        kind: 'deny',
        reason: 'The user has permanently denied this kind of action in this workspace.',
        permanent: true,
      };
    }

    // Full autonomy (ADR-0012): the user opted into running without approval
    // prompts — R1–R3 auto-allow. R4 was already refused above, path/product
    // boundaries still hold at the gateway, and standing denies still win.
    if (mode === 'full') {
      return { kind: 'allow', scope: 'auto', paramsHash };
    }

    // Standing allow grants never satisfy R3: each R3 call needs explicit confirmation (PERM-003).
    if (risk.level !== 'R3') {
      const allowRule = rules.find((r) => r.kind === 'allow' && matches(r));
      if (allowRule) {
        return {
          kind: 'allow',
          scope: allowRule.taskId === null ? 'workspace' : 'task',
          paramsHash,
        };
      }
      // Mode policy (§10.2 defaults): Auto mode runs low-risk work without prompts.
      if (mode === 'auto' && (risk.level === 'R1' || (risk.level === 'R2' && risk.recognized))) {
        return { kind: 'allow', scope: 'auto', paramsHash };
      }
    }

    onWaiting?.();
    return this.ask({ call, tool, risk, preview, ruleKey, paramsHash, signal });
  }

  private ask(input: {
    call: Parameters<PermissionDecider['decide']>[0]['call'];
    tool: { name: string; version: number; description: string };
    risk: RiskAssessment;
    preview: ToolPreview;
    ruleKey: string;
    paramsHash: string;
    signal: AbortSignal;
  }): Promise<PermissionDecision> {
    const { call, tool, risk, preview, ruleKey, paramsHash, signal } = input;
    return new Promise<PermissionDecision>((resolve) => {
      const openRequest = () => {
        const requestId = newId('perm');
        const card: PermissionRequestCard = {
          requestId,
          callId: call.callId,
          runId: call.runId,
          taskId: call.taskId,
          workspaceId: this.workspaceId,
          tool,
          risk,
          preview,
          input: redactObject(call.input),
          paramsHash,
          ruleKey,
          options: {
            allowScopes: risk.level === 'R3' ? ['once'] : ['once', 'task', 'workspace'],
            denyScopes: ['once', 'always'],
          },
          createdAt: this.now(),
        };
        this.store.saveRequest({
          id: requestId,
          toolCallId: call.callId,
          taskId: call.taskId,
          state: 'PENDING',
          risk: risk.level,
          previewJson: JSON.stringify(redactObject({ ...preview, input: card.input })),
          createdAt: card.createdAt,
          resolvedAt: null,
        });
        const onAbort = () =>
          this.finish(requestId, 'CANCELLED', {
            decision: {
              kind: 'deny',
              reason: 'The run was stopped while waiting for permission.',
              permanent: false,
            },
            outcome: 'cancelled',
          });
        signal.addEventListener('abort', onAbort, { once: true });
        this.pending.set(requestId, {
          card,
          resolve,
          cleanup: () => signal.removeEventListener('abort', onAbort),
        });
        this.events.onPending(card);
        if (signal.aborted) onAbort();
        return card;
      };
      // Stored on the entry so PERM-007 invalidation can re-open a fresh request
      // for the same still-waiting tool call. The entry is gone already if the
      // signal was aborted before we got here.
      const card = openRequest();
      const entry = this.pending.get(card.requestId);
      if (entry) entry.reopen = openRequest;
    });
  }

  /** Apply a user decision. Returns the requests actually resolved by it. */
  resolve(decision: UserPermissionDecision): { resolvedRequestIds: string[] } {
    const entry = this.pending.get(decision.requestId);
    if (!entry) return { resolvedRequestIds: [] };

    // PERM-007: the approval is bound to the parameters the user saw.
    if (decision.expectedParamsHash !== entry.card.paramsHash) {
      this.finish(decision.requestId, 'INVALIDATED', { outcome: 'invalidated', keepWaiting: true });
      return { resolvedRequestIds: [] };
    }

    const targets: PendingEntry[] = [entry];
    if (decision.applyToSimilar) {
      for (const other of this.pending.values()) {
        if (other !== entry && other.card.ruleKey === entry.card.ruleKey) targets.push(other);
      }
    }

    // R3 never yields a standing grant, whatever scope was requested (PERM-003).
    const effectiveScope =
      decision.kind === 'allow' &&
      entry.card.risk.level === 'R3' &&
      (decision.scope === 'task' || decision.scope === 'workspace')
        ? 'once'
        : decision.scope;

    if (
      decision.kind === 'allow' &&
      (effectiveScope === 'task' || effectiveScope === 'workspace')
    ) {
      this.store.saveRule({
        id: newId('rule'),
        workspaceId: this.workspaceId,
        taskId: effectiveScope === 'task' ? entry.card.taskId : null,
        kind: 'allow',
        ruleKey: entry.card.ruleKey,
        risk: entry.card.risk.level,
        createdAt: this.now(),
      });
    }
    if (decision.kind === 'deny' && effectiveScope === 'always') {
      this.store.saveRule({
        id: newId('rule'),
        workspaceId: this.workspaceId,
        taskId: null,
        kind: 'deny',
        ruleKey: entry.card.ruleKey,
        risk: entry.card.risk.level,
        createdAt: this.now(),
      });
    }

    const resolvedIds: string[] = [];
    for (const target of targets) {
      const isAllow = decision.kind === 'allow';
      this.store.saveDecision({
        id: newId('dec'),
        requestId: target.card.requestId,
        workspaceId: this.workspaceId,
        taskId: target.card.taskId,
        decision: decision.kind,
        scope: effectiveScope,
        actor: decision.actor,
        reason: decision.reason ?? null,
        createdAt: this.now(),
      });
      this.finish(target.card.requestId, isAllow ? 'ALLOWED' : 'DENIED', {
        decision: isAllow
          ? {
              kind: 'allow',
              scope: effectiveScope === 'always' ? 'once' : effectiveScope,
              paramsHash: target.card.paramsHash,
            }
          : {
              kind: 'deny',
              reason: decision.reason
                ? `The user denied this action: ${decision.reason}`
                : 'The user denied this action.',
              permanent: effectiveScope === 'always',
            },
        outcome: isAllow ? 'allowed' : 'denied',
        scope: effectiveScope,
        actor: decision.actor,
        reason: decision.reason,
      });
      resolvedIds.push(target.card.requestId);
    }
    return { resolvedRequestIds: resolvedIds };
  }

  cancelPendingForTask(taskId: string, reason: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.card.taskId !== taskId) continue;
      this.finish(entry.card.requestId, 'CANCELLED', {
        decision: { kind: 'deny', reason, permanent: false },
        outcome: 'cancelled',
        reason,
      });
    }
  }

  cancelAll(reason: string): void {
    for (const entry of [...this.pending.values()]) {
      this.finish(entry.card.requestId, 'CANCELLED', {
        decision: { kind: 'deny', reason, permanent: false },
        outcome: 'cancelled',
        reason,
      });
    }
  }

  pendingForTask(taskId: string): PermissionRequestCard[] {
    return [...this.pending.values()].map((e) => e.card).filter((c) => c.taskId === taskId);
  }

  pendingAll(): PermissionRequestCard[] {
    return [...this.pending.values()].map((e) => e.card);
  }

  private finish(
    requestId: string,
    state: PermissionRequestState,
    outcome: {
      decision?: PermissionDecision;
      outcome: PermissionResolvedInfo['outcome'];
      scope?: 'once' | 'task' | 'workspace' | 'always';
      actor?: string;
      reason?: string;
      keepWaiting?: boolean;
    },
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    entry.cleanup();
    this.store.resolveRequest(requestId, state, this.now());
    this.events.onResolved({
      requestId,
      taskId: entry.card.taskId,
      outcome: outcome.outcome,
      scope: outcome.scope,
      actor: outcome.actor,
      reason: outcome.reason,
      card: entry.card,
      pendingLeftForTask: this.pendingForTask(entry.card.taskId).length,
    });
    if (outcome.keepWaiting && entry.reopen) {
      // PERM-007: the original approval is void; re-request with a fresh card.
      const card = entry.reopen();
      const reopened = this.pending.get(card.requestId);
      if (reopened) reopened.reopen = entry.reopen;
      return;
    }
    if (outcome.decision) entry.resolve(outcome.decision);
  }
}

/** In-memory store for tests and the mock runtime path. */
export interface MemoryPermissionStore extends PermissionStore {
  requests: StoredPermissionRequest[];
  decisions: StoredPermissionDecision[];
  rules: StandingRule[];
}

export function createMemoryPermissionStore(): MemoryPermissionStore {
  const requests: StoredPermissionRequest[] = [];
  const decisions: StoredPermissionDecision[] = [];
  const rules: StandingRule[] = [];
  return {
    requests,
    decisions,
    rules,
    saveRequest: (request) => {
      requests.push({ ...request });
    },
    resolveRequest: (requestId, state, resolvedAt) => {
      const row = requests.find((r) => r.id === requestId);
      if (row) {
        row.state = state;
        row.resolvedAt = resolvedAt;
      }
    },
    saveDecision: (decision) => {
      decisions.push({ ...decision });
    },
    listRules: (workspaceId) => rules.filter((r) => r.workspaceId === workspaceId),
    saveRule: (rule) => {
      rules.push({ ...rule });
    },
  };
}
