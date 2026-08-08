import React, { useEffect, useMemo, useRef, useState } from 'react';
import { monaco, monacoFontFamily, monacoThemeName } from '../monaco-setup.js';
import type { ChangeSetFileDto, ReviewHunkDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useTaskStore, activeTask } from '../store/taskStore.js';
import { useAppStore } from '../store/appStore.js';
import { ConfirmDangerButton } from './ui.js';
import { Ic } from './home-icons.js';
import { stateLabel } from './labels.js';
import { LivePreview } from './LivePreview.js';
import { ReviewChecks } from './ReviewChecks.js';
import '../styles/review.css';
import '../styles/preview.css';
import { createCodeContextRef } from '../codeContext.js';
import {
  isCurrentVerificationPass,
  latestFinalReport,
  reportExecutionFailed,
  useVerificationEvidence,
} from './verification-evidence.js';

/**
 * Task review v2 (ADR-0013): Changes list + Monaco side-by-side diff, per-hunk
 * accept/reject with the same content-derived keys and hash guards as before,
 * and "Request fix" — selected lines flow back to the agent as a steer message.
 * Presentation only: every decision still goes through task.reviewDecision.
 *
 * ADR-0022 adds two more projections of the same evidence: a Preview tab
 * (the task's own dev server, sandboxed) and a Checks tab (verification
 * records). Three tabs, one `task → main` question.
 */

type GateTab = 'changes' | 'preview' | 'checks';

const STATUS_META: Record<
  ChangeSetFileDto['status'],
  { letter: string; color: string; label: string }
> = {
  created: { letter: 'A', color: 'var(--success)', label: 'added' },
  modified: { letter: 'M', color: 'var(--warning)', label: 'modified' },
  deleted: { letter: 'D', color: 'var(--danger)', label: 'deleted' },
  renamed: { letter: 'R', color: 'var(--info)', label: 'renamed' },
};

/** First modified-side line of a hunk header ("@@ -a,b +c,d @@" → c). */
function hunkTargetLine(header: string): number {
  const m = header.match(/\+(\d+)/);
  return m ? Math.max(1, parseInt(m[1]!, 10)) : 1;
}

