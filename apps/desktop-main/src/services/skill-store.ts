import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { errorMessage, productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import type { SkillDto, SkillSourceDto, SkillSourceKind } from '@pi-ide/ipc-contracts';

/**
 * Multi-source skill catalog (ADR-0015 + ADR-0019).
 *
 * - Managed imports remain copied snapshots under appData/skills.
 * - User-level Agent/Codex/Claude roots are discovered without copying.
 * - Discovery is not trust: external skills stay unavailable to the model
 *   until a skill or its source is explicitly trusted.
 * - Project directories are never scanned implicitly (AG-014).
 * - Watchers are only a latency optimization; periodic/full rescans are the
 *   source of truth, so dropped file-system events cannot permanently desync.
 */

const SKILL_FILE = 'SKILL.md';
const STATE_FILE = 'skills.json';
const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_DISCOVERY_DEPTH = 5;
const MAX_DISCOVERED_SKILLS = 2_000;
const READ_CAP = 256 * 1024;
const WATCH_DEBOUNCE_MS = 450;
const RECONCILE_MS = 45_000;
const STALE_SCAN_MS = 2_000;
const IGNORED_DISCOVERY_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.cache']);
const SCRIPT_EXTS = new Set([
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.rb',
  '.pl',
  '.ps1',
  '.cmd',
  '.bat',
]);

export interface SkillFrontmatter {
  name: string;
  description: string;
  explicitOnly: boolean;
}

/**
 * Parse the portable Agent Skills fields without evaluating arbitrary YAML.
 * Supports quoted scalars plus YAML `|`/`>` block descriptions, which covers
 * Claude/Codex skills while keeping the parser dependency-free and inert.
 */
export function parseSkillFrontmatter(content: string, fallbackName: string): SkillFrontmatter {
  let name = fallbackName;
  let description = '';
  let explicitOnly = false;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return { name, description, explicitOnly };

  const lines = match[1]!.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    let value = kv[2]!.trim();
    if ((value === '|' || value === '>') && key === 'description') {
      const folded = value === '>';
      const block: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1]!;
        if (next.trim() && !/^\s+/.test(next)) break;
        index += 1;
        block.push(next.replace(/^\s{1,4}/, ''));
      }
      value = folded ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
    } else {
      value = unquoteYamlScalar(value);
    }
    if (key === 'name' && value) name = value;
    else if (key === 'description') description = value;
    else if (key === 'disable-model-invocation') explicitOnly = value.toLowerCase() === 'true';
  }
  return { name, description, explicitOnly };
}

