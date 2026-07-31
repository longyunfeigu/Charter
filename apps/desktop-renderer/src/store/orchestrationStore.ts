import { create } from 'zustand';
import type {
  OrchestrationSnapshotDto,
  OrchestrationWorkerDto,
  MissionSnapshotDto,
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
  /** Compatibility lookup for conversation-owned Missions. */
  missions: Record<string, MissionSnapshotDto | null>;
  /** Canonical Mission Center lookup. Includes recent terminal Missions. */
  missionsById: Record<string, MissionSnapshotDto>;
  missionOrder: string[];
  init(): void;
  trackTask(taskId: string): void;
  untrackTask(taskId: string): void;
  refresh(): Promise<void>;
  refreshMissions(): Promise<void>;
  refreshPermissions(): Promise<void>;
  refreshMission(taskId: string): Promise<void>;
  workersFor(taskId: string): OrchestrationWorkerDto[];
  pauseWorker(terminalId: string, paused: boolean): Promise<void>;
  pauseFleet(taskId: string, paused: boolean): Promise<void>;
  handBack(terminalId: string): Promise<void>;
  recordCut(taskId: string, terminalId: string, reason: string): Promise<void>;
  pauseAssignment(missionRef: string, assignmentId: string, paused: boolean): Promise<void>;
  pauseMission(missionRef: string, paused: boolean): Promise<void>;
  steerAssignment(missionRef: string, assignmentId: string, text: string): Promise<void>;
  replyToMessage(missionRef: string, messageId: string, body: string): Promise<void>;
  closeRuntime(missionRef: string, assignmentId: string): Promise<void>;
  promoteLead(missionRef: string, assignmentId: string): Promise<void>;
  cancelAssignment(missionRef: string, assignmentId: string, reason: string): Promise<void>;
  retryAssignment(missionRef: string, assignmentId: string): Promise<void>;
  reassignAssignment(
    missionRef: string,
    assignmentId: string,
    runtime: 'managed' | 'claude' | 'codex' | 'shell',
    displayName: string,
  ): Promise<void>;
  finishMission(
    missionRef: string,
    outcome: 'completed' | 'failed' | 'cancelled',
    reason: string,
  ): Promise<void>;
  requestRevision(missionRef: string, feedback: string): Promise<void>;
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
    void useTerminalStore.getState().adopt(worker.terminalId);
  }
}

function missionFor(
  state: Pick<OrchestrationStore, 'missions' | 'missionsById'>,
  reference: string,
): MissionSnapshotDto | null {
  return state.missionsById[reference] ?? state.missions[reference] ?? null;
}

function withMission(
  state: Pick<OrchestrationStore, 'missions' | 'missionsById' | 'missionOrder'>,
  snapshot: MissionSnapshotDto,
): Pick<OrchestrationStore, 'missions' | 'missionsById' | 'missionOrder'> {
  const originTaskId = snapshot.mission.originConversationTaskId;
  return {
    missionsById: { ...state.missionsById, [snapshot.mission.id]: snapshot },
    missions: originTaskId ? { ...state.missions, [originTaskId]: snapshot } : state.missions,
    missionOrder: [
      snapshot.mission.id,
      ...state.missionOrder.filter((id) => id !== snapshot.mission.id),
    ],
  };
}

