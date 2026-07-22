import { create } from 'zustand';
import type {
  OrchestrationSnapshotDto,
  OrchestrationWorkerDto,
  PermissionCardDto,
} from '@pi-ide/ipc-contracts';
import { onEvent, rpcResult } from '../bridge.js';
import { useAppStore } from './appStore.js';
import { useTerminalStore } from '../views/TerminalPanel.js';

interface OrchestrationStore {
  initialized: boolean;
  loading: boolean;
  error: string | null;
  snapshot: OrchestrationSnapshotDto;
  permissions: Record<string, PermissionCardDto[]>;
  init(): void;
  trackTask(taskId: string): void;
  untrackTask(taskId: string): void;
  refresh(): Promise<void>;
  refreshPermissions(): Promise<void>;
  workersFor(taskId: string): OrchestrationWorkerDto[];
  pauseWorker(terminalId: string, paused: boolean): Promise<void>;
  pauseFleet(taskId: string, paused: boolean): Promise<void>;
  handBack(terminalId: string): Promise<void>;
  recordCut(taskId: string, terminalId: string, reason: string): Promise<void>;
}

const EMPTY: OrchestrationSnapshotDto = {
  enabled: false,
  fleetPausedTaskIds: [],
  workers: [],
};

let permissionTimer: number | null = null;
const trackedTaskIds = new Map<string, number>();

function adoptWorkers(snapshot: OrchestrationSnapshotDto): void {
  for (const worker of snapshot.workers) {
    if (worker.status === 'exited') continue;
    void useTerminalStore.getState().adopt(worker.terminalId, worker.outputTail);
  }
}

export const useOrchestrationStore = create<OrchestrationStore>((set, get) => ({
  initialized: false,
  loading: false,
  error: null,
  snapshot: EMPTY,
  permissions: {},

  init() {
    if (get().initialized) return;
    set({ initialized: true });
    onEvent('orchestration.changed', (snapshot) => {
      adoptWorkers(snapshot);
      set({ snapshot, loading: false, error: null });
      void get().refreshPermissions();
    });
    onEvent('task.event', ({ taskId }) => {
      if (
        !trackedTaskIds.has(taskId) &&
        !get().snapshot.workers.some((worker) => worker.commanderTaskId === taskId)
      ) {
        return;
      }
      if (permissionTimer !== null) window.clearTimeout(permissionTimer);
      permissionTimer = window.setTimeout(() => {
        permissionTimer = null;
        void get().refreshPermissions();
      }, 80);
    });
    void get().refresh();
  },

  trackTask(taskId) {
    trackedTaskIds.set(taskId, (trackedTaskIds.get(taskId) ?? 0) + 1);
    void get().refreshPermissions();
  },

  untrackTask(taskId) {
    const count = trackedTaskIds.get(taskId) ?? 0;
    if (count <= 1) trackedTaskIds.delete(taskId);
    else trackedTaskIds.set(taskId, count - 1);
  },

  async refresh() {
    set({ loading: true, error: null });
    const result = await rpcResult('orchestration.getState', {});
    if (!result.ok) {
      set({ loading: false, error: result.error.userMessage });
      return;
    }
    adoptWorkers(result.data);
    set({ snapshot: result.data, loading: false, error: null });
    await get().refreshPermissions();
  },

  async refreshPermissions() {
    const taskIds = [
      ...new Set([
        ...trackedTaskIds.keys(),
        ...get().snapshot.workers.map((worker) => worker.commanderTaskId),
      ]),
    ];
    const entries = await Promise.all(
      taskIds.map(async (taskId) => {
        const result = await rpcResult('task.pendingPermissions', { taskId });
        return [taskId, result.ok ? result.data.permissions : []] as const;
      }),
    );
    set({ permissions: Object.fromEntries(entries) });
  },

  workersFor(taskId) {
    return get().snapshot.workers.filter((worker) => worker.commanderTaskId === taskId);
  },

  async pauseWorker(terminalId, paused) {
    const result = await rpcResult('orchestration.pauseWorker', { terminalId, paused });
    if (result.ok) set({ snapshot: result.data });
    else useAppStore.getState().pushToast('error', result.error.userMessage);
  },

  async pauseFleet(taskId, paused) {
    const result = await rpcResult('orchestration.pauseFleet', { taskId, paused });
    if (result.ok) set({ snapshot: result.data });
    else useAppStore.getState().pushToast('error', result.error.userMessage);
  },

  async handBack(terminalId) {
    const result = await rpcResult('orchestration.handBack', { terminalId });
    if (result.ok) set({ snapshot: result.data });
    else useAppStore.getState().pushToast('error', result.error.userMessage);
  },

  async recordCut(taskId, terminalId, reason) {
    const result = await rpcResult('orchestration.directorCut', { taskId, terminalId, reason });
    if (!result.ok) useAppStore.getState().pushToast('error', result.error.userMessage);
  },
}));

export function permissionForWorker(
  permissions: readonly PermissionCardDto[],
  terminalId: string,
): PermissionCardDto | null {
  return (
    permissions.find((card) => {
      const input = card.input as { id?: unknown } | null;
      return input?.id === terminalId || card.preview.targets?.includes(terminalId);
    }) ?? null
  );
}
