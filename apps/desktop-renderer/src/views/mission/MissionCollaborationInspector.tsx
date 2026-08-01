import React, { useMemo, useState } from 'react';
import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { Ic, ProviderMark, type ProviderMarkKind } from '../home-icons.js';
import { buildMissionGraph } from './mission-graph-model.js';
import type { MissionGraphSelection } from './MissionGraph.js';
import { formatMissionTime, principalName, userActionRequests } from './mission-view-model.js';

function providerMark(provider: string | null, kind: string | undefined): ProviderMarkKind {
  if (provider === 'claude') return 'claude';
  if (provider === 'codex') return 'codex';
  if (provider === 'shell' || kind === 'shell_agent') return 'shell';
  return 'pi';
}

function visibleMessages(snapshot: MissionSnapshotDto, replayAt: number | null) {
  if (replayAt === null) return snapshot.messages;
  return snapshot.messages.filter((message) => Date.parse(message.createdAt) <= replayAt);
}

export function MissionCollaborationInspector({
  snapshot,
  selection,
  replayAt,
  onResolve,
  onSelectTask,
}: {
  snapshot: MissionSnapshotDto;
  selection: Exclude<MissionGraphSelection, { kind: 'task' } | null>;
  replayAt: number | null;
  onResolve: (requestId: string, outcome: string, body?: string, rationale?: string) => void;
  onSelectTask: (taskId: string) => void;
}): React.JSX.Element {
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const messagesAtTime = useMemo(() => visibleMessages(snapshot, replayAt), [replayAt, snapshot]);
  const graph = useMemo(
    () => buildMissionGraph({ ...snapshot, messages: messagesAtTime }, { at: replayAt }),
    [messagesAtTime, replayAt, snapshot],
  );
  const assignmentTask = useMemo(
    () => new Map(snapshot.assignments.map((assignment) => [assignment.id, assignment.taskId])),
    [snapshot.assignments],
  );

  if (selection.kind === 'human') {
    const replaySnapshot = {
      ...snapshot,
      actionRequests: (snapshot.actionRequests ?? []).filter(
        (request) => Date.parse(request.createdAt) <= (replayAt ?? Number.POSITIVE_INFINITY),
      ),
      messages: messagesAtTime,
    };
    const actions = userActionRequests(replaySnapshot);
    return (
      <article className="mission-collaboration-detail" data-testid="mission-human-detail">
        <header className="mission-collaboration-head human">
          <span>
            <Ic name="user" size={17} />
          </span>
          <div>
            <small>Mission participant</small>
            <strong>You</strong>
          </div>
          <b>{actions.length}</b>
        </header>
        <section className="mission-collaboration-intro">
          <h2>Your actions</h2>
          <p>Explicit decisions the Mission Lead assigned to you.</p>
        </section>
        <div className="mission-human-queue">
          {actions.map((request) => {
            const sourceTask = request.createdByAssignmentId
              ? assignmentTask.get(request.createdByAssignmentId)
              : null;
            const options =
              request.options.length > 0
                ? request.options
                : request.responseType === 'approval'
                  ? [
                      { id: 'approved', label: 'Approve' },
                      { id: 'rejected', label: 'Reject' },
                    ]
                  : [];
            return (
              <article
                key={request.id}
                className={`mission-human-item priority-${request.priority}`}
              >
                <header>
                  <span>{request.kind}</span>
                  <time>{formatMissionTime(request.createdAt)}</time>
                </header>
                <h3>{request.title}</h3>
                {request.context ? <p>{request.context}</p> : null}
                {request.impact ? <p>Why it matters: {request.impact}</p> : null}
                {request.recommendation ? (
                  <p>Team recommendation: {request.recommendation}</p>
                ) : null}
                <small>From {principalName(snapshot, request.createdByAssignmentId)}</small>
                {options.length > 0 && replayAt === null ? (
                  <span className="mission-human-item-actions">
                    {options.map((option) => (
                      <button
                        key={option.id}
                        className={options[0]?.id === option.id ? 'mission-primary' : ''}
                        onClick={() => onResolve(request.id, option.id, option.label)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </span>
                ) : replyingTo === request.id ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const body = reply.trim();
                      if (!body) return;
                      onResolve(request.id, 'answered', body);
                      setReply('');
                      setReplyingTo(null);
                    }}
                  >
                    <textarea
                      autoFocus
                      value={reply}
                      onChange={(event) => setReply(event.currentTarget.value)}
                      placeholder="Give the team a clear decision…"
                    />
                    <span>
                      <button type="button" onClick={() => setReplyingTo(null)}>
                        Cancel
                      </button>
                      <button className="mission-primary" type="submit" disabled={!reply.trim()}>
                        Send decision
                      </button>
                    </span>
                  </form>
                ) : (
                  <span className="mission-human-item-actions">
                    {sourceTask ? (
                      <button onClick={() => onSelectTask(sourceTask)}>
                        View work <Ic name="arrowRight" size={10} />
                      </button>
                    ) : null}
                    {replayAt === null ? (
                      <button
                        className="mission-primary"
                        onClick={() => {
                          setReply('');
                          setReplyingTo(request.id);
                        }}
                      >
                        Respond
                      </button>
                    ) : null}
                  </span>
                )}
              </article>
            );
          })}
          {actions.length === 0 ? (
            <div className="mission-collaboration-empty">
              <Ic name="checkCircle" size={22} />
              <strong>No actions assigned to you</strong>
              <span>Agent requests and runtime issues stay in their own team views.</span>
            </div>
          ) : null}
        </div>
      </article>
    );
  }

  const edge = graph.edges.find((item) => item.id === selection.edgeId);
  const messages = edge
    ? messagesAtTime.filter((message) => edge.messageIds.includes(message.id))
    : [];
  const sourceNode = edge ? graph.nodes.find((node) => node.id === edge.sourceId) : null;
  const targetNode = edge ? graph.nodes.find((node) => node.id === edge.targetId) : null;
  if (!edge || edge.kind !== 'communication') {
    return (
      <div className="mission-detail-empty">
        <Ic name="at" size={24} />
        <strong>Conversation unavailable</strong>
        <span>The selected communication is outside this replay position or filter.</span>
      </div>
    );
  }

  return (
    <article className="mission-collaboration-detail" data-testid="mission-communication-detail">
      <header className="mission-collaboration-head">
        <span className="mission-communication-avatars">
          <ProviderMark
            provider={providerMark(
              sourceNode?.principal?.provider ?? null,
              sourceNode?.principal?.kind,
            )}
            size={14}
          />
          <ProviderMark
            provider={providerMark(
              targetNode?.principal?.provider ?? null,
              targetNode?.principal?.kind,
            )}
            size={14}
          />
        </span>
        <div>
          <small>{edge.bidirectional ? 'Two-way communication' : 'Agent communication'}</small>
          <strong>
            {sourceNode?.principal?.displayName ?? 'Agent'} {edge.bidirectional ? '↔' : '→'}{' '}
            {targetNode?.principal?.displayName ?? 'Agent'}
          </strong>
        </div>
        <b>{edge.count}</b>
      </header>
      <section className="mission-collaboration-intro">
        <h2>{edge.label}</h2>
        <p>
          {messages.length} structured {messages.length === 1 ? 'message' : 'messages'} across{' '}
          {edge.count} {edge.count === 1 ? 'thread' : 'threads'}.
        </p>
      </section>
      <span className="mission-communication-participants">
        {sourceNode ? (
          <button onClick={() => onSelectTask(sourceNode.id)}>{sourceNode.task.title}</button>
        ) : null}
        <Ic name={edge.bidirectional ? 'at' : 'arrowRight'} size={11} />
        {targetNode ? (
          <button onClick={() => onSelectTask(targetNode.id)}>{targetNode.task.title}</button>
        ) : null}
      </span>
      <ol className="mission-conversation-thread">
        {messages.map((message) => {
          const delivery = (snapshot.messageDeliveries ?? []).find(
            (item) => item.messageId === message.id && item.assignmentId === message.toAssignmentId,
          );
          return (
            <li key={message.id} className={`type-${message.type} priority-${message.priority}`}>
              <header>
                <strong>{principalName(snapshot, message.fromAssignmentId)}</strong>
                <time>{formatMissionTime(message.createdAt)}</time>
              </header>
              <span>{message.type}</span>
              <h3>{message.subject}</h3>
              {message.body ? <p>{message.body}</p> : null}
              <small>
                {delivery?.state ?? (message.deliveredAt ? 'delivered' : 'recorded')}
                {message.threadId ? ` · thread ${message.threadId.slice(0, 8)}` : ''}
              </small>
            </li>
          );
        })}
      </ol>
    </article>
  );
}
