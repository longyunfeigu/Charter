import { createPublicKey, verify } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { AgentIdSchema, type AgentPackCatalogDto, type AgentPackDto } from '@pi-ide/ipc-contracts';
import { ProductFailure, productError, type Logger } from '@pi-ide/foundation';
import {
  AGENT_ADAPTER_ENGINE_VERSION,
  AgentAdapterManifestSchema,
  BUILTIN_AGENT_ADAPTERS,
  adapterEngineCompatible,
  type AgentAdapterManifest,
} from './agent-adapter-manifest.js';
import { writeFileAtomicDurable } from './memory/fs-utils.js';
import officialPackData from './official-agent-pack.json';

const MAX_PACK_BYTES = 2 * 1024 * 1024;
const STATE_VERSION = 1;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const AgentPackSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: AgentIdSchema,
    version: z.string().min(1).max(100).regex(SEMVER),
    displayName: z.string().min(1).max(100),
    publisher: z.string().min(1).max(100),
    engine: z
      .object({ min: z.number().int().positive(), max: z.number().int().positive() })
      .strict(),
    adapters: z.array(AgentAdapterManifestSchema).min(1).max(16),
    signature: z
      .object({
        algorithm: z.literal('ed25519'),
        keyId: z.string().min(1).max(200),
        value: z.string().min(1).max(2_000),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((pack, context) => {
    if (pack.engine.min > pack.engine.max) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['engine'],
        message: 'engine.min must be less than or equal to engine.max',
      });
    }
    const ids = new Set<string>();
    for (const [index, adapter] of pack.adapters.entries()) {
      if (ids.has(adapter.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['adapters', index, 'id'],
          message: `duplicate Adapter id: ${adapter.id}`,
        });
      }
      ids.add(adapter.id);
    }
  });

type AgentPack = z.infer<typeof AgentPackSchema>;
type PackTrust = AgentPackDto['trust'];

interface PackStateEntry {
  enabled: boolean;
  currentVersion: string;
  previousVersion: string | null;
  installedAt: string;
  trust: PackTrust;
}

interface PackState {
  schemaVersion: 1;
  packs: Record<string, PackStateEntry>;
  /** Enablement is the only mutable state for app-bundled Packs. */
  official: Record<string, { enabled: boolean }>;
}

export interface InstalledPackManifest {
  manifest: AgentAdapterManifest;
  sourcePath: string;
  packId: string;
}

export interface AgentPackServiceOptions {
  /** Host-owned public keys. Explicit local imports may be unsigned; a pack
   * that claims a signature must verify against one of these keys. */
  trustedPublisherKeys?: Readonly<Record<string, string>>;
  now?: () => Date;
}

const OFFICIAL_PACK_INSTALLED_AT = '2026-08-12T00:00:00.000Z';
const OFFICIAL_PACK_SOURCE = '<bundled>/official-agent-pack.json';
const OFFICIAL_AGENT_PACKS: readonly AgentPack[] = z.array(AgentPackSchema).parse(officialPackData);
const OFFICIAL_PACK_BY_ID = new Map(OFFICIAL_AGENT_PACKS.map((pack) => [pack.id, pack]));

function fail(code: string, userMessage: string): ProductFailure {
  return new ProductFailure(productError(code, { userMessage }));
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/** Deterministic bytes signed by Pack publishers. Validation/defaulting occurs
 * first so signatures bind the exact manifest contract the engine consumes. */
export function agentPackSignaturePayload(value: unknown): Buffer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent Pack signature payload must be an object.');
  }
  const { signature: _signature, ...unsigned } = value as Record<string, unknown>;
  const parsed = AgentPackSchema.safeParse(unsigned);
  if (!parsed.success) throw new Error('Agent Pack signature payload is invalid.');
  return Buffer.from(canonicalJson(parsed.data), 'utf8');
}

