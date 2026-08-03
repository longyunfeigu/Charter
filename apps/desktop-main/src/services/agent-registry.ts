import { accessSync, constants, existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import {
  AgentIdSchema,
  type AgentCatalogDto,
  type AgentCatalogCapabilities,
  type DetectedAgentDto,
} from '@pi-ide/ipc-contracts';
import type { Logger } from '@pi-ide/foundation';
import builtinManifests from './builtin-agent-manifests.json';

const StringListSchema = z.array(z.string().min(1).max(2000)).max(32);
const AgentManifestSchema = z.object({
  id: AgentIdSchema,
  displayName: z.string().min(1).max(100),
  shortName: z.string().min(1).max(40),
  description: z.string().max(300).default(''),
  mark: z.string().min(1).max(40),
  accent: z.string().regex(/^#[0-9a-f]{6}$/i),
  discovery: z.object({
    commands: StringListSchema.min(1),
    knownPaths: StringListSchema.default([]),
    versionArgs: StringListSchema.default(['--version']),
  }),
  terminal: z
    .object({
      promptDelivery: z.enum(['argv', 'deferred']).default('deferred'),
      newSessionArgs: StringListSchema.optional(),
      initialPromptArgs: StringListSchema.optional(),
      /** Safe, host-owned PTY controls used to leave the interactive Agent
       * without closing the containing shell. A sequence is data rather than
       * provider logic because confirmation semantics differ between CLIs. */
      exitSequence: z
        .array(z.enum(['interrupt', 'eof']))
        .min(1)
        .max(4)
        .default(['interrupt', 'eof']),
    })
    .nullable()
    .default(null),
  acp: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('native'), args: StringListSchema.default(['acp']) }),
      z.object({ kind: z.literal('bundled'), package: z.string().min(1).max(100) }),
    ])
    .nullable()
    .default(null),
  sessions: z
    .object({
      idPattern: z.string().min(1).max(500),
      preassignId: z.boolean().default(false),
      resumeArgs: StringListSchema.optional(),
      continueArgs: StringListSchema.optional(),
      homeEnv: z.string().min(1).max(100).optional(),
      defaultHome: z.string().min(1).max(2000).optional(),
      historyConnector: z.string().min(1).max(100).optional(),
    })
    .nullable()
    .default(null),
  surfaces: z.object({
    skillRoots: StringListSchema.default([]),
    instructionRoots: StringListSchema.default([]),
    remote: z.boolean().default(false),
  }),
});

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

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

export type AgentTerminalExitAction = 'interrupt' | 'eof';

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

/**
 * Trusted, capability-driven catalog for external coding Agents. Core product
 * code resolves an opaque agent id through this registry; provider-specific
 * commands and paths remain data in manifests rather than branching logic.
 */
export class AgentRegistry {
  private readonly manifests = new Map<string, AgentManifest>();
  private readonly sources = new Map<string, 'builtin' | 'user'>();
  private readonly detected = new Map<string, string | null>();
  private readonly versions = new Map<string, string | null>();
  private scannedAt = new Date(0).toISOString();

