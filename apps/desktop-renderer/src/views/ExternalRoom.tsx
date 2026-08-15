import React, { useEffect, useRef, useState } from 'react';
import type { TaskDto } from '@pi-ide/ipc-contracts';
import { pathForDroppedFile, rpcResult } from '../bridge.js';
import { okOrToast, useAppStore } from '../store/appStore.js';
import { useExternalStore, type ExternalSessionFile } from '../store/externalStore.js';
import {
  useTerminalStore,
  mountTerminal,
  observeTerminalFit,
  type TermInstance,
} from './TerminalPanel.js';
import { hasDragRef, readDragRef } from './dragRefs.js';
import { Ic } from './home-icons.js';
import { canResumeExternal } from './labels.js';
import {
  externalAgentLifecycle,
  externalCliLabel,
  externalTerminalLifecycle,
  isLeakedTerminalReply,
  isExternalCli,
} from './external-terminal-lifecycle.js';
import { useAgentPresenceStore } from '../store/agentPresenceStore.js';
import { AgentPresenceBadge } from './AgentPresenceBadge.js';

function activeTerminalInput(item: Pick<TermInstance, 'term'>): string {
  const buffer = item.term.buffer.active;
  const cursor = buffer.baseY + buffer.cursorY;
  let start = cursor;
  while (start > 0 && cursor - start < 5 && buffer.getLine(start)?.isWrapped) start -= 1;
  const lines: string[] = [];
  for (let index = start; index <= cursor; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
  }
  return lines.join('');
}

/**
 * Compact external-Agent identity for the shared Session header. Keeping this
 * beside the Session title gives the terminal back the full height that used
 * to be consumed by a second, terminal-only header row.
 */
export function ExternalSessionIdentity({
  task,
  active = true,
}: {
  task: TaskDto;
  active?: boolean;
}): React.JSX.Element {
  const external = task.external!;
  const session = useExternalStore((state) => state.sessions[task.id]);
  const ownerTaskId = useExternalStore((state) => state.taskByTerminal[external.terminalId]);
  const terminal = useTerminalStore((state) =>
    state.items.find((item) => item.id === external.terminalId),
  );
  const live = (session?.status ?? external.status) === 'active';
  const superseded = !live && ownerTaskId !== undefined && ownerTaskId !== task.id;
  const item = superseded ? null : terminal;
  const lifecycle = isExternalCli(external.cli)
    ? externalTerminalLifecycle({
        cli: external.cli,
        agent: externalAgentLifecycle(session?.status ?? external.status, task.state),
        terminalExited: item?.exited ?? true,
        shellTitle: item?.title,
      })
    : null;
  const peekOpen = useAppStore((state) => state.peek?.taskId === task.id);
  const follow = useExternalStore((state) => state.follow[task.id] ?? true);
  const provider = isExternalCli(external.cli) ? externalCliLabel(external.cli) : external.cli;
  const presence = useAgentPresenceStore((state) => state.byTerminal[external.terminalId]);
  const identityRef = useRef<HTMLDivElement>(null);

  useEffect(() => useAgentPresenceStore.getState().init(), []);
  useEffect(() => {
    if (
      active &&
      presence?.attention === 'done' &&
      useAppStore.getState().taskRoomTaskId === task.id &&
      identityRef.current?.isConnected
    ) {
      void useAgentPresenceStore.getState().markSeen(external.terminalId, 'session-header');
    }
  }, [active, external.terminalId, presence?.attention, task.id]);

  return (
    <div
      ref={identityRef}
      className="session-external-identity"
      data-testid="session-external-identity"
      aria-label={live ? `${provider} running` : lifecycle?.summary}
      title="External Agent session — execution is outside Charter's Tool Gateway"
    >
      <span
        className={`tr-extdot ${live ? 'live' : ''}`}
        data-testid={live ? 'external-live' : undefined}
        aria-label={live ? 'External Agent live' : undefined}
      />
      <span className="tr-extname">✳ {provider}</span>
      <AgentPresenceBadge terminalId={external.terminalId} explainable />
      {live && peekOpen ? (
        <button
          className={`tr-extlive ${follow ? '' : 'paused'}`}
          data-testid="external-follow"
          title={
            follow
              ? 'The peek follows what the CLI is writing. Click to pin the current file.'
              : 'Auto-follow is pinned off. Click to follow live changes again.'
          }
          onClick={() => useExternalStore.getState().setFollow(task.id, !follow)}
        >
          {follow ? 'Following changes' : 'Follow latest change'}
        </button>
      ) : !live ? (
        <>
          <span className="tr-extended" data-testid="external-ended">
            {lifecycle?.agentLabel ?? 'Agent ended'}
          </span>
          <span
            className={`tr-extterminal ${lifecycle?.terminal === 'live' ? 'available' : ''}`}
            data-testid="external-terminal-lifecycle"
          >
            {lifecycle?.terminalLabel ?? 'Terminal ended'}
          </span>
        </>
      ) : null}
    </div>
  );
}