function semverParts(value: string): [number, number, number, string[]] | null {
  const match = SEMVER.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4]?.split('.') ?? []];
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : null;
  const rightNumber = /^\d+$/.test(right) ? Number(right) : null;
  if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
  if (leftNumber !== null) return -1;
  if (rightNumber !== null) return 1;
  return left.localeCompare(right);
}

export function comparePackVersions(left: string, right: string): number {
  const a = semverParts(left);
  const b = semverParts(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return Number(a[index]) - Number(b[index]);
  }
  const aPre = a[3];
  const bPre = b[3];
  if (aPre.length === 0 || bPre.length === 0)
    return aPre.length === bPre.length ? 0 : aPre.length ? -1 : 1;
  for (let index = 0; index < Math.max(aPre.length, bPre.length); index += 1) {
    const ai = aPre[index];
    const bi = bPre[index];
    if (ai === undefined || bi === undefined) return ai === bi ? 0 : ai === undefined ? -1 : 1;
    const compared = compareIdentifiers(ai, bi);
    if (compared !== 0) return compared;
  }
  return 0;
}

/** Durable store for user-selected, declarative Agent Packs. Installation is
 * same-filesystem temp+rename; active versions are selected from a separate
 * state file, so a failed write can never leave a half-active Adapter. */
export class AgentPackService {
  private readonly stateFile: string;
  private readonly now: () => Date;
  private state: PackState;

  constructor(
    private readonly root: string,
    private readonly logger: Logger,
    private readonly options: AgentPackServiceOptions = {},
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.restrict(root, 0o700);
    this.stateFile = join(root, 'state.json');
    this.now = options.now ?? (() => new Date());
    this.state = this.readState();
  }

  catalog(): AgentPackCatalogDto {
    const official = OFFICIAL_AGENT_PACKS.map((pack) =>
      this.dto(
        pack,
        OFFICIAL_PACK_SOURCE,
        {
          enabled: this.state.official[pack.id]?.enabled ?? true,
          currentVersion: pack.version,
          previousVersion: null,
          installedAt: OFFICIAL_PACK_INSTALLED_AT,
          trust: 'verified',
        },
        true,
      ),
    );
    const user = Object.entries(this.state.packs).flatMap(([id, entry]) => {
      const loaded = this.readVersion(id, entry.currentVersion);
      return loaded ? [this.dto(loaded.pack, loaded.path, entry)] : [];
    });
    return {
      packs: [...official, ...user].sort((left, right) =>
        left.displayName.localeCompare(right.displayName),
      ),
    };
  }

  activeManifests(): InstalledPackManifest[] {
    const official = OFFICIAL_AGENT_PACKS.flatMap((pack) =>
      (this.state.official[pack.id]?.enabled ?? true)
        ? pack.adapters.map((manifest) => ({
            manifest,
            sourcePath: OFFICIAL_PACK_SOURCE,
            packId: pack.id,
          }))
        : [],
    );
    const user = Object.entries(this.state.packs).flatMap(([id, entry]) => {
      if (!entry.enabled) return [];
      const loaded = this.readVersion(id, entry.currentVersion);
      if (!loaded) return [];
      return loaded.pack.adapters.map((manifest) => ({
        manifest,
        sourcePath: loaded.path,
        packId: id,
      }));
    });
    return [...official, ...user];
  }

