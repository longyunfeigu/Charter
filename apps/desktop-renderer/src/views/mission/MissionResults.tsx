import React, { useState } from 'react';
import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { Ic } from '../home-icons.js';
import { principalName } from './mission-view-model.js';

function artifactDetail(reference: Record<string, unknown>): string | null {
  for (const key of ['path', 'uri', 'state', 'worktreePath']) {
    const value = reference[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function verificationState(reference: Record<string, unknown>): 'passed' | 'failed' | 'unknown' {
  const state = typeof reference.state === 'string' ? reference.state.toLowerCase() : '';
  if (state === 'passed' || state === 'success' || state === 'ok') return 'passed';
  if (state === 'failed' || state === 'error') return 'failed';
  return 'unknown';
}

export function MissionResults({
  snapshot,
  onAccept,
  onRequestChanges,
  onOpenConversation,
}: {
  snapshot: MissionSnapshotDto;
  onAccept: () => void;
  onRequestChanges: (feedback: string) => void;
  onOpenConversation: (() => void) | null;
}): React.JSX.Element {
  const reviewReady = snapshot.mission.state === 'VERIFYING';
  const accepted = snapshot.mission.state === 'COMPLETED';
  const files = snapshot.artifacts.filter((artifact) => artifact.kind === 'file-change');
  const verifications = snapshot.artifacts.filter((artifact) => artifact.kind === 'verification');
  const deliverables = snapshot.artifacts.filter(
    (artifact) => !['file-change', 'verification', 'worktree'].includes(artifact.kind),
  );
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState('');

  return (
    <section className="mission-results" data-testid="mission-results">
      <header className={`mission-review-hero ${accepted ? 'accepted' : ''}`}>
        <span className="mission-review-mark">
          <Ic name={accepted ? 'checkCircle' : reviewReady ? 'clipboard' : 'clock'} size={25} />
        </span>
        <span>
          <small>
            {accepted ? 'Mission accepted' : reviewReady ? 'Your review' : 'Mission results'}
          </small>
          <h2>
            {accepted
              ? 'This Mission is complete.'
              : reviewReady
                ? 'The team says the work is ready.'
                : 'Evidence collected so far.'}
          </h2>
          <p>
            {accepted
              ? 'The work, decisions and evidence remain available as a durable record.'
              : reviewReady
                ? 'Check the agreed outcomes and evidence below before accepting the result.'
                : 'Results update as Agents complete their assigned work.'}
          </p>
        </span>
        {reviewReady ? (
          <button className="mission-accept" data-testid="mission-finish" onClick={onAccept}>
            <Ic name="check" size={13} /> Accept Mission
          </button>
        ) : null}
      </header>

      <div className="mission-results-grid">
        <section className="mission-results-card acceptance">
          <header>
            <span>
              <Ic name="flag" size={14} /> Acceptance
            </span>
            <b>{snapshot.mission.acceptanceCriteria.length}</b>
          </header>
          {snapshot.mission.acceptanceCriteria.length > 0 ? (
            <p className="mission-evidence-disclaimer">
              Criteria are the agreed standard; a team completion report is not a per-item verdict.
            </p>
          ) : null}
          {snapshot.mission.acceptanceCriteria.length > 0 ? (
            <ul className="mission-check-list">
              {snapshot.mission.acceptanceCriteria.map((criterion) => (
                <li key={criterion}>
                  <Ic name={accepted ? 'checkCircle' : 'circle'} size={14} />
                  <span>{criterion}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>No explicit acceptance criteria were recorded.</p>
          )}
        </section>

        <section className="mission-results-card verification">
          <header>
            <span>
              <Ic name="checkCircle" size={14} /> Verification
            </span>
            <b>{verifications.length}</b>
          </header>
          {verifications.length > 0 ? (
            <ul className="mission-evidence-list">
              {verifications.map((artifact) => {
                const state = verificationState(artifact.reference);
                return (
                  <li key={artifact.id}>
                    <span className={`mission-evidence-state ${state}`}>
                      <Ic
                        name={state === 'passed' ? 'check' : state === 'failed' ? 'x' : 'circle'}
                        size={11}
                      />
                    </span>
                    <span>
                      <strong>{artifact.label}</strong>
                      <small>
                        {state === 'unknown'
                          ? 'Reported evidence · no structured verdict'
                          : `${state} · ${artifactDetail(artifact.reference) ?? 'recorded verification'}`}
                      </small>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p>No structured verification evidence was reported.</p>
          )}
        </section>

        <section className="mission-results-card outcomes">
          <header>
            <span>
              <Ic name="map" size={14} /> Work outcomes
            </span>
            <b>{snapshot.tasks.filter((task) => task.state === 'COMPLETED').length}</b>
          </header>
          <ul className="mission-outcome-list">
            {snapshot.tasks.map((task) => {
              const assignment = snapshot.assignments.find((item) => item.taskId === task.id);
              const result =
                task.result && typeof task.result.summary === 'string'
                  ? task.result.summary
                  : snapshot.messages
                      .filter(
                        (message) =>
                          message.fromAssignmentId === assignment?.id &&
                          message.type === 'completion',
                      )
                      .at(-1)?.body;
              return (
                <li key={task.id}>
                  <span className={`mission-outcome-state ${task.state.toLowerCase()}`}>
                    <Ic name={task.state === 'COMPLETED' ? 'check' : 'clock'} size={10} />
                  </span>
                  <span>
                    <strong>{task.title}</strong>
                    <small>{principalName(snapshot, assignment?.id ?? null)}</small>
                    {result ? <p>{result}</p> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="mission-results-card changed-files">
          <header>
            <span>
              <Ic name="file" size={14} /> Changed files
            </span>
            <b>{files.length}</b>
          </header>
          {files.length > 0 ? (
            <ul className="mission-file-list">
              {files.map((artifact) => (
                <li key={artifact.id}>
                  <code>{artifactDetail(artifact.reference) ?? artifact.label}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p>No file changes were reported.</p>
          )}
        </section>

        {deliverables.length > 0 ? (
          <section className="mission-results-card deliverables">
            <header>
              <span>
                <Ic name="archive" size={14} /> Deliverables
              </span>
              <b>{deliverables.length}</b>
            </header>
            <ul className="mission-evidence-list">
              {deliverables.map((artifact) => (
                <li key={artifact.id}>
                  <span className="mission-deliverable-icon">
                    <Ic name="clipboard" size={12} />
                  </span>
                  <span>
                    <strong>{artifact.label}</strong>
                    <small>
                      {artifactDetail(artifact.reference) ?? artifact.kind.replaceAll('-', ' ')}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      {reviewReady ? (
        <footer className="mission-review-feedback">
          <span>
            <strong>Not ready to accept?</strong>
            <small>Request a revision and Charter will reopen the Lead with a fresh Attempt.</small>
          </span>
          <span className="mission-review-feedback-actions">
            {onOpenConversation ? (
              <button onClick={onOpenConversation}>Open conversation</button>
            ) : null}
            <button onClick={() => setFeedbackOpen((open) => !open)}>Request changes…</button>
          </span>
          {feedbackOpen ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const value = feedback.trim();
                if (!value) return;
                onRequestChanges(value);
                setFeedback('');
                setFeedbackOpen(false);
              }}
            >
              <label htmlFor="mission-review-feedback">What should the team change?</label>
              <textarea
                id="mission-review-feedback"
                autoFocus
                value={feedback}
                placeholder="Be specific about the missing outcome, failed expectation, or evidence you need…"
                onChange={(event) => setFeedback(event.currentTarget.value)}
              />
              <span>
                <button type="button" onClick={() => setFeedbackOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="mission-primary" disabled={!feedback.trim()}>
                  Reopen Mission
                </button>
              </span>
            </form>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}
