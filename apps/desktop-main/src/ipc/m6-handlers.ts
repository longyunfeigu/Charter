import { errorMessage, productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import { providerPreset } from '@pi-ide/ipc-contracts';
import { registerHandlers } from './router.js';
import { processPreviewAttachment } from './preview-handlers.js';
import { resolveFileRefImages } from './context-attachment-handlers.js';
import type { TaskService } from '../services/task-service.js';
import type { AgentHost } from '../services/agent-host.js';
import type { SecretService } from '../services/secret-service.js';
import type { SettingsService } from '../services/settings-service.js';
import type { ModelCatalogService } from '../services/model-catalog.js';

export function registerM6Handlers(
  tasks: TaskService,
  host: AgentHost,
  secrets: SecretService,
  settings: SettingsService,
  catalog: ModelCatalogService,
  logger: Logger,
): void {
  registerHandlers(
    {
      'task.create': async (payload) => ({
        task: await tasks.createTask({
          title: payload.title,
          goalMd: payload.goalMd,
          acceptance: payload.acceptance,
          mode: payload.mode,
          model: payload.model,
          verification: payload.verification,
          ...(payload.projectPath !== undefined ? { projectPath: payload.projectPath } : {}),
          isolation: payload.isolation,
          ...(payload.worktreeSetup !== undefined ? { worktreeSetup: payload.worktreeSetup } : {}),
          conversationRefTaskIds: payload.conversationRefTaskIds,
        }),
      }),
      'task.start': async ({ taskId, prompt, preview, codeRefs, fileRefs }) => {
        // ADR-0022 am.2: a follow-up seeded from preview feedback carries the
        // screenshot into its first run (same processing as task.message).
        const attachment = preview ? await processPreviewAttachment(tasks, taskId, preview) : null;
        // ADR-0024: image refs become prompt pixels alongside preview shots.
        const refImages = await resolveFileRefImages(tasks, taskId, fileRefs);
        const images = [
          ...(attachment ? [{ data: attachment.imageData, mimeType: 'image/png' }] : []),
          ...refImages,
        ];
        const result = await tasks.startTask(
          taskId,
          prompt,
          attachment || codeRefs.length > 0 || fileRefs.length > 0
            ? {
                ...(codeRefs.length > 0 ? { codeRefs } : {}),
                ...(fileRefs.length > 0 ? { fileRefs } : {}),
                ...(images.length > 0 ? { images } : {}),
                ...(attachment ? { previewMeta: attachment.meta } : {}),
              }
            : undefined,
        );
        return { task: result.task, queued: result.queued };
      },
      'task.message': async ({ taskId, text, during, model, preview, codeRefs, fileRefs }) => {
        // ADR-0022: marquee feedback — persist the screenshot, attach the
        // timeline meta, and hand the pixels to the runtime with the text.
        const attachment = preview ? await processPreviewAttachment(tasks, taskId, preview) : null;
        // ADR-0024: image refs become prompt pixels alongside preview shots.
        const refImages = await resolveFileRefImages(tasks, taskId, fileRefs);
        const images = [
          ...(attachment ? [{ data: attachment.imageData, mimeType: 'image/png' }] : []),
          ...refImages,
        ];
        return {
          delivered: await tasks.steerOrQueue(
            taskId,
            text,
            during,
            model,
            attachment || codeRefs.length > 0 || fileRefs.length > 0
              ? {
                  ...(codeRefs.length > 0 ? { codeRefs } : {}),
                  ...(fileRefs.length > 0 ? { fileRefs } : {}),
                  ...(images.length > 0 ? { images } : {}),
                  ...(attachment ? { previewMeta: attachment.meta } : {}),
                }
              : undefined,
          ),
        };
      },
      'task.stop': async ({ taskId }) => ({ task: await tasks.stopTask(taskId) }),
      'task.list': async ({ filter, includeArchived, scope }) => ({
        tasks: tasks.listTasks(filter, includeArchived, scope),
      }),
      'task.get': async ({ taskId, eventsAfter }) => ({
        task: tasks.getTask(taskId),
        timeline: tasks.timeline(taskId, eventsAfter),
      }),
      'task.archive': async ({ taskId, confirmConflicts }) => {
        // ADR-0032: archive closes the Session; worktree merge-back happens
        // here and can surface conflicts for explicit confirmation.
        const result = await tasks.archive(taskId, { confirmConflicts });
        return {
          task: result.task,
          status: result.status,
          ...(result.status === 'conflicts' ? { conflicts: result.conflicts } : {}),
        };
      },
      'task.turns': async ({ taskId }) => ({ turns: tasks.turns(taskId) }),

      'models.list': async () => {
        const useMock =
          process.env.PI_IDE_FORCE_MOCK === '1' || settings.effective.models.useMockRuntime;
        try {
          const registry = await host.listModels(useMock ? 'mock' : 'pi');
          // PIVOT-009: remotely fetched models join the registry list.
          const models = useMock ? registry : catalog.merge(registry);
          const configured = new Set(secrets.list().map((s) => s.providerId));
          return {
            models: models.map((m) => ({
              ...m,
              configured: m.providerId === 'mock' ? true : configured.has(m.providerId),
              authKind:
                m.providerId === 'mock'
                  ? ('none' as const)
                  : configured.has(m.providerId)
                    ? ('api-key' as const)
                    : m.authKind,
            })),
            workerAlive: host.alive,
          };
        } catch (e) {
          logger.error('models.list failed', {
            error: errorMessage(e),
          });
          return { models: [], workerAlive: host.alive };
        }
      },
      'models.fetchRemote': async ({ providerId }) => ({
        models: await catalog.fetchRemote(providerId),
      }),
      'secrets.set': async ({ providerId, apiKey, baseUrl, api, displayName }) => {
        // Custom (non-preset) providers must say how to talk to them.
        const preset = providerPreset(providerId);
        const effectiveApi = api ?? preset?.api;
        if (!preset && !effectiveApi) {
          throw new ProductFailure(
            productError('SEC_PROVIDER_NEEDS_API', {
              userMessage: 'Custom providers need a protocol (Anthropic- or OpenAI-compatible).',
            }),
          );
        }
        if (!preset && !baseUrl) {
          throw new ProductFailure(
            productError('SEC_PROVIDER_NEEDS_URL', {
              userMessage: 'Custom providers need a Base URL.',
            }),
          );
        }
        if (preset?.baseUrlRequired && !baseUrl) {
          throw new ProductFailure(
            productError('SEC_PROVIDER_NEEDS_URL', {
              userMessage: `${preset.displayName} is a self-hosted proxy — set its Base URL (e.g. ${preset.placeholder}).`,
            }),
          );
        }
        secrets.setApiKey(providerId, apiKey, {
          baseUrl: baseUrl ?? null,
          ...(effectiveApi ? { api: effectiveApi } : {}),
          ...(displayName ? { displayName } : {}),
        });
        // Worker must be restarted to pick up new credentials.
        await host.stopWorker();
        return { configured: true };
      },
      'secrets.delete': async ({ providerId }) => {
        const deleted = secrets.delete(providerId);
        catalog.evict(providerId);
        await host.stopWorker(); // ONB-008: invalidate immediately
        return { deleted };
      },
      'secrets.list': async () => ({ items: secrets.list() }),
    },
    logger,
  );
}
