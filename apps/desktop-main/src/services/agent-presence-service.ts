import type { Logger } from '@pi-ide/foundation';
import type {
  AgentPresenceExplain,
  AgentPresenceSnapshot,
  AgentPresenceSource,
  AgentPresenceRuleEvaluation,
} from '@pi-ide/ipc-contracts';
import type { TerminalInfo, TerminalManager } from '@pi-ide/terminal-service';
import {
  BUILTIN_AGENT_ADAPTERS,
  type AgentLifecycleManifest,
  type LifecycleGate,
  type LifecycleRegion as Region,
  type LifecycleRule,
} from './agent-adapter-manifest.js';

const SCREEN_LIMIT_BYTES = 96 * 1024;
const SCREEN_PREVIEW_CHARS = 4_000;
const REGION_PREVIEW_CHARS = 500;
const SCAN_DEBOUNCE_MS = 45;
const STABLE_IDLE_SAMPLES = 3;
const STABLE_IDLE_SAMPLE_MS = 110;

export type { AgentLifecycleManifest, LifecycleGate, LifecycleRule };

export const BUILTIN_AGENT_LIFECYCLE_MANIFESTS: readonly AgentLifecycleManifest[] =
  BUILTIN_AGENT_ADAPTERS.flatMap((adapter) => (adapter.lifecycle ? [adapter.lifecycle] : []));

export interface PresenceDetectionInput {
  screen: string;
  oscTitle: string;
}

export interface PresenceDetectionResult {
  manifest: AgentLifecycleManifest | null;
  matchedRule: LifecycleRule | null;
  evaluatedRules: AgentPresenceRuleEvaluation[];
  fallbackReason: string | null;
}

const regexCache = new Map<string, RegExp>();

function compiledRegex(source: string, multiline: boolean): RegExp {
  const key = `${multiline ? 'm' : '-'}:${source}`;
  const cached = regexCache.get(key);
  if (cached) return cached;
  const value = new RegExp(source, multiline ? 'imu' : 'iu');
  regexCache.set(key, value);
  return value;
}

function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function regionLabel(region: Region): string {
  return 'count' in region ? `${region.kind}(${region.count})` : region.kind;
}

function ruleRegion(input: PresenceDetectionInput, region: Region): string {
  if (region.kind === 'osc_title') return input.oscTitle;
  if (region.kind === 'top_non_empty_lines') {
    return nonEmptyLines(input.screen).slice(0, region.count).join('\n');
  }
  if (region.kind === 'bottom_non_empty_lines') {
    return nonEmptyLines(input.screen).slice(-region.count).join('\n');
  }
  if (region.kind === 'after_last_horizontal_rule') {
    const lines = input.screen.split(/\r?\n/);
    let boundary = -1;
    for (let index = 0; index < lines.length; index += 1) {
      if (/^\s*[─━═╌╍┄┅-]{3,}\s*$/.test(lines[index] ?? '')) boundary = index;
    }
    return lines.slice(boundary + 1).join('\n');
  }
  return input.screen;
}

function gateMatches(gate: LifecycleGate, text: string): boolean {
  const folded = text.toLocaleLowerCase();
  if ((gate.contains ?? []).some((value) => !folded.includes(value.toLocaleLowerCase()))) {
    return false;
  }
  if ((gate.regex ?? []).some((source) => !compiledRegex(source, true).test(text))) return false;
  const lines = text.split(/\r?\n/);
  if (
    (gate.lineRegex ?? []).some(
      (source) => !lines.some((line) => compiledRegex(source, false).test(line)),
    )
  ) {
    return false;
  }
  if ((gate.all ?? []).some((child) => !gateMatches(child, text))) return false;
  if ((gate.any?.length ?? 0) > 0 && !gate.any!.some((child) => gateMatches(child, text))) {
    return false;
  }
  if ((gate.not ?? []).some((child) => gateMatches(child, text))) return false;
  return true;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function tail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(value.length - maxChars);
}

