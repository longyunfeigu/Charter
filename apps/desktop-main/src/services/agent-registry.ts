import { accessSync, constants, existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  type AgentAdapterDiagnostic,
  type AgentCatalogDto,
  type AgentCatalogCapabilities,
  type DetectedAgentDto,
} from '@pi-ide/ipc-contracts';
import type { Logger } from '@pi-ide/foundation';
import {
  AGENT_ADAPTER_ENGINE_VERSION,
  AgentAdapterManifestSchema,
  BUILTIN_AGENT_ADAPTERS,
  adapterEngineCompatible,
  type AgentAdapterManifest,
  type AgentLifecycleManifest,
} from './agent-adapter-manifest.js';

/** Compatibility alias for services that consume one declarative Adapter. */
export type AgentManifest = AgentAdapterManifest;

export interface AgentLaunchSpec {
  executable: string;
  args: string[];
  promptDelivery: 'argv' | 'deferred';
  sessionId: string | null;
}

export interface AgentAcpCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AgentRemoteLaunchSpec {
  command: string;
  args: string[];
  promptDelivery: 'argv' | 'deferred';
  sessionId: string | null;
}

export type AgentTerminalExitAction = 'interrupt' | 'eof';
export type AgentStartupAction = 'up' | 'down' | 'left' | 'right' | 'enter';

export interface AgentStartupState {
  trustGateActive: boolean;
  composerReady: boolean;
  updateGateActive: boolean;
  updateActions: AgentStartupAction[];
  deferInitialProbe: boolean;
}

function expand(value: string, home: string, dataHome = home): string {
  return value.replaceAll('{home}', home).replaceAll('{dataHome}', dataHome);
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function nativePath(pathValue: string): string[] {
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .filter((directory) => !/(^|[/\\])node_modules[/\\]\.bin[/\\]?$/.test(directory));
}

function versionedBinDirs(root: string, suffix: readonly string[] = ['bin']): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .slice(0, 64)
      .map((name) => join(root, name, ...suffix));
  } catch {
    return [];
  }
}

/** GUI-launched desktop apps inherit a minimal PATH. Search the bounded,
 * user-owned locations used by common native and Node CLI installers after
 * PATH and manifest-specific paths, without invoking a login shell. */
function fallbackCliDirs(home: string): string[] {
  return dedupe([
    join(home, '.local', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.local', 'share', 'mise', 'shims'),
    join(home, '.fnm', 'aliases', 'default', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, 'Library', 'pnpm'),
    ...versionedBinDirs(join(home, '.nvm', 'versions', 'node')),
    ...versionedBinDirs(join(home, '.local', 'share', 'fnm', 'node-versions'), [
      'installation',
      'bin',
    ]),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]);
}

function fillArgs(
  template: readonly string[] | undefined,
  values: { prompt?: string; sessionId?: string },
): string[] {
  return (template ?? []).map((value) =>
    value
      .replaceAll('{prompt}', values.prompt ?? '')
      .replaceAll('{sessionId}', values.sessionId ?? ''),
  );
}

function compactStartupText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, '');
}

function lastMarker(text: string, markers: readonly string[]): number {
  return markers.reduce(
    (latest, marker) => Math.max(latest, text.lastIndexOf(compactStartupText(marker))),
    -1,
  );
}

/** Pure evaluation for recorded startup fixtures. Marker ownership lives in
 * the Adapter; the engine only compares the newest gate/ready paint. */
export function evaluateAdapterStartup(
  manifest: AgentManifest | null,
  output: string,
  bracketedPasteReady: boolean,
): AgentStartupState {
  const startup = manifest?.terminal?.startup;
  if (!startup) {
    return {
      trustGateActive: false,
      composerReady: bracketedPasteReady,
      updateGateActive: false,
      updateActions: [],
      deferInitialProbe: false,
    };
  }
  const compact = compactStartupText(output);
  const gate = lastMarker(compact, startup.gateMarkers);
  const ready = lastMarker(compact, startup.readyMarkers);
  const trustGateActive = gate >= 0 && gate > ready;
  const readinessEvidence = startup.readyRequired
    ? ready >= 0 && ready > gate
    : gate < 0 || (ready >= 0 && ready > gate);
  const update = startup.updateGate ? lastMarker(compact, startup.updateGate.markers) : -1;
  return {
    trustGateActive,
    composerReady: readinessEvidence && (!startup.requireBracketedPaste || bracketedPasteReady),
    updateGateActive: update >= 0 && update > ready,
    updateActions: [...(startup.updateGate?.actions ?? [])],
    deferInitialProbe: startup.deferInitialProbe,
  };
}

