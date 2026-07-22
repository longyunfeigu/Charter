import { z } from 'zod';
import {
  productError,
  ProductFailure,
  toProductError,
  redactObject,
  type Result,
} from '@pi-ide/foundation';
import type {
  AgentMode,
  ToolCallRequest,
  ToolCatalogEntry,
  ToolResultPayload,
} from '@pi-ide/agent-contract';

export type RiskLevel = 'R0' | 'R1' | 'R2' | 'R3' | 'R4';

export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[];
  /** Recognized verification command — eligible for auto-allow in Auto mode. */
  recognized?: boolean;
}

export interface ToolPreview {
  summary: string;
  detail?: string;
  diff?: string | null;
  command?: { executable: string; args: string[]; cwd: string } | null;
  targets?: string[];
  /** Stable "same kind of action" key used by scoped permission grants (PERM-002). */
  ruleKey?: string;
}

export interface ToolExecuteOutput {
  code: string;
  summary: string;
  data: unknown;
  retryable?: boolean;
}

export interface GatewayTool<I = unknown> {
  name: string;
  version: number;
  description: string;
  promptGuidance?: string;
  inputSchema: z.ZodType<I>;
  /** Host-only invariants that must fail before risk evaluation or an approval
   * prompt (for example orchestration depth and self-control). */
  preflight?(input: I, call: ToolCallRequest): void | Promise<void>;
  risk(input: I): RiskAssessment;
  preview(input: I): Promise<ToolPreview>;
  execute(input: I, signal: AbortSignal, call: ToolCallRequest): Promise<ToolExecuteOutput>;
}

export interface ToolAuditRecord {
  callId: string;
  runId: string;
  taskId: string;
  name: string;
  version: number;
  risk: RiskLevel | null;
  state:
    | 'PROPOSED'
    | 'WAITING_PERMISSION'
    | 'RUNNING'
    | 'SUCCEEDED'
    | 'FAILED'
    | 'DENIED'
    | 'CANCELLED'
    | 'TIMED_OUT';
  input: unknown;
  resultSummary: string | null;
  ok: boolean | null;
  at: string;
}

export type PermissionDecision =
  | { kind: 'allow'; scope: 'once' | 'task' | 'workspace' | 'auto'; paramsHash?: string }
  | { kind: 'deny'; reason: string; permanent: boolean };

export interface PermissionDecider {
  decide(input: {
    call: ToolCallRequest;
    tool: { name: string; version: number; description: string };
    risk: RiskAssessment;
    preview: ToolPreview;
    mode: AgentMode;
    /** Aborting the run must release any pending user prompt. */
    signal: AbortSignal;
    /** Invoked when the decision starts waiting on the user (audit WAITING_PERMISSION). */
    onWaiting?: () => void;
  }): Promise<PermissionDecision>;
}

/** Default M6 decider: R0 auto-allowed; everything else denied (permission engine lands in M7). */
export const readOnlyDecider: PermissionDecider = {
  async decide({ risk }) {
    if (risk.level === 'R0') return { kind: 'allow', scope: 'auto' };
    return {
      kind: 'deny',
      reason: 'Only read-only tools are available in this mode.',
      permanent: true,
    };
  },
};

export interface ToolGatewayOptions {
  root: string;
  mode: AgentMode;
  /**
   * Per-call mode resolution (ADR-0006): with concurrent runs, each task keeps
   * its own approval mode. Falls back to the gateway-wide `mode` field.
   */
  modeForTask?: (taskId: string) => AgentMode;
  permission?: PermissionDecider;
  audit?: (record: ToolAuditRecord) => void;
  maxOutputBytes?: number;
}

const OUTPUT_LIMIT = 1024 * 1024; // TOOL-007

/**
 * The single execution boundary for every agent tool (TOOL-001). Validates
 * schemas, evaluates risk, consults the permission decider, executes with
 * cancellation and audits each lifecycle step.
 */
export class ToolGateway {
  private readonly tools = new Map<string, GatewayTool<never>>();
  readonly root: string;
  mode: AgentMode;
  private readonly modeForTask: (taskId: string) => AgentMode;
  private readonly permission: PermissionDecider;
  private readonly audit: (record: ToolAuditRecord) => void;
  private readonly maxOutputBytes: number;