function unquoteYamlScalar(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if (first === "'" && last === "'") return value.slice(1, -1).replace(/''/g, "'");
  if (first === '"' && last === '"') {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Slug used for portable invocation names. */
export function skillSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'skill'
  );
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function isScript(relPath: string): boolean {
  return SCRIPT_EXTS.has(extname(relPath).toLowerCase());
}

function displayPath(path: string, home: string): string {
  const absolute = resolve(path);
  const homeAbsolute = resolve(home);
  return isInside(homeAbsolute, absolute)
    ? `~${absolute.slice(homeAbsolute.length).replaceAll(sep, '/')}`
    : absolute;
}

function isProtectedInstall(source: SourceDefinition, root: string): boolean {
  if (source.kind !== 'codex') return false;
  const rel = relative(source.root, root);
  return rel.split(sep).includes('.system');
}

interface SourceDefinition {
  id: string;
  label: string;
  kind: SkillSourceKind;
  root: string;
  removable: boolean;
  live: boolean;
}

interface SourcePolicy {
  trusted: boolean;
  autoEnableNew: boolean;
}

interface CustomSourceState {
  id: string;
  label: string;
  path: string;
}

interface DisabledInstallState {
  sourceId: string;
  originalPath: string;
  parkedPath: string;
  disabledAt: string;
}

interface StoreState {
  version: 3;
  /** Per-skill override. Managed absent = on; external absent = source policy. */
  enabled: Record<string, boolean>;
  sourcePolicies: Record<string, SourcePolicy>;
  customSources: CustomSourceState[];
  /** Agent-owned copies parked outside the Agent's live skills root. */
  disabledInstalls: Record<string, DisabledInstallState>;
}

interface FileWalkResult {
  files: string[];
  totalBytes: number;
  latestMtimeMs: number;
  unsafeLinks: string[];
  truncated: boolean;
  revisionParts: string[];
}

interface CatalogEntry {
  id: string;
  source: SourceDefinition;
  /** Physical folder, including the parking location while disabled. */
  root: string;
  rootReal: string;
  /** Stable live location shown to the user and restored on enable. */
  originalRoot: string;
  agentEnabled: boolean;
  protected: boolean;
  displayName: string;
  baseName: string;
  description: string;
  explicitOnly: boolean;
  files: string[];
  scriptCount: number;
  importedAt: string;
  updatedAt: string;
  revision: string;
  status: 'ready' | 'invalid';
  compatibility: 'compatible' | 'needs-review';
  issues: string[];
  dto?: SkillDto;
}

export interface SkillToolEntry {
  name: string;
  description: string;
  dir: string;
  canonicalDir: string;
  explicitOnly: boolean;
  revision: string;
  source: string;
}

export interface SkillCatalogSnapshot {
  skills: SkillDto[];
  sources: SkillSourceDto[];
}

export interface SkillStoreOptions {
  /** Tests default to managed-only; production opts into well-known home roots. */
  discoverExternal?: boolean;
  homeDir?: string;
  onDidChange?: (event: { reason: string; revision: number }) => void;
}

export class SkillStore {
  private readonly stateFile: string;
  private readonly home: string;
  private readonly discoverExternal: boolean;
  private readonly onDidChange: (event: { reason: string; revision: number }) => void;
  private state: StoreState;
  private entries: CatalogEntry[] = [];
  private skillDtos: SkillDto[] = [];
  private sourceDtos: SkillSourceDto[] = [];
  private catalogSignature = '';
  private catalogRevision = 0;
  private lastScanAt = 0;
  private scanning = false;
  private watching = false;
  private watchers = new Map<string, FSWatcher>();
  private watchTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
    options: SkillStoreOptions = {},
  ) {
    mkdirSync(dir, { recursive: true });
    this.stateFile = join(dir, STATE_FILE);
    this.home = resolve(options.homeDir ?? homedir());
    this.discoverExternal = options.discoverExternal ?? false;
    this.onDidChange = options.onDidChange ?? (() => undefined);
    this.state = this.loadState();
    this.rescan('startup', false);
  }

  private loadState(): StoreState {
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<StoreState> & {
        enabled?: Record<string, boolean>;
      };
      if (parsed && typeof parsed === 'object') {
        return {
          version: 3,
          enabled:
            parsed.enabled && typeof parsed.enabled === 'object'
              ? parsed.enabled
              : Object.create(null),
          sourcePolicies:
            parsed.sourcePolicies && typeof parsed.sourcePolicies === 'object'
              ? parsed.sourcePolicies
              : Object.create(null),
          customSources: Array.isArray(parsed.customSources)
            ? parsed.customSources.filter((item): item is CustomSourceState =>
                Boolean(
                  item &&
                  typeof item.id === 'string' &&
                  typeof item.label === 'string' &&
                  typeof item.path === 'string',
                ),
              )
            : [],
          disabledInstalls:
            parsed.disabledInstalls && typeof parsed.disabledInstalls === 'object'
              ? Object.fromEntries(
                  Object.entries(parsed.disabledInstalls).filter(
                    (entry): entry is [string, DisabledInstallState] => {
                      const value = entry[1] as Partial<DisabledInstallState> | null;
                      return Boolean(
                        value &&
                        typeof value.sourceId === 'string' &&
                        typeof value.originalPath === 'string' &&
                        typeof value.parkedPath === 'string' &&
                        typeof value.disabledAt === 'string',
                      );
                    },
                  ),
                )
              : Object.create(null),
        };
      }
    } catch {
      // First run / unreadable state -> defaults. Catalog remains derived.
    }
    return {
      version: 3,
      enabled: {},
      sourcePolicies: {},
      customSources: [],
      disabledInstalls: {},
    };
  }

  private saveState(): void {
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    cpSync(tmp, this.stateFile);
    rmSync(tmp, { force: true });
  }

  private definitions(): SourceDefinition[] {
    const sources: SourceDefinition[] = [
      {
        id: 'managed',
        label: 'Charter Managed',
        kind: 'managed',
        root: resolve(this.dir),
        removable: false,
        live: false,
      },
    ];
    if (this.discoverExternal) {
      sources.push(
        {
          id: 'agents',
          label: 'Agent Skills',
          kind: 'agents',
          root: join(this.home, '.agents', 'skills'),
          removable: false,
          live: true,
        },
        {
          id: 'claude',
          label: 'Claude Code',
          kind: 'claude',
          root: join(this.home, '.claude', 'skills'),
          removable: false,
          live: true,
        },
        {
          id: 'codex',
          label: 'Codex',
          kind: 'codex',
          root: join(this.home, '.codex', 'skills'),
          removable: false,
          live: true,
        },
      );
    }
    for (const custom of this.state.customSources) {
      sources.push({
        id: custom.id,
        label: custom.label,
        kind: 'custom',
        root: resolve(custom.path),
        removable: true,
        live: true,
      });
    }
    return sources;
  }

  private policyFor(source: SourceDefinition): SourcePolicy {
    if (source.kind === 'managed') return { trusted: true, autoEnableNew: true };
    return this.state.sourcePolicies[source.id] ?? { trusted: false, autoEnableNew: false };
  }

  /** Start near-real-time watchers plus a reconciliation safety net. */
  startWatching(): void {
    if (this.watching) return;
    this.watching = true;
    this.refreshWatchers();
    this.reconcileTimer = setInterval(() => this.rescan('periodic'), RECONCILE_MS);
    this.reconcileTimer.unref();
  }

  dispose(): void {
    this.watching = false;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.watchTimer = null;
    this.reconcileTimer = null;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private scheduleRescan(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      this.rescan('filesystem');
    }, WATCH_DEBOUNCE_MS);
    this.watchTimer.unref();
  }

  private refreshWatchers(): void {
    if (!this.watching) return;
    const desired = new Set<string>();
    for (const source of this.definitions()) {
      const target = existsSync(source.root) ? source.root : dirname(source.root);
      if (!existsSync(target)) continue;
      let canonical: string;
      try {
        canonical = realpathSync(target);
      } catch {
        continue;
      }
      desired.add(canonical);
      if (this.watchers.has(canonical)) continue;
      let watcher: FSWatcher;
      try {
        watcher = watch(canonical, { recursive: true }, () => this.scheduleRescan());
      } catch {
        try {
          watcher = watch(canonical, () => this.scheduleRescan());
        } catch (error) {
          this.logger.warn('skill source watcher unavailable', {
            source: source.id,
            error: errorMessage(error),
          });
          continue;
        }
      }
      watcher.on('error', (error) => {
        this.logger.warn('skill source watcher failed', {
          source: source.id,
          error: error.message,
        });
        watcher.close();
        this.watchers.delete(canonical);
      });
      this.watchers.set(canonical, watcher);
    }
    for (const [path, watcher] of this.watchers) {
      if (desired.has(path)) continue;
      watcher.close();
      this.watchers.delete(path);
    }
  }

  /** Full source reconciliation. Events merely schedule this operation. */
  rescan(reason = 'manual', emit = true): SkillCatalogSnapshot {
    if (this.scanning) return this.snapshot();
    this.scanning = true;
    try {
      const scannedAt = new Date().toISOString();
      const definitions = this.definitions();
      const entries: CatalogEntry[] = [];
      const counts = new Map<string, number>();
      for (const source of definitions) {
        const roots = this.findSkillRoots(source);
        const activeIds = new Set<string>();
        for (const root of roots) {
          const entry = this.inspectSkill(source, root);
          if (entry) {
            entries.push(entry);
            activeIds.add(entry.id);
          }
        }
        let disabledCount = 0;
        for (const [id, parked] of Object.entries(this.state.disabledInstalls)) {
          if (parked.sourceId !== source.id || activeIds.has(id)) continue;
          if (!existsSync(join(parked.parkedPath, SKILL_FILE))) continue;
          const entry = this.inspectSkill(source, parked.parkedPath, {
            id,
            originalRoot: parked.originalPath,
            agentEnabled: false,
            skipSourceContainment: true,
          });
          if (entry) {
            entries.push(entry);
            disabledCount += 1;
          }
        }
        counts.set(source.id, roots.length + disabledCount);
      }
      entries.sort(compareEntries);
      this.applyRuntimeNames(entries);
      this.entries = entries;
      this.skillDtos = entries.flatMap((entry) => (entry.dto ? [entry.dto] : []));
      this.sourceDtos = definitions.map((source) => {
        const policy = this.policyFor(source);
        return {
          id: source.id,
          label: source.label,
          kind: source.kind,
          path: displayPath(source.root, this.home),
          available: isDirectory(source.root),
          trusted: policy.trusted,
          autoEnableNew: policy.autoEnableNew,
          removable: source.removable,
          live: source.live,
          skillCount: counts.get(source.id) ?? 0,
          lastScannedAt: scannedAt,
        };
      });
      this.lastScanAt = Date.now();
      const signature = createHash('sha256')
        .update(
          JSON.stringify({
            skills: this.skillDtos.map((skill) => ({
              id: skill.id,
              name: skill.name,
              enabled: skill.enabled,
              agentEnabled: skill.agentEnabled,
              protected: skill.protected,
              revision: skill.revision,
              status: skill.status,
            })),
            sources: this.sourceDtos.map((source) => ({
              id: source.id,
              available: source.available,
              trusted: source.trusted,
              autoEnableNew: source.autoEnableNew,
              skillCount: source.skillCount,
            })),
          }),
        )
        .digest('hex');
      if (signature !== this.catalogSignature) {
        this.catalogSignature = signature;
        this.catalogRevision += 1;
        if (emit) this.onDidChange({ reason, revision: this.catalogRevision });
      }
      this.refreshWatchers();
      return this.snapshot();
    } finally {
      this.scanning = false;
    }
  }

  private rescanIfStale(): void {
    if (Date.now() - this.lastScanAt > STALE_SCAN_MS) this.rescan('on-demand');
  }

  snapshot(): SkillCatalogSnapshot {
    return {
      skills: this.skillDtos.map((skill) => ({
        ...skill,
        files: [...skill.files],
        issues: [...skill.issues],
      })),
      sources: this.sourceDtos.map((source) => ({ ...source })),
    };
  }

  list(): SkillDto[] {
    this.rescanIfStale();
    return this.snapshot().skills;
  }

  sources(): SkillSourceDto[] {
    this.rescanIfStale();
    return this.snapshot().sources;
  }

  private findSkillRoots(source: SourceDefinition): string[] {
    if (!isDirectory(source.root)) return [];
    const roots: string[] = [];
    const visited = new Set<string>();
    const visit = (logicalDir: string, depth: number, isLinked = false): void => {
      if (roots.length >= MAX_DISCOVERED_SKILLS || depth > MAX_DISCOVERY_DEPTH) return;
      let real: string;
      try {
        real = realpathSync(logicalDir);
      } catch {
        return;
      }
      if (visited.has(real)) return;
      visited.add(real);
      if (existsSync(join(logicalDir, SKILL_FILE))) {
        roots.push(logicalDir);
        return; // Bundled references may themselves contain docs named SKILL.md.
      }
      // A linked child is treated as one skill root, never as an unbounded tree.
      if (isLinked) return;
      let names: string[];
      try {
        names = readdirSync(logicalDir).sort();
      } catch {
        return;
      }
      for (const name of names) {
        if (roots.length >= MAX_DISCOVERED_SKILLS) return;
        if (IGNORED_DISCOVERY_DIRS.has(name)) continue;
        if (source.kind === 'managed' && name === '.snapshots') continue;
        const child = join(logicalDir, name);
        try {
          const lst = lstatSync(child);
          if (lst.isSymbolicLink()) {
            if (statSync(child).isDirectory()) visit(child, depth + 1, true);
          } else if (lst.isDirectory()) {
            visit(child, depth + 1);
          }
        } catch {
          // Concurrent source changes are reconciled on the next scan.
        }
      }
    };
    visit(source.root, 0);
    return roots;
  }

  private inspectSkill(
    source: SourceDefinition,
    root: string,
    options: {
      id?: string;
      originalRoot?: string;
      agentEnabled?: boolean;
      skipSourceContainment?: boolean;
    } = {},
  ): CatalogEntry | null {
    let rootReal: string;
    let content: string;
    try {
      rootReal = realpathSync(root);
      const skillReal = realpathSync(join(root, SKILL_FILE));
      if (!isInside(rootReal, skillReal)) return null;
      content = readFileSync(skillReal, 'utf8');
    } catch {
      return null;
    }
    const originalRoot = resolve(options.originalRoot ?? root);
    const relativePath = relative(source.root, originalRoot) || basename(originalRoot);
    const fm = parseSkillFrontmatter(content, basename(root));
    const walked = walkSkillFiles(root, rootReal);
    const issues: string[] = [];
    if (!options.skipSourceContainment) {
      try {
        const sourceReal = realpathSync(source.root);
        if (!isInside(sourceReal, rootReal)) {
          issues.push('Skill directory symlink resolves outside its trusted source root.');
        }
      } catch {
        issues.push('Skill source is no longer available.');
      }
    }
    if (walked.truncated || walked.files.length >= MAX_FILES) {
      issues.push(`Skill contains ${MAX_FILES}+ files.`);
    }
    if (walked.totalBytes > MAX_TOTAL_BYTES) issues.push('Skill is larger than 20 MB.');
    if (walked.unsafeLinks.length > 0) {
      issues.push(`Symlink escapes the skill root: ${walked.unsafeLinks[0]}`);
    }
    if (!fm.description) issues.push('SKILL.md has no description.');
    const status: 'ready' | 'invalid' = issues.some((issue) => !issue.includes('no description'))
      ? 'invalid'
      : 'ready';
    const compatibility = detectCompatibility(content);
    if (compatibility === 'needs-review') {
      issues.push(
        'Instructions reference agent-specific tools or integrations; review before use.',
      );
    }
    const id =
      options.id ??
      (source.kind === 'managed'
        ? skillSlug(relativePath.split(sep)[0] ?? relativePath)
        : `${source.id}-${shortHash(relativePath.replaceAll(sep, '/'))}`);
    let importedAt = new Date(0).toISOString();
    try {
      importedAt = statSync(root).birthtime.toISOString();
    } catch {
      // Epoch fallback is deterministic for unusual file systems.
    }
    const updatedAt = new Date(walked.latestMtimeMs || 0).toISOString();
    const revision = createHash('sha256')
      .update(content)
      .update('\0')
      .update(walked.revisionParts.join('\0'))
      .digest('hex');
    return {
      id,
      source,
      root: resolve(root),
      rootReal,
      originalRoot,
      agentEnabled: options.agentEnabled ?? true,
      protected: isProtectedInstall(source, originalRoot),
      displayName: fm.name,
      baseName: skillSlug(fm.name),
      description: fm.description,
      explicitOnly: fm.explicitOnly,
      files: walked.files,
      scriptCount: walked.files.filter(isScript).length,
      importedAt,
      updatedAt,
      revision,
      status,
      compatibility,
      issues,
    };
  }

  private applyRuntimeNames(entries: CatalogEntry[]): void {
    const groups = new Map<string, CatalogEntry[]>();
    for (const entry of entries) {
      const list = groups.get(entry.baseName) ?? [];
      list.push(entry);
      groups.set(entry.baseName, list);
    }
    for (const entry of entries) {
      const group = groups.get(entry.baseName)!;
      const preferred = [...group].sort(compareEntries)[0]!;
      const conflict = group.length > 1;
      const runtimeName =
        !conflict || preferred === entry
          ? entry.baseName
          : `${entry.baseName.slice(0, Math.max(1, 63 - entry.source.id.length))}@${entry.source.id}`;
      const policy = this.policyFor(entry.source);
      const defaultEnabled =
        entry.source.kind === 'managed' ? true : policy.trusted && policy.autoEnableNew;
      const desired = this.state.enabled[entry.id] ?? defaultEnabled;
      const enabled = entry.agentEnabled && entry.status !== 'invalid' && policy.trusted && desired;
      const agentEnabled =
        entry.source.kind === 'claude' || entry.source.kind === 'codex'
          ? entry.agentEnabled
          : enabled;
      const issues = [...entry.issues];
      if (!entry.agentEnabled) {
        issues.push(`Disabled for ${entry.source.label}; the installed copy is parked by Charter.`);
      }
      if (conflict) {
        issues.push(
          preferred === entry
            ? `Name conflict: this source keeps /skill:${entry.baseName}; other sources use qualified names.`
            : `Name conflict: invoke this copy as /skill:${runtimeName}.`,
        );
      }
      entry.dto = {
        id: entry.id,
        name: runtimeName,
        displayName: entry.displayName,
        description: entry.description,
        enabled,
        agentEnabled,
        protected: entry.protected,
        explicitOnly: entry.explicitOnly,
        source: entry.source.kind,
        sourceId: entry.source.id,
        sourceLabel: entry.source.label,
        sourcePath: displayPath(entry.originalRoot, this.home),
        live: entry.source.live,
        status: conflict && entry.status === 'ready' ? 'conflict' : entry.status,
        compatibility: entry.compatibility,
        issues,
        revision: entry.revision,
        files: [...entry.files],
        scriptCount: entry.scriptCount,
        importedAt: entry.importedAt,
        updatedAt: entry.updatedAt,
      };
    }
  }

  import(sourceDir: string): SkillDto {
    const src = resolve(sourceDir);
    if (isInside(resolve(this.dir), src)) {
      throw new ProductFailure(
        productError('SKILL_IMPORT_INVALID', {
          userMessage: 'That folder is already inside the managed skills store.',
        }),
      );
    }
    const source: SourceDefinition = {
      id: 'import-check',
      label: 'Import',
      kind: 'custom',
      root: dirname(src),
      removable: false,
      live: true,
    };
    const inspected = existsSync(join(src, SKILL_FILE)) ? this.inspectSkill(source, src) : null;
    if (!inspected) {
      throw new ProductFailure(
        productError('SKILL_IMPORT_INVALID', {
          userMessage: `The folder has no ${SKILL_FILE} — pick the skill's root folder.`,
        }),
      );
    }
    if (inspected.status === 'invalid') {
      throw new ProductFailure(
        productError('SKILL_IMPORT_TOO_LARGE', {
          userMessage: inspected.issues[0] ?? 'The skill failed validation.',
        }),
      );
    }
    let id = inspected.baseName;
    let suffix = 2;
    while (existsSync(join(this.dir, id))) {
      id = `${inspected.baseName}-${suffix}`;
      suffix += 1;
    }
    // Import is deliberately a snapshot: dereference safe in-root links.
    cpSync(src, join(this.dir, id), { recursive: true, dereference: true });
    this.logger.info('skill imported', { id, files: inspected.files.length });
    this.rescan('import');
    const dto = this.skillDtos.find((skill) => skill.id === id);
    if (!dto) {
      throw new ProductFailure(
        productError('SKILL_IMPORT_INVALID', { userMessage: 'The skill could not be imported.' }),
      );
    }
    return { ...dto };
  }

  /** Install a product-owned, script-free manual into the managed store.
   * Idempotent by name: existing user-visible content is never overwritten. */
  installManaged(name: string, content: string): SkillDto {
    const id = skillSlug(name);
    const root = join(this.dir, id);
    const file = join(root, SKILL_FILE);
    if (!existsSync(file)) {
      mkdirSync(root, { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, content, 'utf8');
      renameSync(tmp, file);
    }
    this.rescan('install-managed');
    const dto = this.skillDtos.find((skill) => skill.id === id);
    if (!dto) {
      throw new ProductFailure(
        productError('SKILL_IMPORT_INVALID', { userMessage: 'The manual could not be installed.' }),
      );
    }
    return { ...dto };
  }

  addSource(sourceDir: string): SkillSourceDto {
    const src = resolve(sourceDir);
    if (!isDirectory(src)) {
      throw new ProductFailure(
        productError('SKILL_SOURCE_INVALID', {
          userMessage: 'That skill source folder is missing.',
        }),
      );
    }
    const canonical = realpathSync(src);
    if (isInside(resolve(this.dir), canonical) || isInside(canonical, resolve(this.dir))) {
      throw new ProductFailure(
        productError('SKILL_SOURCE_INVALID', {
          userMessage: 'The managed skills library cannot also be connected as an external source.',
        }),
      );
    }
    const duplicate = this.definitions().find((source) => {
      try {
        return realpathSync(source.root) === canonical;
      } catch {
        return false;
      }
    });
    if (duplicate) {
      const existing = this.sourceDtos.find((source) => source.id === duplicate.id);
      if (existing) return { ...existing };
    }
    const id = `custom-${shortHash(canonical)}`;
    this.state.customSources.push({
      id,
      label: basename(canonical) || 'Custom Skills',
      path: canonical,
    });
    this.state.sourcePolicies[id] = { trusted: false, autoEnableNew: false };
    this.saveState();
    this.rescan('source-added');
    const source = this.sourceDtos.find((item) => item.id === id);
    if (!source) {
      throw new ProductFailure(
        productError('SKILL_SOURCE_INVALID', { userMessage: 'The source could not be connected.' }),
      );
    }
    return { ...source };
  }

  removeSource(id: string): boolean {
    const index = this.state.customSources.findIndex((source) => source.id === id);
    if (index < 0) return false;
    this.state.customSources.splice(index, 1);
    delete this.state.sourcePolicies[id];
    for (const key of Object.keys(this.state.enabled)) {
      if (key.startsWith(`${id}-`)) delete this.state.enabled[key];
    }
    this.saveState();
    this.rescan('source-removed');
    return true;
  }

  setSourcePolicy(
    id: string,
    patch: { trusted?: boolean; autoEnableNew?: boolean },
  ): SkillSourceDto {
    const source = this.definitions().find((item) => item.id === id);
    if (!source) {
      throw new ProductFailure(
        productError('SKILL_SOURCE_NOT_FOUND', {
          userMessage: 'This skill source no longer exists.',
        }),
      );
    }
    if (source.kind === 'managed') return this.sourceDtos.find((item) => item.id === id)!;
    const current = this.policyFor(source);
    const trusted = patch.trusted ?? current.trusted;
    const autoEnableNew = trusted ? (patch.autoEnableNew ?? current.autoEnableNew) : false;
    this.state.sourcePolicies[id] = { trusted, autoEnableNew };
    this.saveState();
    this.rescan('source-policy');
    return { ...this.sourceDtos.find((item) => item.id === id)! };
  }

  remove(id: string): boolean {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return false;
    if (entry.source.kind !== 'managed') {
      throw new ProductFailure(
        productError('SKILL_EXTERNAL_OWNED', {
          userMessage: 'This is a linked skill. Disable it or disconnect its source instead.',
        }),
      );
    }
    const existed = existsSync(join(entry.root, SKILL_FILE));
    rmSync(entry.root, { recursive: true, force: true });
    delete this.state.enabled[id];
    this.saveState();
    this.rescan('remove');
    if (existed) this.logger.info('skill removed', { id });
    return existed;
  }

  setEnabled(id: string, enabled: boolean): SkillDto {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry || !entry.dto) {
      throw new ProductFailure(
        productError('SKILL_NOT_FOUND', { userMessage: 'This skill no longer exists on disk.' }),
      );
    }
    if (enabled && entry.status === 'invalid') {
      throw new ProductFailure(
        productError('SKILL_INVALID', {
          userMessage: entry.issues[0] ?? 'This skill failed validation and cannot be enabled.',
        }),
      );
    }
    if (enabled && entry.source.kind !== 'managed') {
      const current = this.policyFor(entry.source);
      this.state.sourcePolicies[entry.source.id] = { ...current, trusted: true };
    }
    this.state.enabled[id] = enabled;
    this.saveState();
    this.rescan('skill-policy');
    const dto = this.skillDtos.find((skill) => skill.id === id);
    if (!dto) {
      throw new ProductFailure(
        productError('SKILL_NOT_FOUND', { userMessage: 'This skill no longer exists on disk.' }),
      );
    }
    this.logger.info('skill toggled', { id, enabled, source: entry.source.id });
    return { ...dto };
  }

  /**
   * Toggle the installed copy for its owning Agent. Pi/shared sources already
   * have an in-process policy, while Claude/Codex need their folder moved out
   * of the live discovery root. The parking path is a sibling of that root so
   * restore stays atomic on the same file system.
   */
  setAgentEnabled(id: string, enabled: boolean): SkillDto {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry || !entry.dto) {
      throw new ProductFailure(
        productError('SKILL_NOT_FOUND', { userMessage: 'This skill no longer exists on disk.' }),
      );
    }
    if (entry.protected) {
      throw new ProductFailure(
        productError('SKILL_PROTECTED', {
          userMessage: 'This Agent built-in is protected and cannot be disabled or removed.',
        }),
      );
    }

    const ownedByExternalAgent = entry.source.kind === 'claude' || entry.source.kind === 'codex';
    if (!ownedByExternalAgent) return this.setEnabled(id, enabled);
    if (entry.agentEnabled === enabled) return { ...entry.dto };

    if (enabled) {
      const parked = this.state.disabledInstalls[id];
      if (!parked || !existsSync(join(parked.parkedPath, SKILL_FILE))) {
        throw new ProductFailure(
          productError('SKILL_NOT_FOUND', {
            userMessage: 'The parked skill copy is missing and cannot be restored.',
          }),
        );
      }
      if (existsSync(parked.originalPath)) {
        throw new ProductFailure(
          productError('SKILL_RESTORE_CONFLICT', {
            userMessage: 'A skill already exists at the original Agent path.',
          }),
        );
      }
      mkdirSync(dirname(parked.originalPath), { recursive: true });
      renameSync(parked.parkedPath, parked.originalPath);
      delete this.state.disabledInstalls[id];
    } else {
      const relativePath = relative(entry.source.root, entry.originalRoot);
      if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === '..') {
        throw new ProductFailure(
          productError('SKILL_PATH_OUTSIDE', {
            userMessage: 'This installed copy is outside its Agent source root.',
          }),
        );
      }
      const parkedPath = join(
        dirname(entry.source.root),
        '.charter-disabled-skills',
        entry.source.id,
        relativePath,
      );
      if (existsSync(parkedPath)) {
        throw new ProductFailure(
          productError('SKILL_DISABLE_CONFLICT', {
            userMessage: 'A parked copy already exists for this Agent skill.',
          }),
        );
      }
      mkdirSync(dirname(parkedPath), { recursive: true });
      renameSync(entry.root, parkedPath);
      this.state.disabledInstalls[id] = {
        sourceId: entry.source.id,
        originalPath: entry.originalRoot,
        parkedPath,
        disabledAt: new Date().toISOString(),
      };
    }

    this.saveState();
    this.rescan(enabled ? 'agent-skill-enabled' : 'agent-skill-disabled');
    const dto = this.skillDtos.find((skill) => skill.id === id);
    if (!dto) {
      throw new ProductFailure(
        productError('SKILL_NOT_FOUND', {
          userMessage: 'The Agent skill changed on disk before the operation completed.',
        }),
      );
    }
    this.logger.info('agent skill install toggled', {
      id,
      enabled,
      source: entry.source.id,
    });
    return { ...dto };
  }

  /** Resolve one exact, mutable copy for Electron's recoverable trash API. */
  trashTarget(id: string): string {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) {
      throw new ProductFailure(
        productError('SKILL_NOT_FOUND', { userMessage: 'This skill no longer exists on disk.' }),
      );
    }
    if (entry.protected) {
      throw new ProductFailure(
        productError('SKILL_PROTECTED', {
          userMessage: 'This Agent built-in is protected and cannot be disabled or removed.',
        }),
      );
    }
    if (!existsSync(join(entry.root, SKILL_FILE))) {
      throw new ProductFailure(
        productError('SKILL_NOT_FOUND', { userMessage: 'This skill no longer exists on disk.' }),
      );
    }
    return entry.root;
  }

  /** Reconcile state only after Electron confirms the folder reached Trash. */
  finishTrash(id: string): void {
    delete this.state.enabled[id];
    delete this.state.disabledInstalls[id];
    this.saveState();
    this.rescan('trash');
    this.logger.info('skill moved to trash', { id });
  }

  /** Audit view. Actual path containment follows symlinks before the read. */
  readFile(id: string, relPath = SKILL_FILE): { path: string; content: string; binary: boolean } {
    this.rescan('audit-demand');
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) {
      throw new ProductFailure(
        productError('SKILL_NOT_FOUND', { userMessage: 'This skill no longer exists on disk.' }),
      );
    }
    const logical = resolve(entry.root, relPath);
    if (!isInside(resolve(entry.root), logical)) {
      throw new ProductFailure(
        productError('SKILL_PATH_OUTSIDE', {
          userMessage: 'That path is outside the skill folder.',
        }),
      );
    }
    let actual: string;
    let raw: Buffer;
    try {
      actual = realpathSync(logical);
      if (!isInside(entry.rootReal, actual)) throw new Error('outside');
      raw = readFileSync(actual);
    } catch (error) {
      if (error instanceof Error && error.message === 'outside') {
        throw new ProductFailure(
          productError('SKILL_PATH_OUTSIDE', {
            userMessage: 'That linked file resolves outside the skill folder.',
          }),
        );
      }
      throw new ProductFailure(
        productError('SKILL_FILE_NOT_FOUND', {
          userMessage: `${relPath} does not exist in this skill.`,
        }),
      );
    }
    const binary = raw.subarray(0, 8192).includes(0);
    return {
      path: relPath,
      content: binary ? '' : raw.subarray(0, READ_CAP).toString('utf8'),
      binary,
    };
  }

  enabledSkills(): SkillToolEntry[] {
    // Runtime demand is an explicit consistency boundary. Watchers make this
    // cheap in the common case, while this scan guarantees the revision and
    // enablement offered to load_skill are current even after a dropped event.
    this.rescan('runtime-demand');
    return this.entries.flatMap((entry) => {
      const dto = entry.dto;
      if (!dto?.enabled || dto.status === 'invalid') return [];
      return [
        {
          name: dto.name,
          description: dto.description,
          dir: entry.root,
          canonicalDir: entry.rootReal,
          explicitOnly: dto.explicitOnly,
          revision: dto.revision,
          source: dto.sourceLabel,
        },
      ];
    });
  }

  preambleBlock(): string {
    const visible = this.enabledSkills().filter((skill) => !skill.explicitOnly);
    if (visible.length === 0) return '';
    const lines = [...PREAMBLE_FRAME_HEAD];
    for (const skill of visible) lines.push(skillPreambleChunk(skill));
    lines.push(PREAMBLE_FRAME_TAIL);
    return lines.join('\n');
  }

  /**
   * Per-skill preamble cost estimates for the Settings insight panel
   * (ADR-0037). Disabled, invalid and explicit-only skills are absent from
   * the preamble, so they carry no entry (the UI reads that as 0).
   */
  preambleTokenEstimates(): { overheadTokens: number; bySkill: Map<string, number> } {
    const visible = this.enabledSkills().filter((skill) => !skill.explicitOnly);
    const bySkill = new Map<string, number>();
    for (const skill of visible) {
      bySkill.set(skill.name, estimateTokens(skillPreambleChunk(skill)));
    }
    const overheadTokens =
      visible.length === 0
        ? 0
        : estimateTokens([...PREAMBLE_FRAME_HEAD, PREAMBLE_FRAME_TAIL].join('\n'));
    return { overheadTokens, bySkill };
  }

  expandCommand(text: string): string {
    return this.expandCommandDetailed(text).text;
  }

  /** Expansion plus which skill fired, so callers can ledger explicit usage (ADR-0037). */
  expandCommandDetailed(text: string): { text: string; skill: string | null } {
    const match = /^\/skill:([A-Za-z0-9_@-]+)[ \t]?/.exec(text);
    if (!match) return { text, skill: null };
    const skill = this.enabledSkills().find((item) => item.name === match[1]!.toLowerCase());
    if (!skill) return { text, skill: null };
    let body: string;
    try {
      body = stripFrontmatter(readFileSync(join(skill.dir, SKILL_FILE), 'utf8')).trim();
    } catch {
      return { text, skill: null };
    }
    const args = text.slice(match[0].length).trim();
    const block = `<skill name="${skill.name}">\nRevision: ${skill.revision.slice(0, 12)}. Load bundled files this skill references with load_skill (name + file).\n\n${body}\n</skill>`;
    return { text: args ? `${block}\n\n${args}` : block, skill: skill.name };
  }
}

