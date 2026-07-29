import React, { useEffect, useState } from 'react';
import type { ArtifactFeedbackRefDto } from '@pi-ide/ipc-contracts';
import { useDraftStore } from '../store/draftStore.js';
import { rpcResult } from '../bridge.js';

function anchorLabel(ref: ArtifactFeedbackRefDto): string {
  const anchor = ref.anchor;
  if (anchor.type === 'text') return `lines ${anchor.startLine}-${anchor.endLine}`;
  if (anchor.type === 'table') {
    return `rows ${anchor.startRow}-${anchor.endRow}, columns ${anchor.startColumn}-${anchor.endColumn}`;
  }
  if (anchor.type === 'media') {
    const end = anchor.endSeconds === undefined ? '' : `-${anchor.endSeconds.toFixed(2)}s`;
    return `${anchor.startSeconds.toFixed(2)}s${end}`;
  }
  if (anchor.type === 'pdf') return `page ${anchor.page}`;
  if (anchor.type === 'html') {
    const element = anchor.element;
    if (!element) return anchor.selector;
    const name = element.accessibleName || element.text;
    return `${element.tagName}${name ? ` "${name}"` : ''} · ${anchor.selector}`;
  }
  if (anchor.type === 'archive') return anchor.innerPath;
  if (anchor.type === 'image') return 'image region';
  return 'whole file';
}

export function ArtifactFeedbackAttachments(props: {
  taskId: string;
  refs: ArtifactFeedbackRefDto[];
}): React.JSX.Element | null {
  const [currentHashes, setCurrentHashes] = useState<Record<string, string>>({});
  useEffect(() => {
    const taskIds = [...new Set(props.refs.map((ref) => ref.taskId))];
    if (taskIds.length === 0) return;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      const responses = await Promise.all(
        taskIds.map(async (taskId) => ({
          taskId,
          response: await rpcResult('artifact.list', { taskId }),
        })),
      );
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const { taskId, response } of responses) {
        if (!response.ok) continue;
        for (const artifact of response.data.artifacts)
          next[`${taskId}\u0000${artifact.path}`] = artifact.contentHash;
      }
      setCurrentHashes(next);
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [props.refs]);
  if (props.refs.length === 0) return null;
  return (
    <div className="artifact-ref-list" data-testid="room-artifact-refs">
      {props.refs.map((ref) => (
        <div
          className={`artifact-ref-chip ${currentHashes[`${ref.taskId}\u0000${ref.path}`] && currentHashes[`${ref.taskId}\u0000${ref.path}`] !== ref.contentHash ? 'stale' : ''}`}
          key={ref.id}
          data-testid={`artifact-ref-${ref.id}`}
        >
          <span className="artifact-ref-kind">{ref.artifactKind}</span>
          <span className="artifact-ref-copy">
            <strong>{ref.path.split('/').at(-1)}</strong>
            <small>
              {anchorLabel(ref)} · {ref.contentHash.slice(0, 8)}
              {currentHashes[`${ref.taskId}\u0000${ref.path}`] &&
              currentHashes[`${ref.taskId}\u0000${ref.path}`] !== ref.contentHash
                ? ' · stale'
                : ''}
            </small>
          </span>
          <button
            type="button"
            aria-label={`Remove artifact feedback for ${ref.path}`}
            onClick={() => useDraftStore.getState().removeArtifactRef(props.taskId, ref.id)}
          >
            x
          </button>
        </div>
      ))}
    </div>
  );
}

/** Read-only audit presentation for artifact refs already delivered to an agent. */
export function SentArtifactFeedback(props: {
  refs: ArtifactFeedbackRefDto[];
}): React.JSX.Element | null {
  if (props.refs.length === 0) return null;
  return (
    <details className="rt-artifact-context" data-testid="tl-artifact-feedback" open>
      <summary>Artifact feedback / {props.refs.length}</summary>
      {props.refs.map((ref) => (
        <div key={ref.id} className="rt-artifact-ref">
          <span>{ref.artifactKind}</span>
          <strong>{ref.path}</strong>
          <code>{anchorLabel(ref)}</code>
          {ref.note ? <p>{ref.note}</p> : null}
          {ref.staleAtSend ? <em>Stale when sent</em> : null}
          <small>sha256 {ref.contentHash.slice(0, 12)}</small>
        </div>
      ))}
    </details>
  );
}