function DiffPane({
  taskId,
  file,
  onRequestFix,
  revealSeq,
}: {
  taskId: string;
  file: ChangeSetFileDto;
  onRequestFix: (path: string, startLine: number, endLine: number, code: string) => void;
  revealSeq: { line: number; seq: number };
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<monaco.editor.ITextModel[]>([]);
  const requestSeqRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<{ start: number; end: number; code: string } | null>(
    null,
  );

  // Load both sides whenever the file identity or its on-disk content changes
  // (a hunk reject rewrites the file — the diff must follow).
  useEffect(() => {
    let cancelled = false;
    const requestSeq = ++requestSeqRef.current;
    setLoading(true);
    setSelection(null);
    void rpcResult('task.reviewFile', { taskId, path: file.path }).then((res) => {
      if (cancelled || !hostRef.current) return;
      setLoading(false);
      if (!res.ok) return;
      // Keep each side on a query-free URI. The TypeScript worker keys source
      // files by the complete URI and could otherwise request a path whose
      // query was already stripped during model synchronization.
      const uriPath = [taskId, String(requestSeq), ...file.path.split('/')]
        .map(encodeURIComponent)
        .join('/');
      const mk = (content: string, side: string): monaco.editor.ITextModel => {
        const uri = monaco.Uri.parse(`review://task/${side}/${uriPath}`);
        return monaco.editor.createModel(content, undefined, uri);
      };
      const original = mk(res.data.baseline ?? '', 'baseline');
      const modified = mk(res.data.current ?? '', 'current');
      // Old generations are intentionally retained until the diff editor is
      // destroyed. Disposing an async-diagnostics model while Monaco still has
      // a widget reference is what caused the review close error.
      modelsRef.current.push(original, modified);
      if (!editorRef.current) {
        editorRef.current = monaco.editor.createDiffEditor(hostRef.current, {
          automaticLayout: true,
          readOnly: true,
          originalEditable: false,
          renderSideBySide: true,
          renderOverviewRuler: true,
          diffAlgorithm: 'advanced',
          scrollBeyondLastLine: false,
          minimap: { enabled: false },
          fontFamily: monacoFontFamily(),
          theme: monacoThemeName(),
        });
        editorRef.current.getModifiedEditor().onDidChangeCursorSelection((e) => {
          const model = editorRef.current?.getModifiedEditor().getModel();
          if (!model || e.selection.isEmpty()) {
            setSelection(null);
            return;
          }
          setSelection({
            start: e.selection.startLineNumber,
            end: e.selection.endLineNumber,
            code: model.getValueInRange({
              startLineNumber: e.selection.startLineNumber,
              startColumn: 1,
              endLineNumber: e.selection.endLineNumber,
              endColumn: model.getLineMaxColumn(e.selection.endLineNumber),
            }),
          });
        });
      }
      editorRef.current.setModel({ original, modified });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, file.path, file.currentHash]);

  useEffect(
    () => () => {
      const editor = editorRef.current;
      editor?.setModel(null);
      editor?.dispose();
      editorRef.current = null;
      for (const model of modelsRef.current) model.dispose();
      modelsRef.current = [];
    },
    [],
  );

  // Hunk chip clicks scroll the modified side.
  useEffect(() => {
    if (revealSeq.seq === 0) return;
    editorRef.current?.getModifiedEditor().revealLineInCenter(revealSeq.line);
  }, [revealSeq]);

  return (
    <div className="rv-diffwrap">
      {file.binary ? (
        <div className="empty-state">Binary file — no text diff available.</div>
      ) : (
        <>
          <div ref={hostRef} className="rv-monaco" data-testid="review-diff" />
          {loading ? <div className="rv-loading">Loading diff…</div> : null}
          {selection ? (
            <button
              className="rv-requestfix"
              data-testid="review-request-fix"
              title="Send the selected lines back to the agent with your feedback"
              onClick={() =>
                onRequestFix(file.path, selection.start, selection.end, selection.code)
              }
            >
              <Ic name="pencil" size={12} /> Request fix — lines {selection.start}–{selection.end}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function HunkStrip({
  file,
  canDecide,
  onReveal,
}: {
  file: ChangeSetFileDto;
  canDecide: boolean;
  onReveal: (line: number) => void;
}): React.JSX.Element | null {
  const store = useTaskStore();
  if (file.binary || file.hunks.length === 0) return null;
  return (
    <div className="rv-hunks" data-testid="review-hunkstrip">
      {file.hunks.map((hunk: ReviewHunkDto, index) => {
        const decided = hunk.state !== 'pending';
        return (
          <div key={hunk.key} className="rv-hunk" data-testid={`hunk-${hunk.key}`}>
            <button
              className="rv-hunk-jump mono"
              title="Scroll to this change"
              onClick={() => onReveal(hunkTargetLine(hunk.header))}
            >
              #{index + 1} {hunk.header}
            </button>
            {decided ? (
              <span
                className={`rv-hunk-state ${hunk.state}`}
                data-testid={`hunk-state-${hunk.key}`}
              >
                {hunk.state}
              </span>
            ) : canDecide ? (
              <>
                <button
                  className="rv-hbtn ok"
                  data-testid={`hunk-accept-${hunk.key}`}
                  onClick={() =>
                    void store.reviewDecision({
                      path: file.path,
                      scope: 'hunk',
                      decision: 'accept',
                      hunkKey: hunk.key,
                      ...(file.currentHash ? { expectedCurrentHash: file.currentHash } : {}),
                    })
                  }
                >
                  ✓ Accept
                </button>
                <button
                  className="rv-hbtn bad"
                  data-testid={`hunk-reject-${hunk.key}`}
                  onClick={() =>
                    void store.reviewDecision({
                      path: file.path,
                      scope: 'hunk',
                      decision: 'reject',
                      hunkKey: hunk.key,
                      ...(file.currentHash ? { expectedCurrentHash: file.currentHash } : {}),
                    })
                  }
                >
                  ✕ Reject
                </button>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Task-level review (REV, CHG-005/007/008 — presentation per ADR-0013). */
export function ReviewView(): React.JSX.Element | null {
  const store = useTaskStore();
  const app = useAppStore();
  const task = activeTask(store);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [reveal, setReveal] = useState({ line: 1, seq: 0 });
  const [fix, setFix] = useState<{
    path: string;
    start: number;
    end: number;
    code: string;
  } | null>(null);
  const [fixNote, setFixNote] = useState('');
  const [tab, setTab] = useState<GateTab>('changes');
  // ADR-0022: the Preview tab exists only for web-ish trees (ports live now, or
  // a dev/start/serve script waiting to be run). Once shown it stays for this
  // review session — tabs must not vanish underfoot.
  const [previewAvailable, setPreviewAvailable] = useState(false);

  const cs = store.changeSet;
  const files = useMemo(() => cs?.files ?? [], [cs]);
  const selectedFile = files.find((f) => f.path === selectedPath) ?? files[0] ?? null;
  const reviewVerification = useVerificationEvidence(
    task?.id ?? null,
    task?.updatedAt ?? null,
    store.timeline,
  );

  // Auto-select the first file; keep the selection when the set refreshes.
  useEffect(() => {
    if (files.length > 0 && !files.some((f) => f.path === selectedPath)) {
      setSelectedPath(files[0]!.path);
    }
  }, [files, selectedPath]);

  const reviewOpen = store.reviewOpen;
  const taskId = task?.id ?? null;
  useEffect(() => {
    setTab('changes');
    setPreviewAvailable(false);
    if (!reviewOpen || !taskId) return;
    let cancelled = false;
    let found = false;
    const probe = async (): Promise<void> => {
      if (found) return;
      const res = await rpcResult('task.previewPorts', { taskId });
      if (!cancelled && res.ok && (res.data.webish || res.data.ports.length > 0)) {
        found = true;
        setPreviewAvailable(true);
      }
    };
    void probe();
    const timer = window.setInterval(() => void probe(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [reviewOpen, taskId]);

  if (!store.reviewOpen || !task) return null;
  const canDecide = task.state === 'REVIEW_READY';
  const report = latestFinalReport(store.timeline);
  const executionFailed = reportExecutionFailed(report);
  const failedChecks = reviewVerification.filter((run) => !isCurrentVerificationPass(run));
  const recordedLabels = new Set(reviewVerification.map((run) => run.label));
  const missingChecks = task.verification.filter((check) => !recordedLabels.has(check.label));
  const hasEvidenceRisk =
    task.mode !== 'ask' &&
    (executionFailed ||
      failedChecks.length > 0 ||
      reviewVerification.length === 0 ||
      missingChecks.length > 0);

  const sendFix = async (): Promise<void> => {
    if (!fix) return;
    const note = fixNote.trim();
    const codeRef = await createCodeContextRef({
      path: fix.path,
      origin: 'review',
      version: 'working-tree',
      startLine: fix.start,
      startColumn: 1,
      endLine: fix.end,
      endColumn: (fix.code.split('\n').at(-1)?.length ?? 0) + 1,
      text: fix.code.slice(0, 16_000),
      contentHash: selectedFile?.currentHash ?? null,
    });
    if (!codeRef) return;
    const delivered = await store.send(
      note || 'Please revise the attached code selection.',
      'steer',
      undefined,
      [codeRef],
    );
    if (!delivered) return;
    setFix(null);
    setFixNote('');
    store.closeReview();
    app.openTaskRoom(task.id);
  };

  return (
    <div className="rv-root" data-testid="review-view" role="dialog" aria-label="Review changes">
      <div className="rv-head">
        <span className="rv-title">
          <small>{task.projectName} / Session review</small>
          <span>{task.title}</span>
        </span>
        {cs ? (
          <span className="rv-totals" data-testid="review-totals">
            {cs.files.length} file{cs.files.length === 1 ? '' : 's'} ·{' '}
            <i className="plus">+{cs.totalAdditions}</i>{' '}
            <i className="minus">−{cs.totalDeletions}</i>
          </span>
        ) : null}
        <span className="rv-sp" />
        {!canDecide ? (
          <span className="rv-readonly">Read-only — {stateLabel(task.state)}</span>
        ) : null}
        {canDecide && hasEvidenceRisk ? (
          <ConfirmDangerButton
            label={
              executionFailed
                ? 'Accept despite failed request…'
                : failedChecks.length > 0
                  ? 'Accept despite failed checks…'
                  : 'Accept without verification…'
            }
            confirmLabel={
              executionFailed
                ? 'Confirm — accept without requested fix'
                : failedChecks.length > 0
                  ? 'Confirm — accept failed checks'
                  : 'Confirm — accept unverified changes'
            }
            testid="review-accept-all"
            onConfirm={() => void store.acceptTask({ confirmEvidenceRisk: true })}
          />
        ) : (
          <button
            className="btn primary"
            data-testid="review-accept-all"
            disabled={!canDecide}
            onClick={() => void store.acceptTask()}
          >
            Accept all changes
          </button>
        )}
        <button className="btn" data-testid="review-close" onClick={() => store.closeReview()}>
          Close
        </button>
      </div>

      {executionFailed ? (
        <div className="rv-execution-warning" data-testid="review-execution-failed">
          <Ic name="alert" size={14} />
          <span>
            <strong>The latest request did not complete.</strong> A file action failed; the Diff
            shows the existing changes, not proof that the requested fix was applied.
          </span>
        </div>
      ) : null}

      <div className="rv-tabs" role="tablist" aria-label="Evidence">
        <button
          className={`rv-tab ${tab === 'changes' ? 'on' : ''}`}
          role="tab"
          aria-selected={tab === 'changes'}
          data-testid="review-tab-changes"
          onClick={() => setTab('changes')}
        >
          Changes
        </button>
        {previewAvailable ? (
          <button
            className={`rv-tab ${tab === 'preview' ? 'on' : ''}`}
            role="tab"
            aria-selected={tab === 'preview'}
            data-testid="review-tab-preview"
            onClick={() => setTab('preview')}
          >
            Preview
          </button>
        ) : null}
        <button
          className={`rv-tab ${tab === 'checks' ? 'on' : ''}`}
          role="tab"
          aria-selected={tab === 'checks'}
          data-testid="review-tab-checks"
          onClick={() => setTab('checks')}
        >
          Checks
        </button>
        <span className="rv-tabnote">
          three projections of the same change — code, checks, pixels
        </span>
      </div>

      {tab === 'preview' ? <LivePreview task={task} variant="gate" /> : null}
      {tab === 'checks' ? <ReviewChecks task={task} /> : null}

      <div className="rv-body" style={tab === 'changes' ? undefined : { display: 'none' }}>
        <aside className="rv-files">
          {store.loadingChangeSet ? (
            <div className="rv-note">Computing change set…</div>
          ) : files.length === 0 ? (
            <div className="empty-state" data-testid="review-empty">
              <div className="es-title">No file changes</div>
              <div>This Session has no remaining net changes to review.</div>
            </div>
          ) : (
            files.map((file) => {
              const meta = STATUS_META[file.status];
              const active = selectedFile?.path === file.path;
              return (
                <div
                  key={file.path}
                  className={`rv-file ${active ? 'active' : ''}`}
                  data-testid={`review-file-${file.path}`}
                  role="button"
                  tabIndex={0}
                  title={file.renamedFrom ? `renamed from ${file.renamedFrom}` : file.path}
                  onClick={() => setSelectedPath(file.path)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') setSelectedPath(file.path);
                  }}
                >
                  <span className="rv-file-letter" style={{ color: meta.color }}>
                    {meta.letter}
                  </span>
                  <span className="rv-file-body">
                    <span
                      className="rv-file-name"
                      style={{ color: active ? undefined : meta.color }}
                    >
                      {file.path.split('/').pop()}
                    </span>
                    <span className="rv-file-dir">
                      {file.path.includes('/')
                        ? file.path.slice(0, file.path.lastIndexOf('/'))
                        : './'}
                    </span>
                  </span>
                  <span className="rv-file-stat mono">
                    <i className="plus">+{file.additions}</i>{' '}
                    <i className="minus">−{file.deletions}</i>
                  </span>
                  <span className="rv-file-state" data-testid={`review-file-state-${file.path}`}>
                    {file.reviewState}
                  </span>
                  {canDecide && file.reviewState !== 'accepted' ? (
                    <span className="rv-file-actions">
                      <button
                        className="rv-hbtn ok"
                        data-testid={`file-accept-${file.path}`}
                        title="Accept every change in this file"
                        onClick={(e) => {
                          e.stopPropagation();
                          void store.reviewDecision({
                            path: file.path,
                            scope: 'file',
                            decision: 'accept',
                          });
                        }}
                      >
                        ✓
                      </button>
                      <button
                        className="rv-hbtn bad"
                        data-testid={`file-reject-${file.path}`}
                        title="Reject the file — restore its pre-Session state"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (
                            window.confirm(
                              `Reject all changes to ${file.path}? The file is restored to its pre-Session state.`,
                            )
                          ) {
                            void store.reviewDecision({
                              path: file.path,
                              scope: 'file',
                              decision: 'reject',
                              ...(file.currentHash
                                ? { expectedCurrentHash: file.currentHash }
                                : {}),
                            });
                          }
                        }}
                      >
                        ✕
                      </button>
                    </span>
                  ) : null}
                </div>
              );
            })
          )}
        </aside>

        <main className="rv-main">
          {selectedFile ? (
            <>
              <HunkStrip
                file={selectedFile}
                canDecide={canDecide}
                onReveal={(line) => setReveal((r) => ({ line, seq: r.seq + 1 }))}
              />
              <DiffPane
                taskId={task.id}
                file={selectedFile}
                revealSeq={reveal}
                onRequestFix={(path, start, end, code) => setFix({ path, start, end, code })}
              />
            </>
          ) : (
            <div className="empty-state">Select a file to see its diff.</div>
          )}
        </main>
      </div>

      <div className="rv-foot">
        <ConfirmDangerButton
          label="Roll back everything…"
          confirmLabel="Confirm — restore all files"
          confirmDescription={`Restores ${cs?.files.length ?? 0} changed ${(cs?.files.length ?? 0) === 1 ? 'file' : 'files'} to the recorded pre-Session bytes and discards unaccepted edits. Git commits are not rewritten; current verification becomes stale.`}
          testid="review-rollback"
          quiet
          disabled={!canDecide}
          title="Restore every touched file to its pre-Session state"
          onConfirm={() => void store.rollbackTask({ confirmDestructive: true })}
        />
        <span className="rv-footnote">
          Baseline (left) is the pre-Session snapshot; current file (right) is what accept keeps.
        </span>
      </div>

      {fix ? (
        <div className="modal-backdrop" data-testid="request-fix-dialog">
          <div className="modal" style={{ width: 480 }}>
            <div className="modal-header">
              <span>
                Request fix — <span className="mono">{fix.path}</span> lines {fix.start}–{fix.end}
              </span>
              <button className="modal-close" aria-label="Close" onClick={() => setFix(null)}>
                ✕
              </button>
            </div>
            <div
              style={{ padding: '4px 14px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <pre className="mono rv-fixcode">{fix.code.slice(0, 1200)}</pre>
              <textarea
                autoFocus
                data-testid="request-fix-note"
                rows={3}
                placeholder="What should change here? (sent to the agent with the selected lines)"
                value={fixNote}
                onChange={(e) => setFixNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void sendFix();
                  }
                }}
              />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={() => setFix(null)}>
                  Cancel
                </button>
                <button
                  className="btn primary"
                  data-testid="request-fix-send"
                  onClick={() => void sendFix()}
                >
                  Send to agent
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
