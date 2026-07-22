import { dialog, shell } from 'electron';
import { errorMessage, type Logger } from '@pi-ide/foundation';
import { registerHandlers } from './router.js';
import type { SkillStore } from '../services/skill-store.js';
import {
  aggregateSkillUsage,
  composeSkillUsage,
  joinExternalSkillEvents,
  type ConsumerSkillUsageEvent,
  type ExternalSkillEvent,
  type SkillUsageEvent,
} from '../services/skill-usage.js';
import { CHARTER_TERMINAL_SKILL } from '../services/terminal-control-manual.js';
import {
  charterTerminalSurfaceStatus,
  installCharterTerminalSurfaces,
} from '../services/charter-terminal-surfaces.js';

export interface SkillsHandlerDeps {
  /**
   * ADR-0037: the invocation ledgers live with the task database. The
   * callback indirection tolerates the TaskService being constructed after
   * these handlers register (usage reads empty until then).
   */
  events?: (windowDays: number) => SkillUsageEvent[];
  /**
   * ADR-0040: raw Skill invocations parsed out of external CLI transcripts
   * (session archaeology, also constructed later). Failures degrade to
   * Charter-only numbers — the panel never breaks over a transcript read.
   */
  externalEvents?: () => Promise<ExternalSkillEvent[]>;
}

const USAGE_WINDOW_DAYS_DEFAULT = 45;

/** Skills manager (ADR-0015/0019): managed imports + linked source registry. */
export function registerSkillsHandlers(
  skills: SkillStore,
  logger: Logger,
  deps: SkillsHandlerDeps = {},
): void {
  registerHandlers(
    {
      'skills.list': async () => skills.rescan('ipc-list'),
      'skills.rescan': async () => skills.rescan('manual'),
      'skills.import': async ({ dir }) => {
        let source = dir ?? null;
        if (!source) {
          const result = await dialog.showOpenDialog({
            properties: ['openDirectory'],
            title: 'Import skill folder (must contain SKILL.md)',
            buttonLabel: 'Import',
          });
          source = result.canceled ? null : (result.filePaths[0] ?? null);
        }
        if (!source) return { skill: null };
        return { skill: skills.import(source) };
      },
      // ADR-0045: one explicit click lands the manual in Charter's managed
      // store (Pi runtime) and in ~/.claude/skills + ~/.codex/skills, so a
      // hand-launched claude/codex can trigger orchestration even when the
      // MCP wrapper chain is bypassed by the user's shell.
      'skills.installCharterTerminal': async () => ({
        skill: skills.installManaged('charter-terminal', CHARTER_TERMINAL_SKILL),
        surfaces: installCharterTerminalSurfaces(),
      }),
      'skills.charterTerminalStatus': async () => ({
        surfaces: charterTerminalSurfaceStatus(),
      }),
      'skills.addSource': async ({ dir }) => {
        let source = dir ?? null;
        if (!source) {
          const result = await dialog.showOpenDialog({
            properties: ['openDirectory'],
            title: 'Connect a live skill source',
            buttonLabel: 'Connect',
          });
          source = result.canceled ? null : (result.filePaths[0] ?? null);
        }
        if (!source) return { source: null };
        return { source: skills.addSource(source) };
      },
      'skills.removeSource': async ({ id }) => ({ removed: skills.removeSource(id) }),
      'skills.setSourcePolicy': async ({ id, trusted, autoEnableNew }) => ({
        source: skills.setSourcePolicy(id, {
          ...(trusted !== undefined ? { trusted } : {}),
          ...(autoEnableNew !== undefined ? { autoEnableNew } : {}),
        }),
      }),
      'skills.remove': async ({ id }) => ({ removed: skills.remove(id) }),
      'skills.setEnabled': async ({ id, enabled }) => ({ skill: skills.setEnabled(id, enabled) }),
      'skills.setAgentEnabled': async ({ id, enabled }) => ({
        skill: skills.setAgentEnabled(id, enabled),
      }),
      'skills.trash': async ({ id }) => {
        const target = skills.trashTarget(id);
        await shell.trashItem(target);
        skills.finishTrash(id);
        return { removed: true };
      },
      'skills.read': async ({ id, relPath }) => skills.readFile(id, relPath),
      // ADR-0037: usage insight — catalog joined with ledger counts + the
      // preamble cost each enabled skill charges on every turn. ADR-0040
      // merges in external CLI invocations, split per consumer.
      'skills.usage': async ({ windowDays }) => {
        const days = windowDays ?? USAGE_WINDOW_DAYS_DEFAULT;
        const catalog = skills.list();
        const estimates = skills.preambleTokenEstimates();
        const charter: ConsumerSkillUsageEvent[] = (deps.events?.(days) ?? []).map((event) => ({
          ...event,
          consumer: 'charter' as const,
        }));
        let external: ConsumerSkillUsageEvent[] = [];
        try {
          external = joinExternalSkillEvents((await deps.externalEvents?.()) ?? [], catalog);
        } catch (e) {
          logger.warn('external skill usage unavailable', { error: errorMessage(e) });
        }
        const usage = aggregateSkillUsage([...charter, ...external], Date.now(), days);
        return {
          windowDays: days,
          since: new Date(Date.now() - days * 86_400_000).toISOString(),
          preambleOverheadTokens: estimates.overheadTokens,
          skills: composeSkillUsage(catalog, estimates, usage, days),
        };
      },
    },
    logger,
  );
}
