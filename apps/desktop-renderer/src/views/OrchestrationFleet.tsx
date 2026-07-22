import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OrchestrationWorkerDto, PermissionCardDto } from '@pi-ide/ipc-contracts';
import { useAppStore } from '../store/appStore.js';
import { permissionForWorker, useOrchestrationStore } from '../store/orchestrationStore.js';
import { useTaskStore } from '../store/taskStore.js';
import { PermissionCard } from './AgentPanel.js';
import { directorCandidate } from './orchestration-director.js';
import { mountTerminal, useTerminalStore, type TermInstance } from './TerminalPanel.js';
import { terminalViewportText } from './terminal-viewport-text.js';

const EMPTY_PERMISSIONS: PermissionCardDto[] = [];

function workerProvider(worker: OrchestrationWorkerDto): string {
  return worker.launch === 'shell' ? 'Shell' : worker.launch === 'claude' ? 'Claude' : 'Codex';
}

function workerName(worker: OrchestrationWorkerDto): string {
  return `${workerProvider(worker)} · ${worker.title}`;
}

function workerAge(worker: OrchestrationWorkerDto): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(worker.updatedAt));
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  return `${Math.floor(elapsed / 3_600_000)} 小时前`;
}

function outputSnippet(output: string): string {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join('\n');
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

function WorkerDot({ worker }: { worker: OrchestrationWorkerDto }): React.JSX.Element {
  return <span className={`orch-live ${worker.status}`} aria-hidden />;
}

function NativeWorkerTerminal({
  item,
  terminalId,
  fallback,
}: {
  item: TermInstance | undefined;
  terminalId: string;
  fallback: string;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !item) return;
    mountTerminal(host, item);
    const observer = new ResizeObserver(() => {
      try {
        item.fit.fit();
      } catch {
        // Layout can race while switching workers or entering focus mode.
      }
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [item]);

  return (
    <div
      className="orch-native-terminal"
      data-testid="orchestration-native-terminal"
      data-terminal-id={terminalId}
    >
      {item ? (
        <div ref={hostRef} className="orch-native-terminal-host" />
      ) : (
        <pre>{fallback || '正在连接原生终端…'}</pre>
      )}
    </div>
  );
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
  const [automatic, setAutomatic] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusOpen, setFocusOpen] = useState(false);
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
  const candidate = useMemo(() => directorCandidate(workers, permissions), [permissions, workers]);

  useEffect(() => {
    if (!initialized) useOrchestrationStore.getState().init();
  }, [initialized]);

  useEffect(() => {
    if (selectedId && workers.some((worker) => worker.terminalId === selectedId)) return;
    setSelectedId(candidate?.worker.terminalId ?? workers[0]?.terminalId ?? null);
  }, [candidate?.worker.terminalId, selectedId, workers]);

  useEffect(() => {
    if (!automatic || !candidate || focusOpen) return;
    setSelectedId(candidate.worker.terminalId);
  }, [automatic, candidate, focusOpen]);

  useEffect(() => {
    if (!focusOpen) return;
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFocusOpen(false);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [focusOpen]);

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

  const selected = workers.find((worker) => worker.terminalId === selectedId) ?? workers[0] ?? null;
  const selectedApproval = selected ? permissionForWorker(permissions, selected.terminalId) : null;
  const fleetPaused = snapshot.fleetPausedTaskIds.includes(taskId);
  const activeCount = workers.filter(
    (worker) => worker.status === 'streaming' || worker.status === 'quiet',
  ).length;
  const needsCount =
    permissions.length + workers.filter((worker) => worker.status === 'failed').length;

  const selectWorker = (worker: OrchestrationWorkerDto, source = '手动查看'): void => {
    setSelectedId(worker.terminalId);
    setAutomatic(false);
    void useOrchestrationStore.getState().recordCut(taskId, worker.terminalId, source);
  };

  if (error) {
    return (
      <section className="orch-fleet" data-testid="orchestration-fleet">
        <div className="orch-state error" data-testid="orchestration-error">
          <span>{error}</span>
          <button onClick={() => void useOrchestrationStore.getState().refresh()}>重试</button>
        </div>
      </section>
    );
  }

  if (workers.length === 0 || !selected) {
    return (
      <section className="orch-fleet" data-testid="orchestration-fleet">
        <div className="orch-state" data-testid="orchestration-empty">
          暂无 worker。返回主会话后，Commander 调用 <code>terminal.create</code> 即会加入这里。
        </div>
      </section>
    );
  }

  return (
    <section
      className={`orch-fleet ${focusOpen ? 'focus-mode' : ''}`}
      data-testid="orchestration-fleet"
    >
      <header className="orch-command-head">
        <div className="orch-command-heading">
          <small>Session Fleet</small>
          <strong>{focusOpen ? 'Worker 聚焦' : '编队指挥台'}</strong>
        </div>
        <span className="orch-summary-pill">
          <span className="orch-live streaming" /> {activeCount} 运行中
        </span>
        {needsCount > 0 ? (
          <span className="orch-summary-pill attention">{needsCount} 待处理</span>
        ) : null}
        <span className="orch-spacer" />
        {!focusOpen ? (
          <button
            className={`orch-chip ${automatic ? 'active' : ''}`}
            data-testid="orchestration-auto"
            onClick={() => setAutomatic((value) => !value)}
          >
            导播 · {automatic ? '自动' : '手动'}
          </button>
        ) : null}
        <button
          className={`orch-chip ${fleetPaused ? 'warning' : ''}`}
          data-testid="orchestration-pause-all"
          onClick={() => void useOrchestrationStore.getState().pauseFleet(taskId, !fleetPaused)}
        >
          {fleetPaused ? '▶ 恢复全部遥控' : '⏸ 暂停全部遥控'}
        </button>
      </header>

      {focusOpen ? (
        <div className="orch-focus" data-testid="orchestration-focus">
          <header className="orch-focus-head">
            <button data-testid="orchestration-focus-back" onClick={() => setFocusOpen(false)}>
              ‹ 返回编队
            </button>
            <span>当前仍是同一个 Session</span>
            <span className="orch-spacer" />
            <span className={`orch-observe ${selected.takeover ? 'taken' : ''}`}>
              {selected.takeover ? '✋ 已接管' : '⌨ 原生终端 · 未接管'}
            </span>
            <button className="orch-open-original" onClick={() => openWorker(selected)}>
              打开独立会话页 ↗
            </button>
          </header>
          <div className="orch-filmstrip" role="tablist" aria-label="Workers">
            {workers.map((worker) => (
              <button
                key={worker.terminalId}
                className={worker.terminalId === selected.terminalId ? 'active' : ''}
                role="tab"
                aria-selected={worker.terminalId === selected.terminalId}
                onClick={() => selectWorker(worker, '聚焦切换')}
              >
                <WorkerDot worker={worker} />
                <span>
                  <strong>{workerName(worker)}</strong>
                  <small>
                    {worker.takeover
                      ? '已接管'
                      : worker.queuedSends > 0
                        ? `队列 ${worker.queuedSends}`
                        : workerAge(worker)}
                  </small>
                </span>
              </button>
            ))}
          </div>
          <div className="orch-focus-grid">
            <section className="orch-focus-screen">
              <header>
                <WorkerDot worker={selected} />
                <strong>{workerName(selected)}</strong>
                <StatusPill worker={selected} />
                <span className="orch-spacer" />
                <code>{selected.terminalId}</code>
              </header>
              <NativeWorkerTerminal
                key={`focus:${selected.terminalId}`}
                item={terminalById.get(selected.terminalId)}
                terminalId={selected.terminalId}
                fallback={workerOutput(selected)}
              />
              {selectedApproval ? (
                <div className="orch-focus-approval">
                  <PermissionCard card={selectedApproval} resolution={null} />
                </div>
              ) : null}
            </section>
            <aside className="orch-focus-inspector">
              <h3>当前 worker</h3>
              <dl>
                <div>
                  <dt>Purpose</dt>
                  <dd>{selected.title}</dd>
                </div>
                <div>
                  <dt>Provider</dt>
                  <dd>{workerProvider(selected)}</dd>
                </div>
                <div>
                  <dt>Control</dt>
                  <dd>
                    {selected.takeover
                      ? '用户在原终端控制'
                      : selected.paused || fleetPaused
                        ? '远程控制已暂停'
                        : 'Commander 持有控制权'}
                  </dd>
                </div>
                <div>
                  <dt>Lifetime</dt>
                  <dd>完成后保持打开</dd>
                </div>
              </dl>
              <p>
                中间就是 worker 的原生终端，支持 Claude Code / Codex
                的斜杠命令、@文件、补全和快捷键。查看与切换不会接管；只有实际键盘输入才会改变控制权。
              </p>
              {selected.takeover ? (
                <button
                  className="orch-hand-back"
                  onClick={() =>
                    void useOrchestrationStore.getState().handBack(selected.terminalId)
                  }
                >
                  交还给 Commander
                </button>
              ) : null}
            </aside>
          </div>
        </div>
      ) : (
        <div className="orch-command-grid">
          <aside className="orch-roster">
            <div className="orch-roster-overview">
              <span>Workers</span>
              <strong>{workers.length}</strong>
              <small>
                {activeCount} active ·{' '}
                {workers.filter((worker) => worker.status === 'completed').length} completed
              </small>
            </div>
            <div className="orch-worker-list">
              {workers.map((worker) => {
                const approval = permissionForWorker(permissions, worker.terminalId);
                return (
                  <button
                    key={worker.terminalId}
                    className={`orch-tile ${worker.terminalId === selected.terminalId ? 'on-air' : ''} ${approval ? 'attention' : ''}`}
                    data-terminal-id={worker.terminalId}
                    onClick={() => selectWorker(worker)}
                  >
                    <WorkerDot worker={worker} />
                    <span>
                      <strong>{workerName(worker)}</strong>
                      <small>
                        {worker.takeover
                          ? '用户已接管'
                          : worker.paused
                            ? '远程控制已暂停'
                            : worker.queuedSends > 0
                              ? `等待发送 ${worker.queuedSends}`
                              : workerAge(worker)}
                      </small>
                    </span>
                    <StatusPill worker={worker} />
                  </button>
                );
              })}
            </div>
            <div className="orch-roster-legend">
              <span>Commander</span>
              <strong>当前主会话</strong>
              <small>Worker 完成后仍保留，可继续追问</small>
            </div>
          </aside>

          <section className={`orch-stage ${selectedApproval ? 'attention' : ''}`}>
            <header>
              <WorkerDot worker={selected} />
              <div>
                <strong>{workerName(selected)}</strong>
                <small>{selected.title}</small>
              </div>
              <StatusPill worker={selected} />
              <span className="orch-spacer" />
              <span className={`orch-observe ${selected.takeover ? 'taken' : ''}`}>
                {selected.takeover ? '✋ 已接管' : '⌨ 原生终端 · 未接管'}
              </span>
              <button
                className="orch-primary"
                data-testid="orchestration-focus-open"
                onClick={() => setFocusOpen(true)}
              >
                聚焦查看 ↗
              </button>
            </header>
            <div className="orch-stage-context">
              <span>原生终端</span>
              <strong>
                {selected.takeover ? '用户正在控制' : '可直接输入 /skill、@文件或自然语言'}
              </strong>
              <small>切换 worker 不接管；键盘输入才接管</small>
            </div>
            <NativeWorkerTerminal
              key={`stage:${selected.terminalId}`}
              item={terminalById.get(selected.terminalId)}
              terminalId={selected.terminalId}
              fallback={workerOutput(selected)}
            />
            <footer>
              <button onClick={() => openWorker(selected)}>打开独立会话页</button>
              <button
                onClick={() =>
                  void useOrchestrationStore
                    .getState()
                    .pauseWorker(selected.terminalId, !selected.paused)
                }
              >
                {selected.paused ? '恢复遥控' : '暂停遥控'}
              </button>
              <span>这里与独立会话页是同一个 PTY</span>
            </footer>
          </section>

          <aside className="orch-signals">
            <header>
              <div>
                <small>Activity intelligence</small>
                <h3>需要你关注</h3>
              </div>
              <span>{needsCount > 0 ? `${needsCount} 项` : '当前无阻塞'}</span>
            </header>
            <div className="orch-signal-feed">
              {permissions.map((card) => {
                const owner = workers.find(
                  (worker) => permissionForWorker([card], worker.terminalId) !== null,
                );
                return (
                  <article key={card.requestId} className="orch-signal-card needs">
                    <div className="orch-signal-kicker">
                      <span>需要决定</span>
                      <time>现在</time>
                    </div>
                    {owner ? (
                      <button onClick={() => selectWorker(owner, '从待处理事件查看')}>
                        {workerName(owner)} · 在中间查看
                      </button>
                    ) : null}
                    <PermissionCard card={card} resolution={null} />
                  </article>
                );
              })}
              {workers
                .filter((worker) => worker.status === 'failed')
                .map((worker) => (
                  <article key={`failed:${worker.terminalId}`} className="orch-signal-card failed">
                    <div className="orch-signal-kicker">
                      <span>执行失败</span>
                      <time>{workerAge(worker)}</time>
                    </div>
                    <h4>{workerName(worker)}</h4>
                    <pre>
                      {outputSnippet(workerOutput(worker)) || `退出码 ${worker.exitCode ?? '未知'}`}
                    </pre>
                    <button onClick={() => selectWorker(worker, '从失败事件查看')}>
                      在中间查看
                    </button>
                  </article>
                ))}
              {workers
                .filter((worker) => worker.status === 'completed')
                .map((worker) => (
                  <article key={`done:${worker.terminalId}`} className="orch-signal-card done">
                    <div className="orch-signal-kicker">
                      <span>已完成</span>
                      <time>{workerAge(worker)}</time>
                    </div>
                    <h4>{workerName(worker)}</h4>
                    <p>任务已经完成，worker 仍保持打开，可以继续发送指令。</p>
                    <button onClick={() => selectWorker(worker, '从完成事件查看')}>查看结果</button>
                  </article>
                ))}
              {workers
                .filter((worker) => worker.status === 'streaming')
                .map((worker) => (
                  <article key={`live:${worker.terminalId}`} className="orch-signal-card finding">
                    <div className="orch-signal-kicker">
                      <span>最新输出</span>
                      <time>{workerAge(worker)}</time>
                    </div>
                    <h4>{workerName(worker)}</h4>
                    <pre>{outputSnippet(workerOutput(worker)) || '正在输出…'}</pre>
                    <div className="orch-signal-actions">
                      <button onClick={() => selectWorker(worker, '从最新输出查看')}>
                        在中间查看
                      </button>
                      <button
                        onClick={() => {
                          selectWorker(worker, '从最新输出聚焦');
                          setFocusOpen(true);
                        }}
                      >
                        聚焦查看 ↗
                      </button>
                    </div>
                  </article>
                ))}
              {permissions.length === 0 &&
              workers.every(
                (worker) =>
                  worker.status !== 'failed' &&
                  worker.status !== 'completed' &&
                  worker.status !== 'streaming',
              ) ? (
                <div className="orch-signals-empty">
                  <strong>当前没有需要处理的事件</strong>
                  <span>右侧只保留决策、失败、完成和实时进展，不堆原始日志。</span>
                </div>
              ) : null}
            </div>
          </aside>
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
    useAppStore.getState().setSessionRoomView('fleet');
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