/** Pure manifest evaluation, exported so provider fixtures can pin behavior. */
export function evaluateAgentPresence(
  agent: string,
  input: PresenceDetectionInput,
  manifests: readonly AgentLifecycleManifest[] = BUILTIN_AGENT_LIFECYCLE_MANIFESTS,
): PresenceDetectionResult {
  const normalized = agent.trim().toLocaleLowerCase();
  const manifest =
    manifests.find(
      (candidate) =>
        candidate.id.toLocaleLowerCase() === normalized ||
        candidate.aliases.some((alias) => alias.toLocaleLowerCase() === normalized),
    ) ?? null;
  if (!manifest) {
    return {
      manifest: null,
      matchedRule: null,
      evaluatedRules: [],
      fallbackReason: 'No bundled lifecycle manifest for this Agent.',
    };
  }

  let matchedRule: LifecycleRule | null = null;
  const evaluatedRules = manifest.rules.map((rule) => {
    const text = ruleRegion(input, rule.region);
    const matched = gateMatches(rule, text);
    if (matched && (!matchedRule || rule.priority > matchedRule.priority)) matchedRule = rule;
    return {
      id: rule.id,
      priority: rule.priority,
      region: regionLabel(rule.region),
      state: rule.state,
      matched,
      regionBytes: utf8Bytes(text),
      regionPreview: tail(text, REGION_PREVIEW_CHARS),
    };
  });
  return {
    manifest,
    matchedRule,
    evaluatedRules,
    fallbackReason: matchedRule ? null : 'No lifecycle rule matched the current visible screen.',
  };
}

interface PresenceTerminalSource {
  onAgentState(
    listener: (info: { id: string; agent: string | null; cwd: string }) => void,
  ): () => void;
  onDataEvent(listener: (info: { id: string; data: string }) => void): () => void;
  onExitEvent(listener: (info: { id: string; exitCode: number }) => void): () => void;
  agentFor(id: string): string | null;
  list(): TerminalInfo[];
  screenText(id: string, maxBytes: number): Promise<{ content: string; totalBytes: number } | null>;
}

interface MutablePresence {
  snapshot: AgentPresenceSnapshot;
  oscTitle: string;
  oscBuffer: string;
  explain: AgentPresenceExplain;
  scanTimer: ReturnType<typeof setTimeout> | null;
  scanGeneration: number;
  idleCandidate: { ruleId: string; samples: number } | null;
}

export interface AgentPresenceServiceOptions {
  onChanged?: (presence: AgentPresenceSnapshot) => void;
  now?: () => Date;
  manifests?: readonly AgentLifecycleManifest[];
}

function defaultExplain(snapshot: AgentPresenceSnapshot): AgentPresenceExplain {
  return {
    snapshot,
    matchedRule: null,
    evaluatedRules: [],
    screenPreview: '',
    oscTitle: '',
    fallbackReason: 'Waiting for visible Agent evidence.',
    stabilization: { candidate: null, samples: 0, requiredSamples: STABLE_IDLE_SAMPLES },
  };
}

function snapshotChanged(left: AgentPresenceSnapshot, right: AgentPresenceSnapshot): boolean {
  return (
    left.taskId !== right.taskId ||
    left.agent !== right.agent ||
    left.processState !== right.processState ||
    left.lifecycle !== right.lifecycle ||
    left.attention !== right.attention ||
    left.source !== right.source ||
    left.message !== right.message ||
    left.matchedRuleId !== right.matchedRuleId ||
    left.manifestVersion !== right.manifestVersion
  );
}

