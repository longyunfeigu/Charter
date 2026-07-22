import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OrchestrationWorkerDto, PermissionCardDto } from '@pi-ide/ipc-contracts';
import { useAppStore } from '../store/appStore.js';
import { permissionForWorker, useOrchestrationStore } from '../store/orchestrationStore.js';
import { useTaskStore } from '../store/taskStore.js';
import { PermissionCard } from './AgentPanel.js';
import { directorCandidate, type DirectorCandidate } from './orchestration-director.js';
import { useTerminalStore } from './TerminalPanel.js';
import { terminalViewportText } from './terminal-viewport-text.js';

const FLEET_FOLD_KEY = 'charter.orchestration.fleet.folded.v1';
const EMPTY_PERMISSIONS: PermissionCardDto[] = [];

function workerName(worker: OrchestrationWorkerDto): string {
  const provider =
    worker.launch === 'shell' ? 'Shell' : worker.launch === 'claude' ? 'Claude' : 'Codex';
  return `${provider} · ${worker.title}`;
}

function openWorker(worker: OrchestrationWorkerDto): void {
  if (worker.taskId) {
    void useTaskStore.getState().openTask(worker.taskId);
    useAppStore.getState().openTaskRoom(worker.taskId);
  } else {
    useAppStore.getState().openTerminalSession(worker.terminalId);
  }
}

function StatusPill({ worker }: { worker: OrchestrationWorkerDto }): React.JSX.Element {
  const labels: Record<OrchestrationWorkerDto['status'], string> = {
    streaming: '输出中',
    quiet: '静默',
    completed: '完成',
    failed: '失败',
    exited: '已退出',
  };
  return <span className={`orch-status ${worker.status}`}>{labels[worker.status]}</span>;
}

interface CutLogEntry {
  terminalId: string;
  name: string;
  reason: string;
  at: string;
  snapshot: string;
}

