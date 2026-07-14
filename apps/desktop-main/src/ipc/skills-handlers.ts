import { dialog } from 'electron';
import type { Logger } from '@pi-ide/foundation';
import { registerHandlers } from './router.js';
import type { SkillStore } from '../services/skill-store.js';

/** Skills manager (ADR-0015): managed store CRUD + audit reads. */
export function registerSkillsHandlers(skills: SkillStore, logger: Logger): void {
  registerHandlers(
    {
      'skills.list': async () => ({ skills: skills.list() }),
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
      'skills.remove': async ({ id }) => ({ removed: skills.remove(id) }),
      'skills.setEnabled': async ({ id, enabled }) => ({ skill: skills.setEnabled(id, enabled) }),
      'skills.read': async ({ id, relPath }) => skills.readFile(id, relPath),
    },
    logger,
  );
}