  install(sourcePath: string): AgentPackDto {
    if (!isAbsolute(sourcePath))
      throw fail('AGENT_PACK_PATH_INVALID', 'Choose an absolute Agent Pack file.');
    let bytes: Buffer;
    try {
      const info = statSync(sourcePath);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_PACK_BYTES) {
        throw fail('AGENT_PACK_SIZE_INVALID', 'Agent Pack files must be between 1 byte and 2 MB.');
      }
      bytes = readFileSync(sourcePath);
    } catch (error) {
      if (error instanceof ProductFailure) throw error;
      throw fail('AGENT_PACK_READ_FAILED', 'Charter could not read that Agent Pack file.');
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw fail('AGENT_PACK_INVALID_JSON', 'That file is not valid Agent Pack JSON.');
    }
    const parsed = AgentPackSchema.safeParse(value);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || 'pack'}: ${issue.message}`)
        .join('; ');
      throw fail('AGENT_PACK_INVALID', `Agent Pack validation failed: ${detail}`);
    }
    const pack = parsed.data;
    this.validateCompatibility(pack);
    this.validateAdapterOwnership(pack);
    const trust = this.verifyTrust(pack);
    const existing = this.state.packs[pack.id];
    if (existing && comparePackVersions(pack.version, existing.currentVersion) < 0) {
      throw fail(
        'AGENT_PACK_DOWNGRADE_BLOCKED',
        `Pack ${pack.id} ${pack.version} is older than ${existing.currentVersion}. Use Roll back for a stored version.`,
      );
    }

    const destination = this.versionPath(pack.id, pack.version);
    if (existsSync(destination)) {
      const installed = this.readVersion(pack.id, pack.version)?.pack;
      if (!installed || canonicalJson(installed) !== canonicalJson(pack)) {
        throw fail(
          'AGENT_PACK_VERSION_MUTATED',
          `Pack ${pack.id} ${pack.version} is already installed with different contents. Publish a new version instead.`,
        );
      }
    } else {
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      this.restrict(dirname(destination), 0o700);
      writeFileAtomicDurable(destination, `${JSON.stringify(pack, null, 2)}\n`);
      this.restrict(destination, 0o600);
    }

    const installedAt = this.now().toISOString();
    this.state.packs[pack.id] = {
      enabled: existing?.enabled ?? true,
      currentVersion: pack.version,
      previousVersion:
        existing && existing.currentVersion !== pack.version
          ? existing.currentVersion
          : (existing?.previousVersion ?? null),
      installedAt,
      trust,
    };
    this.saveState();
    this.logger.info('Agent Pack installed', {
      id: pack.id,
      version: pack.version,
      adapters: pack.adapters.map((adapter) => adapter.id),
      trust,
    });
    return this.dto(pack, destination, this.state.packs[pack.id]!);
  }

  setEnabled(id: string, enabled: boolean): boolean {
    if (OFFICIAL_PACK_BY_ID.has(id)) {
      const current = this.state.official[id]?.enabled ?? true;
      if (current === enabled) return false;
      this.state.official[id] = { enabled };
      this.saveState();
      this.logger.info('Bundled Agent Pack toggled', { id, enabled });
      return true;
    }
    const entry = this.state.packs[id];
    if (!entry) throw fail('AGENT_PACK_NOT_FOUND', `Agent Pack ${id} is not installed.`);
    if (entry.enabled === enabled) return false;
    entry.enabled = enabled;
    this.saveState();
    this.logger.info('Agent Pack toggled', { id, enabled });
    return true;
  }

  rollback(id: string): boolean {
    if (OFFICIAL_PACK_BY_ID.has(id)) {
      throw fail(
        'AGENT_PACK_ROLLBACK_UNAVAILABLE',
        `Bundled Agent Pack ${id} is updated with Charter and has no local rollback version.`,
      );
    }
    const entry = this.state.packs[id];
    if (!entry) throw fail('AGENT_PACK_NOT_FOUND', `Agent Pack ${id} is not installed.`);
    if (!entry.previousVersion || !this.readVersion(id, entry.previousVersion)) {
      throw fail(
        'AGENT_PACK_ROLLBACK_UNAVAILABLE',
        `Agent Pack ${id} has no stored rollback version.`,
      );
    }
    const current = entry.currentVersion;
    entry.currentVersion = entry.previousVersion;
    entry.previousVersion = current;
    this.saveState();
    this.logger.info('Agent Pack rolled back', { id, version: entry.currentVersion });
    return true;
  }

  remove(id: string): boolean {
    if (OFFICIAL_PACK_BY_ID.has(id)) {
      throw fail(
        'AGENT_PACK_REMOVE_FORBIDDEN',
        `Bundled Agent Pack ${id} can be disabled but not removed.`,
      );
    }
    if (!this.state.packs[id]) return false;
    const packDir = this.packDir(id);
    const trash = `${packDir}.removing-${process.pid}-${Date.now()}`;
    delete this.state.packs[id];
    this.saveState();
    if (existsSync(packDir)) {
      renameSync(packDir, trash);
      rmSync(trash, { recursive: true, force: true });
    }
    this.logger.info('Agent Pack removed', { id });
    return true;
  }

  private validateCompatibility(pack: AgentPack): void {
    if (
      pack.engine.min > AGENT_ADAPTER_ENGINE_VERSION ||
      pack.engine.max < AGENT_ADAPTER_ENGINE_VERSION ||
      pack.adapters.some((adapter) => !adapterEngineCompatible(adapter))
    ) {
      throw fail(
        'AGENT_PACK_ENGINE_INCOMPATIBLE',
        `This pack is not compatible with Agent Adapter engine ${AGENT_ADAPTER_ENGINE_VERSION}.`,
      );
    }
    if (pack.adapters.some((adapter) => adapter.acp?.kind === 'bundled')) {
      throw fail(
        'AGENT_PACK_BUNDLED_CODE_FORBIDDEN',
        'User Agent Packs cannot select bundled JavaScript runtimes; use the Agent’s native ACP command.',
      );
    }
  }

  private validateAdapterOwnership(pack: AgentPack): void {
    if (OFFICIAL_PACK_BY_ID.has(pack.id)) {
      throw fail(
        'AGENT_PACK_OFFICIAL_CONFLICT',
        `Pack id ${pack.id} is reserved for a bundled Charter Agent Pack.`,
      );
    }
    const builtinIds = new Set(BUILTIN_AGENT_ADAPTERS.map((adapter) => adapter.id));
    const occupied = new Map<string, string>(
      OFFICIAL_AGENT_PACKS.flatMap((official) =>
        official.adapters.map((adapter) => [adapter.id, official.id] as const),
      ),
    );
    for (const [packId, state] of Object.entries(this.state.packs)) {
      if (packId === pack.id) continue;
      const loaded = this.readVersion(packId, state.currentVersion);
      for (const adapter of loaded?.pack.adapters ?? []) occupied.set(adapter.id, packId);
    }
    for (const adapter of pack.adapters) {
      if (builtinIds.has(adapter.id)) {
        throw fail(
          'AGENT_PACK_BUILTIN_CONFLICT',
          `Adapter ${adapter.id} is built into Charter and cannot be replaced by a Pack.`,
        );
      }
      const owner = occupied.get(adapter.id);
      if (owner) {
        throw fail(
          'AGENT_PACK_ADAPTER_CONFLICT',
          `Adapter ${adapter.id} is already owned by Agent Pack ${owner}.`,
        );
      }
    }
  }

  private verifyTrust(pack: AgentPack): PackTrust {
    if (!pack.signature) return 'local';
    const publicKey = this.options.trustedPublisherKeys?.[pack.signature.keyId];
    if (!publicKey) {
      throw fail(
        'AGENT_PACK_SIGNATURE_UNKNOWN',
        `The Agent Pack signature key ${pack.signature.keyId} is not trusted by this Charter build.`,
      );
    }
    let valid = false;
    try {
      valid = verify(
        null,
        agentPackSignaturePayload(pack),
        createPublicKey(publicKey),
        Buffer.from(pack.signature.value, 'base64'),
      );
    } catch {
      valid = false;
    }
    if (!valid) throw fail('AGENT_PACK_SIGNATURE_INVALID', 'The Agent Pack signature is invalid.');
    return 'verified';
  }

  private dto(
    pack: AgentPack,
    sourcePath: string,
    state: PackStateEntry,
    bundled = false,
  ): AgentPackDto {
    return {
      id: pack.id,
      displayName: pack.displayName,
      publisher: pack.publisher,
      currentVersion: state.currentVersion,
      previousVersion: state.previousVersion,
      availableVersions: bundled ? [pack.version] : this.versions(pack.id),
      enabled: state.enabled,
      trust: state.trust,
      adapterIds: pack.adapters.map((adapter) => adapter.id),
      installedAt: state.installedAt,
      sourcePath,
      bundled,
    };
  }

  private versions(id: string): string[] {
    const dir = join(this.packDir(id), 'versions');
    try {
      return readdirSync(dir)
        .filter((name) => name.endsWith('.json') && SEMVER.test(name.slice(0, -5)))
        .map((name) => name.slice(0, -5))
        .sort((left, right) => comparePackVersions(right, left))
        .slice(0, 32);
    } catch {
      return [];
    }
  }

  private readVersion(id: string, version: string): { pack: AgentPack; path: string } | null {
    const path = this.versionPath(id, version);
    try {
      const parsed = AgentPackSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (!parsed.success || parsed.data.id !== id || parsed.data.version !== version) return null;
      return { pack: parsed.data, path };
    } catch {
      return null;
    }
  }

  private readState(): PackState {
    try {
      const value = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<PackState>;
      if (value.schemaVersion === STATE_VERSION && value.packs && typeof value.packs === 'object') {
        const packs: PackState['packs'] = {};
        for (const [id, candidate] of Object.entries(value.packs)) {
          const entry = candidate as Partial<PackStateEntry> | null;
          if (
            !AgentIdSchema.safeParse(id).success ||
            !entry ||
            typeof entry.enabled !== 'boolean' ||
            typeof entry.currentVersion !== 'string' ||
            !SEMVER.test(entry.currentVersion) ||
            (entry.previousVersion !== null &&
              (typeof entry.previousVersion !== 'string' || !SEMVER.test(entry.previousVersion))) ||
            typeof entry.installedAt !== 'string' ||
            (entry.trust !== 'local' && entry.trust !== 'verified')
          ) {
            continue;
          }
          packs[id] = entry as PackStateEntry;
        }
        const official: PackState['official'] = {};
        if (value.official && typeof value.official === 'object') {
          for (const [id, candidate] of Object.entries(value.official)) {
            if (
              OFFICIAL_PACK_BY_ID.has(id) &&
              candidate &&
              typeof candidate === 'object' &&
              typeof (candidate as { enabled?: unknown }).enabled === 'boolean'
            ) {
              official[id] = { enabled: (candidate as { enabled: boolean }).enabled };
            }
          }
        }
        return { schemaVersion: STATE_VERSION, packs, official };
      }
    } catch {
      // First start or damaged state: inactive files remain on disk for manual recovery.
    }
    return { schemaVersion: STATE_VERSION, packs: {}, official: {} };
  }

  private saveState(): void {
    writeFileAtomicDurable(this.stateFile, `${JSON.stringify(this.state, null, 2)}\n`);
    this.restrict(this.stateFile, 0o600);
  }

  private packDir(id: string): string {
    const path = resolve(this.root, id);
    if (dirname(path) !== resolve(this.root))
      throw fail('AGENT_PACK_ID_INVALID', 'Invalid Agent Pack id.');
    return path;
  }

  private versionPath(id: string, version: string): string {
    if (!SEMVER.test(version))
      throw fail('AGENT_PACK_VERSION_INVALID', 'Invalid Agent Pack version.');
    return join(this.packDir(id), 'versions', `${version}.json`);
  }

  private restrict(path: string, mode: number): void {
    if (process.platform === 'win32') return;
    try {
      chmodSync(path, mode);
    } catch (error) {
      this.logger.warn('Agent Pack permissions could not be restricted', {
        path: basename(path),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