  constructor(options: ToolGatewayOptions) {
    this.root = options.root;
    this.mode = options.mode;
    this.modeForTask = options.modeForTask ?? (() => this.mode);
    this.permission = options.permission ?? readOnlyDecider;
    this.audit = options.audit ?? (() => undefined);
    this.maxOutputBytes = options.maxOutputBytes ?? OUTPUT_LIMIT;
  }

  register<I>(tool: GatewayTool<I>): void {
    this.tools.set(tool.name, tool as GatewayTool<never>);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Tool surface for a mode: Ask exposes only tools whose *minimum* risk is R0. */
  catalog(mode: AgentMode): ToolCatalogEntry[] {
    const entries: ToolCatalogEntry[] = [];
    for (const tool of this.tools.values()) {
      const minimalRisk = safeMinimalRisk(tool);
      if (mode === 'ask' && minimalRisk !== 'R0') continue;
      entries.push({
        name: tool.name,
        description: tool.description,
        schemaVersion: tool.version,
        inputJsonSchema: z.toJSONSchema(tool.inputSchema, { io: 'input' }),
        ...(tool.promptGuidance ? { promptGuidance: tool.promptGuidance } : {}),
      });
    }
    return entries;
  }

  async preview(call: ToolCallRequest): Promise<Result<ToolPreview>> {
    const tool = this.tools.get(call.toolName);
    if (!tool) {
      return {
        ok: false,
        error: productError('TOOL_UNKNOWN', { userMessage: `Unknown tool ${call.toolName}.` }),
      };
    }
    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      return {
        ok: false,
        error: productError('TOOL_INVALID_INPUT', { userMessage: 'Invalid tool input.' }),
      };
    }
    return { ok: true, value: await tool.preview(parsed.data as never) };
  }

