import { productError, ProductFailure, toProductError, type Logger } from '@pi-ide/foundation';
import type { ModelDescriptor } from '@pi-ide/agent-contract';
import { providerPreset } from '@pi-ide/ipc-contracts';
import { registerHandlers } from './router.js';
import { processPreviewAttachment } from './preview-handlers.js';
import { resolveFileRefImages } from './context-attachment-handlers.js';
import type { TaskService } from '../services/task-service.js';
import type { AgentHost } from '../services/agent-host.js';
import type { SecretService } from '../services/secret-service.js';
import type { SettingsService } from '../services/settings-service.js';
import type { ModelCatalogService } from '../services/model-catalog.js';
import type { ArtifactService } from '../services/artifact-service.js';

export function registerM6Handlers(
  tasks: TaskService,
  host: AgentHost,
  secrets: SecretService,
  settings: SettingsService,
  catalog: ModelCatalogService,
  logger: Logger,
  artifacts?: ArtifactService,
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
      'task.start': async ({ taskId, prompt, preview, codeRefs, fileRefs, artifactRefs }) => {
        const validArtifactRefs = artifacts
          ? await artifacts.validateFeedbackRefs(artifactRefs)
          : artifactRefs;
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
          attachment || codeRefs.length > 0 || fileRefs.length > 0 || validArtifactRefs.length > 0
            ? {
                ...(codeRefs.length > 0 ? { codeRefs } : {}),
                ...(fileRefs.length > 0 ? { fileRefs } : {}),
                ...(validArtifactRefs.length > 0 ? { artifactRefs: validArtifactRefs } : {}),
                ...(images.length > 0 ? { images } : {}),
                ...(attachment ? { previewMeta: attachment.meta } : {}),
              }
            : undefined,
        );
        return { task: result.task, queued: result.queued };
      },
      'task.message': async ({
        taskId,
        text,
        during,
        model,
        preview,
        codeRefs,
        fileRefs,
        artifactRefs,
      }) => {
        const validArtifactRefs = artifacts
          ? await artifacts.validateFeedbackRefs(artifactRefs)
          : artifactRefs;
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
            attachment || codeRefs.length > 0 || fileRefs.length > 0 || validArtifactRefs.length > 0
              ? {
                  ...(codeRefs.length > 0 ? { codeRefs } : {}),
                  ...(fileRefs.length > 0 ? { fileRefs } : {}),
                  ...(validArtifactRefs.length > 0 ? { artifactRefs: validArtifactRefs } : {}),
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
      'task.rename': async ({ taskId, title }) => ({
        task: tasks.renameTask(taskId, title),
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
      'task.delete': async ({ taskId }) => {
        await tasks.deleteTask(taskId);
        return { deleted: true as const };
      },
      'task.turns': async ({ taskId }) => ({ turns: tasks.turns(taskId) }),

      'models.list': async () => {
        const useMock =
          process.env.PI_IDE_FORCE_MOCK === '1' || settings.effective.models.useMockRuntime;
        try {
          const registry = await host.listModels(useMock ? 'mock' : 'pi');
          // PIVOT-009: remotely fetched models join the registry list.
          const models = useMock ? registry : catalog.merge(registry);
          const configured = new Set(secrets.configuredProviderIds());
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
          // The response already degrades to an empty catalog and the renderer
          // refetches on agent.workerStatus. Self-healing conditions (worker
          // still starting / restarting — retryable) are expected during cold
          // start and are not error-level events.
          const err = toProductError(e, 'AG_LIST_MODELS_FAILED');
          logger[err.retryable ? 'warn' : 'error']('models.list unavailable', {
            code: err.code,
            error: err.userMessage,
          });
          return { models: [], workerAlive: host.alive };
        }
      },
      'models.fetchRemote': async ({ providerId }) => {
        let registryCandidates: ModelDescriptor[] = [];
        try {
          // The provider's /models endpoint can be stale or incomplete. Pi's
          // same-provider registry supplies additional ids to verify against
          // the configured endpoint; verification still decides visibility.
          registryCandidates = await host.listModels('pi');
        } catch (e) {
          // A registry failure must not prevent verification of ids the
          // provider does advertise.
          const err = toProductError(e, 'AG_LIST_MODELS_FAILED');
          logger.warn('Pi registry unavailable during model verification', {
            providerId,
            code: err.code,
            error: err.userMessage,
          });
        }
        const routes = secrets.catalogRoutes(providerId);
        const routeIds = routes.length > 0 ? routes.map((route) => route.providerId) : [providerId];
        const settled = await Promise.allSettled(
          routeIds.map((routeProviderId) =>
            catalog.fetchRemote(routeProviderId, registryCandidates),
          ),
        );
        const primary = settled[0];
        if (!primary || primary.status === 'rejected') {
          throw primary?.reason;
        }
        const successful = settled.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : [],
        );
        const failedRouteIds = settled.flatMap((result, index) => {
          if (result.status === 'fulfilled') return [];
          const failedProviderId = routeIds[index]!;
          const err = toProductError(result.reason, 'MODELS_FETCH_FAILED');
          logger.warn('model verification route unavailable', {
            sourceProviderId: providerId,
            providerId: failedProviderId,
            code: err.code,
            error: err.userMessage,
          });
          return [failedProviderId];
        });
        return {
          models: successful.flatMap((result) => result.models),
          advertisedCount: successful.reduce((sum, result) => sum + result.advertisedCount, 0),
          registryCandidateCount: successful.reduce(
            (sum, result) => sum + result.registryCandidateCount,
            0,
          ),
          candidateCount: successful.reduce((sum, result) => sum + result.candidateCount, 0),
          unavailableModelIds: successful.flatMap((result) => result.unavailableModelIds),
          routeCount: routeIds.length,
          failedRouteIds,
        };
      },
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
        // A key, endpoint or protocol change invalidates point-in-time model
        // verification. The provider remains hidden until Fetch & verify runs.
        for (const relatedProviderId of secrets.relatedProviderIds(providerId)) {
          catalog.evict(relatedProviderId);
        }
        // Worker must be restarted to pick up new credentials.
        await host.stopWorker();
        return { configured: true };
      },
      'secrets.delete': async ({ providerId }) => {
        const relatedProviderIds = secrets.relatedProviderIds(providerId);
        const deleted = secrets.delete(providerId);
        for (const relatedProviderId of relatedProviderIds) catalog.evict(relatedProviderId);
        await host.stopWorker(); // ONB-008: invalidate immediately
        return { deleted };
      },
      'secrets.list': async () => ({ items: secrets.list() }),
    },
    logger,
  );
}