  constructor(
    private readonly logger: Logger,
    private readonly options: {
      homeDir?: string;
      pathValue?: string;
      userManifestDir?: string | null;
      probeVersions?: boolean;
    } = {},
  ) {
    for (const { manifest, source } of this.loadManifests()) {
      this.manifests.set(manifest.id, manifest);
      this.sources.set(manifest.id, source);
    }
    this.refresh();
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
    };
  }

  manifest(agentId: string): AgentManifest | null {
    return this.manifests.get(agentId) ?? null;
  }

  isKnown(agentId: string): boolean {
    return this.manifests.has(agentId);
  }

  installed(agentId: string): boolean {
    return Boolean(this.detected.get(agentId));
  }

  executableFor(agentId: string): string | null {
    return this.detected.get(agentId) ?? null;
  }

  terminalAgentIds(): string[] {
    return [...this.manifests.values()]
      .filter((manifest) => manifest.terminal && this.installed(manifest.id))
      .map((manifest) => manifest.id);
  }

  acpAgentIds(): string[] {
    return [...this.manifests.values()]
      .filter((manifest) => manifest.acp && this.installed(manifest.id))
      .map((manifest) => manifest.id);
  }

  displayName(agentId: string): string {
    return this.manifest(agentId)?.displayName ?? agentId;
  }

  preassignSessionId(agentId: string): boolean {
    return this.manifest(agentId)?.sessions?.preassignId === true;
  }

  terminalExitSequence(agentId: string): AgentTerminalExitAction[] {
    return [...(this.manifest(agentId)?.terminal?.exitSequence ?? ['interrupt', 'eof'])];
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
    if (!manifest?.terminal || !path) return null;
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

  resumeCommand(
    agentId: string,
    sessionId?: string | null,
  ): { executable: string; args: string[] } | null {
    const manifest = this.manifest(agentId);
    const path = this.executableFor(agentId);
    if (!manifest?.sessions || !path) return null;
    if (sessionId && this.sessionIdSafe(agentId, sessionId) && manifest.sessions.resumeArgs) {
      return { executable: path, args: fillArgs(manifest.sessions.resumeArgs, { sessionId }) };
    }
    return manifest.sessions.continueArgs
      ? { executable: path, args: [...manifest.sessions.continueArgs] }
      : null;
  }

  acpCommand(
    agentId: string,
    input: { runtimeAppPath: string; nodeExecutable: string; env?: Record<string, string> },
  ): AgentAcpCommand | null {
    const manifest = this.manifest(agentId);
    if (!manifest?.acp) return null;
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

  /** Primary provider-owned skill roots. Shared ~/.agents/skills remains its own catalog source. */
  skillSources(homeOverride?: string): Array<{ id: string; label: string; root: string }> {
    const home = resolve(homeOverride ?? this.options.homeDir ?? homedir());
    const shared = resolve(home, '.agents', 'skills');
    return [...this.manifests.values()]
      .filter((manifest) => this.installed(manifest.id))
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
      if (!sessions?.historyConnector || !this.installed(manifest.id)) return [];
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
    const capabilities: AgentCatalogCapabilities = {
      terminal: Boolean(manifest.terminal && installed),
      acp: Boolean(manifest.acp && installed),
      loadSession: Boolean(manifest.acp && installed),
      sessionList: Boolean(manifest.acp && installed),
      sessionResume: Boolean(manifest.acp && installed),
      images: Boolean(manifest.acp && installed),
      embeddedContext: Boolean(manifest.acp && installed),
      mcp: Boolean(manifest.acp && installed),
      exactResume: Boolean(manifest.sessions?.resumeArgs && installed),
      history: Boolean(manifest.sessions?.historyConnector && installed),
      skills: Boolean(manifest.surfaces.skillRoots.length && installed),
      instructions: Boolean(manifest.surfaces.instructionRoots.length && installed),
      remote: Boolean(manifest.surfaces.remote && installed),
    };
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
      source: this.sources.get(manifest.id) ?? 'builtin',
      capabilities,
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

  private loadManifests(): Array<{ manifest: AgentManifest; source: 'builtin' | 'user' }> {
    const out: Array<{ manifest: AgentManifest; source: 'builtin' | 'user' }> = [];
    const load = (value: unknown, location: string, source: 'builtin' | 'user') => {
      const parsed = AgentManifestSchema.safeParse(value);
      if (parsed.success) out.push({ manifest: parsed.data, source });
      else
        this.logger.warn('agent manifest ignored', {
          source: location,
          error: parsed.error.message,
        });
    };
    for (const [index, value] of (builtinManifests as unknown[]).entries()) {
      load(value, `builtin:${index}`, 'builtin');
    }
    const dir = this.options.userManifestDir;
    if (dir && isAbsolute(dir) && existsSync(dir)) {
      for (const name of readdirSync(dir)
        .filter((item) => item.endsWith('.json'))
        .sort()) {
        const path = resolve(dir, name);
        if (dirname(path) !== resolve(dir)) continue;
        try {
          load(JSON.parse(readFileSync(path, 'utf8')), path, 'user');
        } catch (error) {
          this.logger.warn('agent manifest unreadable', {
            path,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return out;
  }
}
