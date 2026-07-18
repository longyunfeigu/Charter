import type { TaskDto } from '@pi-ide/ipc-contracts';

export type SessionNoticeTone = 'success' | 'review' | 'error' | 'warning';
export type ExternalReplyBoundary = 'structured' | 'observed';

export interface SessionCompletionInfo {
  label: string;
  body: string;
  tone: SessionNoticeTone;
}

/**
 * Interactive external agents stay in one running task across many replies, so their
 * useful attention edge is not a task-state completion. Keep the copy honest
 * about the evidence: structured streams expose a real turn boundary, while
 * observed TUIs only prove that submitted-prompt output became quiet.
 */
export function externalSessionReplyInfo(
  task: TaskDto,
  boundary: ExternalReplyBoundary,
  status: 'ok' | 'error' = 'ok',
): SessionCompletionInfo | null {
  const cli = task.external?.cli.toLowerCase();
  if (cli !== 'claude' && cli !== 'codex') return null;
  const provider = cli === 'claude' ? 'Claude' : 'Codex';
  if (status === 'error') {
    return {
      label: `${provider} reply failed`,
      body: 'The latest reply ended with an error. Open the Session for details.',
      tone: 'error',
    };
  }
  return {
    label: `${provider} reply complete`,
    body:
      boundary === 'observed'
        ? 'Terminal output settled · Session is ready for you.'
        : 'The latest reply finished · Session is ready for you.',
    tone: 'success',
  };
}

function compactSessionIdentity(value: string): string {
  const raw = value.trim();
  const normalized = raw.replace(/^(?:session|sess|terminal|term)[\s:_-]+/i, '') || raw;
  if (normalized.length <= 18) return normalized;
  return `${normalized.slice(0, 9)}…${normalized.slice(-6)}`;
}

/** Keep notification and rail titles identical, including fixture/provider cleanup. */
export function sessionDisplayTitle(task: TaskDto): string {
  const withoutFixtureDirective = task.title.replace(/^\[scenario:[^\]]+\]\s*/i, '');
  const withoutRepeatedProvider = withoutFixtureDirective.replace(
    /^(?:claude(?: code)?|codex|pi)\s*[·:—-]\s*/i,
    '',
  );
  if (!/^(?:external|new) session$/i.test(withoutRepeatedProvider)) {
    return withoutRepeatedProvider || 'Session';
  }
  if (task.external) {
    const identity = task.external.sessionId?.trim() || task.external.terminalId;
    return `Session ${compactSessionIdentity(identity)}`;
  }
  const goalLine = task.goalMd
    .replace(/^\[scenario:[^\]]+\]\s*/i, '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return goalLine?.slice(0, 72) || 'New Pi session';
}

/**
 * One user-visible completion per meaningful run edge. Full-auto passes
 * through REVIEW_READY mechanically, while manual accept is a user action;
 * those two edges stay quiet so a run never announces itself twice.
 */
export function sessionCompletionInfo(task: TaskDto): SessionCompletionInfo | null {
  if (task.state === 'REVIEW_READY') {
    if (task.mode === 'full') return null;
    if (task.changedFiles === 0) {
      return {
        label: 'Answered',
        body: 'The agent answered with no file changes.',
        tone: 'success',
      };
    }
    const files = task.changedFiles;
    return {
      label: 'Ready for review',
      body:
        files === null
          ? 'The agent finished and is ready for review.'
          : `${files} file${files === 1 ? '' : 's'} changed · ready for review.`,
      tone: 'review',
    };
  }
  if (task.state === 'FAILED') {
    return {
      label: 'Failed',
      body: 'The agent stopped with an error. Open the Session for details.',
      tone: 'error',
    };
  }
  if (task.state === 'INTERRUPTED') {
    return {
      label: 'Interrupted',
      body: 'The agent stopped before finishing. Open the Session to resume.',
      tone: 'warning',
    };
  }
  if (task.state === 'ACCEPTED' && task.mode === 'full') {
    return {
      label: 'Completed & applied',
      body: 'The agent finished and applied the changes.',
      tone: 'success',
    };
  }
  return null;
}