/**
 * Trusted, capability-driven catalog for external coding Agents. Core product
 * code resolves an opaque agent id through this registry; provider-specific
 * commands and paths remain data in manifests rather than branching logic.
 */
export class AgentRegistry {
  private readonly manifests = new Map<string, AgentManifest>();
  private readonly sources = new Map<
    string,
    { kind: 'builtin' | 'pack' | 'override'; path: string | null }
  >();
  private readonly detected = new Map<string, string | null>();
  private readonly versions = new Map<string, string | null>();
  private readonly diagnostics: AgentAdapterDiagnostic[] = [];
  private readonly overrideEnabled: boolean;
  private scannedAt = new Date(0).toISOString();

  constructor(
    private readonly logger: Logger,
    private readonly options: {
      homeDir?: string;
      pathValue?: string;
      userManifestDir?: string | null;
      /** Enabled manifests from the durable user Pack store. Pack Adapters
       * augment built-ins but are never allowed to replace them. */
      packManifests?: () => Array<{
        manifest: AgentAdapterManifest;
        sourcePath: string;
        packId: string;
      }>;
      /** Local Adapter overrides are a developer feature. Packaged builds
       * leave this false unless an explicit developer switch enables it. */
      allowOverrides?: boolean;
      probeVersions?: boolean;
    } = {},
  ) {
    this.overrideEnabled = options.allowOverrides === true;
    this.reload();
  }

  /** Rebuild the trusted manifest set after a Pack mutation, then re-run host
   * discovery. Existing consumers keep this registry object and immediately
   * observe the new contracts. */
  reload(): AgentCatalogDto {
    this.manifests.clear();
    this.sources.clear();
    this.detected.clear();
    this.versions.clear();
    this.diagnostics.splice(0);
    for (const { manifest, source, sourcePath } of this.loadManifests()) {
      this.manifests.set(manifest.id, manifest);
      this.sources.set(manifest.id, { kind: source, path: sourcePath });
    }
    return this.refresh();
  }

  refresh(): AgentCatalogDto {
    const pathValue = this.options.pathValue ?? process.env.PATH ?? '';
    const home = this.options.homeDir ?? homedir();
    const fallbackDirs = fallbackCliDirs(home);
    for (const manifest of this.manifests.values()) {
      const candidates = dedupe([
        ...manifest.discovery.commands.flatMap((name) =>
          nativePath(pathValue).map((directory) => join(directory, name)),
        ),
        ...manifest.discovery.knownPaths.map((value) => expand(value, home)),
        ...manifest.discovery.commands.flatMap((name) =>
          fallbackDirs.map((directory) => join(directory, name)),
        ),
      ]);
      const found = candidates.find(executable) ?? null;
      this.detected.set(manifest.id, found);
      this.versions.set(manifest.id, found ? this.probeVersion(found, manifest) : null);
    }
    this.scannedAt = new Date().toISOString();
    return this.catalog();
  }

  catalog(): AgentCatalogDto {
    return {
      agents: [...this.manifests.values()].map((manifest) => this.dto(manifest)),
      scannedAt: this.scannedAt,
      engineVersion: AGENT_ADAPTER_ENGINE_VERSION,
      overrideEnabled: this.overrideEnabled,
      diagnostics: [...this.diagnostics],
    };
  }

  manifest(agentId: string): AgentManifest | null {
    return this.manifests.get(agentId) ?? null;
  }

  isKnown(agentId: string): boolean {
    return this.manifests.has(agentId);
  }

  lifecycleManifests(): readonly AgentLifecycleManifest[] {
    return [...this.manifests.values()].flatMap((manifest) =>
      manifest.capabilities.lifecycle !== 'none' && manifest.lifecycle ? [manifest.lifecycle] : [],
    );
  }

  installed(agentId: string): boolean {
    return Boolean(this.detected.get(agentId));
  }

  executableFor(agentId: string): string | null {
    return this.detected.get(agentId) ?? null;
  }

