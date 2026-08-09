import { dialog } from 'electron';
import type { Logger } from '@pi-ide/foundation';
import type { WorkItemService } from '../services/work-item-service.js';
import { registerHandlers } from './router.js';

export function registerWorkItemHandlers(service: WorkItemService, logger: Logger): void {
  registerHandlers(
    {
      'workItem.snapshot': async ({ includeArchived }) => service.snapshot(includeArchived),
      'workItem.get': async ({ id }) => service.detail(id),
      'workItem.create': async (input) => ({ item: service.create(input) }),
      'workItem.update': async (input) => ({ item: service.update(input) }),
      'workItem.move': async (input) => ({ item: service.move(input) }),
      'workItem.archive': async ({ id, archived, expectedVersion }) => ({
        item: service.archive(id, archived, expectedVersion),
      }),
      'workItem.reminder.create': async ({ workItemId, remindAt, message }) => ({
        reminder: service.createReminder(workItemId, remindAt, message),
      }),
      'workItem.reminder.snooze': async ({ id, remindAt }) => ({
        reminder: service.snoozeReminder(id, remindAt),
      }),
      'workItem.reminder.cancel': async ({ id }) => ({
        reminder: service.cancelReminder(id),
      }),
      'workItem.execution.link': async (input) => ({ execution: service.linkExecution(input) }),
      'workItem.execution.unlink': async ({ id }) => ({ removed: service.unlinkExecution(id) }),
      'workItem.attachment.pick': async () => {
        const result = await dialog.showOpenDialog({
          title: 'Attach files to this work item',
          properties: ['openFile', 'multiSelections'],
        });
        return { paths: result.canceled ? null : result.filePaths.slice(0, 20) };
      },
      'workItem.evidence.add': async (input) => ({ evidence: service.addEvidence(input) }),
      'workItem.evidence.remove': async ({ id }) => ({ removed: service.removeEvidence(id) }),
      'workItem.type.create': async (input) => ({ type: service.createType(input) }),
      'workItem.column.create': async (input) => ({ column: service.createColumn(input) }),
    },
    logger,
  );
}
