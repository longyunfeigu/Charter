import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, dialog } from 'electron';
import type { Logger } from '@pi-ide/foundation';
import { registerHandlers } from './router.js';
import type { AgentRegistry } from '../services/agent-registry.js';
import type { AgentVerificationService } from '../services/agent-verification-service.js';

export function registerAgentVerificationHandlers(
  verification: AgentVerificationService,
  registry: AgentRegistry,
  logger: Logger,
): void {
  registerHandlers(
    {
      'agents.verification.scan': async ({ refresh }) => {
        if (refresh) registry.refresh();
        return verification.snapshot();
      },
      'agents.verification.begin': async (input) => verification.begin(input),
      'agents.verification.attach': async ({ runId, terminalId }) =>
        verification.attach(runId, terminalId),
      'agents.verification.getRun': async ({ runId }) => ({ run: verification.getRun(runId) }),
      'agents.verification.cancel': async ({ runId }) => verification.cancel(runId),
      'agents.verification.export': async () => {
        const report = verification.exportBundle({
          appVersion: app.getVersion(),
          platform: `${process.platform}-${process.arch}`,
        });
        let markdownPath: string | null;
        if (process.env.PI_IDE_E2E) {
          markdownPath = join(app.getPath('userData'), `${report.suggestedName}.md`);
        } else {
          const chosen = await dialog.showSaveDialog({
            title: 'Export Agent compatibility report',
            defaultPath: join(app.getPath('downloads'), `${report.suggestedName}.md`),
            filters: [{ name: 'Markdown report', extensions: ['md'] }],
          });
          markdownPath = chosen.canceled || !chosen.filePath ? null : chosen.filePath;
        }
        if (!markdownPath) return { markdownPath: null, jsonPath: null };
        const jsonPath = markdownPath.replace(/\.md$/i, '') + '.json';
        writeFileSync(markdownPath, report.markdown, { mode: 0o600 });
        writeFileSync(jsonPath, report.json, { mode: 0o600 });
        logger.info('agent verification report exported', { markdownPath, jsonPath });
        return { markdownPath, jsonPath };
      },
    },
    logger,
  );
}