  terminalAgentIds(): string[] {
    return [...this.manifests.values()]
      .filter(
        (manifest) =>
          manifest.capabilities.terminal && manifest.terminal && this.installed(manifest.id),
      )
      .map((manifest) => manifest.id);
  }

  /** All declared terminal Agent ids, including remote-only installations.
   * Process observation and SSH known-agent declaration must not depend on
   * whether the same CLI also happens to be installed on this Mac. */
  terminalAgentManifestIds(): string[] {
    return [...this.manifests.values()]
      .filter((manifest) => manifest.capabilities.terminal && manifest.terminal)
      .map((manifest) => manifest.id);
  }

  /** Canonical Adapter ids plus every executable alias accepted by process
   * observation. Terminal state must report the Adapter id even when the
   * foreground binary has a different name (for example cursor-agent). */
  terminalAgentCliIdentities(): Array<{ id: string; aliases: string[] }> {
    return [...this.manifests.values()]
      .filter((manifest) => manifest.capabilities.terminal && manifest.terminal)
      .map((manifest) => ({
        id: manifest.id,
        aliases: dedupe([
          manifest.id,
          ...manifest.discovery.commands,
          ...(manifest.lifecycle?.aliases ?? []),
        ]).filter((alias) => /^[a-z0-9][a-z0-9._-]*$/i.test(alias)),
      }));
  }

  acpAgentIds(): string[] {
    return [...this.manifests.values()]
      .filter(
        (manifest) => manifest.capabilities.acp && manifest.acp && this.installed(manifest.id),
      )
      .map((manifest) => manifest.id);
  }

  displayName(agentId: string): string {
    return this.manifest(agentId)?.displayName ?? agentId;
  }

  preassignSessionId(agentId: string): boolean {
    return this.manifest(agentId)?.sessions?.preassignId === true;
  }

  sessionIdentityConnector(agentId: string): string | null {
    return this.manifest(agentId)?.sessions?.identityConnector ?? null;
  }

  /** Adapter-selected native history source for one running Agent. Unlike the
   * catalog projection this does not require a fresh PATH probe: observing the
   * Agent process in a terminal is already stronger availability evidence. */
  sessionHistorySource(
    agentId: string,
    homeOverride?: string,
  ): { connector: string; dataHome: string } | null {
    const manifest = this.manifest(agentId);
    const connector = manifest?.sessions?.historyConnector;
    if (!manifest?.capabilities.history || !connector) return null;
    return {
      connector,
      dataHome: this.providerDataHome(manifest, homeOverride),
    };
  }

  terminalExitSequence(agentId: string): AgentTerminalExitAction[] {
    return [...(this.manifest(agentId)?.terminal?.exitSequence ?? ['interrupt', 'eof'])];
  }

  startupState(agentId: string, output: string, bracketedPasteReady: boolean): AgentStartupState {
    return evaluateAdapterStartup(this.manifest(agentId), output, bracketedPasteReady);
  }

  sessionIdSafe(agentId: string, sessionId: string): boolean {
    const pattern = this.manifest(agentId)?.sessions?.idPattern;
    if (!pattern || sessionId.length > 200) return false;
    try {
      return new RegExp(pattern, 'i').test(sessionId);
    } catch {
      return false;
    }
  }

  launchSpec(
    agentId: string,
    input: { prompt?: string | null; sessionId?: string | null } = {},
  ): AgentLaunchSpec | null {
    const manifest = this.manifest(agentId);
    const path = this.executableFor(agentId);
    if (!manifest?.capabilities.terminal || !manifest.terminal || !path) return null;
    const sessionId =
      input.sessionId && this.sessionIdSafe(agentId, input.sessionId) ? input.sessionId : null;
    const args = [
      ...fillArgs(manifest.terminal.newSessionArgs, { sessionId: sessionId ?? undefined }),
      ...(input.prompt && manifest.terminal.promptDelivery === 'argv'
        ? fillArgs(manifest.terminal.initialPromptArgs, { prompt: input.prompt })
        : []),
    ];
    return {
      executable: path,
      args,
      promptDelivery: manifest.terminal.promptDelivery,
      sessionId,
    };
  }

