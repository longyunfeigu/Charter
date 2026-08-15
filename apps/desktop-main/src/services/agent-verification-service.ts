import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { z } from 'zod';
import {
  AgentVerificationRunSchema,
  type AgentPackCatalogDto,
  type AgentVerificationAgent,
  type AgentVerificationCheck,
  type AgentVerificationCheckId,
  type AgentVerificationRun,
  type AgentVerificationSnapshot,
  type AgentPresenceSnapshot,
} from '@pi-ide/ipc-contracts';
import { productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import type { TerminalInfo } from '@pi-ide/terminal-service';
import type { AgentRegistry } from './agent-registry.js';

const RUN_TIMEOUT_MS = 3 * 60 * 1_000;
const MAX_STORED_RUNS = 80;

const StoredStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    runs: z.array(AgentVerificationRunSchema).max(MAX_STORED_RUNS),
  })
  .strict();

interface VerificationTerminalSource {
  list(): TerminalInfo[];
  agentFor(id: string): string | null;
  recentData(id: string): string;
  onAgentState(
    listener: (info: { id: string; agent: string | null; cwd: string }) => void,
  ): () => void;
  onDataEvent(listener: (info: { id: string; data: string }) => void): () => void;
  onExitEvent(listener: (info: { id: string; exitCode: number }) => void): () => void;
}

interface VerificationPresenceSource {
  get(terminalId: string): AgentPresenceSnapshot | null;
  onChanged(listener: (snapshot: AgentPresenceSnapshot) => void): () => void;
}

interface ActiveRun {
  run: AgentVerificationRun;
  expectedReply: string;
  /** Memory-only and bounded. It exists solely so a PTY may split one reply
   * marker across transport chunks; it is never serialized or exported. */
  responseTail: string;
  timeout: ReturnType<typeof setTimeout>;
}

const CHECK_LABELS: Record<AgentVerificationCheckId, string> = {
  source: 'Source contract',
  integration: 'Charter integration',
  installation: 'CLI installation',
  version: 'CLI version',
  authentication: 'Provider login',
  launch: 'Agent launch',
  prompt_response: 'Prompt and response',
  image_path: 'Image delivery',
  image_response: 'Image response',
  local: 'Local terminal',
  ssh: 'SSH terminal',
  lifecycle_working: 'Working state',
  lifecycle_needs_user: 'Needs you state',
  lifecycle_done: 'Done state',
  acp: 'ACP',
  exact_resume: 'Exact resume',
  history: 'Native history',
  skills: 'Skills',
  instructions: 'Instructions',
};

function checked(
  id: AgentVerificationCheckId,
  status: AgentVerificationCheck['status'],
  detail: string,
  checkedAt: string | null,
): AgentVerificationCheck {
  return { id, label: CHECK_LABELS[id], status, detail, checkedAt };
}

