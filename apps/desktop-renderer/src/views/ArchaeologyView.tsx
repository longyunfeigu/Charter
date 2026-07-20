import React, { useEffect, useMemo } from 'react';
import type { DiscoveredSessionDto } from '@pi-ide/ipc-contracts';
import { useAppStore } from '../store/appStore.js';
import {
  sessionsInScope,
  unknownDirectories,
  useArchaeologyStore,
} from '../store/archaeologyStore.js';
import { Ic, ProviderMark } from './home-icons.js';
import { timeAgo } from './SessionRail.js';

/**
 * ADR-0038 — the session-archaeology page: every agent conversation that ever
 * ran in this scope (a project path, a discovered directory, or the whole
 * machine), Charter-tracked and discovered alike, newest first. Discovered
 * rows adopt with one click; tracked rows open their existing Session.
 */

function pathTail(path: string): string {
  const tail = path.replace(/\/+$/, '').split('/').pop();
  return tail || path;
}

function compactHome(path: string): string {
  const home = path.match(/^\/Users\/[^/]+|^\/home\/[^/]+/)?.[0];
  return home ? `~${path.slice(home.length)}` : path;
}

function SessionRow({ session, scope }: { session: DiscoveredSessionDto; scope: string | null }) {
  const adoptingId = useArchaeologyStore((s) => s.adoptingId);
  const adopt = useArchaeologyStore((s) => s.adopt);
  const tracked = session.trackedTaskId !== null;
  const adopting = adoptingId === session.sessionId;
  const showCwd = scope === null || session.cwd !== scope;
  const meta: string[] = [];
  if (showCwd) meta.push(compactHome(session.cwd));
  meta.push(tracked ? 'tracked by Charter' : 'ran outside Charter');
  if (session.filesTouched.length > 0) {
    meta.push(`${session.filesTouched.length} file${session.filesTouched.length === 1 ? '' : 's'}`);
  } else {
    meta.push('no file changes');
  }
  if (session.skills.length > 0) meta.push(`skill: ${session.skills.join(', ')}`);
  return (
    <div className={`arch-row ${tracked ? 'tracked' : ''}`} data-testid="arch-row">
      <ProviderMark provider={session.cli} size={15} />
      <span className="arch-copy">
        <span className="arch-title">
          <b title={session.title}>{session.title}</b>
          <span className={`sr-state ${tracked ? 'neutral' : 'found'}`}>
            {tracked ? 'Tracked' : 'External'}
          </span>
        </span>
        <span className="arch-meta">
          <span title={session.filesTouched.join('\n')}>{meta.join(' · ')}</span>
          {session.endedAt ? (
            <time dateTime={session.endedAt}>{timeAgo(session.endedAt, Date.now())}</time>
          ) : null}
        </span>
      </span>
      <span className="arch-acts">
        <button
          className={`arch-btn ${tracked ? '' : 'primary'}`}
          data-testid={tracked ? 'arch-open' : 'arch-resume'}
          disabled={adopting}
          onClick={() => void adopt(session)}
        >
          {tracked ? 'Open' : adopting ? 'Resuming…' : '⏵ Resume'}
        </button>
      </span>
    </div>
  );
}

export function ArchaeologyView(): React.JSX.Element {
  const scope = useAppStore((s) => s.archaeology?.scope ?? null);
  const closeArchaeology = useAppStore((s) => s.closeArchaeology);
  const openArchaeology = useAppStore((s) => s.openArchaeology);
  const store = useArchaeologyStore();

  useEffect(() => {
    void store.scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scoped = useMemo(() => sessionsInScope(store.sessions, scope), [store.sessions, scope]);
  const discovered = scoped.filter((item) => item.trackedTaskId === null);
  const tracked = scoped.filter((item) => item.trackedTaskId !== null);
  const directories = useMemo(
    () => (scope === null ? unknownDirectories(store.sessions) : []),
    [store.sessions, scope],
  );

  return (
    <main className="arch-root" data-testid="archaeology-view">
      <header className="arch-head">
        <button className="arch-back" data-testid="arch-back" onClick={() => closeArchaeology()}>
          <Ic name="chevron" size={12} /> Sessions
        </button>
        <div className="arch-heading">
          <strong>{scope ? pathTail(scope) : 'Agent activity'}</strong>
          <span title={scope ?? undefined}>
            {scope
              ? compactHome(scope)
              : 'Every agent conversation discovered on this machine · last 30 days for Codex'}
          </span>
        </div>
        <button
          className="arch-btn"
          data-testid="arch-rescan"
          disabled={store.loading}
          onClick={() => void store.scan(true)}
        >
          {store.loading ? 'Scanning…' : '↻ Rescan'}
        </button>
      </header>

      <div className="arch-scroll">
        <div className="arch-col">
          {!store.enabled ? (
            <div className="arch-empty" data-testid="arch-disabled">
              Discovery is disabled in this run.
            </div>
          ) : store.loading && store.sessions.length === 0 ? (
            <div className="arch-empty">Scanning ~/.claude and ~/.codex (read-only)…</div>
          ) : scoped.length === 0 && directories.length === 0 ? (
            <div className="arch-empty" data-testid="arch-empty">
              No agent conversations discovered{scope ? ' in this project' : ''} yet.
            </div>
          ) : null}

          {discovered.length > 0 ? (
            <>
              <div className="arch-sec">Discovered outside Charter · {discovered.length}</div>
              {discovered.map((session) => (
                <SessionRow
                  key={`${session.cli}:${session.sessionId}`}
                  session={session}
                  scope={scope}
                />
              ))}
            </>
          ) : null}

          {scope === null && directories.length > 0 ? (
            <>
              <div className="arch-sec">Directories never opened in Charter</div>
              {directories.map((dir) => (
                <button
                  key={dir.cwd}
                  className="arch-row arch-dir"
                  data-testid="arch-dir"
                  onClick={() => openArchaeology(dir.cwd)}
                >
                  <Ic name="folder" size={14} />
                  <span className="arch-copy">
                    <span className="arch-title">
                      <b>{compactHome(dir.cwd)}</b>
                    </span>
                    <span className="arch-meta">
                      <span>
                        {dir.clis.join(' + ')} · {dir.count} session{dir.count === 1 ? '' : 's'}
                      </span>
                      {dir.lastAt ? (
                        <time dateTime={dir.lastAt}>{timeAgo(dir.lastAt, Date.now())}</time>
                      ) : null}
                    </span>
                  </span>
                  <span className="arch-acts">
                    <Ic name="chevron" size={12} className="arch-dir-chevron" />
                  </span>
                </button>
              ))}
            </>
          ) : null}

          {tracked.length > 0 ? (
            <>
              <div className="arch-sec">Already tracked by Charter · {tracked.length}</div>
              {tracked.map((session) => (
                <SessionRow
                  key={`${session.cli}:${session.sessionId}`}
                  session={session}
                  scope={scope}
                />
              ))}
            </>
          ) : null}
        </div>
      </div>
    </main>
  );
}
