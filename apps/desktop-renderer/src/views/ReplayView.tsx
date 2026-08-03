import React, { useEffect, useState } from 'react';
import type { ReplayRequest, TaskDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useTaskStore } from '../store/taskStore.js';
import { TerminalReplayPlayer } from './TerminalReplayPlayer.js';
import '../styles/replay.css';

/** A Replay request owns a standalone, exact terminal black-box surface. */
export function ReplayView(): React.JSX.Element | null {
  const store = useTaskStore();
  const request = store.replayRequest;
  if (!request) return null;
  return <ReplayShell key={request.taskId} request={request} />;
}

function ReplayShell({ request }: { request: ReplayRequest }): React.JSX.Element | null {
  const store = useTaskStore();
  // Bind to request.taskId — never to whatever activeTaskId later becomes.
  const knownTask = store.tasks.find((t) => t.id === request.taskId) ?? null;
  const [fetchedTask, setFetchedTask] = useState<TaskDto | null>(null);
  useEffect(() => {
    if (knownTask) return;
    let disposed = false;
    void rpcResult('task.get', { taskId: request.taskId, eventsAfter: 0 }).then((result) => {
      if (!disposed && result.ok) setFetchedTask(result.data.task);
    });
    return () => {
      disposed = true;
    };
  }, [knownTask, request.taskId]);
  const task = knownTask ?? fetchedTask;

  useEffect(() => {
    document.documentElement.classList.add('replay-active');
    return () => document.documentElement.classList.remove('replay-active');
  }, []);

  if (!task) return null;
  return <TerminalReplayPlayer task={task} />;
}