/**
 * ADR-0017 — the center column of an external CLI session's Task Room: the
 * session's real terminal (same xterm instance as the dock, PTY uninterrupted)
 * in the place where the timeline + composer normally live. ADR-0030: the
 * CLI's own input line is the room's only conversation entry — context feeding
 * (file drags, code selections) lands inside that input line as an unsent
 * reference instead of flowing through a second product composer.
 */
export function ExternalTerminalColumn({
  task,
  sameProject,
}: {
  task: TaskDto;
  sameProject: boolean;
}): React.JSX.Element {
  const external = task.external!;
  const session = useExternalStore((s) => s.sessions[task.id]);
  const termStore = useTerminalStore();
  const live = (session?.status ?? external.status) === 'active';
  // One PTY can host several sequential sessions, each with its own task. The
  // terminal is this room's window only while this task owns it: it is live,
  // or it was the terminal's most recent session and no newer session has
  // taken the PTY over. Superseded rooms keep their own record instead of
  // re-parenting a terminal that now shows someone else's conversation.
  const ownerTaskId = useExternalStore((s) => s.taskByTerminal[external.terminalId]);
  const superseded = !live && ownerTaskId !== undefined && ownerTaskId !== task.id;
  const item = superseded
    ? null
    : (termStore.items.find((t) => t.id === external.terminalId) ?? null);
  const lifecycle = isExternalCli(external.cli)
    ? externalTerminalLifecycle({
        cli: external.cli,
        agent: externalAgentLifecycle(session?.status ?? external.status, task.state),
        terminalExited: item?.exited ?? true,
        shellTitle: item?.title,
      })
    : null;
  const repairKey =
    !live && item && lifecycle?.agent === 'ended' && lifecycle.terminal === 'live'
      ? `${task.id}:${item.id}`
      : null;
  const [repairedInputKey, setRepairedInputKey] = useState<string | null>(null);
  // Keep the adopted shell read-only during the short legacy-input check. It
  // prevents the first user command from racing the cleanup Ctrl-C.
  const inputRepairPending = repairKey !== null && repairedInputKey !== repairKey;
  const terminalReadOnly =
    item !== null && (item.exited || lifecycle?.interactive === false || inputRepairPending);
  const hostRef = useRef<HTMLDivElement>(null);
  const peekOpen = useAppStore((state) => state.peek?.taskId === task.id);
  const follow = useExternalStore((s) => s.follow[task.id] ?? true);
  const lastDelta = useExternalStore((s) => s.lastDelta);
  // 'drag' veils follow the pointer; 'ended' sticks after a drop on a dead
  // session until the user resumes or dismisses it.
  const [dragOver, setDragOver] = useState(false);
  const [endedPrompt, setEndedPrompt] = useState(false);
  const [reconnectState, setReconnectState] = useState<'idle' | 'connecting' | 'missing'>('idle');
  const reconnectingRef = useRef(false);

  const reconnectTerminal = (): void => {
    if (reconnectingRef.current) return;
    reconnectingRef.current = true;
    setReconnectState('connecting');
    void useTerminalStore
      .getState()
      .adopt(external.terminalId)
      .then((connected) => setReconnectState(connected ? 'idle' : 'missing'))
      .catch(() => setReconnectState('missing'))
      .finally(() => {
        reconnectingRef.current = false;
      });
  };

  useEffect(() => {
    useExternalStore.getState().init();
    termStore.init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The PTY lives in main and can outlive this renderer (reloads and terminals
  // created by another product surface both exercise this path).
  useEffect(() => {
    if (live && !superseded && !item && reconnectState === 'idle') reconnectTerminal();
    // reconnectTerminal intentionally keys only off the terminal identity/state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [external.terminalId, item, live, reconnectState, superseded]);

  // Live auto-follow (mock chapter ⑤ / direction B): while the peek is open,
  // it follows whatever the CLI is writing right now. The control is shown
  // only in that context instead of occupying every external terminal header.
  useEffect(() => {
    if (!follow || !lastDelta || lastDelta.taskId !== task.id) return;
    const app = useAppStore.getState();
    if (app.peek === null || app.peek.taskId !== task.id) return;
    const path = lastDelta.paths[0];
    if (path) app.openPeek(task.id, path, 'diff');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastDelta?.seq]);

  // Mount the session's terminal into this room (same mount substrate as the
  // dock / side panel — ADR-0017 rev.2: xterm re-mounts move the live element).
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !item) return;
    mountTerminal(host, item, 'normal', terminalReadOnly);
    return observeTerminalFit(host, item);
  }, [item, terminalReadOnly]);

  // Repair terminals already polluted by older builds. Only an ended Agent
  // sitting at a live shell is eligible, and only when the current input line
  // contains the exact xterm response signature. Ctrl-C cancels that corrupt
  // line and gives the user a clean prompt; historical transcript rows remain
  // untouched and arbitrary user commands are never guessed at or erased.
  useEffect(() => {
    if (!repairKey || !item || repairedInputKey === repairKey) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const repair = isLeakedTerminalReply(activeTerminalInput(item))
        ? rpcResult('terminal.write', {
            id: item.id,
            data: '\u0003',
            userInitiated: false,
          })
        : Promise.resolve();
      void repair.finally(() => {
        if (!cancelled) setRepairedInputKey(repairKey);
      });
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [item, repairKey, repairedInputKey]);

  const acceptsDrag = (e: React.DragEvent): boolean =>
    hasDragRef(e) || e.dataTransfer.types.includes('Files');

  return (
    <div
      className="tr-extcol"
      data-testid="external-terminal-column"
      data-task-id={task.id}
      data-terminal-id={external.terminalId}
      onDragOver={(e) => {
        if (!acceptsDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = live ? 'copy' : 'none';
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        const next = e.relatedTarget as Node | null;
        if (!next || !e.currentTarget.contains(next)) setDragOver(false);
      }}
      onDrop={(e) => {
        if (!acceptsDrag(e)) return;
        e.preventDefault();
        setDragOver(false);
        if (!live) {
          setEndedPrompt(true);
          return;
        }
        void injectDroppedRefs(task.id, sameProject, e).then(() => item?.term.focus());
      }}
    >
      <div className="tr-extbody">
        {item ? (
          <div
            ref={hostRef}
            className="tr-exthost"
            data-testid="external-terminal-host"
            data-terminal-id={item.id}
          />
        ) : (
          <div className="tr-extgone" data-testid="external-terminal-gone">
            <div className="tr-extgone-title">
              {live
                ? reconnectState === 'connecting'
                  ? 'Reconnecting the live session terminal…'
                  : 'The live session terminal is not connected to this view.'
                : superseded
                  ? 'This session is over — its terminal moved on to a newer session.'
                  : 'This session is over.'}
            </div>
            <div className="tr-extgone-body">
              {(session?.files.length ?? task.changedFiles ?? 0) > 0
                ? `${session?.files.length ?? task.changedFiles} file${(session?.files.length ?? task.changedFiles) === 1 ? '' : 's'} changed — use the rail to peek, or Review to close out.`
                : 'No tracked file changes.'}
            </div>
            {live && reconnectState !== 'connecting' ? (
              <button
                type="button"
                className="btn"
                data-testid="external-terminal-reconnect"
                onClick={reconnectTerminal}
              >
                Reconnect terminal
              </button>
            ) : null}
          </div>
        )}
        {terminalReadOnly && item ? (
          <div className="tr-extreadonly" data-testid="external-terminal-readonly" role="status">
            <span>
              <strong>Session stopped</strong>
              Transcript is read-only. Resume the Session to continue.
            </span>
            {canResumeExternal(task) ? (
              <button
                type="button"
                data-testid="external-terminal-readonly-resume"
                onClick={() => void useExternalStore.getState().resumeTask(task)}
              >
                Resume Session
              </button>
            ) : null}
          </div>
        ) : null}
        {dragOver && live ? (
          <div className="tr-extdropveil" data-testid="external-drop-veil" aria-hidden>
            <span>
              <Ic name="file" size={14} />
              Drop to place an @reference in {external.cli}&rsquo;s input line — nothing is sent
              until you press Enter there
            </span>
          </div>
        ) : null}
        {(dragOver && !live) || endedPrompt ? (
          <div className="tr-extendveil" data-testid="external-ended-veil">
            <div className="tr-extendveil-card">
              <div className="tr-extendveil-title">
                This session has ended — resume it to keep feeding context.
              </div>
              <div className="tr-extendveil-body">
                Resume restarts {external.cli} in the same terminal and reconnects the conversation.
              </div>
              <div className="tr-extendveil-row">
                <button
                  type="button"
                  data-testid="external-resume-from-drop"
                  onClick={() => {
                    setEndedPrompt(false);
                    void useExternalStore.getState().resumeTask(task);
                  }}
                >
                  ↻ Resume this Session
                </button>
                {endedPrompt ? (
                  <button
                    type="button"
                    className="ghost"
                    data-testid="external-ended-veil-dismiss"
                    onClick={() => setEndedPrompt(false)}
                  >
                    Not now
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * ADR-0030 — drop → `@path` in the CLI's own input line. Internal tree drags
 * carry a workspace-relative ref (directories end in "/"); OS drops are
 * relativized by the main process. Out-of-project items are skipped with an
 * explanation: the CLI's @-references are project-relative by contract.
 */
async function injectDroppedRefs(
  taskId: string,
  sameProject: boolean,
  e: React.DragEvent,
): Promise<void> {
  const toast = useAppStore.getState().pushToast;
  const rel = readDragRef(e);
  if (rel) {
    if (!sameProject) {
      toast('warning', 'Open this task’s project to reference its files by path.');
      return;
    }
    await injectFileRef(taskId, rel);
    return;
  }
  const items = Array.from(e.dataTransfer.items ?? []).filter((entry) => entry.kind === 'file');
  const dropped: Array<{ abs: string; isDirectory: boolean }> = [];
  for (const entry of items) {
    const file = entry.getAsFile();
    if (!file) continue;
    const abs = pathForDroppedFile(file);
    if (!abs) continue;
    const dirEntry = typeof entry.webkitGetAsEntry === 'function' ? entry.webkitGetAsEntry() : null;
    dropped.push({ abs, isDirectory: dirEntry?.isDirectory ?? false });
  }
  if (dropped.length === 0) return;
  const res = await rpcResult('workspace.relativize', {
    paths: dropped.slice(0, 50).map((d) => d.abs),
  });
  if (!okOrToast(res)) return;
  const byAbs = new Map(dropped.map((d) => [d.abs, d]));
  for (const inside of res.data.inside) {
    const isDirectory = byAbs.get(inside.abs)?.isDirectory ?? false;
    await injectFileRef(taskId, isDirectory ? `${inside.rel}/` : inside.rel);
  }
  if (res.data.outside.length > 0) {
    toast(
      'warning',
      `${res.data.outside.length} item(s) outside the project were skipped — @-references are project-relative (move the file into the project first).`,
    );
  }
}

/** One `@path` mention → the CLI's input line (trailing "/" marks a folder). */
async function injectFileRef(taskId: string, rel: string): Promise<boolean> {
  const isFolder = rel.endsWith('/');
  const path = isFolder ? rel.slice(0, -1) : rel;
  const result = await rpcResult('external.injectContext', {
    taskId,
    ref: { kind: 'file', path, isFolder },
  });
  return okOrToast(result);
}

/**
 * Rail data for an external task: live session files when the session store
 * has them, else a one-shot hydrate from the recorded change set (restarts,
 * ended sessions).
 */
export function useExternalFiles(task: TaskDto | null): ExternalSessionFile[] {
  const session = useExternalStore((s) => (task ? s.sessions[task.id] : undefined));
  useEffect(() => {
    if (!task?.external || session) return;
    let cancelled = false;
    void rpcResult('task.changeSet', { taskId: task.id }).then((res) => {
      if (cancelled || !res.ok) return;
      const files = res.data.changeSet.files.map((f) => ({
        path: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      }));
      useExternalStore.setState((s) => ({
        sessions: {
          ...s.sessions,
          [task.id]: {
            terminalId: task.external!.terminalId,
            taskId: task.id,
            cli: task.external!.cli,
            snapshotRef: task.external!.snapshotRef,
            status: task.external!.status,
            captureGrade: task.external!.captureGrade ?? 'observed',
            files,
          },
        },
      }));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, session === undefined]);
  return session?.files ?? [];
}
