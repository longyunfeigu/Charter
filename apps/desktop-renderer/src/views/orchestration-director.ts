import type { OrchestrationWorkerDto, PermissionCardDto } from '@pi-ide/ipc-contracts';

export interface DirectorCandidate {
  worker: OrchestrationWorkerDto;
  priority: number;
  reason: string;
}

/** Keep auto-director cuts meaningful instead of following every output timestamp. */
export function shouldDirectorCut(
  current: DirectorCandidate | null,
  next: DirectorCandidate | null,
): boolean {
  if (!next) return false;
  if (!current) return true;
  if (current.worker.terminalId === next.worker.terminalId) return false;
  if (next.priority !== current.priority) return next.priority > current.priority;
  // Equal-priority streaming/quiet workers are deliberately sticky. Raw PTY
  // output updates timestamps continuously and otherwise makes the stage flicker.
  if (next.priority < 30) return false;
  return Date.parse(next.worker.updatedAt) > Date.parse(current.worker.updatedAt);
}

function permissionTargets(card: PermissionCardDto, terminalId: string): boolean {
  const input = card.input as { id?: unknown } | null;
  return input?.id === terminalId || Boolean(card.preview.targets?.includes(terminalId));
}

export function directorCandidate(
  workers: readonly OrchestrationWorkerDto[],
  permissions: readonly PermissionCardDto[],
): DirectorCandidate | null {
  const ranked = workers.map((worker): DirectorCandidate => {
    const approval = permissions.find((card) => permissionTargets(card, worker.terminalId));
    if (approval) return { worker, priority: 50, reason: `待审批 ${approval.risk.level}` };
    if (worker.status === 'failed') return { worker, priority: 40, reason: '失败 / 异常退出' };
    if (worker.status === 'completed') return { worker, priority: 30, reason: '刚刚完成' };
    if (worker.status === 'streaming') return { worker, priority: 20, reason: '正在输出' };
    return { worker, priority: 10, reason: '静默' };
  });
  return (
    ranked.sort(
      (a, b) =>
        b.priority - a.priority || Date.parse(b.worker.updatedAt) - Date.parse(a.worker.updatedAt),
    )[0] ?? null
  );
}