export function OrchestrationFleet({ taskId }: { taskId: string }): React.JSX.Element | null {
  const initialized = useOrchestrationStore((state) => state.initialized);
  const loading = useOrchestrationStore((state) => state.loading);
  const error = useOrchestrationStore((state) => state.error);
  const snapshot = useOrchestrationStore((state) => state.snapshot);
  const terminalItems = useTerminalStore((state) => state.items);
  const permissions = useOrchestrationStore(
    (state) => state.permissions[taskId] ?? EMPTY_PERMISSIONS,
  );
  const workers = useMemo(
    () => snapshot.workers.filter((worker) => worker.commanderTaskId === taskId),
    [snapshot.workers, taskId],
  );
  const [folded, setFolded] = useState(() => {
    try {
      return window.localStorage.getItem(FLEET_FOLD_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [automatic, setAutomatic] = useState(true);
  const [locked, setLocked] = useState(false);
  const [stagedId, setStagedId] = useState<string | null>(null);
  const [stageReason, setStageReason] = useState('等待活动');
  const [pending, setPending] = useState<DirectorCandidate | null>(null);
  const [cutLog, setCutLog] = useState<CutLogEntry[]>([]);
  const [reviewIndex, setReviewIndex] = useState<number | null>(null);
  const previousWorkers = useRef(workers);
  const terminalById = useMemo(
    () => new Map(terminalItems.map((item) => [item.id, item])),
    [terminalItems],
  );
  const workerOutput = useCallback(
    (worker: OrchestrationWorkerDto): string => {
      const item = terminalById.get(worker.terminalId);
      return (item ? terminalViewportText(item) : '') || worker.outputTail;
    },
    [terminalById],
  );

  useEffect(() => {
    if (!initialized) useOrchestrationStore.getState().init();
  }, [initialized]);

  useEffect(() => {
    const store = useOrchestrationStore.getState();
    store.trackTask(taskId);
    return () => store.untrackTask(taskId);
  }, [taskId]);

  useEffect(() => {
    if (stagedId && workers.some((worker) => worker.terminalId === stagedId)) return;
    setStagedId(workers[0]?.terminalId ?? null);
  }, [stagedId, workers]);

  const candidate = useMemo(() => directorCandidate(workers, permissions), [permissions, workers]);
  const staged = workers.find((worker) => worker.terminalId === stagedId) ?? null;
  const stagedApproval = staged ? permissionForWorker(permissions, staged.terminalId) : null;

  useEffect(() => {
    if (!automatic || locked || !candidate) return;
    if (stagedApproval && staged && candidate.worker.terminalId !== staged.terminalId) {
      setPending(candidate);
      return;
    }
    if (candidate.worker.terminalId === stagedId) {
      setStageReason(candidate.reason);
      if (!stagedApproval && pending?.worker.terminalId === stagedId) setPending(null);
      return;
    }
    const previous = previousWorkers.current.find((worker) => worker.terminalId === stagedId);
    if (previous) {
      setCutLog((entries) =>
        [
          ...entries,
          {
            terminalId: previous.terminalId,
            name: workerName(previous),
            reason: stageReason,
            at: new Date().toISOString(),
            snapshot: workerOutput(previous),
          },
        ].slice(-12),
      );
    }
    setStagedId(candidate.worker.terminalId);
    setStageReason(candidate.reason);
    setPending(null);
    setReviewIndex(null);
    void useOrchestrationStore
      .getState()
      .recordCut(taskId, candidate.worker.terminalId, candidate.reason);
  }, [
    automatic,
    candidate,
    locked,
    pending?.worker.terminalId,
    stageReason,
    staged,
    stagedApproval,
    stagedId,
    taskId,
    workerOutput,
  ]);

  useEffect(() => {
    previousWorkers.current = workers;
  }, [workers]);

  const workerRoom = snapshot.workers.some((worker) => worker.taskId === taskId);
  if ((!initialized || loading) && !snapshot.enabled) {
    return (
      <section className="orch-fleet" data-testid="orchestration-fleet">
        <div className="orch-state" data-testid="orchestration-loading">
          正在接入编队…
        </div>
      </section>
    );
  }
  if ((!snapshot.enabled && !error) || workerRoom) return null;

  const setFold = (): void => {
    const next = !folded;
    setFolded(next);
    try {
      window.localStorage.setItem(FLEET_FOLD_KEY, next ? '1' : '0');
    } catch {
      // Fold persistence is best-effort.
    }
  };
  const fleetPaused = snapshot.fleetPausedTaskIds.includes(taskId);
  const review = reviewIndex === null ? null : (cutLog[reviewIndex] ?? null);

  const manualCut = (worker: OrchestrationWorkerDto, reason = '手动上屏'): void => {
    setStagedId(worker.terminalId);
    setStageReason(reason);
    setPending(null);
    setReviewIndex(null);
    void useOrchestrationStore.getState().recordCut(taskId, worker.terminalId, reason);
  };

  return (
    <section className={`orch-fleet ${folded ? 'folded' : ''}`} data-testid="orchestration-fleet">
      <header className="orch-fleet-head">
        <button onClick={setFold} aria-expanded={!folded}>
          <span className="orch-chevron">▾</span>
          <strong>⌁ 编队 · {workers.length}</strong>
        </button>
        <span className="orch-spacer" />
        <button
          className={`orch-chip ${automatic ? 'active' : ''}`}
          data-testid="orchestration-auto"
          onClick={() => setAutomatic((value) => !value)}
        >
          导播 · {automatic ? '自动' : '手动'}
        </button>
        <button
          className={`orch-chip ${fleetPaused ? 'warning' : ''}`}
          data-testid="orchestration-pause-all"
          onClick={() => void useOrchestrationStore.getState().pauseFleet(taskId, !fleetPaused)}
        >
          {fleetPaused ? '▶ 恢复全部遥控' : '⏸ 暂停全部遥控'}
        </button>
      </header>

      {folded ? null : (
        <div className="orch-fleet-body">
          {loading && workers.length === 0 ? (
            <div className="orch-state" data-testid="orchestration-loading">
              正在接入编队…
            </div>
          ) : error ? (
            <div className="orch-state error" data-testid="orchestration-error">
              <span>{error}</span>
              <button onClick={() => void useOrchestrationStore.getState().refresh()}>重试</button>
            </div>
          ) : workers.length === 0 ? (
            <>
              <div className="orch-state" data-testid="orchestration-empty">
                暂无工人会话。主会话调用 <code>terminal.create</code> 后会在这里出现。
              </div>
              {permissions.length > 0 ? (
                <div className="orch-commander-approvals">
                  {permissions.map((card) => (
                    <PermissionCard key={card.requestId} card={card} resolution={null} />
                  ))}
                </div>
              ) : null}
            </>
          ) : staged ? (
            <>
              <article className={`orch-stage ${stagedApproval ? 'attention' : ''}`}>
                <header>
                  <span className={`orch-live ${staged.status}`} />
                  <strong>{workerName(staged)}</strong>
                  <StatusPill worker={staged} />
                  {staged.takeover ? <span className="orch-taken">✋ 已接管</span> : null}
                  <span className="orch-reason">
                    {automatic ? '切入' : '手动'} · {stageReason}
                  </span>
                  <span className="orch-spacer" />
                  <button className={locked ? 'active' : ''} onClick={() => setLocked(!locked)}>
                    {locked ? '已锁定' : '锁定这路'}
                  </button>
                  <button className="orch-open" onClick={() => openWorker(staged)}>
                    打开房间 ›
                  </button>
                </header>
                {review ? (
                  <div className="orch-review-band">
                    回看 {new Date(review.at).toLocaleTimeString()} · {review.name} ·{' '}
                    {review.reason}
                    <button onClick={() => setReviewIndex(null)}>回到直播</button>
                  </div>
                ) : null}
                <pre>{review ? review.snapshot : workerOutput(staged) || '等待终端输出…'}</pre>
                {!review && stagedApproval ? (
                  <div className="orch-stage-approval">
                    <PermissionCard card={stagedApproval} resolution={null} />
                  </div>
                ) : null}
              </article>

              {pending ? (
                <button
                  className="orch-pending-cut"
                  data-testid="orchestration-pending-cut"
                  onClick={() => manualCut(pending.worker, pending.reason)}
                >
                  待切 ▸ {workerName(pending.worker)} · {pending.reason}
                </button>
              ) : null}

              <div className="orch-cutlog" aria-label="导播记录">
                <span>导播记录</span>
                {cutLog.length === 0 ? <small>尚无切换</small> : null}
                {cutLog.map((entry, index) => (
                  <button key={`${entry.at}:${index}`} onClick={() => setReviewIndex(index)}>
                    {new Date(entry.at).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                    {' · '}
                    {entry.reason}
                  </button>
                ))}
              </div>

              <div className="orch-wall">
                {workers.map((worker) => {
                  const approval = permissionForWorker(permissions, worker.terminalId);
                  const onAir = worker.terminalId === staged.terminalId;
                  return (
                    <article
                      key={worker.terminalId}
                      className={`orch-tile ${onAir ? 'on-air' : ''} ${approval ? 'attention' : ''}`}
                    >
                      <button className="orch-tile-head" onClick={() => manualCut(worker)}>
                        <span className={`orch-live ${worker.status}`} />
                        <strong>{workerName(worker)}</strong>
                        <StatusPill worker={worker} />
                        {onAir ? <span className="orch-onair">◉ 导播位</span> : null}
                      </button>
                      {onAir ? (
                        <div className="orch-tile-muted">已在导播位放大直播</div>
                      ) : (
                        <pre>{workerOutput(worker) || '等待终端输出…'}</pre>
                      )}
                      {worker.queuedSends > 0 ? (
                        <span className="orch-queue">队列 {worker.queuedSends}</span>
                      ) : null}
                      {!onAir && approval ? (
                        <PermissionCard card={approval} resolution={null} />
                      ) : null}
                      <footer>
                        <button onClick={() => openWorker(worker)}>打开房间</button>
                        <button
                          onClick={() =>
                            void useOrchestrationStore
                              .getState()
                              .pauseWorker(worker.terminalId, !worker.paused)
                          }
                        >
                          {worker.paused ? '恢复遥控' : '暂停遥控'}
                        </button>
                      </footer>
                    </article>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="orch-state" data-testid="orchestration-cancelled">
              编队已结束。
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function OrchestrationWorkerBand({
  taskId,
  terminalId,
}: {
  taskId?: string;
  terminalId: string;
}): React.JSX.Element | null {
  const snapshot = useOrchestrationStore((state) => state.snapshot);
  const worker = snapshot.workers.find(
    (candidate) =>
      (taskId !== undefined && candidate.taskId === taskId) || candidate.terminalId === terminalId,
  );
  if (!snapshot.enabled || !worker) return null;
  const fleetPaused = snapshot.fleetPausedTaskIds.includes(worker.commanderTaskId);
  const openCommander = (): void => {
    void useTaskStore.getState().openTask(worker.commanderTaskId);
    useAppStore.getState().openTaskRoom(worker.commanderTaskId);
  };
  return (
    <div
      className={`orch-worker-band ${worker.takeover ? 'taken' : ''}`}
      data-testid="orchestration-worker-band"
    >
      <button onClick={openCommander}>⌁ 由主会话指挥 · 返回指挥室</button>
      <span className="orch-spacer" />
      {worker.queuedSends > 0 ? <span>队列 {worker.queuedSends}</span> : null}
      {worker.takeover ? (
        <>
          <strong>✋ 你已接管，远程注入暂挂</strong>
          <button onClick={() => void useOrchestrationStore.getState().handBack(worker.terminalId)}>
            交还控制
          </button>
        </>
      ) : (
        <button
          onClick={() =>
            void useOrchestrationStore.getState().pauseWorker(worker.terminalId, !worker.paused)
          }
        >
          {worker.paused || fleetPaused ? '▶ 恢复对它的遥控' : '⏸ 暂停对它的遥控'}
        </button>
      )}
    </div>
  );
}
