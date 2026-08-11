import React, { useEffect, useState } from 'react';
import type { GithubAuthStatusDto, GithubIssuePreviewDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { useForYouStore } from '../store/forYouStore.js';
import {
  useWorkItemStore,
  type GithubImportOutcome,
  type GithubResolveOutcome,
} from '../store/workItemStore.js';
import { Markdown } from './Markdown.js';
import { Ic } from './home-icons.js';

interface ProjectChoice {
  path: string;
  displayName: string;
}

type DialogOutcome = GithubImportOutcome | GithubResolveOutcome;
type Phase = 'entry' | 'resolving' | 'preview' | 'importing';

function connectionLabel(auth: GithubAuthStatusDto | null): string {
  if (!auth) return 'Checking GitHub connection…';
  if (auth.method === 'pat') {
    return `Connected with token${auth.tokenLogin ? ` · @${auth.tokenLogin}` : ''}`;
  }
  if (auth.method === 'gh-cli') return 'Connected with GitHub CLI';
  return 'Public issues work without signing in';
}

/** Two-phase import: resolve is side-effect free, then the user verifies the
 * source and repository mapping before a local Work item is created. */
export function ForYouImportDialog(props: { onClose(): void }): React.JSX.Element {
  const [url, setUrl] = useState('');
  const [resolvedInput, setResolvedInput] = useState('');
  const [phase, setPhase] = useState<Phase>('entry');
  const [outcome, setOutcome] = useState<DialogOutcome | null>(null);
  const [preview, setPreview] = useState<GithubIssuePreviewDto | null>(null);
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [projectPath, setProjectPath] = useState('');
  const [auth, setAuth] = useState<GithubAuthStatusDto | null>(null);
  const busy = phase === 'resolving' || phase === 'importing';

  useEffect(() => {
    void rpcResult('github.auth.status', {}).then((result) => {
      if (result.ok) setAuth(result.data);
    });
    void rpcResult('workspace.recent', {}).then((result) => {
      if (result.ok) {
        setProjects(
          result.data.items.map((entry) => ({ path: entry.path, displayName: entry.displayName })),
        );
      }
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && phase !== 'importing') props.onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [phase, props]);

  const resolve = async (): Promise<void> => {
    const input = url.trim();
    if (!input || busy) return;
    setPhase('resolving');
    setOutcome(null);
    const result = await useWorkItemStore.getState().resolveGithubIssue(input);
    if (result.kind === 'resolved') {
      setPreview(result.preview);
      setResolvedInput(input);
      setProjectPath(result.preview.localProject?.path ?? '');
      setPhase('preview');
      return;
    }
    setOutcome(result);
    setPhase('entry');
  };

  const confirmImport = async (): Promise<void> => {
    if (!preview || !resolvedInput || busy) return;
    setPhase('importing');
    setOutcome(null);
    const result = await useWorkItemStore
      .getState()
      .importGithubIssue(resolvedInput, projectPath || null);
    if (result.kind === 'imported') {
      const forYou = useForYouStore.getState();
      forYou.setTab('incoming');
      await forYou.selectItem(result.item.id);
      useAppStore.getState().pushToast('success', `Imported “${result.item.title}”.`);
      props.onClose();
      return;
    }
    setOutcome(result);
    setPhase(result.kind === 'duplicate' ? 'entry' : 'preview');
  };

  const openExisting = async (itemId: string): Promise<void> => {
    const forYou = useForYouStore.getState();
    forYou.setTab('incoming');
    await forYou.selectItem(itemId);
    props.onClose();
  };

  const openGithubSettings = (): void => {
    props.onClose();
    useAppStore.getState().openSettings('github');
  };

  const authHint =
    outcome?.kind === 'error' &&
    (outcome.code === 'GITHUB_ISSUE_NOT_FOUND' || outcome.code === 'GITHUB_AUTH_FAILED');

  return (
    <div
      className="modal-backdrop fy-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && phase !== 'importing') props.onClose();
      }}
    >
      <section
        className={`fy-modal fy-import-modal ${preview ? 'has-preview' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fy-import-title"
        aria-busy={busy}
        data-testid="fy-import-modal"
      >
        <header className="fy-modal-head fy-import-head">
          <div>
            <span className="fy-modal-kicker">GITHUB · READ ONLY</span>
            <h2 id="fy-import-title">Import GitHub issue</h2>
            <p>Preview the source and repository match before adding it to Work.</p>
          </div>
          <button
            className="fy-icon-button"
            aria-label="Close"
            disabled={phase === 'importing'}
            onClick={props.onClose}
          >
            <Ic name="x" size={14} />
          </button>
        </header>

        <div className="fy-import-progress" aria-label="Import progress">
          <span className="active">
            <i>{preview ? <Ic name="check" size={9} /> : '1'}</i> Find issue
          </span>
          <b />
          <span className={preview ? 'active' : ''}>
            <i>2</i> Review & import
          </span>
        </div>

        <div className="fy-modal-body">
          {preview ? (
            <div className="fy-import-preview" data-testid="fy-import-preview">
              <div className="fy-import-source-row">
                <span className="fy-source-mark github">GH</span>
                <span className="fy-import-source-main">
                  <strong className="mono" data-i18n-ignore>
                    {preview.ref}
                  </strong>
                  <span>
                    <i className={`fy-import-state ${preview.state.toLowerCase()}`} />
                    <span>
                      {preview.state.toLowerCase() === 'open' ? 'Open issue' : 'Closed issue'}
                    </span>{' '}
                    · <span>opened by</span> <b data-i18n-ignore>@{preview.author || 'unknown'}</b>
                    {preview.createdAt ? ` · ${preview.createdAt.slice(0, 10)}` : ''}
                  </span>
                </span>
                <button
                  className="fy-inline-link"
                  data-testid="fy-import-back"
                  disabled={phase === 'importing'}
                  onClick={() => {
                    setPreview(null);
                    setOutcome(null);
                    setPhase('entry');
                  }}
                >
                  Change
                </button>
              </div>

              <div className="fy-import-issue-card">
                <h3 data-i18n-ignore>{preview.title}</h3>
                {preview.labels.length ? (
                  <div className="fy-labels compact">
                    {preview.labels.map((label) => (
                      <span className="fy-label" key={label} data-i18n-ignore>
                        {label}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="fy-import-body fy-prose">
                  {preview.body ? (
                    <Markdown text={preview.body} />
                  ) : (
                    <p className="fy-muted">This issue has no description.</p>
                  )}
                </div>
                <div className="fy-import-facts">
                  <span>
                    <b data-i18n-ignore>{preview.acceptance.length}</b> checklist items
                  </span>
                  <span>
                    <b data-i18n-ignore>{preview.commentCount}</b> comments
                  </span>
                  <span>
                    <b data-i18n-ignore>{preview.recentCommentCount}</b> recent carried in
                  </span>
                </div>
              </div>

              <label className="fy-field fy-import-project">
                <span>
                  Local Project
                  {preview.localProject ? <em>Matched by git remote</em> : <em>Optional</em>}
                </span>
                <select
                  data-testid="fy-import-project"
                  disabled={phase === 'importing'}
                  value={projectPath}
                  onChange={(event) => setProjectPath(event.target.value)}
                >
                  <option value="">Choose later</option>
                  {projects.map((project) => (
                    <option value={project.path} key={project.path}>
                      {project.displayName} — {project.path}
                    </option>
                  ))}
                </select>
                <small>
                  {projectPath
                    ? 'This is where Charter will start the Session or Mission.'
                    : 'The issue can still be imported; choose a Project before starting work.'}
                </small>
              </label>
            </div>
          ) : (
            <>
              <label className="fy-field fy-import-url-field">
                <span>Issue URL or reference</span>
                <div className="fy-import-input-wrap">
                  <Ic name="external" size={14} />
                  <input
                    autoFocus
                    className="mono"
                    data-testid="fy-import-input"
                    value={url}
                    disabled={phase === 'resolving'}
                    placeholder="https://github.com/owner/repo/issues/128"
                    spellCheck={false}
                    onChange={(event) => {
                      setUrl(event.target.value);
                      setOutcome(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void resolve();
                      }
                    }}
                  />
                  {url && phase !== 'resolving' ? (
                    <button
                      aria-label="Clear issue URL"
                      onClick={() => {
                        setUrl('');
                        setOutcome(null);
                      }}
                    >
                      <Ic name="x" size={12} />
                    </button>
                  ) : null}
                </div>
                <small>
                  Also accepts <span className="mono">owner/repo#123</span>
                </small>
              </label>

              {phase === 'resolving' ? (
                <div className="fy-resolving" data-testid="fy-import-resolving">
                  <span className="fy-spinner" />
                  <span>
                    <strong>Reading issue context…</strong>
                    <small>Fetching metadata, recent discussion, and matching local remotes.</small>
                  </span>
                </div>
              ) : (
                <div className="fy-import-assurance">
                  <span className="fy-assurance-icon">
                    <Ic name="shield" size={13} />
                  </span>
                  <span>
                    <strong>Nothing changes on GitHub</strong>
                    <small>Previewing and importing only read the issue.</small>
                  </span>
                </div>
              )}
            </>
          )}

          {outcome?.kind === 'error' ? (
            <div className="fy-import-error" role="alert" data-testid="fy-import-error">
              <Ic name="alert" size={13} />
              <span>
                {outcome.message}
                {authHint ? (
                  <>
                    {' '}
                    <button className="fy-inline-link" onClick={openGithubSettings}>
                      Open GitHub settings
                    </button>
                  </>
                ) : null}
              </span>
            </div>
          ) : null}
          {outcome?.kind === 'duplicate' ? (
            <div className="fy-import-duplicate" data-testid="fy-import-duplicate">
              <Ic name="info" size={13} />
              <span>This issue is already in Work.</span>
              <button
                className="fy-small-button"
                data-testid="fy-import-open-existing"
                onClick={() => void openExisting(outcome.itemId)}
              >
                Open existing item
              </button>
            </div>
          ) : null}
        </div>

        <footer className="fy-modal-foot fy-import-foot">
          <span className="fy-import-connection">
            <i className={auth?.method === 'none' ? '' : 'ok'} /> {connectionLabel(auth)}
          </span>
          <div className="fy-modal-foot-right">
            <button
              className="fy-small-button"
              disabled={phase === 'importing'}
              onClick={props.onClose}
            >
              Cancel
            </button>
            {preview ? (
              <button
                className="fy-small-button primary"
                data-testid="fy-import-confirm"
                disabled={phase === 'importing'}
                onClick={() => void confirmImport()}
              >
                {phase === 'importing' ? 'Importing…' : 'Import to Work'}
              </button>
            ) : (
              <button
                className="fy-small-button primary"
                data-testid="fy-import-submit"
                disabled={!url.trim() || phase === 'resolving'}
                onClick={() => void resolve()}
              >
                {phase === 'resolving' ? 'Resolving…' : 'Preview issue'}
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}