  async executeCall(call: ToolCallRequest, signal: AbortSignal): Promise<ToolResultPayload> {
    const at = () => new Date().toISOString();
    const base = {
      callId: call.callId,
      runId: call.runId,
      taskId: call.taskId,
      input: redactObject(call.input),
    };

    const tool = this.tools.get(call.toolName);
    if (!tool) {
      this.audit({
        ...base,
        name: call.toolName,
        version: 0,
        risk: null,
        state: 'FAILED',
        resultSummary: 'unknown tool',
        ok: false,
        at: at(),
      });
      return {
        callId: call.callId,
        ok: false,
        code: 'TOOL_UNKNOWN',
        summary: `The tool "${call.toolName}" is not registered. Available tools are listed in your instructions.`,
        data: {},
      };
    }
    const auditRecord = (
      state: ToolAuditRecord['state'],
      risk: RiskLevel | null,
      resultSummary: string | null,
      ok: boolean | null,
    ) =>
      this.audit({
        ...base,
        name: tool.name,
        version: tool.version,
        risk,
        state,
        resultSummary,
        ok,
        at: at(),
      });

    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      auditRecord('FAILED', null, 'schema violation', false);
      return {
        callId: call.callId,
        ok: false,
        code: 'TOOL_INVALID_INPUT',
        summary: `Invalid input for ${tool.name}: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
        data: {},
        retryable: true,
      };
    }
    const input = parsed.data as never;

    if (tool.preflight) {
      try {
        await tool.preflight(input, call);
      } catch (e) {
        const error =
          e instanceof ProductFailure ? e.error : toProductError(e, 'TOOL_PREFLIGHT_FAILED');
        auditRecord('FAILED', null, error.code, false);
        return {
          callId: call.callId,
          ok: false,
          code: error.code,
          summary: error.userMessage,
          data: {},
          retryable: error.retryable,
        };
      }
    }

    let risk: RiskAssessment;
    try {
      risk = tool.risk(input);
    } catch (e) {
      auditRecord('FAILED', null, 'risk evaluation failed', false);
      return {
        callId: call.callId,
        ok: false,
        code: 'TOOL_RISK_FAILED',
        summary: toProductError(e, 'TOOL_RISK_FAILED').userMessage,
        data: {},
      };
    }
    auditRecord('PROPOSED', risk.level, null, null);

    // R4 is refused at the product layer — no permission prompt, no override (PERM-008).
    if (risk.level === 'R4') {
      auditRecord('DENIED', risk.level, 'forbidden (R4)', false);
      return {
        callId: call.callId,
        ok: false,
        code: 'PERMISSION_DENIED',
        summary: `This action is forbidden by product policy: ${risk.reasons.join('; ')}`,
        data: { risk: risk.level, permanent: true },
      };
    }

    // Ask mode is a hard read-only boundary regardless of registration (AG-001).
    // The mode is resolved per task so concurrent runs never share a mode (ADR-0006).
    const mode = this.modeForTask(call.taskId);
    if (mode === 'ask' && risk.level !== 'R0') {
      auditRecord('DENIED', risk.level, 'ask mode is read-only', false);
      return {
        callId: call.callId,
        ok: false,
        code: 'PERMISSION_DENIED',
        summary: 'Ask mode is read-only: writing files or running commands is not available.',
        data: { risk: risk.level, permanent: true },
      };
    }

    let preview: ToolPreview;
    try {
      preview = await tool.preview(input);
    } catch {
      preview = { summary: `${tool.name}` };
    }

    const decision = await this.permission.decide({
      call,
      tool: { name: tool.name, version: tool.version, description: tool.description },
      risk,
      preview,
      mode,
      signal,
      onWaiting: () => auditRecord('WAITING_PERMISSION', risk.level, null, null),
    });
    if (decision.kind === 'deny') {
      auditRecord('DENIED', risk.level, decision.reason, false);
      return {
        callId: call.callId,
        ok: false,
        code: 'PERMISSION_DENIED',
        summary: decision.reason,
        data: { risk: risk.level, permanent: decision.permanent },
      };
    }

    if (signal.aborted) {
      auditRecord('CANCELLED', risk.level, 'cancelled before start', false);
      return {
        callId: call.callId,
        ok: false,
        code: 'CANCELLED',
        summary: 'The tool call was cancelled.',
        data: {},
      };
    }

    auditRecord('RUNNING', risk.level, null, null);
    try {
      const output = await tool.execute(input, signal, call);
      const bounded = this.boundOutput(output.data);
      auditRecord('SUCCEEDED', risk.level, output.summary.slice(0, 300), true);
      return {
        callId: call.callId,
        ok: true,
        code: output.code,
        summary: output.summary,
        data: bounded,
        ...(output.retryable !== undefined ? { retryable: output.retryable } : {}),
      };
    } catch (e) {
      if (signal.aborted) {
        auditRecord('CANCELLED', risk.level, 'cancelled', false);
        return {
          callId: call.callId,
          ok: false,
          code: 'CANCELLED',
          summary: 'The tool call was cancelled.',
          data: {},
        };
      }
      const error =
        e instanceof ProductFailure ? e.error : toProductError(e, 'TOOL_EXECUTION_FAILED');
      auditRecord('FAILED', risk.level, error.code, false);
      return {
        callId: call.callId,
        ok: false,
        code: error.code,
        summary: error.userMessage,
        data: { technical: error.technicalMessage?.slice(0, 500) ?? null },
        retryable: error.retryable,
      };
    }
  }

  /** TOOL-007: cap payloads; long strings are truncated with an explicit flag. */
  private boundOutput(data: unknown): unknown {
    const text = JSON.stringify(data) ?? 'null';
    if (text.length <= this.maxOutputBytes) return data;
    if (
      typeof data === 'object' &&
      data !== null &&
      typeof (data as { content?: unknown }).content === 'string'
    ) {
      const obj = data as Record<string, unknown> & { content: string };
      const keep = Math.max(0, this.maxOutputBytes - (text.length - obj.content.length));
      return { ...obj, content: obj.content.slice(0, keep), truncated: true };
    }
    return { truncated: true, preview: text.slice(0, this.maxOutputBytes) };
  }
}

function safeMinimalRisk(tool: GatewayTool<never>): RiskLevel {
  try {
    // Risk of an empty-ish probe: tools whose risk never depends on input return their floor.
    return tool.risk({} as never).level;
  } catch {
    return 'R3';
  }
}
