import type { OrchestrationMessage, OrchestrationMessageType } from '@pi-ide/orchestration-domain';
import type { MissionRepository } from '@pi-ide/persistence';

export interface WaitForMessagesInput {
  assignmentId: string;
  types?: OrchestrationMessageType[];
  threadId?: string;
  afterSequence?: number;
  unreadOnly?: boolean;
  limit?: number;
  timeoutMs: number;
  markRead?: boolean;
  signal?: AbortSignal;
}

interface Waiter {
  assignmentId: string;
  read: () => OrchestrationMessage[];
  resolve: (messages: OrchestrationMessage[]) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

interface MissionWaiter<T> {
  missionId: string;
  read: () => T | null;
  resolve: (value: T | null) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/** Durable inbox plus an in-memory commit notification edge. */
export class OrchestrationMessageBus {
  private readonly waiters = new Set<Waiter>();
  private readonly missionWaiters = new Set<MissionWaiter<unknown>>();

  constructor(private readonly repository: MissionRepository) {}

  notifyAssignment(assignmentId: string): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.assignmentId !== assignmentId) continue;
      const messages = waiter.read();
      if (messages.length === 0) continue;
      waiter.cleanup();
      waiter.resolve(messages);
    }
  }

  notifyMission(missionId: string): void {
    for (const waiter of [...this.waiters]) {
      const assignment = this.repository.getAssignment(waiter.assignmentId);
      if (assignment?.missionId !== missionId) continue;
      const messages = waiter.read();
      if (messages.length === 0) continue;
      waiter.cleanup();
      waiter.resolve(messages);
    }
    for (const waiter of [...this.missionWaiters]) {
      if (waiter.missionId !== missionId) continue;
      const result = waiter.read();
      if (result === null) continue;
      waiter.cleanup();
      waiter.resolve(result);
    }
  }

  async wait(input: WaitForMessagesInput): Promise<OrchestrationMessage[]> {
    const read = () =>
      this.repository.listInbox(input.assignmentId, {
        unreadOnly: input.unreadOnly ?? true,
        types: input.types,
        threadId: input.threadId,
        afterSequence: input.afterSequence,
        limit: input.limit ?? 100,
      });
    const initial = read();
    if (initial.length > 0) return this.finish(input, initial);
    if (input.signal?.aborted) throw new Error('Orchestration wait was cancelled.');

    const messages = await new Promise<OrchestrationMessage[]>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => waiter.reject(new Error('Orchestration wait was cancelled.'));
      const waiter: Waiter = {
        assignmentId: input.assignmentId,
        read,
        resolve,
        reject,
        cleanup: () => {
          if (!this.waiters.delete(waiter)) return;
          if (timer) clearTimeout(timer);
          input.signal?.removeEventListener('abort', onAbort);
        },
      };
      const rejectWithCleanup = waiter.reject;
      waiter.reject = (error) => {
        waiter.cleanup();
        rejectWithCleanup(error);
      };
      this.waiters.add(waiter);
      input.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(
        () => {
          waiter.cleanup();
          resolve([]);
        },
        Math.max(1, input.timeoutMs),
      );

      // Close the read/subscribe race: a committed message between the first
      // query and waiter registration is observed here.
      const afterSubscribe = read();
      if (afterSubscribe.length > 0) {
        waiter.cleanup();
        resolve(afterSubscribe);
      }
    });
    return this.finish(input, messages);
  }

  async waitForMission<T>(
    missionId: string,
    read: () => T | null,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T | null> {
    const initial = read();
    if (initial !== null) return initial;
    if (signal?.aborted) throw new Error('Orchestration join was cancelled.');
    return await new Promise<T | null>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => waiter.reject(new Error('Orchestration join was cancelled.'));
      const waiter: MissionWaiter<T> = {
        missionId,
        read,
        resolve,
        reject,
        cleanup: () => {
          if (!this.missionWaiters.delete(waiter as MissionWaiter<unknown>)) return;
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        },
      };
      const rejectWithCleanup = waiter.reject;
      waiter.reject = (error) => {
        waiter.cleanup();
        rejectWithCleanup(error);
      };
      this.missionWaiters.add(waiter as MissionWaiter<unknown>);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(
        () => {
          waiter.cleanup();
          resolve(null);
        },
        Math.max(1, timeoutMs),
      );
      const afterSubscribe = read();
      if (afterSubscribe !== null) {
        waiter.cleanup();
        resolve(afterSubscribe);
      }
    });
  }

  shutdown(reason = 'Orchestration message bus stopped.'): void {
    for (const waiter of [...this.waiters]) waiter.reject(new Error(reason));
    for (const waiter of [...this.missionWaiters]) waiter.reject(new Error(reason));
  }

  private finish(
    input: WaitForMessagesInput,
    messages: OrchestrationMessage[],
  ): OrchestrationMessage[] {
    if (input.markRead && messages.length > 0) {
      this.repository.markMessagesRead(
        input.assignmentId,
        messages.map((message) => message.id),
      );
    }
    return messages;
  }
}