  /** Host-owned command used only when preserving an interactive login shell. */
  terminalShellCommand(
    agentId: string,
    input: { prompt?: string | null; sessionId?: string | null } = {},
  ): { command: string; promptDelivery: 'argv' | 'deferred'; sessionId: string | null } | null {
    const spec = this.launchSpec(agentId, input);
    if (!spec) return null;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    return {
      command: [spec.executable, ...spec.args].map(quote).join(' '),
      promptDelivery: spec.promptDelivery,
      sessionId: spec.sessionId,
    };
  }

  /** Manifest-owned remote launch independent of this Mac's PATH. SSH probes
   * and invokes the primary declared command on the other host, while argv vs
   * deferred Prompt semantics remain identical to local Sessions. */
  remoteLaunchSpec(
    agentId: string,
    input: { prompt?: string | null; sessionId?: string | null } = {},
  ): AgentRemoteLaunchSpec | null {
    const manifest = this.manifest(agentId);
    if (
      !manifest?.capabilities.terminal ||
      !manifest.capabilities.remote ||
      !manifest.terminal ||
      !manifest.discovery.commands[0]
    ) {
      return null;
    }
    const sessionId =
      input.sessionId && this.sessionIdSafe(agentId, input.sessionId) ? input.sessionId : null;
    return {
      command: manifest.discovery.commands[0],
      args: [
        ...(sessionId ? fillArgs(manifest.terminal.newSessionArgs, { sessionId }) : []),
        ...(input.prompt && manifest.terminal.promptDelivery === 'argv'
          ? fillArgs(manifest.terminal.initialPromptArgs, { prompt: input.prompt })
          : []),
      ],
      promptDelivery: manifest.terminal.promptDelivery,
      sessionId,
    };
  }

  resumeCommand(
    agentId: string,
    sessionId?: string | null,
  ): { executable: string; args: string[] } | null {
    const path = this.executableFor(agentId);
    const args = this.resumeArguments(agentId, sessionId);
    return path && args ? { executable: path, args } : null;
  }

  /** Manifest-owned resume arguments without requiring the Agent to be
   * installed on this Mac. Managed SSH Sessions use these arguments with the
   * independently probed executable on the remote server. */
  resumeArguments(agentId: string, sessionId?: string | null): string[] | null {
    const manifest = this.manifest(agentId);
    if (!manifest?.sessions || !manifest.capabilities.exactResume) return null;
    if (sessionId && this.sessionIdSafe(agentId, sessionId) && manifest.sessions.resumeArgs) {
      return fillArgs(manifest.sessions.resumeArgs, { sessionId });
    }
    return manifest.sessions.continueArgs ? [...manifest.sessions.continueArgs] : null;
  }

  acpCommand(
    agentId: string,
    input: { runtimeAppPath: string; nodeExecutable: string; env?: Record<string, string> },
  ): AgentAcpCommand | null {
    const manifest = this.manifest(agentId);
    if (!manifest?.capabilities.acp || !manifest.acp) return null;
    if (manifest.acp.kind === 'native') {
      const path = this.executableFor(agentId);
      return path ? { command: path, args: [...manifest.acp.args], env: input.env } : null;
    }
    return {
      command: input.nodeExecutable,
      args: [
        join(
          input.runtimeAppPath,
          'node_modules',
          '@agentclientprotocol',
          manifest.acp.package,
          'dist',
          'index.js',
        ),
      ],
      env: input.env,
    };
  }

  skillRoots(agentId: string, homeOverride?: string): string[] {
    const home = homeOverride ?? this.options.homeDir ?? homedir();
    const manifest = this.manifest(agentId);
    if (!manifest) return [];
    const dataHome = this.providerDataHome(manifest, homeOverride);
    return manifest.surfaces.skillRoots.map((value) => expand(value, home, dataHome));
  }

  instructionRoots(agentId: string, homeOverride?: string): string[] {
    const home = homeOverride ?? this.options.homeDir ?? homedir();
    const manifest = this.manifest(agentId);
    if (!manifest) return [];
    const dataHome = this.providerDataHome(manifest, homeOverride);
    return manifest.surfaces.instructionRoots.map((value) => expand(value, home, dataHome));
  }