export const useOrchestrationStore = create<OrchestrationStore>((set, get) => ({
  initialized: false,
  loading: false,
  error: null,
  snapshot: EMPTY,
  permissions: {},
  missions: {},
  missionsById: {},
  missionOrder: [],

  init() {
    if (get().initialized) return;
    set({ initialized: true });
    onEvent('orchestration.changed', (snapshot) => {
      adoptWorkers(snapshot);
      set({ snapshot, loading: false, error: null });
      void get().refreshPermissions();
    });
    onEvent('mission.changed', (snapshot) => {
      set((state) => withMission(state, snapshot));
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
    void get().refreshMissions();
  },

  trackTask(taskId) {
    trackedTaskIds.set(taskId, (trackedTaskIds.get(taskId) ?? 0) + 1);
    void get().refreshPermissions();
    void get().refreshMission(taskId);
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

  async refreshMissions() {
    const result = await rpcResult('mission.list', { limit: 100 });
    if (!result.ok) return;
    const byTask = Object.fromEntries(
      result.data.missions.flatMap((snapshot) => {
        const taskId = snapshot.mission.originConversationTaskId;
        return taskId ? [[taskId, snapshot] as const] : [];
      }),
    );
    set({
      missions: byTask,
      missionsById: Object.fromEntries(
        result.data.missions.map((snapshot) => [snapshot.mission.id, snapshot]),
      ),
      missionOrder: result.data.missions.map((snapshot) => snapshot.mission.id),
    });
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

  async refreshMission(taskId) {
    const result = await rpcResult('mission.forConversation', { taskId });
    if (result.ok) {
      if (result.data.snapshot) set((state) => withMission(state, result.data.snapshot!));
      else set((state) => ({ missions: { ...state.missions, [taskId]: null } }));
    }
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

  async pauseAssignment(missionRef, assignmentId, paused) {
    const current = missionFor(get(), missionRef);
    if (!current) return;
    const result = await rpcResult('mission.pauseAssignment', {
      missionId: current.mission.id,
      assignmentId,
      paused,
    });
    if (result.ok) set((state) => withMission(state, result.data));
    else useAppStore.getState().pushToast('error', result.error.userMessage);
  },

  async pauseMission(missionRef, paused) {
    const current = missionFor(get(), missionRef);
    if (!current) return;
    const targets = current.assignments.filter((assignment) =>
      paused ? ['ACTIVE', 'WAITING'].includes(assignment.state) : assignment.state === 'PAUSED',
    );
    for (const assignment of targets) {
      const result = await rpcResult('mission.pauseAssignment', {
        missionId: current.mission.id,
        assignmentId: assignment.id,
        paused,
      });
      if (!result.ok) {
        useAppStore.getState().pushToast('error', result.error.userMessage);
        continue;
      }
      set((state) => withMission(state, result.data));
    }
  },

  async steerAssignment(missionRef, assignmentId, text) {
    const current = missionFor(get(), missionRef);
    if (!current) return;
    const result = await rpcResult('mission.steerAssignment', {
      missionId: current.mission.id,
      assignmentId,
      text,
    });
    if (result.ok) set((state) => withMission(state, result.data));
    else useAppStore.getState().pushToast('error', result.error.userMessage);
  },

  async replyToMessage(missionRef, messageId, body) {
    const current = missionFor(get(), missionRef);
    if (!current) return;
    const result = await rpcResult('mission.replyMessage', {
      missionId: current.mission.id,
      messageId,
      body,
    });
    if (result.ok) set((state) => withMission(state, result.data));
    else useAppStore.getState().pushToast('error', result.error.userMessage);
  },

  async closeRuntime(missionRef, assignmentId) {
    const current = missionFor(get(), missionRef);
    if (!current) return;
    const result = await rpcResult('mission.closeRuntime', {
      missionId: current.mission.id,
      assignmentId,
      reason: 'Closed by user from Mission Runtime inspector',
    });
    if (result.ok) set((state) => withMission(state, result.data));
    else useAppStore.getState().pushToast('error', result.error.userMessage);
  },

  async promoteLead(missionRef, assignmentId) {
    const current = missionFor(get(), missionRef);
    if (!current) return;
    const result = await rpcResult('mission.promoteLead', {
      missionId: current.mission.id,
      assignmentId,
      reason: 'Promoted by user from Mission Runtime inspector',
    });
    if (result.ok) set((state) => withMission(state, result.data));
    else useAppStore.getState().pushToast('error', result.error.userMessage);
  },

  async cancelAssignment(missionRef, assignmentId, reason) {
    const current = missionFor(get(), missionRef);
    if (!current) return;
    const result = await rpcResult('mission.cancelAssignment', {
      missionId: current.mission.id,
      assignmentId,
      reason,
    });
    if (result.ok) set((state) => withMission(state, result.data));
    else useAppStore.getState().pushToast('error', result.error.userMessage);
  },

  async retryAssignment(missionRef, assignmentId) {
    const current = missionFor(get(), missionRef);
    if (!current) return;
    const result = await rpcResult('mission.retryAssignment', {
      missionId: current.mission.id,
      assignmentId,
    });
    if (result.ok) set((state) => withMission(state, result.data));
    else useAppStore.getState().pushToast('error', result.error.userMessage);
  },

  async reassignAssignment(missionRef, assignmentId, runtime, displayName) {
    const current = missionFor(get(), missionRef);
    if (!current) return;
    const kind =
      runtime === 'managed'
        ? ('managed_agent' as const)
        : runtime === 'shell'
          ? ('shell_agent' as const)
          : ('external_agent' as const);
    const result = await rpcResult('mission.reassignAssignment', {
      missionId: current.mission.id,
      assignmentId,
      assignee: { kind, provider: runtime, displayName },
      requestedRuntime: runtime,
      reason: 'Reassigned by user from Mission Runtime inspector',
    });
    if (result.ok) set((state) => withMission(state, result.data));
    else useAppStore.getState().pushToast('error', result.error.userMessage);
  },

  async finishMission(missionRef, outcome, reason) {
    const current = missionFor(get(), missionRef);
    if (!current) return;
    const result = await rpcResult('mission.finish', {
      missionId: current.mission.id,
      outcome,
      reason,
    });
    if (result.ok) set((state) => withMission(state, result.data));
    else useAppStore.getState().pushToast('error', result.error.userMessage);
  },

  async requestRevision(missionRef, feedback) {
    const current = missionFor(get(), missionRef);
    if (!current) return;
    const result = await rpcResult('mission.requestRevision', {
      missionId: current.mission.id,
      feedback,
      idempotencyKey: `user-revision:${current.mission.id}:${Date.now()}:${crypto.randomUUID()}`,
    });
    if (result.ok) {
      set((state) => withMission(state, result.data));
      useAppStore
        .getState()
        .pushToast('success', 'Changes requested. The Mission is running again.');
    } else useAppStore.getState().pushToast('error', result.error.userMessage);
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
