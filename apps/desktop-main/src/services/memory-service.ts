/**
 * Project memory (ADR-0028) — one shared rules source per project:
 *
 * - `.charter/rules.md` holds rule text + enabled state (hand-editable,
 *   git-shareable). The DB holds only the machine-local halves: captured
 *   candidates, per-rule provenance/observation counters, sync state.
 * - Review corrections (request-fix / plan changes) are captured as
 *   candidates; the distill card approves them into rules.
 * - Enabled rules are injected into every managed run's preamble and
 *   optionally projected into CLAUDE.md (one @import line) / AGENTS.md
 *   (rendered list) managed blocks. Hand edits inside a managed block are
 *   detected by hash and never overwritten silently.
 * - External private memory (Claude/Codex home files) is view/edit/delete/
 *   promote only — never merged, never rewritten in the background.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { errorMessage, productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import type { SqlDatabase } from '@pi-ide/persistence';
import type {
  ExternalMemoryFileDto,
  MemoryAgentsTreeDto,
  MemoryCandidateDto,
  MemoryCandidateOrigin,
  MemoryOverviewDto,
  MemoryRuleDto,
  MemorySyncStateDto,
  MemorySyncTarget,
} from '@pi-ide/ipc-contracts';
import {
  addRule,
  createDefaultRulesFile,
  findRule,
  listGroups,
  listRules,
  normalizeRuleText,
  parseRulesFile,
  removeRule,
  serializeRulesFile,
  updateRule,
  type MemoryRuleEntry,
  type RulesFileModel,
} from './memory/rules-file.js';
import {
  contentOutsideManagedBlock,
  extractConventionBullets,
  extractManagedBlock,
  managedBlockHash,
  renderAgentsInner,
  renderClaudeInner,
  upsertManagedBlock,
} from './memory/managed-block.js';
import { correctionSimilarity, CORRECTION_SIMILAR_THRESHOLD } from './memory/similarity.js';
import { ExternalMemoryStore } from './memory/external-memory.js';
import { writeFileAtomicDurable } from './memory/fs-utils.js';

export const RULES_REL_PATH = '.charter/rules.md';
const SYNC_TARGETS: MemorySyncTarget[] = ['claude-md', 'agents-md'];
const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CAPTURE_TEXT = 4000;

export interface MemoryServiceOptions {
  db: SqlDatabase;
  logger: Logger;
  /** Backup directory for external-memory deletes (userData/memory/trash). */
  trashDir: string;
  /** Test seam (PI_IDE_MEMORY_HOME): root for ~/.claude and ~/.codex discovery. */
  homeDir?: string;
  broadcast?: (payload: { projectPath: string | null; reason: string }) => void;
  /** settings.memory.captureEnabled, read live. */
  captureEnabled?: () => boolean;
  /** E2E gate (mirrors SkillStore): never scan the developer's real home. */
  discoverExternal?: boolean;
  /** Timeline receipt for approvals (wired to TaskService.recordEvent). */
  recordTaskEvent?: (taskId: string, type: string, payload: unknown) => void;
  now?: () => Date;
  idFactory?: () => string;
}

interface WorkspaceRef {
  id: string;
  canonicalPath: string;
}

function fail(code: string, userMessage: string, technicalMessage?: string): ProductFailure {
  return new ProductFailure(
    productError(code, { userMessage, technicalMessage: technicalMessage ?? userMessage }),
  );
}

function defaultRuleId(): string {
  return `r-${globalThis.crypto.randomUUID().slice(0, 8)}`;
}

export class MemoryService {
  private readonly db: SqlDatabase;
  private readonly logger: Logger;
  private readonly home: string;
  private readonly external: ExternalMemoryStore;
  private readonly broadcastFn: (payload: { projectPath: string | null; reason: string }) => void;
  private readonly captureEnabledFn: () => boolean;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly discoverExternal: boolean;
  private readonly recordTaskEvent:
    ((taskId: string, type: string, payload: unknown) => void) | null;

  constructor(options: MemoryServiceOptions) {
    this.db = options.db;
    this.logger = options.logger;
    this.home = options.homeDir ?? homedir();
    this.external = new ExternalMemoryStore({
      homeDir: options.homeDir,
      trashDir: options.trashDir,
      now: options.now,
    });
    this.broadcastFn = options.broadcast ?? (() => {});
    this.captureEnabledFn = options.captureEnabled ?? (() => true);
    this.discoverExternal = options.discoverExternal ?? true;
    this.recordTaskEvent = options.recordTaskEvent ?? null;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? defaultRuleId;
  }

  // ─────────────────────────── agents tree (IA v3) ───────────────────────────