function latestOscTitle(value: string): string | null {
  const pattern = /\u001b\](?:0|1|2);([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;
  let title: string | null = null;
  for (const match of value.matchAll(pattern)) title = match[1] ?? '';
  return title;
}

/**
 * Unified presence is deliberately a projection over PTY/process evidence.
 * It never mutates a task, decides Mission completion, or writes to a terminal.
 */
export class AgentPresenceService {
  private readonly states = new Map<string, MutablePresence>();
  private readonly listeners = new Set<(presence: AgentPresenceSnapshot) => void>();
  private readonly unsubscribers: Array<() => void>;
  private readonly now: () => Date;
  private manifests: readonly AgentLifecycleManifest[] | undefined;

  constructor(
    private readonly terminals: PresenceTerminalSource,
    private readonly logger: Logger,
    private readonly options: AgentPresenceServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.manifests = options.manifests;
    this.unsubscribers = [
      terminals.onAgentState(({ id, agent }) => {
        if (agent) this.enter(id, agent);
        else this.exit(id);
      }),
      terminals.onDataEvent(({ id, data }) => this.onData(id, data)),
      terminals.onExitEvent(({ id }) => this.exit(id)),
    ];
    for (const terminal of terminals.list()) {
      const agent = terminals.agentFor(terminal.id);
      if (agent) this.enter(terminal.id, agent);
    }
  }

  list(): AgentPresenceSnapshot[] {
    return [...this.states.values()]
      .map((state) => state.snapshot)
      .toSorted((left, right) => left.terminalId.localeCompare(right.terminalId));
  }

  get(terminalId: string): AgentPresenceSnapshot | null {
    return this.states.get(terminalId)?.snapshot ?? null;
  }

  /** Subscribe to committed presence transitions. Semantic waiters use this
   * event lane so they never need to poll terminal output or renderer state. */
  onChanged(listener: (presence: AgentPresenceSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Apply lifecycle contracts from the current Adapter registry without
   * recreating subscriptions or losing per-terminal identity sequences. */
  updateManifests(manifests: readonly AgentLifecycleManifest[]): void {
    this.manifests = manifests;
    for (const state of this.states.values()) {
      state.idleCandidate = null;
      this.scheduleScan(state, 0);
    }
  }

  async explain(terminalId: string): Promise<AgentPresenceExplain | null> {
    if (!this.states.has(terminalId)) return null;
    await this.scanNow(terminalId);
    return this.states.get(terminalId)?.explain ?? null;
  }

  bindTask(terminalId: string, taskId: string): void {
    const state = this.ensure(terminalId);
    if (!state) return;
    this.transition(state, { taskId });
  }

  notifyTurnStarted(event: { terminalId: string; taskId: string }): void {
    const state = this.ensure(event.terminalId);
    if (!state) return;
    this.transition(state, {
      taskId: event.taskId,
      processState: 'running',
      lifecycle: 'working',
      attention: 'none',
      source: 'turn',
      message: 'Agent is working',
      matchedRuleId: null,
    });
  }

  notifyTurnSettled(event: {
    terminalId: string;
    taskId: string;
    status: 'ok' | 'error';
    source: 'structured' | 'observed';
  }): void {
    const state = this.ensure(event.terminalId);
    if (!state) return;
    this.transition(state, {
      taskId: event.taskId,
      processState: 'running',
      lifecycle: 'idle',
      source: event.source === 'structured' ? 'structured' : 'turn',
      message: event.status === 'error' ? 'Reply ended with an error' : 'Ready for input',
      matchedRuleId:
        event.source === 'structured' ? 'structured_turn_settled' : 'observed_output_settled',
    });
  }

  markSeen(
    terminalId: string,
    surface: 'session-rail' | 'session-header' | 'terminal-header' = 'session-rail',
  ): AgentPresenceSnapshot | null {
    const state = this.states.get(terminalId);
    if (!state) return null;
    if (state.snapshot.attention === 'done') {
      this.logger.info('agent presence marked seen', {
        terminalId,
        taskId: state.snapshot.taskId,
        surface,
      });
      this.transition(state, { attention: 'none' });
    }
    return state.snapshot;
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    for (const state of this.states.values()) {
      if (state.scanTimer) clearTimeout(state.scanTimer);
    }
    this.listeners.clear();
    this.states.clear();
  }

  private ensure(terminalId: string): MutablePresence | null {
    const existing = this.states.get(terminalId);
    if (existing) return existing;
    const agent = this.terminals.agentFor(terminalId);
    if (!agent) return null;
    this.enter(terminalId, agent);
    return this.states.get(terminalId) ?? null;
  }

  private enter(terminalId: string, agent: string): void {
    const existing = this.states.get(terminalId);
    if (
      existing &&
      existing.snapshot.processState === 'running' &&
      existing.snapshot.agent === agent
    ) {
      this.scheduleScan(existing, 0);
      return;
    }
    if (existing?.scanTimer) clearTimeout(existing.scanTimer);
    const manifest = evaluateAgentPresence(
      agent,
      { screen: '', oscTitle: '' },
      this.manifests,
    ).manifest;
    const snapshot: AgentPresenceSnapshot = {
      terminalId,
      taskId: existing?.snapshot.taskId ?? null,
      agent,
      processState: 'running',
      lifecycle: 'unknown',
      attention: 'none',
      source: 'process',
      identitySeq: (existing?.snapshot.identitySeq ?? 0) + 1,
      stateChangeSeq: (existing?.snapshot.stateChangeSeq ?? 0) + 1,
      changedAt: this.now().toISOString(),
      message: 'Waiting for Agent state evidence',
      matchedRuleId: null,
      manifestVersion: manifest?.version ?? null,
    };
    const state: MutablePresence = {
      snapshot,
      oscTitle: '',
      oscBuffer: '',
      explain: defaultExplain(snapshot),
      scanTimer: null,
      scanGeneration: 0,
      idleCandidate: null,
    };
    this.states.set(terminalId, state);
    this.emit(snapshot);
    this.scheduleScan(state, 0);
  }

  private exit(terminalId: string): void {
    const state = this.states.get(terminalId);
    if (!state || state.snapshot.processState === 'exited') return;
    if (state.scanTimer) clearTimeout(state.scanTimer);
    state.scanTimer = null;
    state.scanGeneration += 1;
    state.idleCandidate = null;
    this.transition(state, {
      processState: 'exited',
      lifecycle: 'unknown',
      attention: 'none',
      source: 'process',
      message: 'Agent process exited',
      matchedRuleId: null,
    });
  }

  private onData(terminalId: string, data: string): void {
    const state = this.states.get(terminalId);
    if (!state || state.snapshot.processState !== 'running') return;
    state.oscBuffer = tail(`${state.oscBuffer}${data}`, 4_096);
    const title = latestOscTitle(state.oscBuffer);
    if (title !== null) state.oscTitle = title;
    this.scheduleScan(state, SCAN_DEBOUNCE_MS);
  }

  private scheduleScan(state: MutablePresence, delay: number): void {
    if (state.scanTimer) clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => {
      state.scanTimer = null;
      void this.scanNow(state.snapshot.terminalId);
    }, delay);
    state.scanTimer.unref?.();
  }

  private async scanNow(terminalId: string): Promise<void> {
    const state = this.states.get(terminalId);
    if (!state || state.snapshot.processState !== 'running') return;
    const generation = ++state.scanGeneration;
    let screen: Awaited<ReturnType<TerminalManager['screenText']>>;
    try {
      screen = await this.terminals.screenText(terminalId, SCREEN_LIMIT_BYTES);
    } catch (error) {
      this.logger.warn('agent presence screen read failed', {
        terminalId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (
      !screen ||
      generation !== state.scanGeneration ||
      state.snapshot.processState !== 'running'
    ) {
      return;
    }
    const detection = evaluateAgentPresence(
      state.snapshot.agent,
      {
        screen: screen.content,
        oscTitle: state.oscTitle,
      },
      this.manifests,
    );
    const rule = detection.matchedRule;
    state.explain = {
      snapshot: state.snapshot,
      matchedRule: rule
        ? {
            id: rule.id,
            priority: rule.priority,
            region: regionLabel(rule.region),
            state: rule.state,
            visibleIdle: rule.visibleIdle ?? false,
            visibleBlocker: rule.visibleBlocker ?? false,
            visibleWorking: rule.visibleWorking ?? false,
            skipStateUpdate: rule.skipStateUpdate ?? false,
          }
        : null,
      evaluatedRules: detection.evaluatedRules,
      screenPreview: tail(screen.content, SCREEN_PREVIEW_CHARS),
      oscTitle: tail(state.oscTitle, 500),
      fallbackReason: detection.fallbackReason,
      stabilization: {
        candidate: state.idleCandidate ? 'idle' : null,
        samples: state.idleCandidate?.samples ?? 0,
        requiredSamples: STABLE_IDLE_SAMPLES,
      },
    };
    if (!rule || rule.skipStateUpdate || rule.state === 'unknown') return;

    if (rule.state === 'idle') {
      if (state.snapshot.lifecycle === 'idle' && state.snapshot.matchedRuleId === rule.id) {
        state.idleCandidate = null;
        return;
      }
      const samples = state.idleCandidate?.ruleId === rule.id ? state.idleCandidate.samples + 1 : 1;
      state.idleCandidate = { ruleId: rule.id, samples };
      state.explain = {
        ...state.explain,
        stabilization: { candidate: 'idle', samples, requiredSamples: STABLE_IDLE_SAMPLES },
      };
      if (samples < STABLE_IDLE_SAMPLES) {
        this.scheduleScan(state, STABLE_IDLE_SAMPLE_MS);
        return;
      }
    } else {
      state.idleCandidate = null;
    }

    const source: AgentPresenceSource =
      rule.region.kind === 'osc_title' ? 'osc' : 'screen-manifest';
    this.transition(state, {
      lifecycle: rule.state,
      source,
      message:
        rule.state === 'blocked'
          ? 'Waiting for your input'
          : rule.state === 'working'
            ? 'Agent is working'
            : 'Ready for input',
      matchedRuleId: rule.id,
      manifestVersion: detection.manifest?.version ?? null,
    });
  }

  private transition(
    state: MutablePresence,
    patch: Partial<
      Pick<
        AgentPresenceSnapshot,
        | 'taskId'
        | 'processState'
        | 'lifecycle'
        | 'attention'
        | 'source'
        | 'message'
        | 'matchedRuleId'
        | 'manifestVersion'
      >
    >,
  ): void {
    const previous = state.snapshot;
    const lifecycle = patch.lifecycle ?? previous.lifecycle;
    let attention = patch.attention ?? previous.attention;
    if (patch.attention === undefined && patch.lifecycle !== undefined) {
      if (lifecycle === 'blocked') attention = 'needs_user';
      else if (previous.lifecycle === 'working' && lifecycle === 'idle') attention = 'done';
      else if (lifecycle === 'idle' && previous.attention === 'needs_user') attention = 'none';
      else if (lifecycle === 'working' || lifecycle === 'unknown') attention = 'none';
    }
    const candidate: AgentPresenceSnapshot = {
      ...previous,
      ...patch,
      lifecycle,
      attention,
    };
    if (!snapshotChanged(previous, candidate)) return;
    const next: AgentPresenceSnapshot = {
      ...candidate,
      stateChangeSeq: previous.stateChangeSeq + 1,
      changedAt: this.now().toISOString(),
    };
    state.snapshot = next;
    state.explain = { ...state.explain, snapshot: next };
    this.emit(next);
  }

  private emit(snapshot: AgentPresenceSnapshot): void {
    this.options.onChanged?.(snapshot);
    for (const listener of this.listeners) listener(snapshot);
  }
}
