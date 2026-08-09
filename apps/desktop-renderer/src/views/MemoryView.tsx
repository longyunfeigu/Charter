import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ExternalMemoryFileDto,
  MemoryCandidateDto,
  MemoryCharterProject,
  MemoryClaudeProjectGroup,
  MemoryOverviewDto,
  MemoryRuleDto,
  MemorySyncStateDto,
} from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useMemoryStore } from '../store/memoryStore.js';
import { useMemoryViewStore } from '../store/memoryViewStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { Markdown } from './Markdown.js';
import { Ic } from './home-icons.js';
import '../styles/memory.css';

/**
 * Memory (ADR-0028, IA v3 — user-directed): agents are the top level.
 * Claude Code / Codex / Charter each open into their GLOBAL memory first,
 * then a per-project second level. Claude lists EVERY project it has
 * auto-memory for (matched Charter projects by name, foreign dirs verbatim);
 * Charter's "memory" is each project's distilled rules + distribution.
 */
function when(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

/** Two-step destructive button (repo confirm convention). */
function ConfirmButton(props: {
  label: string;
  confirmLabel: string;
  testid?: string;
  onConfirm: () => void;
}): React.JSX.Element {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={`mv-btn danger ${armed ? 'confirming' : ''}`}
      data-testid={props.testid}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        props.onConfirm();
      }}
    >
      {armed ? props.confirmLabel : props.label}
    </button>
  );
}

type ParsedMemoryDoc = {
  meta: Array<{ key: string; value: string }>;
  description: string | null;
  body: string;
};

/** Shallow parse of a leading YAML frontmatter block into display chips. */
function parseMemoryDoc(content: string): ParsedMemoryDoc {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return { meta: [], description: null, body: content };
  const meta: Array<{ key: string; value: string }> = [];
  let description: string | null = null;
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2]!.trim().replace(/^["']/, '').replace(/["']$/, '');
    if (value.length === 0) continue; // parent keys like `metadata:`
    if (kv[1] === 'description') description = value;
    else meta.push({ key: kv[1]!, value });
  }
  return { meta, description, body: content.slice(match[0].length) };
}

/** Render [[wiki-links]] as inline-code chips, leaving fenced blocks alone. */
function chipWikiLinks(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?(?:```|$))/)
    .map((segment, index) =>
      index % 2 === 1 ? segment : segment.replace(/(?<!`)\[\[([^\]`\n]+)\]\](?!`)/g, '`[[$1]]`'),
    )
    .join('');
}

/**
 * Centered dialog for one external memory file (nested inside the memory
 * overlay). View renders the markdown body under a frontmatter strip; Edit
 * is the raw file text. Escape is intercepted in the capture phase so the
 * workbench overlay underneath stays open.
 */