  /**
   * Panel spine: agents at the top; each agent = global memory + per-project
   * groups. Claude's project list is the FULL set under ~/.claude/projects
   * (matched Charter workspaces get their display name, foreign dirs keep the
   * munged name); Charter's list is every opened workspace with rule/candidate
   * counts (per-project detail loads lazily via memory.overview).
   */
  agentsTree(): MemoryAgentsTreeDto {
    const workspaces = (
      this.db
        .prepare(
          `SELECT id, canonical_path, display_name FROM workspaces ORDER BY last_opened_at DESC LIMIT 200`,
        )
        .all() as unknown as { id: string; canonical_path: string; display_name: string }[]
    ).map((row) => ({ id: row.id, path: row.canonical_path, displayName: row.display_name }));

    const external = this.discoverExternal
      ? this.external.listAll(workspaces)
      : { claudeGlobal: [], codexGlobal: [], claudeProjects: [] };

    const candidateCounts = new Map(
      (
        this.db
          .prepare(
            `SELECT workspace_id, COUNT(*) AS n FROM memory_candidates WHERE status = 'pending' GROUP BY workspace_id`,
          )
          .all() as unknown as { workspace_id: string; n: number }[]
      ).map((row) => [row.workspace_id, row.n]),
    );

    const charterProjects = workspaces.map((ws) => {
      let ruleCount = 0;
      let enabledCount = 0;
      try {
        const rules = listRules(this.loadModel(ws.path).model);
        ruleCount = rules.length;
        enabledCount = rules.filter((rule) => rule.enabled).length;
      } catch (error) {
        this.logger.warn('memory.tree.rules.failed', {
          path: ws.path,
          message: errorMessage(error),
        });
      }
      return {
        projectPath: ws.path,
        displayName: ws.displayName,
        ruleCount,
        enabledCount,
        candidateCount: candidateCounts.get(ws.id) ?? 0,
      };
    });

    return {
      claude: { global: external.claudeGlobal, projects: external.claudeProjects },
      codex: { global: external.codexGlobal },
      charter: { projects: charterProjects },
    };
  }

  // ─────────────────────────── overview ───────────────────────────

  overview(projectPath: string): MemoryOverviewDto {
    const ws = this.workspaceFor(projectPath);
    const rulesFilePath = this.rulesFilePathFor(projectPath);
    if (!ws) {
      return {
        projectPath,
        available: false,
        rules: [],
        groups: [],
        candidates: [],
        stats: { enabled: 0, injectedTasks7d: 0, hitsTotal: 0, candidates: 0 },
        sync: SYNC_TARGETS.map((target) => this.defaultSyncState(projectPath, target)),
        rulesFilePath,
        rulesFileExists: existsSync(rulesFilePath),
      };
    }
    const { model, exists } = this.loadModel(ws.canonicalPath);
    const rules = listRules(model);
    const statsByRule = this.ruleStatsByRule(ws.id);
    const injectionsByRule = this.injectionCountsByRule(ws.id);
    const candidates = this.pendingCandidates(ws.id);
    const sinceIso = new Date(this.now().getTime() - WINDOW_7D_MS).toISOString();
    const injected7d = this.db
      .prepare(
        `SELECT COUNT(DISTINCT task_id) AS n FROM memory_rule_injections
         WHERE workspace_id = ? AND injected_at >= ?`,
      )
      .get(ws.id, sinceIso) as unknown as { n: number };
    const hitsTotal = this.db
      .prepare(
        `SELECT COALESCE(SUM(hit_count), 0) AS n FROM memory_rule_stats WHERE workspace_id = ?`,
      )
      .get(ws.id) as unknown as { n: number };
    return {
      projectPath: ws.canonicalPath,
      available: true,
      rules: rules.map((rule) =>
        this.ruleToDto(rule, statsByRule.get(rule.id), injectionsByRule.get(rule.id)),
      ),
      groups: listGroups(model),
      candidates,
      stats: {
        enabled: rules.filter((rule) => rule.enabled).length,
        injectedTasks7d: injected7d.n,
        hitsTotal: hitsTotal.n,
        candidates: candidates.length,
      },
      sync: this.syncStates(ws),
      rulesFilePath: this.rulesFilePathFor(ws.canonicalPath),
      rulesFileExists: exists,
    };
  }

  // ─────────────────────────── rules CRUD ───────────────────────────

  addRuleFromInput(input: {
    projectPath: string;
    text: string;
    group?: string;
    enabled?: boolean;
    source?: { taskId: string | null; label: string | null };
  }): MemoryRuleDto {
    const ws = this.requireWorkspace(input.projectPath);
    const { model } = this.loadModel(ws.canonicalPath);
    const rule = addRule(model, {
      id: this.freshRuleId(model),
      text: input.text,
      group: input.group,
      enabled: input.enabled,
    });
    this.upsertRuleStats(ws.id, rule.id, input.source?.taskId ?? null, input.source?.label ?? null);
    this.persistModel(ws, model, 'rule-added');
    return this.ruleToDto(rule, this.ruleStatsByRule(ws.id).get(rule.id), undefined);
  }