const PREAMBLE_FRAME_HEAD: readonly string[] = [
  'The following skills provide specialized instructions for specific tasks.',
  "When a task matches a skill's description, call load_skill with its exact name before proceeding. Load referenced bundled files with load_skill too.",
  '<available_skills>',
];
const PREAMBLE_FRAME_TAIL = '</available_skills>';

function skillPreambleChunk(skill: SkillToolEntry): string {
  return [
    '  <skill>',
    `    <name>${escapeXml(skill.name)}</name>`,
    `    <description>${escapeXml(skill.description)}</description>`,
    `    <revision>${skill.revision.slice(0, 12)}</revision>`,
    '  </skill>',
  ].join('\n');
}

/** Budget signal, not a tokenizer: ~4 chars per token for English prose. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function walkSkillFiles(root: string, rootReal: string): FileWalkResult {
  const out: FileWalkResult = {
    files: [],
    totalBytes: 0,
    latestMtimeMs: 0,
    unsafeLinks: [],
    truncated: false,
    revisionParts: [],
  };
  const visited = new Set<string>();
  const visit = (logicalDir: string, relDir: string): void => {
    if (out.files.length >= MAX_FILES) {
      out.truncated = true;
      return;
    }
    let realDir: string;
    try {
      realDir = realpathSync(logicalDir);
    } catch {
      return;
    }
    if (!isInside(rootReal, realDir) || visited.has(realDir)) return;
    visited.add(realDir);
    let names: string[];
    try {
      names = readdirSync(logicalDir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (out.files.length >= MAX_FILES) {
        out.truncated = true;
        return;
      }
      if (name === '.DS_Store' || name === '.git') continue;
      const logical = join(logicalDir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      try {
        const lst = lstatSync(logical);
        let actual = logical;
        if (lst.isSymbolicLink()) {
          actual = realpathSync(logical);
          if (!isInside(rootReal, actual)) {
            out.unsafeLinks.push(rel);
            continue;
          }
        }
        const stat = statSync(actual);
        if (stat.isDirectory()) {
          if (lst.isSymbolicLink() && visited.has(realpathSync(actual))) {
            out.unsafeLinks.push(`${rel} (directory link cycle/alias)`);
            continue;
          }
          visit(logical, rel);
        } else if (stat.isFile()) {
          out.files.push(rel);
          out.totalBytes += stat.size;
          out.latestMtimeMs = Math.max(out.latestMtimeMs, stat.mtimeMs);
          out.revisionParts.push(`${rel}:${stat.size}:${Math.trunc(stat.mtimeMs)}`);
        }
      } catch {
        // Source changed during scan; the next reconciliation settles it.
      }
    }
  };
  visit(root, '');
  return out;
}

function detectCompatibility(content: string): 'compatible' | 'needs-review' {
  const agentSpecific = [
    /\bWebSearch\b/,
    /\bmcp__[A-Za-z0-9_-]+/,
    /\bClaude Code\b/i,
    /\bCodex (?:manual|MCP|plugin)\b/i,
    /\bTask\s*\(.*subagent/i,
  ];
  return agentSpecific.some((pattern) => pattern.test(content)) ? 'needs-review' : 'compatible';
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function compareEntries(a: CatalogEntry, b: CatalogEntry): number {
  const priority: Record<SkillSourceKind, number> = {
    managed: 0,
    custom: 1,
    agents: 2,
    claude: 3,
    codex: 4,
  };
  return (
    priority[a.source.kind] - priority[b.source.kind] ||
    a.baseName.localeCompare(b.baseName) ||
    a.root.localeCompare(b.root)
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
