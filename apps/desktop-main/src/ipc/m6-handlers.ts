import type { Logger } from '@pi-ide/foundation';
import { registerHandlers } from './router.js';
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
        }),
      }),
      'task.start': async ({ taskId, prompt }) => {
        const result = await tasks.startTask(taskId, prompt);
        return { task: result.task, queued: result.queued };
      },
      'task.message': async ({ taskId, text, during }) => ({
        delivered: tasks.steerOrQueue(taskId, text, during),
      }),
      'task.stop': async ({ taskId }) => ({ task: await tasks.stopTask(taskId) }),
      'task.list': async ({ filter, includeArchived, scope }) => ({
        tasks: tasks.listTasks(filter, includeArchived, scope),
      }),
      'task.get': async ({ taskId, eventsAfter }) => ({
        task: tasks.getTask(taskId),
        timeline: tasks.timeline(taskId, eventsAfter),
      }),
      'task.archive': async ({ taskId }) => ({ task: tasks.archive(taskId) }),

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
            error: e instanceof Error ? e.message : String(e),
          });
          return { models: [], workerAlive: host.alive };
        }
      },
      'models.fetchRemote': async ({ providerId }) => ({
        models: await catalog.fetchRemote(providerId),
      }),
      'secrets.set': async ({ providerId, apiKey, baseUrl }) => {
        secrets.setApiKey(providerId, apiKey, baseUrl ?? null);
        // Worker must be restarted to pick up new credentials.
        await host.stopWorker();
        return { configured: true };
      },
      'secrets.delete': async ({ providerId }) => {
        const deleted = secrets.delete(providerId);
        await host.stopWorker(); // ONB-008: invalidate immediately
        return { deleted };
      },
      'secrets.list': async () => ({ items: secrets.list() }),
    },
    logger,
  );
}