  /** Primary provider-owned skill roots. Shared ~/.agents/skills remains its own catalog source. */
  skillSources(homeOverride?: string): Array<{ id: string; label: string; root: string }> {
    const home = resolve(homeOverride ?? this.options.homeDir ?? homedir());
    const shared = resolve(home, '.agents', 'skills');
    return [...this.manifests.values()]
      .filter((manifest) => manifest.capabilities.skills && this.installed(manifest.id))
      .flatMap((manifest) => {
        const root = this.skillRoots(manifest.id, homeOverride)[0];
        return root && resolve(root) !== shared
          ? [{ id: manifest.id, label: manifest.displayName, root: resolve(root) }]
          : [];
      });
  }

  historySources(
    homeOverride?: string,
  ): Array<{ id: string; connector: string; dataHome: string }> {
    const home = resolve(homeOverride ?? this.options.homeDir ?? homedir());
    return [...this.manifests.values()].flatMap((manifest) => {
      const sessions = manifest.sessions;
      if (
        !manifest.capabilities.history ||
        !sessions?.historyConnector ||
        !this.installed(manifest.id)
      ) {
        return [];
      }
      const dataHome = this.providerDataHome(manifest, homeOverride);
      return [{ id: manifest.id, connector: sessions.historyConnector, dataHome }];
    });
  }

  private providerDataHome(manifest: AgentManifest, homeOverride?: string): string {
    const pinnedHome = homeOverride ?? this.options.homeDir;
    const home = resolve(pinnedHome ?? homedir());
    const sessions = manifest.sessions;
    const envHome = !pinnedHome && sessions?.homeEnv ? process.env[sessions.homeEnv] : undefined;
    return envHome && isAbsolute(envHome)
      ? resolve(envHome)
      : resolve(expand(sessions?.defaultHome ?? home, home));
  }

  private dto(manifest: AgentManifest): DetectedAgentDto {
    const installed = this.installed(manifest.id);
    const declared = manifest.capabilities;
    const available = (value: boolean): boolean => value && installed;
    const capabilities: AgentCatalogCapabilities = {
      terminal: available(declared.terminal),
      acp: available(declared.acp),
      loadSession: available(declared.loadSession),
      sessionList: available(declared.sessionList),
      sessionResume: available(declared.sessionResume),
      images: available(declared.images),
      embeddedContext: available(declared.embeddedContext),
      mcp: available(declared.mcp),
      exactResume: available(declared.exactResume),
      history: available(declared.history),
      skills: available(declared.skills),
      instructions: available(declared.instructions),
      // Remote launch describes another host, so it intentionally does not
      // depend on whether this Mac has the same CLI installed.
      remote: declared.remote,
      lifecycle: declared.lifecycle,
    };
    const source = this.sources.get(manifest.id) ?? { kind: 'builtin' as const, path: null };
    return {
      id: manifest.id,
      displayName: manifest.displayName,
      shortName: manifest.shortName,
      description: manifest.description,
      mark: manifest.mark,
      accent: manifest.accent,
      installed,
      executable: this.executableFor(manifest.id),
      version: this.versions.get(manifest.id) ?? null,
      adapter: {
        schemaVersion: manifest.schemaVersion,
        adapterVersion: manifest.adapterVersion,
        engineMin: manifest.engine.min,
        engineMax: manifest.engine.max,
        source: source.kind,
        sourcePath: source.path,
        lifecycleVersion: manifest.lifecycle?.version ?? null,
        lifecycleAuthority: manifest.lifecycle?.authority ?? 'none',
      },
      capabilities,
      models: [],
    };
  }