function compactVersion(value: string | null): string | null {
  if (!value) return null;
  // Reports promise not to expose paths or account identities. Treat version
  // command output as untrusted and retain only a version-shaped token rather
  // than exporting an arbitrary provider banner.
  return value.match(/\bv?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

function escapeMarkdown(value: string): string {
  return value.replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
}

function failure(code: string, userMessage: string): ProductFailure {
  return new ProductFailure(productError(code, { userMessage }));
}

/**
 * Host-owned self-verification ledger. It watches semantic presence and an
 * unpredictable response challenge, but never persists the challenge, Prompt,
 * terminal bytes, workspace coordinates, executable paths or account data.
 */
export class AgentVerificationService {
  private readonly active = new Map<string, ActiveRun>();
  private storedRuns: AgentVerificationRun[] = [];
  private readonly unsubscribers: Array<() => void>;

  constructor(
    private readonly file: string,
    private readonly registry: AgentRegistry,
    private readonly packs: () => AgentPackCatalogDto,
    private readonly terminals: VerificationTerminalSource,
    private readonly presence: VerificationPresenceSource,
    private readonly logger: Logger,
    private readonly options: {
      now?: () => Date;
      randomId?: () => string;
      challenge?: () => string;
      timeoutMs?: number;
    } = {},
  ) {
    this.load();
    this.unsubscribers = [
      terminals.onAgentState(({ id, agent }) => this.onAgentState(id, agent)),
      terminals.onDataEvent(({ id, data }) => this.onData(id, data)),
      terminals.onExitEvent(({ id }) => this.onExit(id)),
      presence.onChanged((snapshot) => this.onPresence(snapshot)),
    ];
  }

  snapshot(): AgentVerificationSnapshot {
    const now = this.nowIso();
    const packCatalog = this.packs();
    return {
      generatedAt: now,
      agents: this.registry.catalog().agents.map((agent) => {
        const pack = packCatalog.packs.find((candidate) => candidate.adapterIds.includes(agent.id));
        const sourceVerified =
          agent.adapter.source === 'builtin' || Boolean(pack?.bundled && pack.trust === 'verified');
        const integrationTested = agent.adapter.source === 'builtin' || pack?.bundled === true;
        const runs = this.runsFor(agent.id);
        const livePassed = runs.some((run) => run.mode === 'core' && run.status === 'passed');
        const version = compactVersion(agent.version);
        const skillRoots = this.registry.skillRoots(agent.id);
        const instructionRoots = this.registry.instructionRoots(agent.id);
        const capability = (
          id: AgentVerificationCheckId,
          supported: boolean,
          supportedDetail: string,
        ) =>
          checked(
            id,
            supported ? 'available' : 'unsupported',
            supported ? supportedDetail : 'The Adapter does not declare this capability.',
            now,
          );
        const checks: AgentVerificationCheck[] = [
          checked(
            'source',
            sourceVerified ? 'passed' : 'not_run',
            sourceVerified
              ? 'The Adapter is bundled with Charter or shipped in a verified official Pack.'
              : 'This local Pack has not been source-certified by Charter.',
            sourceVerified ? now : null,
          ),
          checked(
            'integration',
            integrationTested ? 'passed' : 'not_run',
            integrationTested
              ? 'The launch and capability contract is covered by Charter integration tests.'
              : 'No bundled Charter integration result is attached to this Pack.',
            integrationTested ? now : null,
          ),
          checked(
            'installation',
            agent.installed ? 'passed' : 'not_run',
            agent.installed
              ? `Executable discovered as ${basename(agent.executable ?? agent.id)}.`
              : 'CLI was not found on this computer.',
            agent.installed ? now : null,
          ),
          checked(
            'version',
            version ? 'passed' : agent.installed ? 'needs_user' : 'not_run',
            version ??
              (agent.installed
                ? 'The CLI did not return a readable version.'
                : 'Install the CLI before checking its version.'),
            version ? now : null,
          ),
          checked('authentication', 'not_run', 'Verified only by an explicit live check.', null),
          checked('launch', 'not_run', 'Verified only by an explicit live check.', null),
          checked(
            'prompt_response',
            'not_run',
            'Verified with a random response challenge during an explicit live check.',
            null,
          ),
          checked(
            'local',
            agent.installed && agent.capabilities.terminal ? 'available' : 'unsupported',
            agent.installed && agent.capabilities.terminal
              ? 'Ready for an explicit local live check.'
              : 'A local terminal launch is unavailable.',
            now,
          ),
          capability('ssh', agent.capabilities.remote, 'Ready to test on a saved SSH host.'),
          capability(
            'image_path',
            agent.capabilities.images,
            'Copy an image and run the optional image check after the core check.',
          ),
          checked(
            'image_response',
            agent.capabilities.images ? 'not_run' : 'unsupported',
            agent.capabilities.images
              ? 'A real model response is required.'
              : 'The Adapter does not declare image input.',
            null,
          ),
          capability(
            'lifecycle_working',
            agent.capabilities.lifecycle !== 'none',
            'Observed automatically during a live check.',
          ),
          capability(
            'lifecycle_needs_user',
            agent.capabilities.lifecycle !== 'none',
            'Recorded when a login, trust or approval gate is actually shown.',
          ),
          capability(
            'lifecycle_done',
            agent.capabilities.lifecycle !== 'none',
            'Observed automatically after the response settles.',
          ),
          capability('acp', agent.capabilities.acp, 'Declared by the Adapter contract.'),
          capability(
            'exact_resume',
            agent.capabilities.exactResume,
            'Declared by the Adapter contract.',
          ),
          capability('history', agent.capabilities.history, 'Declared by the Adapter contract.'),
          checked(
            'skills',
            agent.capabilities.skills ? 'available' : 'unsupported',
            agent.capabilities.skills
              ? `${skillRoots.filter(existsSync).length}/${skillRoots.length} declared Skill locations currently exist.`
              : 'The Adapter does not declare Skills.',
            now,
          ),
          checked(
            'instructions',
            agent.capabilities.instructions ? 'available' : 'unsupported',
            agent.capabilities.instructions
              ? `${instructionRoots.filter(existsSync).length}/${instructionRoots.length} declared instruction locations currently exist.`
              : 'The Adapter does not declare instruction files.',
            now,
          ),
        ];
        return {
          agentId: agent.id,
          displayName: agent.displayName,
          installed: agent.installed,
          version,
          level: livePassed
            ? 'locally_verified'
            : integrationTested
              ? 'integration_tested'
              : sourceVerified
                ? 'source_verified'
                : 'unverified',
          checks,
          latestRuns: runs.slice(0, 4),
        } satisfies AgentVerificationAgent;
      }),
      privacy: {
        storesPrompt: false,
        storesTerminalOutput: false,
        storesWorkspacePath: false,
        storesAccountIdentity: false,
      },
    };
  }

  begin(input: { agentId: string; mode: 'core' | 'image'; target: 'local' | 'ssh' }): {
    run: AgentVerificationRun;
    prompt: string;
  } {
    const agent = this.registry
      .catalog()
      .agents.find((candidate) => candidate.id === input.agentId);
    if (!agent) throw failure('AGENT_VERIFICATION_UNKNOWN', 'That Agent is not registered.');
    if (!agent.installed && input.target === 'local') {
      throw failure(
        'AGENT_NOT_AVAILABLE',
        `${agent.displayName} is not installed on this computer.`,
      );
    }
    if (input.target === 'ssh' && !agent.capabilities.remote) {
      throw failure(
        'AGENT_VERIFICATION_SSH_UNSUPPORTED',
        `${agent.displayName} does not support SSH launch.`,
      );
    }
    if (input.mode === 'image' && !agent.capabilities.images) {
      throw failure(
        'AGENT_VERIFICATION_IMAGE_UNSUPPORTED',
        `${agent.displayName} does not declare image input support.`,
      );
    }
    for (const active of this.active.values()) {
      if (active.run.agentId === input.agentId && active.run.mode === input.mode) {
        throw failure(
          'AGENT_VERIFICATION_ALREADY_RUNNING',
          `A ${input.mode} check for ${agent.displayName} is already running.`,
        );
      }
    }
    const challenge = (this.options.challenge?.() ?? randomBytes(6).toString('hex'))
      .replace(/[^a-z0-9]/gi, '')
      .slice(0, 24);
    const suffix = [...challenge].reverse().join('');
    const expectedReply = `CHARTER_AGENT_REPLY_${suffix}`;
    const prompt =
      input.mode === 'core'
        ? `Charter compatibility check. Do not inspect or modify files and do not run tools. Reply with exactly CHARTER_AGENT_REPLY_ followed by the reverse of this challenge, and nothing else. Challenge: ${challenge}`
        : `Charter image compatibility check. Inspect only the attached image. Do not modify files or run tools. Then reply with exactly CHARTER_AGENT_REPLY_ followed by the reverse of this challenge, and nothing else. Challenge: ${challenge}`;
    const now = this.nowIso();
    const run: AgentVerificationRun = {
      id: this.options.randomId?.() ?? `verify_${randomUUID()}`,
      agentId: input.agentId,
      mode: input.mode,
      target: input.target,
      status: 'pending',
      startedAt: now,
      updatedAt: now,
      terminalId: null,
      checks:
        input.mode === 'core'
          ? [
              checked('launch', 'not_run', 'Waiting for the Agent process.', null),
              checked('authentication', 'not_run', 'Waiting for a real model response.', null),
              checked(
                'prompt_response',
                'not_run',
                'Waiting for the random challenge reply.',
                null,
              ),
              checked(
                input.target === 'local' ? 'local' : 'ssh',
                'not_run',
                'Waiting for the terminal attachment.',
                null,
              ),
              checked(
                'lifecycle_working',
                agent.capabilities.lifecycle === 'none' ? 'unsupported' : 'not_run',
                agent.capabilities.lifecycle === 'none'
                  ? 'The Adapter does not declare lifecycle observation.'
                  : 'Waiting for Working evidence.',
                null,
              ),
              checked(
                'lifecycle_needs_user',
                agent.capabilities.lifecycle === 'none' ? 'unsupported' : 'not_run',
                agent.capabilities.lifecycle === 'none'
                  ? 'The Adapter does not declare lifecycle observation.'
                  : 'Passes only if a real login, trust or approval gate appears.',
                null,
              ),
              checked(
                'lifecycle_done',
                agent.capabilities.lifecycle === 'none' ? 'unsupported' : 'not_run',
                agent.capabilities.lifecycle === 'none'
                  ? 'The Adapter does not declare lifecycle observation.'
                  : 'Waiting for Done evidence.',
                null,
              ),
            ]
          : [
              checked('image_path', 'not_run', 'Waiting for clipboard image delivery.', null),
              checked('image_response', 'not_run', 'Waiting for a real model response.', null),
            ],
      message:
        input.mode === 'core'
          ? 'Starting a visible Agent terminal. Complete login or trust prompts there if asked.'
          : 'Copy an image before sending this check.',
    };
    const timeout = setTimeout(
      () =>
        this.finish(run.id, 'timed_out', 'The live check timed out. The terminal was left open.'),
      this.options.timeoutMs ?? RUN_TIMEOUT_MS,
    );
    timeout.unref?.();
    this.active.set(run.id, { run, expectedReply, responseTail: '', timeout });
    return { run, prompt };
  }

  attach(runId: string, terminalId: string): AgentVerificationRun {
    const active = this.mustActive(runId);
    const terminal = this.terminals.list().find((candidate) => candidate.id === terminalId);
    if (!terminal || terminal.launch !== active.run.agentId) {
      throw failure(
        'AGENT_VERIFICATION_TERMINAL_MISMATCH',
        'The verification terminal does not match this Agent.',
      );
    }
    if ((active.run.target === 'ssh') !== Boolean(terminal.remote)) {
      throw failure(
        'AGENT_VERIFICATION_TARGET_MISMATCH',
        'The verification terminal does not match the selected local or SSH target.',
      );
    }
    active.run = {
      ...active.run,
      terminalId,
      status: 'running',
      updatedAt: this.nowIso(),
      message:
        active.run.mode === 'core'
          ? 'Waiting for launch, semantic state and the random challenge reply.'
          : 'Waiting for the image and random challenge reply.',
    };
    if (active.run.mode === 'core') {
      this.pass(
        active,
        active.run.target === 'local' ? 'local' : 'ssh',
        active.run.target === 'local'
          ? 'A real local PTY was created.'
          : 'A real terminal was created on the selected SSH host.',
      );
      this.onAgentState(terminalId, this.terminals.agentFor(terminalId));
      const snapshot = this.presence.get(terminalId);
      if (snapshot) this.onPresence(snapshot);
    }
    this.onData(terminalId, this.terminals.recentData(terminalId));
    return active.run;
  }

  noteImagePasted(terminalId: string): void {
    for (const active of this.active.values()) {
      if (active.run.mode === 'image' && active.run.terminalId === terminalId) {
        this.pass(
          active,
          'image_path',
          'Charter staged and delivered a real clipboard image path.',
        );
      }
    }
  }

  getRun(runId: string): AgentVerificationRun | null {
    return this.active.get(runId)?.run ?? this.storedRuns.find((run) => run.id === runId) ?? null;
  }

  cancel(runId: string): AgentVerificationRun {
    const active = this.mustActive(runId);
    this.finish(runId, 'cancelled', 'Verification stopped. The Agent terminal was left open.');
    return this.getRun(runId) ?? active.run;
  }

  exportBundle(input: { appVersion: string; platform: string }): {
    suggestedName: string;
    markdown: string;
    json: string;
  } {
    const snapshot = this.snapshot();
    const exported = {
      schemaVersion: 1,
      exportedAt: snapshot.generatedAt,
      appVersion: input.appVersion,
      platform: input.platform,
      privacy: snapshot.privacy,
      agents: snapshot.agents.map((agent) => ({
        agentId: agent.agentId,
        displayName: agent.displayName,
        installed: agent.installed,
        version: agent.version,
        level: agent.level,
        checks: agent.checks,
        runs: agent.latestRuns.map(({ terminalId: _terminalId, ...run }) => run),
      })),
    };
    const lines = [
      '# Charter Agent Compatibility Report',
      '',
      `Exported: ${snapshot.generatedAt}`,
      `Charter: ${input.appVersion}`,
      `Platform: ${input.platform}`,
      '',
      '> Privacy: this report contains no prompts, terminal output, workspace paths, executable paths, host names, usernames, tokens or account identities.',
      '',
      '| Agent | Installed | Version | Verification |',
      '|---|---:|---|---|',
      ...snapshot.agents.map(
        (agent) =>
          `| ${escapeMarkdown(agent.displayName)} | ${agent.installed ? 'Yes' : 'No'} | ${escapeMarkdown(agent.version ?? '—')} | ${agent.level} |`,
      ),
    ];
    for (const agent of snapshot.agents) {
      lines.push(
        '',
        `## ${escapeMarkdown(agent.displayName)}`,
        '',
        '| Check | Status | Detail |',
        '|---|---|---|',
      );
      for (const check of agent.checks) {
        lines.push(
          `| ${escapeMarkdown(check.label)} | ${check.status} | ${escapeMarkdown(check.detail)} |`,
        );
      }
      for (const run of agent.latestRuns) {
        lines.push(
          '',
          `Live ${run.mode} check (${run.target}): **${run.status}** at ${run.updatedAt}`,
        );
        for (const check of run.checks) {
          lines.push(
            `- ${escapeMarkdown(check.label)}: ${check.status} — ${escapeMarkdown(check.detail)}`,
          );
        }
      }
    }
    return {
      suggestedName: `charter-agent-compatibility-${snapshot.generatedAt.slice(0, 10)}`,
      markdown: `${lines.join('\n')}\n`,
      json: `${JSON.stringify(exported, null, 2)}\n`,
    };
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    for (const active of this.active.values()) clearTimeout(active.timeout);
    this.active.clear();
  }

  private onAgentState(terminalId: string, agent: string | null): void {
    for (const active of this.attached(terminalId, 'core')) {
      if (agent === active.run.agentId) {
        this.pass(active, 'launch', `The ${active.run.agentId} process was observed in the PTY.`);
      }
    }
  }

  private onData(terminalId: string, data: string): void {
    if (!data) return;
    for (const active of this.attached(terminalId)) {
      active.responseTail = `${active.responseTail}${data}`.slice(-8_192);
      if (!active.responseTail.includes(active.expectedReply)) continue;
      if (active.run.mode === 'core') {
        this.pass(
          active,
          'prompt_response',
          'The model returned the unpredictable challenge answer.',
        );
        this.pass(active, 'authentication', 'A real provider response was received.');
      } else {
        this.pass(active, 'image_response', 'The model replied after the image was delivered.');
      }
    }
  }

  private onPresence(snapshot: AgentPresenceSnapshot): void {
    for (const active of this.attached(snapshot.terminalId, 'core')) {
      if (snapshot.agent !== active.run.agentId) continue;
      this.pass(active, 'launch', `The ${snapshot.agent} process was observed in the PTY.`);
      if (snapshot.lifecycle === 'working') {
        this.pass(active, 'lifecycle_working', 'Charter observed the Agent in Working state.');
        active.run = { ...active.run, status: 'running', message: 'The Agent is working.' };
      }
      if (snapshot.lifecycle === 'blocked') {
        this.pass(
          active,
          'lifecycle_needs_user',
          'Charter observed a real login, trust or approval blocker.',
        );
        active.run = {
          ...active.run,
          status: 'needs_user',
          message: 'The Agent needs input in the visible terminal.',
        };
      }
      if (snapshot.lifecycle === 'idle' && snapshot.attention === 'done') {
        this.pass(active, 'lifecycle_done', 'Charter observed the reply settle as Done.');
      }
      this.evaluate(active);
    }
  }

  private onExit(terminalId: string): void {
    for (const active of this.attached(terminalId)) {
      this.finish(
        active.run.id,
        'failed',
        'The Agent process exited before verification completed.',
      );
    }
  }

  private pass(active: ActiveRun, id: AgentVerificationCheckId, detail: string): void {
    const now = this.nowIso();
    active.run = {
      ...active.run,
      updatedAt: now,
      checks: active.run.checks.map((check) =>
        check.id === id ? { ...check, status: 'passed', detail, checkedAt: now } : check,
      ),
    };
    this.evaluate(active);
  }

  private evaluate(active: ActiveRun): void {
    const candidates: AgentVerificationCheckId[] =
      active.run.mode === 'image'
        ? ['image_path', 'image_response']
        : [
            'launch',
            'authentication',
            'prompt_response',
            active.run.target === 'local' ? 'local' : 'ssh',
            'lifecycle_working',
            'lifecycle_done',
          ];
    const required = candidates.filter(
      (id) => active.run.checks.find((check) => check.id === id)?.status !== 'unsupported',
    );
    if (
      required.every(
        (id) => active.run.checks.find((check) => check.id === id)?.status === 'passed',
      )
    ) {
      this.finish(
        active.run.id,
        'passed',
        active.run.mode === 'core'
          ? 'Real launch, login, Prompt response and lifecycle checks passed.'
          : 'Real clipboard image delivery and model response checks passed.',
      );
    }
  }

  private finish(
    runId: string,
    status: Extract<
      AgentVerificationRun['status'],
      'passed' | 'failed' | 'cancelled' | 'timed_out'
    >,
    message: string,
  ): void {
    const active = this.active.get(runId);
    if (!active) return;
    clearTimeout(active.timeout);
    active.run = { ...active.run, status, message, updatedAt: this.nowIso() };
    this.active.delete(runId);
    this.storedRuns = [active.run, ...this.storedRuns.filter((run) => run.id !== runId)].slice(
      0,
      MAX_STORED_RUNS,
    );
    this.save();
    this.logger.info('agent verification finished', {
      runId,
      agentId: active.run.agentId,
      mode: active.run.mode,
      target: active.run.target,
      status,
    });
  }

  private attached(terminalId: string, mode?: 'core' | 'image'): ActiveRun[] {
    return [...this.active.values()].filter(
      (active) => active.run.terminalId === terminalId && (!mode || active.run.mode === mode),
    );
  }

  private mustActive(runId: string): ActiveRun {
    const active = this.active.get(runId);
    if (!active) {
      throw failure(
        'AGENT_VERIFICATION_NOT_ACTIVE',
        'That verification check is no longer active.',
      );
    }
    return active;
  }

  private runsFor(agentId: string): AgentVerificationRun[] {
    return [...this.active.values()]
      .map((active) => active.run)
      .concat(this.storedRuns)
      .filter((run) => run.agentId === agentId)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const parsed = StoredStateSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      if (!parsed.success) throw new Error(parsed.error.message);
      this.storedRuns = parsed.data.runs.map((run) =>
        run.status === 'pending' || run.status === 'running' || run.status === 'needs_user'
          ? {
              ...run,
              status: 'timed_out' as const,
              terminalId: null,
              message: 'Charter closed before this verification completed.',
            }
          : run,
      );
    } catch (error) {
      this.logger.warn('agent verification ledger ignored', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.storedRuns = [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ schemaVersion: 1, runs: this.storedRuns }, null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(temporary, this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // Best effort on filesystems without POSIX permissions.
    }
  }
}