  updateRuleFromInput(input: {
    projectPath: string;
    ruleId: string;
    text?: string;
    group?: string;
    enabled?: boolean;
  }): MemoryRuleDto {
    const ws = this.requireWorkspace(input.projectPath);
    const { model } = this.loadModel(ws.canonicalPath);
    const rule = updateRule(model, input.ruleId, {
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.group !== undefined ? { group: input.group } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    });
    if (!rule)
      throw fail(
        'MEMORY_RULE_NOT_FOUND',
        'This rule no longer exists (it may have been removed by a hand edit).',
      );
    this.persistModel(ws, model, 'rule-updated');
    return this.ruleToDto(
      rule,
      this.ruleStatsByRule(ws.id).get(rule.id),
      this.injectionCountsByRule(ws.id).get(rule.id),
    );
  }

  removeRuleById(projectPath: string, ruleId: string): boolean {
    const ws = this.requireWorkspace(projectPath);
    const { model } = this.loadModel(ws.canonicalPath);
    const removed = removeRule(model, ruleId);
    if (removed) this.persistModel(ws, model, 'rule-removed');
    return removed;
  }

  // ─────────────────────────── candidates ───────────────────────────

  candidatesForTask(taskId: string): {
    candidates: MemoryCandidateDto[];
    projectPath: string | null;
  } {
    const ws = this.workspaceForTask(taskId);
    if (!ws) return { candidates: [], projectPath: null };
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_candidates
         WHERE workspace_id = ? AND status = 'pending'
         ORDER BY created_at DESC`,
      )
      .all(ws.id) as unknown as CandidateRow[];
    const forTask = rows.filter((row) => {
      const origin = parseOrigin(row.origin_json);
      return origin.taskId === taskId;
    });
    return {
      candidates: forTask.map((row) => candidateRowToDto(row)),
      projectPath: ws.canonicalPath,
    };
  }

  resolveCandidate(input: {
    projectPath: string;
    candidateId: string;
    action: 'approve' | 'dismiss';
    editedText?: string;
    group?: string;
  }): MemoryRuleDto | null {
    const ws = this.requireWorkspace(input.projectPath);
    const row = this.db
      .prepare(`SELECT * FROM memory_candidates WHERE id = ? AND workspace_id = ?`)
      .get(input.candidateId, ws.id) as unknown as CandidateRow | undefined;
    if (!row) throw fail('MEMORY_CANDIDATE_NOT_FOUND', 'This candidate no longer exists.');
    if (row.status !== 'pending') {
      throw fail('MEMORY_CANDIDATE_RESOLVED', 'This candidate was already resolved.');
    }
    const nowIso = this.now().toISOString();
    if (input.action === 'dismiss') {
      this.db
        .prepare(
          `UPDATE memory_candidates SET status = 'dismissed', resolved_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(nowIso, nowIso, row.id);
      this.broadcast(ws.canonicalPath, 'candidate-dismissed');
      return null;
    }
    const origin = parseOrigin(row.origin_json);
    const { model } = this.loadModel(ws.canonicalPath);
    const rule = addRule(model, {
      id: this.freshRuleId(model),
      text: input.editedText ?? row.text,
      group: input.group,
      enabled: true,
    });
    this.upsertRuleStats(ws.id, rule.id, origin.taskId, origin.label);
    // Write rules.md first: a failed write must leave the candidate pending
    // (retryable) rather than approved against a rule that does not exist.
    this.persistModel(ws, model, 'candidate-approved');
    this.db
      .prepare(
        `UPDATE memory_candidates
         SET status = 'approved', resolved_rule_id = ?, resolved_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(rule.id, nowIso, nowIso, row.id);
    // Timeline receipt in the source task (replay-traceable "why this rule exists").
    if (origin.taskId) {
      try {
        this.recordTaskEvent?.(origin.taskId, 'memory.distilled', {
          candidateId: row.id,
          ruleId: rule.id,
          text: rule.text.slice(0, 300),
        });
      } catch (error) {
        this.logger.warn('memory.distill.receipt.failed', { message: errorMessage(error) });
      }
    }
    return this.ruleToDto(rule, this.ruleStatsByRule(ws.id).get(rule.id), undefined);
  }

  /**
   * Capture hook (task-service): a review correction happened. Never throws —
   * capture must not be able to break the correction flow itself.
   */
  captureCorrection(input: {
    taskId: string;
    kind: 'request-fix' | 'plan-changes';
    text: string;
  }): void {
    try {
      if (!this.captureEnabledFn()) return;
      const text = normalizeRuleText(input.text).slice(0, MAX_CAPTURE_TEXT);
      if (text.length < 4) return;
      const ws = this.workspaceForTask(input.taskId);
      if (!ws) return;
      const taskTitle = this.taskTitle(input.taskId);
      const label = `${taskTitle ?? 'Task'} · ${input.kind === 'plan-changes' ? 'Plan changes' : 'Request fix'}`;
      const nowIso = this.now().toISOString();

      // (a) does this correction hit an existing enabled rule? ("slipped again")
      const { model } = this.loadModel(ws.canonicalPath);
      let matchedRuleId: string | null = null;
      let bestSim = 0;
      for (const rule of listRules(model)) {
        if (!rule.enabled) continue;
        const sim = correctionSimilarity(text, rule.text);
        if (sim >= CORRECTION_SIMILAR_THRESHOLD && sim > bestSim) {
          bestSim = sim;
          matchedRuleId = rule.id;
        }
      }
      if (matchedRuleId) {
        this.db
          .prepare(
            `INSERT INTO memory_rule_stats (workspace_id, rule_id, created_at, hit_count, last_hit_at)
             VALUES (?, ?, ?, 1, ?)
             ON CONFLICT(workspace_id, rule_id)
             DO UPDATE SET hit_count = hit_count + 1, last_hit_at = excluded.last_hit_at`,
          )
          .run(ws.id, matchedRuleId, nowIso, nowIso);
      }

      // (b) merge into a similar pending candidate instead of stacking duplicates
      const allRows = this.db
        .prepare(`SELECT * FROM memory_candidates WHERE workspace_id = ?`)
        .all(ws.id) as unknown as CandidateRow[];
      const pendingSimilar = allRows.find(
        (row) =>
          row.status === 'pending' &&
          correctionSimilarity(text, row.text) >= CORRECTION_SIMILAR_THRESHOLD,
      );
      if (pendingSimilar) {
        this.db
          .prepare(
            `UPDATE memory_candidates SET similar_count = similar_count + 1, updated_at = ? WHERE id = ?`,
          )
          .run(nowIso, pendingSimilar.id);
        this.broadcast(ws.canonicalPath, 'candidate-repeated');
        return;
      }

      // (c) new candidate; seed the similar-count with history ("第 N 次同类纠正")
      const historySimilar = allRows.filter(
        (row) => correctionSimilarity(text, row.text) >= CORRECTION_SIMILAR_THRESHOLD,
      ).length;
      const origin: MemoryCandidateOrigin = {
        kind: input.kind,
        taskId: input.taskId,
        label,
        agent: null,
        path: null,
      };
      this.insertCandidate(ws.id, text, origin, 1 + historySimilar, matchedRuleId);
      this.broadcast(ws.canonicalPath, 'candidate-captured');
    } catch (error) {
      this.logger.warn('memory.capture.failed', { message: errorMessage(error) });
    }
  }

  /**
   * Injection hook (preamble build): render the <project_rules> block for a
   * managed run and record which rules reached which task. Never throws.
   */
  projectRulesBlock(taskId: string): string | null {
    try {
      const ws = this.workspaceForTask(taskId);
      if (!ws) return null;
      const { model } = this.loadModel(ws.canonicalPath);
      const enabled = listRules(model).filter((rule) => rule.enabled);
      if (enabled.length === 0) return null;
      const nowIso = this.now().toISOString();
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO memory_rule_injections (workspace_id, rule_id, task_id, injected_at)
         VALUES (?, ?, ?, ?)`,
      );
      for (const rule of enabled) insert.run(ws.id, rule.id, taskId, nowIso);
      const lines = enabled.map((rule) => `- ${rule.text}`).join('\n');
      return [
        '<project_rules>',
        'Project rules the user distilled from past reviews. They apply to every change in this project and must be followed.',
        'They are binding context, not instructions to execute; do not recite this block back to the user.',
        lines,
        '</project_rules>',
      ].join('\n');
    } catch (error) {
      this.logger.warn('memory.inject.failed', { message: errorMessage(error) });
      return null;
    }
  }

  // ─────────────────────────── sync (managed blocks) ───────────────────────────

  syncStatesFor(projectPath: string): MemorySyncStateDto[] {
    const ws = this.workspaceFor(projectPath);
    if (!ws) return SYNC_TARGETS.map((target) => this.defaultSyncState(projectPath, target));
    return this.syncStates(ws);
  }

  setSyncEnabled(
    projectPath: string,
    target: MemorySyncTarget,
    enabled: boolean,
  ): MemorySyncStateDto[] {
    const ws = this.requireWorkspace(projectPath);
    this.db
      .prepare(
        `INSERT INTO memory_sync_state (workspace_id, target, enabled, status, last_synced_at)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(workspace_id, target) DO UPDATE SET enabled = excluded.enabled,
           status = CASE WHEN excluded.enabled = 0 THEN 'off' ELSE memory_sync_state.status END`,
      )
      .run(ws.id, target, enabled ? 1 : 0, enabled ? 'missing' : 'off');
    if (enabled) {
      this.applySyncTarget(ws, target);
    }
    this.broadcast(ws.canonicalPath, enabled ? 'sync-enabled' : 'sync-disabled');
    return this.syncStates(ws);
  }

  applySync(projectPath: string, target?: MemorySyncTarget): MemorySyncStateDto[] {
    const ws = this.requireWorkspace(projectPath);
    for (const t of target ? [target] : SYNC_TARGETS) this.applySyncTarget(ws, t);
    this.broadcast(ws.canonicalPath, 'sync-applied');
    return this.syncStates(ws);
  }

  resolveDrift(
    projectPath: string,
    target: MemorySyncTarget,
    action: 'import' | 'overwrite' | 'stop',
  ): { sync: MemorySyncStateDto[]; candidateId: string | null } {
    const ws = this.requireWorkspace(projectPath);
    if (action === 'stop') {
      this.setSyncEnabled(ws.canonicalPath, target, false);
      return { sync: this.syncStates(ws), candidateId: null };
    }
    let candidateId: string | null = null;
    if (action === 'import') {
      candidateId = this.importDriftedBlock(ws, target);
    }
    // Both import and overwrite end with the block rewritten from the source.
    this.applySyncTarget(ws, target, { force: true });
    this.broadcast(ws.canonicalPath, `drift-${action}`);
    return { sync: this.syncStates(ws), candidateId };
  }

  // ─────────────────────────── reverse import ───────────────────────────

  scanImport(projectPath: string): {
    items: { text: string; source: 'claude-md' | 'agents-md' }[];
  } {
    const ws = this.requireWorkspace(projectPath);
    const { model } = this.loadModel(ws.canonicalPath);
    const existing = listRules(model);
    const pending = this.pendingCandidates(ws.id);
    const items: { text: string; source: 'claude-md' | 'agents-md' }[] = [];
    const seen = new Set<string>();
    for (const target of SYNC_TARGETS) {
      const filePath = this.syncTargetPath(ws.canonicalPath, target);
      if (!existsSync(filePath)) continue;
      let content = '';
      try {
        content = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      for (const text of extractConventionBullets(contentOutsideManagedBlock(content))) {
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        if (
          existing.some(
            (rule) => correctionSimilarity(text, rule.text) >= CORRECTION_SIMILAR_THRESHOLD,
          )
        )
          continue;
        if (pending.some((c) => correctionSimilarity(text, c.text) >= CORRECTION_SIMILAR_THRESHOLD))
          continue;
        seen.add(key);
        items.push({ text, source: target === 'claude-md' ? 'claude-md' : 'agents-md' });
      }
    }
    return { items };
  }

  applyImport(
    projectPath: string,
    items: { text: string; source: 'claude-md' | 'agents-md' }[],
  ): number {
    const ws = this.requireWorkspace(projectPath);
    let added = 0;
    for (const item of items) {
      const origin: MemoryCandidateOrigin = {
        kind: 'reverse-import',
        taskId: null,
        label: item.source === 'claude-md' ? 'Imported from CLAUDE.md' : 'Imported from AGENTS.md',
        agent: item.source === 'claude-md' ? 'claude' : 'codex',
        path: null,
      };
      this.insertCandidate(ws.id, normalizeRuleText(item.text), origin, 1, null);
      added += 1;
    }
    if (added > 0) this.broadcast(ws.canonicalPath, 'import-applied');
    return added;
  }

  // ─────────────────────────── external private memory ───────────────────────────

  externalList(projectPath: string): ExternalMemoryFileDto[] {
    if (!this.discoverExternal) return [];
    return this.external.list(projectPath);
  }

  externalRead(fileId: string): {
    content: string;
    truncated: boolean;
    path: string;
    mtimeMs: number;
  } {
    return this.external.read(fileId);
  }

  externalWrite(
    fileId: string,
    content: string,
    expectedMtimeMs: number | null | undefined,
  ): ExternalMemoryFileDto {
    const dto = this.external.write(fileId, content, expectedMtimeMs);
    this.broadcast(null, 'external-written');
    return dto;
  }

  externalDelete(fileId: string): { backedUpTo: string } {
    const result = this.external.delete(fileId);
    this.broadcast(null, 'external-deleted');
    return result;
  }

  externalPromote(projectPath: string, fileId: string): MemoryCandidateDto {
    const ws = this.requireWorkspace(projectPath);
    const { text, file, displayPath } = this.external.readForPromote(fileId);
    const origin: MemoryCandidateOrigin = {
      kind: 'external-promote',
      taskId: null,
      label: `${file.role === 'instructions' ? 'instructions file' : 'private memory'} promoted`,
      agent: file.agent,
      path: displayPath,
    };
    const id = this.insertCandidate(ws.id, text, origin, 1, null);
    this.broadcast(ws.canonicalPath, 'external-promoted');
    const row = this.db
      .prepare(`SELECT * FROM memory_candidates WHERE id = ?`)
      .get(id) as unknown as CandidateRow;
    return candidateRowToDto(row);
  }

  // ─────────────────────────── internals ───────────────────────────

  rulesFilePathFor(projectPath: string): string {
    return join(projectPath, RULES_REL_PATH);
  }

  private syncTargetPath(projectPath: string, target: MemorySyncTarget): string {
    return join(projectPath, target === 'claude-md' ? 'CLAUDE.md' : 'AGENTS.md');
  }

  private loadModel(projectPath: string): { model: RulesFileModel; exists: boolean } {
    const filePath = this.rulesFilePathFor(projectPath);
    if (!existsSync(filePath)) {
      return { model: parseRulesFile('', this.idFactory), exists: false };
    }
    const content = readFileSync(filePath, 'utf8');
    return { model: parseRulesFile(content, this.idFactory), exists: true };
  }

  private persistModel(ws: WorkspaceRef, model: RulesFileModel, reason: string): void {
    const filePath = this.rulesFilePathFor(ws.canonicalPath);
    const hadFile = existsSync(filePath);
    const body = serializeRulesFile(model);
    const content = hadFile ? body : `${createDefaultRulesFile()}${body}`;
    writeFileAtomicDurable(filePath, content);
    // Projections follow the source automatically (enabled targets only).
    for (const target of SYNC_TARGETS) this.applySyncTarget(ws, target);
    this.broadcast(ws.canonicalPath, reason);
  }

  private freshRuleId(model: RulesFileModel): string {
    for (let i = 0; i < 32; i += 1) {
      const id = this.idFactory();
      if (!findRule(model, id)) return id;
    }
    throw fail('MEMORY_ID_EXHAUSTED', 'Could not allocate a rule id.');
  }

  private applySyncTarget(
    ws: WorkspaceRef,
    target: MemorySyncTarget,
    opts?: { force?: boolean },
  ): void {
    const row = this.syncRow(ws.id, target);
    if (!row || row.enabled === 0) return;
    const nowIso = this.now().toISOString();
    const filePath = this.syncTargetPath(ws.canonicalPath, target);
    try {
      const { model } = this.loadModel(ws.canonicalPath);
      const enabledTexts = listRules(model)
        .filter((rule) => rule.enabled)
        .map((rule) => rule.text);
      const expectedInner =
        target === 'claude-md' ? renderClaudeInner() : renderAgentsInner(enabledTexts);
      const expectedHash = managedBlockHash(expectedInner);
      const content = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
      const block = extractManagedBlock(content);
      if (block) {
        const currentHash = managedBlockHash(block.inner);
        if (currentHash === expectedHash) {
          this.updateSyncRow(ws.id, target, {
            status: 'ok',
            hash: expectedHash,
            syncedAt: nowIso,
            detail: null,
          });
          return;
        }
        const baseline = row.managed_block_hash;
        const editedSinceBaseline = baseline ? currentHash !== baseline : true;
        if (editedSinceBaseline && !opts?.force) {
          this.updateSyncRow(ws.id, target, {
            status: 'drift',
            detail: baseline
              ? 'The managed block was hand-edited since the last sync — choose import, overwrite or stop managing.'
              : 'Found an existing managed block that differs from the rules source — confirm how to take it over.',
          });
          return;
        }
      }
      const next = upsertManagedBlock(content, expectedInner);
      if (next !== content) writeFileAtomicDurable(filePath, next);
      this.updateSyncRow(ws.id, target, {
        status: 'ok',
        hash: expectedHash,
        syncedAt: nowIso,
        detail: null,
      });
    } catch (error) {
      this.logger.warn('memory.sync.failed', { target, message: errorMessage(error) });
      this.updateSyncRow(ws.id, target, { status: 'error', detail: errorMessage(error) });
    }
  }

  private importDriftedBlock(ws: WorkspaceRef, target: MemorySyncTarget): string | null {
    const filePath = this.syncTargetPath(ws.canonicalPath, target);
    if (!existsSync(filePath)) return null;
    let content = '';
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
    const block = extractManagedBlock(content);
    if (!block) return null;
    const { model } = this.loadModel(ws.canonicalPath);
    const ruleTexts = new Set(listRules(model).map((rule) => rule.text.toLowerCase()));
    let firstId: string | null = null;
    for (const text of extractConventionBullets(block.inner)) {
      if (ruleTexts.has(text.toLowerCase())) continue;
      if (target === 'claude-md' && text === renderClaudeInner()) continue;
      const origin: MemoryCandidateOrigin = {
        kind: 'reverse-import',
        taskId: null,
        label:
          target === 'claude-md'
            ? 'Hand edit in the CLAUDE.md managed block'
            : 'Hand edit in the AGENTS.md managed block',
        agent: target === 'claude-md' ? 'claude' : 'codex',
        path: null,
      };
      const id = this.insertCandidate(ws.id, normalizeRuleText(text), origin, 1, null);
      if (!firstId) firstId = id;
    }
    return firstId;
  }

  private syncStates(ws: WorkspaceRef): MemorySyncStateDto[] {
    return SYNC_TARGETS.map((target) => {
      const row = this.syncRow(ws.id, target);
      const filePath = this.syncTargetPath(ws.canonicalPath, target);
      if (!row) return this.defaultSyncState(ws.canonicalPath, target);
      return {
        target,
        enabled: row.enabled === 1,
        status: (row.enabled === 1 ? row.status : 'off') as MemorySyncStateDto['status'],
        filePath: this.displayPath(filePath),
        lastSyncedAt: row.last_synced_at,
        detail: row.detail,
      };
    });
  }

  private defaultSyncState(projectPath: string, target: MemorySyncTarget): MemorySyncStateDto {
    return {
      target,
      enabled: false,
      status: 'off',
      filePath: this.displayPath(this.syncTargetPath(projectPath, target)),
      lastSyncedAt: null,
      detail: null,
    };
  }

  private syncRow(workspaceId: string, target: MemorySyncTarget): SyncRow | undefined {
    return this.db
      .prepare(`SELECT * FROM memory_sync_state WHERE workspace_id = ? AND target = ?`)
      .get(workspaceId, target) as unknown as SyncRow | undefined;
  }

  private updateSyncRow(
    workspaceId: string,
    target: MemorySyncTarget,
    patch: { status: string; hash?: string; syncedAt?: string; detail?: string | null },
  ): void {
    this.db
      .prepare(
        `INSERT INTO memory_sync_state (workspace_id, target, enabled, managed_block_hash, last_synced_at, status, detail)
         VALUES (?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, target) DO UPDATE SET
           managed_block_hash = COALESCE(excluded.managed_block_hash, memory_sync_state.managed_block_hash),
           last_synced_at = COALESCE(excluded.last_synced_at, memory_sync_state.last_synced_at),
           status = excluded.status,
           detail = excluded.detail`,
      )
      .run(
        workspaceId,
        target,
        patch.hash ?? null,
        patch.syncedAt ?? null,
        patch.status,
        patch.detail ?? null,
      );
  }

  private insertCandidate(
    workspaceId: string,
    text: string,
    origin: MemoryCandidateOrigin,
    similarCount: number,
    matchedRuleId: string | null,
  ): string {
    const id = `mc_${globalThis.crypto.randomUUID()}`;
    const nowIso = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO memory_candidates
           (id, workspace_id, text, origin_json, similar_count, matched_rule_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        text,
        JSON.stringify(origin),
        similarCount,
        matchedRuleId,
        nowIso,
        nowIso,
      );
    return id;
  }

  private pendingCandidates(workspaceId: string): MemoryCandidateDto[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_candidates WHERE workspace_id = ? AND status = 'pending' ORDER BY created_at DESC`,
      )
      .all(workspaceId) as unknown as CandidateRow[];
    return rows.map((row) => candidateRowToDto(row));
  }

  private ruleStatsByRule(workspaceId: string): Map<string, StatsRow> {
    const rows = this.db
      .prepare(`SELECT * FROM memory_rule_stats WHERE workspace_id = ?`)
      .all(workspaceId) as unknown as StatsRow[];
    return new Map(rows.map((row) => [row.rule_id, row]));
  }

  private injectionCountsByRule(
    workspaceId: string,
  ): Map<string, { n: number; last: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT rule_id, COUNT(DISTINCT task_id) AS n, MAX(injected_at) AS last
         FROM memory_rule_injections
         WHERE workspace_id = ? GROUP BY rule_id`,
      )
      .all(workspaceId) as unknown as { rule_id: string; n: number; last: string | null }[];
    return new Map(rows.map((row) => [row.rule_id, { n: row.n, last: row.last }]));
  }

  private upsertRuleStats(
    workspaceId: string,
    ruleId: string,
    sourceTaskId: string | null,
    sourceLabel: string | null,
  ): void {
    const nowIso = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO memory_rule_stats (workspace_id, rule_id, source_task_id, source_label, created_at, hit_count)
         VALUES (?, ?, ?, ?, ?, 0)
         ON CONFLICT(workspace_id, rule_id) DO UPDATE SET
           source_task_id = COALESCE(memory_rule_stats.source_task_id, excluded.source_task_id),
           source_label = COALESCE(memory_rule_stats.source_label, excluded.source_label)`,
      )
      .run(workspaceId, ruleId, sourceTaskId, sourceLabel, nowIso);
  }

  private ruleToDto(
    rule: MemoryRuleEntry,
    stats: StatsRow | undefined,
    injections: { n: number; last: string | null } | undefined,
  ): MemoryRuleDto {
    return {
      id: rule.id,
      text: rule.text,
      group: rule.group,
      enabled: rule.enabled,
      sourceTaskId: stats?.source_task_id ?? null,
      sourceLabel: stats?.source_label ?? null,
      createdAt: stats?.created_at ?? null,
      injectedTasks: injections?.n ?? 0,
      hitCount: stats?.hit_count ?? 0,
      lastInjectedAt: injections?.last ?? null,
    };
  }

  private taskTitle(taskId: string): string | null {
    const row = this.db.prepare(`SELECT title FROM tasks WHERE id = ?`).get(taskId) as
      { title: string } | undefined;
    return row?.title ?? null;
  }

  private workspaceFor(projectPath: string): WorkspaceRef | null {
    const direct = this.db
      .prepare(`SELECT id, canonical_path FROM workspaces WHERE canonical_path = ?`)
      .get(projectPath) as unknown as { id: string; canonical_path: string } | undefined;
    if (direct) return { id: direct.id, canonicalPath: direct.canonical_path };
    try {
      const real = realpathSync(projectPath);
      const byReal = this.db
        .prepare(`SELECT id, canonical_path FROM workspaces WHERE canonical_path = ?`)
        .get(real) as unknown as { id: string; canonical_path: string } | undefined;
      if (byReal) return { id: byReal.id, canonicalPath: byReal.canonical_path };
    } catch {
      // path may not exist — fall through
    }
    return null;
  }

  private requireWorkspace(projectPath: string): WorkspaceRef {
    const ws = this.workspaceFor(projectPath);
    if (!ws) {
      throw fail(
        'MEMORY_WORKSPACE_UNKNOWN',
        'This folder is not an opened project yet — open it under Projects first.',
        projectPath,
      );
    }
    return ws;
  }

  private workspaceForTask(taskId: string): WorkspaceRef | null {
    const row = this.db
      .prepare(
        `SELECT w.id AS id, w.canonical_path AS canonical_path
         FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
         WHERE t.id = ?`,
      )
      .get(taskId) as unknown as { id: string; canonical_path: string } | undefined;
    return row ? { id: row.id, canonicalPath: row.canonical_path } : null;
  }

  private displayPath(absPath: string): string {
    return absPath.startsWith(this.home) ? `~${absPath.slice(this.home.length)}` : absPath;
  }

  private broadcast(projectPath: string | null, reason: string): void {
    try {
      this.broadcastFn({ projectPath, reason });
    } catch (error) {
      this.logger.warn('memory.broadcast.failed', { message: errorMessage(error) });
    }
  }
}

interface CandidateRow {
  id: string;
  workspace_id: string;
  text: string;
  origin_json: string;
  similar_count: number;
  matched_rule_id: string | null;
  status: string;
  resolved_rule_id: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface StatsRow {
  workspace_id: string;
  rule_id: string;
  source_task_id: string | null;
  source_label: string | null;
  created_at: string;
  hit_count: number;
  last_hit_at: string | null;
}

interface SyncRow {
  workspace_id: string;
  target: string;
  enabled: number;
  managed_block_hash: string | null;
  last_synced_at: string | null;
  status: string;
  detail: string | null;
}

function parseOrigin(json: string): MemoryCandidateOrigin {
  try {
    const parsed = JSON.parse(json) as Partial<MemoryCandidateOrigin>;
    return {
      kind: parsed.kind ?? 'manual',
      taskId: parsed.taskId ?? null,
      label: parsed.label ?? null,
      agent: parsed.agent ?? null,
      path: parsed.path ?? null,
    };
  } catch {
    return { kind: 'manual', taskId: null, label: null, agent: null, path: null };
  }
}

function candidateRowToDto(row: CandidateRow): MemoryCandidateDto {
  return {
    id: row.id,
    text: row.text,
    origin: parseOrigin(row.origin_json),
    similarCount: row.similar_count,
    matchedRuleId: row.matched_rule_id,
    status: row.status as MemoryCandidateDto['status'],
    createdAt: row.created_at,
  };
}