  private probeVersion(path: string, manifest: AgentManifest): string | null {
    if (this.options.probeVersions === false || process.env.PI_IDE_E2E) return null;
    try {
      return (
        execFileSync(path, manifest.discovery.versionArgs, {
          encoding: 'utf8',
          timeout: 3_000,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .trim()
          .slice(0, 200) || null
      );
    } catch {
      return null;
    }
  }

  private loadManifests(): Array<{
    manifest: AgentManifest;
    source: 'builtin' | 'pack' | 'override';
    sourcePath: string | null;
  }> {
    const active = new Map<
      string,
      {
        manifest: AgentManifest;
        source: 'builtin' | 'pack' | 'override';
        sourcePath: string | null;
      }
    >();
    for (const manifest of BUILTIN_AGENT_ADAPTERS) {
      active.set(manifest.id, { manifest, source: 'builtin', sourcePath: null });
    }
    const packIds = new Set<string>();
    let packManifests: ReturnType<NonNullable<typeof this.options.packManifests>> = [];
    try {
      packManifests = this.options.packManifests?.() ?? [];
    } catch (error) {
      this.addDiagnostic({
        agentId: null,
        sourcePath: '<agent-pack-store>',
        severity: 'error',
        code: 'invalid-manifest',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    for (const entry of packManifests) {
      const parsed = AgentAdapterManifestSchema.safeParse(entry.manifest);
      if (!parsed.success || !adapterEngineCompatible(entry.manifest)) {
        this.addDiagnostic({
          agentId: entry.manifest.id,
          sourcePath: entry.sourcePath,
          severity: 'error',
          code: parsed.success ? 'incompatible-engine' : 'invalid-manifest',
          message: parsed.success
            ? `Adapter requires engine ${entry.manifest.engine.min}–${entry.manifest.engine.max}; Charter provides ${AGENT_ADAPTER_ENGINE_VERSION}.`
            : parsed.error.issues
                .slice(0, 6)
                .map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`)
                .join('; '),
        });
        continue;
      }
      if (active.has(entry.manifest.id) || packIds.has(entry.manifest.id)) {
        this.addDiagnostic({
          agentId: entry.manifest.id,
          sourcePath: entry.sourcePath,
          severity: 'error',
          code: 'duplicate-pack',
          message: `Agent Pack ${entry.packId} cannot replace the existing ${entry.manifest.id} Adapter.`,
        });
        continue;
      }
      packIds.add(entry.manifest.id);
      active.set(entry.manifest.id, {
        manifest: parsed.data,
        source: 'pack',
        sourcePath: entry.sourcePath,
      });
    }
    const dir = this.options.userManifestDir;
    if (dir && isAbsolute(dir) && existsSync(dir)) {
      const names = readdirSync(dir)
        .filter((item) => item.endsWith('.json'))
        .sort();
      if (!this.overrideEnabled && names.length > 0) {
        this.addDiagnostic({
          agentId: null,
          sourcePath: resolve(dir),
          severity: 'warning',
          code: 'override-disabled',
          message: 'Local Agent Adapter overrides are disabled outside developer mode.',
        });
        return [...active.values()];
      }
      const seen = new Set<string>();
      for (const name of names) {
        const path = resolve(dir, name);
        if (dirname(path) !== resolve(dir)) continue;
        let value: unknown;
        try {
          value = JSON.parse(readFileSync(path, 'utf8'));
        } catch (error) {
          this.addDiagnostic({
            agentId: null,
            sourcePath: path,
            severity: 'error',
            code: 'invalid-json',
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        const parsed = AgentAdapterManifestSchema.safeParse(value);
        if (!parsed.success) {
          const candidateId =
            value && typeof value === 'object' && 'id' in value && typeof value.id === 'string'
              ? value.id
              : null;
          this.addDiagnostic({
            agentId: candidateId,
            sourcePath: path,
            severity: 'error',
            code: 'invalid-manifest',
            message: parsed.error.issues
              .slice(0, 6)
              .map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`)
              .join('; '),
          });
          continue;
        }
        const manifest = parsed.data;
        if (!adapterEngineCompatible(manifest)) {
          this.addDiagnostic({
            agentId: manifest.id,
            sourcePath: path,
            severity: 'error',
            code: 'incompatible-engine',
            message: `Adapter requires engine ${manifest.engine.min}–${manifest.engine.max}; Charter provides ${AGENT_ADAPTER_ENGINE_VERSION}.`,
          });
          continue;
        }
        if (seen.has(manifest.id)) {
          this.addDiagnostic({
            agentId: manifest.id,
            sourcePath: path,
            severity: 'error',
            code: 'duplicate-override',
            message: `A local override for ${manifest.id} was already loaded; this file was ignored.`,
          });
          continue;
        }
        seen.add(manifest.id);
        active.set(manifest.id, { manifest, source: 'override', sourcePath: path });
      }
    }
    return [...active.values()];
  }

  private addDiagnostic(diagnostic: AgentAdapterDiagnostic): void {
    this.diagnostics.push(diagnostic);
    this.logger.warn('agent adapter diagnostic', diagnostic);
  }
}