function FileDialog(props: {
  file: ExternalMemoryFileDto;
  mode: 'view' | 'edit';
  content: string;
  truncated: boolean;
  onModeChange: (mode: 'view' | 'edit') => void;
  onContentChange: (content: string) => void;
  onSave: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const { file } = props;
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const doc = useMemo(() => parseMemoryDoc(props.content), [props.content]);

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div
        className="modal mv-fd"
        role="dialog"
        aria-modal="true"
        aria-label={file.label}
        data-testid="memory-file-dialog"
      >
        <div className="modal-header mv-fd-head">
          <div className="mv-fd-title">
            <div className="name">
              {file.label}
              <span className="scope">{file.scope === 'global' ? 'global' : 'project'}</span>
            </div>
            <div className="path">{file.path}</div>
          </div>
          <div className="mv-fd-seg">
            <button
              className={props.mode === 'view' ? 'active' : ''}
              data-testid="memory-file-mode-view"
              onClick={() => props.onModeChange('view')}
            >
              View
            </button>
            <button
              className={props.mode === 'edit' ? 'active' : ''}
              data-testid="memory-file-mode-edit"
              onClick={() => props.onModeChange('edit')}
            >
              Edit
            </button>
          </div>
          <button
            className="modal-close"
            aria-label="Close"
            data-testid="memory-file-close"
            onClick={props.onClose}
          >
            ✕
          </button>
        </div>
        {props.mode === 'view' ? (
          <div className="modal-body" data-testid="memory-external-viewer">
            {doc.meta.length > 0 || doc.description ? (
              <div className="mv-fd-fm">
                {doc.meta.map((entry) => (
                  <span key={entry.key} className="chip">
                    {entry.key}: {entry.value}
                  </span>
                ))}
                {doc.description ? <span className="desc">{doc.description}</span> : null}
              </div>
            ) : null}
            {props.truncated ? (
              <div className="mv-hint" style={{ padding: '10px 22px 0' }}>
                Preview truncated — the file is longer than shown here.
              </div>
            ) : null}
            <div className="mv-fd-md">
              <Markdown text={chipWikiLinks(doc.body)} />
            </div>
          </div>
        ) : (
          <>
            <div className="modal-body mv-fd-editwrap">
              <textarea
                className="mv-fd-editor"
                value={props.content}
                onChange={(e) => props.onContentChange(e.target.value)}
                spellCheck={false}
                autoFocus
                data-testid="memory-external-editor"
              />
            </div>
            <div className="mv-fd-foot">
              <button
                className="mv-btn primary"
                data-testid="memory-external-save"
                disabled={props.truncated}
                onClick={props.onSave}
              >
                Save
              </button>
              <button className="mv-btn quiet" onClick={props.onClose}>
                Cancel
              </button>
              <span className="hint">
                {props.truncated
                  ? 'truncated read — saving would lose the tail; view only'
                  : 'Raw file contents, frontmatter included'}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** One external memory file row. `promoteTo` = matched Charter project path. */
function FileRow(props: {
  file: ExternalMemoryFileDto;
  promoteTo: string | null;
}): React.JSX.Element {
  const store = useMemoryStore();
  const { file } = props;
  const [mode, setMode] = useState<'closed' | 'view' | 'edit'>('closed');
  const [content, setContent] = useState('');
  const [mtime, setMtime] = useState<number | null>(null);
  const [truncated, setTruncated] = useState(false);

  const open = async (nextMode: 'view' | 'edit'): Promise<void> => {
    const data = await store.readExternal(file.id);
    if (!data) return;
    setContent(data.content);
    setMtime(data.mtimeMs);
    setTruncated(data.truncated);
    setMode(nextMode);
  };

  return (
    <div className="mv-file" data-testid="memory-external-file">
      <div className="mv-file-head">
        <span className="label">{file.label}</span>
        <span className="scope">{file.scope === 'global' ? 'global' : 'project'}</span>
        {file.role === 'memory-index' ? <span className="scope">index</span> : null}
        <span className="when">{when(file.updatedAt)}</span>
      </div>
      <div className="mv-file-summary">{file.summary}</div>
      <div className="mv-file-path">{file.path}</div>
      <div className="mv-file-actions">
        {file.readable ? (
          <>
            <button className="mv-btn quiet" onClick={() => void open('view')}>
              View
            </button>
            <button
              className="mv-btn quiet"
              data-testid="memory-external-edit"
              onClick={() => void open('edit')}
            >
              Edit
            </button>
          </>
        ) : (
          <span className="mv-hint">too large or binary — view disabled</span>
        )}
        {file.role === 'memory' && file.readable && props.promoteTo ? (
          <button
            className="mv-btn"
            data-testid="memory-external-promote"
            onClick={() => void store.promoteExternal(props.promoteTo!, file.id)}
          >
            ↑ Promote to Charter rule
          </button>
        ) : null}
        <ConfirmButton
          label="Delete"
          confirmLabel="Backup & delete?"
          testid="memory-external-delete"
          onConfirm={() => void store.deleteExternal(file.id)}
        />
      </div>
      {mode !== 'closed' ? (
        <FileDialog
          file={file}
          mode={mode}
          content={content}
          truncated={truncated}
          onModeChange={setMode}
          onContentChange={setContent}
          onSave={() =>
            void store.writeExternal(file.id, content, mtime).then((ok) => {
              if (ok) setMode('closed');
            })
          }
          onClose={() => setMode('closed')}
        />
      ) : null}
    </div>
  );
}

/** Collapsible project group (level 2). */
function ProjGroup(props: {
  title: string;
  path: string | null;
  meta: React.ReactNode;
  current: boolean;
  open: boolean;
  onToggle: () => void;
  rawName: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={`mv-proj ${props.open ? 'open' : ''}`} data-testid="memory-proj-group">
      <button className="mv-proj-head" data-testid="memory-proj-head" onClick={props.onToggle}>
        <span className="tri">▶</span>
        <span className={`name ${props.rawName ? 'raw' : ''}`}>{props.title}</span>
        {props.path ? <span className="path">{props.path}</span> : null}
        {props.current ? <span className="cur">current</span> : null}
        {props.meta}
      </button>
      {props.open ? <div className="mv-proj-body">{props.children}</div> : null}
    </div>
  );
}

// ───────────────────────── Claude Code ─────────────────────────

function ClaudeView(props: {
  global: ExternalMemoryFileDto[];
  projects: MemoryClaudeProjectGroup[];
  currentPath: string | null;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const current = props.projects.find((group) => group.projectPath === props.currentPath);
    return new Set(current ? [current.key] : []);
  });
  const toggle = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  return (
    <>
      <div className="mv-sec">Global — applies to every project</div>
      {props.global.length === 0 ? (
        <div className="mv-empty">No global CLAUDE.md found (~/.claude/CLAUDE.md).</div>
      ) : (
        props.global.map((file) => <FileRow key={file.id} file={file} promoteTo={null} />)
      )}
      <div className="mv-sec">Projects — auto-memory per project</div>
      {props.projects.length === 0 ? (
        <div className="mv-empty" data-testid="memory-claude-empty">
          Claude Code has no per-project auto-memory on this machine yet. Groups appear here as soon
          as it writes them (~/.claude/projects/&lt;project&gt;/memory).
        </div>
      ) : (
        props.projects.map((group) => (
          <ProjGroup
            key={group.key}
            title={group.displayName}
            path={group.projectPath}
            rawName={group.projectPath === null}
            current={group.projectPath !== null && group.projectPath === props.currentPath}
            open={expanded.has(group.key)}
            onToggle={() => toggle(group.key)}
            meta={<span className="n">{group.files.length} memories</span>}
          >
            {group.projectPath === null ? (
              <div className="mv-hint">
                Claude knows this directory but it was never opened in Charter — browse and delete
                only (there is no Charter project to promote into).
              </div>
            ) : null}
            {group.files.map((file) => (
              <FileRow key={file.id} file={file} promoteTo={group.projectPath} />
            ))}
          </ProjGroup>
        ))
      )}
      <div className="mv-hint">
        Read-only discovery over ~/.claude path conventions. Edits and deletes are explicit actions;
        deletes back up first; Promote copies a note into that project's Charter rules (one-way).
        Session transcripts are not memory and are not listed.
      </div>
    </>
  );
}

// ───────────────────────── Codex ─────────────────────────

function CodexView(props: { global: ExternalMemoryFileDto[] }): React.JSX.Element {
  return (
    <>
      <div className="mv-sec">Global — applies to every project</div>
      {props.global.length === 0 ? (
        <div className="mv-empty">No global AGENTS.md found (~/.codex/AGENTS.md).</div>
      ) : (
        props.global.map((file) => <FileRow key={file.id} file={file} promoteTo={null} />)
      )}
      <div className="mv-sec">Projects</div>
      <div className="mv-empty" data-testid="memory-codex-empty">
        This Codex version keeps no per-project auto-memory — only the global AGENTS.md above.
        Project-level AGENTS.md files are project files, managed under each project's Charter →
        Distribution. If a future Codex adds a memory store, it appears here under the same
        read-only rules.
      </div>
    </>
  );
}

// ───────────────────────── Charter ─────────────────────────

function CandidateCard(props: {
  candidate: MemoryCandidateDto;
  projectPath: string;
}): React.JSX.Element {
  const store = useMemoryStore();
  const { candidate } = props;
  const [text, setText] = useState(candidate.text);
  const isHit = candidate.matchedRuleId !== null;
  return (
    <div className={`mv-candidate ${isHit ? 'hit' : ''}`} data-testid="memory-candidate">
      <div className="mv-candidate-origin">
        <span>{candidate.origin.label ?? 'Captured correction'}</span>
        {candidate.similarCount > 1 ? (
          <span className="sim">×{candidate.similarCount} similar corrections</span>
        ) : null}
        {isHit ? <span>matches an existing rule — it slipped again</span> : null}
        <span>{when(candidate.createdAt)}</span>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        data-testid="memory-candidate-text"
      />
      <div className="mv-row-actions">
        <button
          className="mv-btn primary"
          data-testid="memory-candidate-approve"
          onClick={() =>
            void store.resolveCandidate({
              projectPath: props.projectPath,
              candidateId: candidate.id,
              action: 'approve',
              editedText: text,
            })
          }
        >
          Distill into a rule
        </button>
        <button
          className="mv-btn quiet"
          data-testid="memory-candidate-dismiss"
          onClick={() =>
            void store.resolveCandidate({
              projectPath: props.projectPath,
              candidateId: candidate.id,
              action: 'dismiss',
            })
          }
        >
          {isHit ? 'Got it' : 'Not a rule'}
        </button>
      </div>
    </div>
  );
}

function RuleRow(props: { rule: MemoryRuleDto; projectPath: string }): React.JSX.Element {
  const store = useMemoryStore();
  const { rule, projectPath } = props;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(rule.text);
  return (
    <div className={`mv-rule ${rule.enabled ? '' : 'off'}`} data-testid="memory-rule-row">
      <div className="mv-rule-body">
        {editing ? (
          <>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} />
            <div className="mv-row-actions" style={{ marginTop: 6 }}>
              <button
                className="mv-btn primary"
                onClick={() => {
                  void store.updateRule(projectPath, rule.id, { text });
                  setEditing(false);
                }}
              >
                Save
              </button>
              <button
                className="mv-btn quiet"
                onClick={() => {
                  setText(rule.text);
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mv-rule-text">{rule.text}</div>
            <div className="mv-rule-meta">
              {rule.sourceLabel ? <span className="src">{rule.sourceLabel}</span> : null}
              {rule.injectedTasks > 0 ? (
                <span className="use">injected into {rule.injectedTasks} tasks</span>
              ) : (
                <span>not injected yet</span>
              )}
              {rule.hitCount > 0 ? (
                <span className="hit">slipped again ×{rule.hitCount}</span>
              ) : null}
            </div>
          </>
        )}
      </div>
      <div className="mv-row-actions">
        {!editing ? (
          <button className="mv-btn quiet" onClick={() => setEditing(true)} aria-label="Edit rule">
            Edit
          </button>
        ) : null}
        <ConfirmButton
          label="Remove"
          confirmLabel="Really remove?"
          onConfirm={() => void store.removeRule(projectPath, rule.id)}
        />
        <div
          className={`mv-toggle ${rule.enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={rule.enabled}
          aria-label={`Rule enabled: ${rule.enabled}`}
          tabIndex={0}
          data-testid="memory-rule-toggle"
          onClick={() => void store.updateRule(projectPath, rule.id, { enabled: !rule.enabled })}
          onKeyDown={(e) => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              void store.updateRule(projectPath, rule.id, { enabled: !rule.enabled });
            }
          }}
        />
      </div>
    </div>
  );
}

const SYNC_LINE_LABEL: Record<MemorySyncStateDto['target'], string> = {
  'claude-md': 'CLAUDE.md',
  'agents-md': 'AGENTS.md',
};

function SyncLine(props: { sync: MemorySyncStateDto; projectPath: string }): React.JSX.Element {
  const store = useMemoryStore();
  const { sync, projectPath } = props;
  return (
    <div className="mv-syncline-wrap" data-testid={`memory-sync-${sync.target}`}>
      <div className="mv-syncline">
        <span className="lab">{SYNC_LINE_LABEL[sync.target]}</span>
        <span
          className={`mv-status ${sync.status}`}
          data-testid={`memory-sync-status-${sync.target}`}
        >
          {sync.status === 'ok' ? (
            '✓ synced'
          ) : sync.status === 'drift' ? (
            <>
              <Ic name="alert" size={11} /> hand-edited
            </>
          ) : (
            sync.status
          )}
        </span>
        <span className="path">{sync.filePath}</span>
        {sync.enabled && sync.status !== 'drift' ? (
          <button
            className="mv-btn quiet"
            onClick={() => void store.applySync(projectPath, sync.target)}
          >
            Sync now
          </button>
        ) : null}
        <div
          className={`mv-toggle ${sync.enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={sync.enabled}
          aria-label={`Sync ${SYNC_LINE_LABEL[sync.target]}`}
          tabIndex={0}
          data-testid={`memory-sync-toggle-${sync.target}`}
          onClick={() => void store.setSyncEnabled(projectPath, sync.target, !sync.enabled)}
          onKeyDown={(e) => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              void store.setSyncEnabled(projectPath, sync.target, !sync.enabled);
            }
          }}
        />
      </div>
      {sync.detail ? (
        <div className="mv-hint" style={{ padding: '2px 0 4px' }}>
          {sync.detail}
        </div>
      ) : null}
      {sync.status === 'drift' ? (
        <div className="mv-drift-actions" data-testid={`memory-drift-${sync.target}`}>
          <button
            className="mv-btn primary"
            data-testid={`memory-drift-import-${sync.target}`}
            onClick={() => void store.resolveDrift(projectPath, sync.target, 'import')}
          >
            Import hand edits as candidates
          </button>
          <button
            className="mv-btn"
            onClick={() => void store.resolveDrift(projectPath, sync.target, 'overwrite')}
          >
            Overwrite from rules source
          </button>
          <button
            className="mv-btn quiet"
            onClick={() => void store.resolveDrift(projectPath, sync.target, 'stop')}
          >
            Stop managing
          </button>
        </div>
      ) : null}
    </div>
  );
}

function CharterProjectBody(props: { projectPath: string }): React.JSX.Element {
  const store = useMemoryStore();
  const overview = store.projectOverviews[props.projectPath];
  const [draft, setDraft] = useState('');
  useEffect(() => {
    void store.refreshProject(props.projectPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projectPath]);

  if (!overview) return <div className="mv-hint">Loading…</div>;
  if (!overview.available) {
    return (
      <div className="mv-hint">
        This folder is not an opened project anymore — open it under Projects to manage rules.
      </div>
    );
  }
  return (
    <>
      <div className="mv-stats" data-testid="memory-stats">
        <span>
          <b>{overview.stats.enabled}</b>enabled
        </span>
        <span>
          <b>{overview.stats.injectedTasks7d}</b>tasks injected · 7d
        </span>
        <span>
          <b>{overview.stats.hitsTotal}</b>slipped again
        </span>
        <span>
          <b>{overview.stats.candidates}</b>candidates
        </span>
      </div>
      {overview.candidates.map((candidate) => (
        <CandidateCard key={candidate.id} candidate={candidate} projectPath={props.projectPath} />
      ))}
      {overview.rules.length === 0 ? (
        <div className="mv-empty" data-testid="memory-rules-empty">
          No rules yet. Reject a hunk or send a request-fix note during review and Charter offers to
          distill it — or add one below.
        </div>
      ) : (
        overview.groups.map((group) => (
          <div key={group} style={{ display: 'grid', gap: 8 }}>
            {overview.groups.length > 1 ? <div className="mv-group-head">{group}</div> : null}
            {overview.rules
              .filter((rule) => rule.group === group)
              .map((rule) => (
                <RuleRow key={rule.id} rule={rule} projectPath={props.projectPath} />
              ))}
          </div>
        ))
      )}
      <div className="mv-sec" style={{ paddingTop: 2 }}>
        Distribution
      </div>
      <div className="mv-syncline-wrap">
        <div className="mv-syncline">
          <span className="lab">Charter runs</span>
          <span className="mv-status ok">always on</span>
          <span className="mv-hint">preamble + every run &amp; reply</span>
        </div>
      </div>
      {overview.sync.map((sync) => (
        <SyncLine key={sync.target} sync={sync} projectPath={props.projectPath} />
      ))}
      <div className="mv-add-rule">
        <textarea
          placeholder="New rule, e.g. “Named exports only; never default export.”"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          data-testid="memory-add-rule-input"
        />
        <button
          className="mv-btn primary"
          data-testid="memory-add-rule"
          disabled={draft.trim().length === 0}
          onClick={() => {
            void store.addRule(props.projectPath, draft.trim()).then((ok) => {
              if (ok) setDraft('');
            });
          }}
        >
          Add rule
        </button>
      </div>
      <div className="mv-hint">
        Stored in <code>{overview.rulesFilePath}</code> — hand edits safe, git-shareable.{' '}
        <button
          className="mv-btn quiet"
          onClick={() => void rpcResult('app.revealPath', { path: overview.rulesFilePath })}
        >
          Reveal in Finder
        </button>
      </div>
    </>
  );
}

function CharterView(props: {
  projects: MemoryCharterProject[];
  currentPath: string | null;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const current = props.projects.find((project) => project.projectPath === props.currentPath);
    return new Set(current ? [current.projectPath] : []);
  });
  const toggle = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  return (
    <>
      <div className="mv-sec">Global</div>
      <div className="mv-empty">
        Charter has no global rules by design — every rule belongs to a project (stored in that
        project's <code>.charter/rules.md</code>, git-shareable). Its working memory is the task
        ledger, already in the product.
      </div>
      <div className="mv-sec">Projects — rules distilled from your reviews</div>
      {props.projects.length === 0 ? (
        <div className="mv-empty">No projects opened yet.</div>
      ) : (
        props.projects.map((project) => (
          <ProjGroup
            key={project.projectPath}
            title={project.displayName}
            path={project.projectPath}
            rawName={false}
            current={project.projectPath === props.currentPath}
            open={expanded.has(project.projectPath)}
            onToggle={() => toggle(project.projectPath)}
            meta={
              <>
                {project.candidateCount > 0 ? (
                  <span className="badge" data-testid="memory-proj-candidates">
                    {project.candidateCount}
                  </span>
                ) : null}
                <span className="n">{project.ruleCount} rules</span>
              </>
            }
          >
            <CharterProjectBody projectPath={project.projectPath} />
          </ProjGroup>
        ))
      )}
    </>
  );
}

// ───────────────────────── shell ─────────────────────────

export function MemoryView(props: { embedded?: boolean } = {}): React.JSX.Element {
  const store = useMemoryStore();
  const currentPath = useWorkspaceStore((s) => s.workspace?.path ?? null);
  const agent = useMemoryViewStore((state) => state.agent);
  const setAgent = useMemoryViewStore((state) => state.setAgent);
  useEffect(() => {
    store.init();
    void store.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tree = store.tree;
  const page =
    agent === 'claude'
      ? {
          eyebrow: 'Claude Code knowledge',
          title: 'Claude Code Memory',
          description:
            'Inspect global instructions and private project notes without changing who owns them.',
        }
      : agent === 'codex'
        ? {
            eyebrow: 'Codex knowledge',
            title: 'Codex Memory',
            description: 'Review the instruction files Codex carries into its work.',
          }
        : {
            eyebrow: 'Charter knowledge',
            title: 'Project Rules',
            description:
              'Turn reviewed corrections into explicit, shareable rules for future Agent work.',
          };

  return (
    <main className="mv-main" data-testid="memory-view">
      <div className="mv-main-inner">
        <header className="mv-page-head">
          <div className="mv-page-copy">
            <span>{page.eyebrow}</span>
            <h1>{page.title}</h1>
            <p>{page.description}</p>
          </div>
          <div className="mv-page-actions">
            {props.embedded ? (
              <nav className="mv-agent-tabs" aria-label="Memory agent">
                {(
                  [
                    ['claude', '✳', 'Claude'],
                    ['codex', '▣', 'Codex'],
                    ['charter', '◆', 'Charter'],
                  ] as const
                ).map(([id, mark, label]) => (
                  <button
                    type="button"
                    key={id}
                    className={agent === id ? 'on' : ''}
                    data-testid={`memory-nav-${id}`}
                    aria-current={agent === id ? 'page' : undefined}
                    onClick={() => setAgent(id)}
                  >
                    <span aria-hidden="true">{mark}</span>
                    {label}
                  </button>
                ))}
              </nav>
            ) : null}
            <button
              className="mv-btn quiet"
              data-testid="memory-refresh"
              onClick={() => store.refresh()}
            >
              <Ic name="refresh" size={13} /> Refresh
            </button>
          </div>
        </header>
        {!tree ? (
          <div className="mv-loading">
            <span className="mv-loading-mark" aria-hidden="true" />
            Loading memory…
          </div>
        ) : agent === 'claude' ? (
          <ClaudeView
            global={tree.claude.global}
            projects={tree.claude.projects}
            currentPath={currentPath}
          />
        ) : agent === 'codex' ? (
          <CodexView global={tree.codex.global} />
        ) : (
          <CharterView projects={tree.charter.projects} currentPath={currentPath} />
        )}
      </div>
    </main>
  );
}
