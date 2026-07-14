import React, { useEffect, useMemo, useState } from 'react';
import { rpcResult } from '../bridge.js';
import { useTaskStore } from '../store/taskStore.js';
import { useAppStore } from '../store/appStore.js';

export function NewTaskDialog(): React.JSX.Element {
  const store = useTaskStore();
  const settings = useAppStore((s) => s.settings);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [acceptance, setAcceptance] = useState<string[]>(['']);
  const [mode, setMode] = useState<'ask' | 'edit' | 'auto' | 'full'>(
    settings?.agent.defaultMode ?? 'edit',
  );
  const [modelKey, setModelKey] = useState<string>('');
  const [providerForKey, setProviderForKey] = useState('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [suggestions, setSuggestions] = useState<
    Array<{ label: string; executable: string; args: string[]; cwd: string; timeoutMs: number }>
  >([]);
  const [selectedVerifications, setSelectedVerifications] = useState<Set<string>>(new Set());
  const [customVerification, setCustomVerification] = useState('');

  useEffect(() => {
    void store.refreshModels();
    void rpcResult('secrets.list', {});
    void rpcResult('task.suggestVerifications', {}).then((res) => {
      if (res.ok) setSuggestions(res.data.suggestions);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const configuredModels = useMemo(() => store.models.filter((m) => m.configured), [store.models]);

  useEffect(() => {
    if (!modelKey && configuredModels.length > 0) {
      const preferred =
        configuredModels.find(
          (m) =>
            m.providerId === settings?.models.defaultProviderId &&
            m.modelId === settings?.models.defaultModelId,
        ) ?? configuredModels[0]!;
      setModelKey(`${preferred.providerId}::${preferred.modelId}`);
    }
  }, [configuredModels, modelKey, settings]);

  const saveKey = async () => {
    if (!apiKey.trim()) return;
    setSavingKey(true);
    const res = await rpcResult('secrets.set', {
      providerId: providerForKey,
      apiKey: apiKey.trim(),
    });
    setSavingKey(false);
    setApiKey('');
    if (res.ok) {
      useAppStore.getState().pushToast('success', `Credential stored for ${providerForKey}.`);
      await store.refreshModels();
    } else {
      useAppStore.getState().pushToast('error', res.error.userMessage);
    }
  };

  const submit = async () => {
    const [providerId, modelId] = modelKey.split('::');
    if (!providerId || !modelId) {
      useAppStore.getState().pushToast('warning', 'Choose a model first.');
      return;
    }
    if (!title.trim() || !goal.trim()) {
      useAppStore.getState().pushToast('warning', 'Title and goal are required.');
      return;
    }
    setSubmitting(true);
    const verification = suggestions.filter((s) => selectedVerifications.has(s.label));
    const custom = customVerification.trim();
    if (custom) {
      const [executable, ...args] = custom.split(/\s+/);
      if (executable) {
        verification.push({
          label: custom.length > 60 ? `${custom.slice(0, 57)}…` : custom,
          executable,
          args,
          cwd: '',
          timeoutMs: 300_000,
        });
      }
    }
    await store.createAndStart({
      title: title.trim(),
      goalMd: goal.trim(),
      acceptance: acceptance.map((a) => a.trim()).filter(Boolean),
      mode,
      model: { providerId, modelId },
      verification,
    });
    setSubmitting(false);
  };

  const noAcceptance = acceptance.every((a) => a.trim() === '');

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-label="New task"
        data-testid="new-task-dialog"
        style={{ width: 'min(680px, 94vw)', height: 'auto', maxHeight: '90vh' }}
      >
        <div className="modal-header">
          New agent task
          <button
            className="modal-close"
            aria-label="Close"
            onClick={() => store.setNewTaskOpen(false)}
          >
            ✕
          </button>
        </div>
        <div
          className="modal-body"
          style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="text-muted" style={{ fontSize: 11 }}>
              Title *
            </span>
            <input
              data-testid="task-title"
              value={title}
              placeholder="Fix the failing add() rounding bug"
              style={{
                background: 'var(--bg-input)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '6px 8px',
              }}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="text-muted" style={{ fontSize: 11 }}>
              Goal (markdown) *
            </span>
            <textarea
              data-testid="task-goal"
              value={goal}
              rows={4}
              placeholder="Describe what the agent should achieve…"
              style={{
                background: 'var(--bg-input)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '6px 8px',
                fontFamily: 'inherit',
                resize: 'vertical',
              }}
              onChange={(e) => setGoal(e.target.value)}
            />
          </label>

          <div>
            <span className="text-muted" style={{ fontSize: 11 }}>
              Acceptance criteria
            </span>
            {acceptance.map((value, i) => (
              <div key={i} style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                <input
                  data-testid={`task-acceptance-${i}`}
                  value={value}
                  placeholder={`Criterion ${i + 1}`}
                  style={{
                    flex: 1,
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    padding: '5px 8px',
                  }}
                  onChange={(e) =>
                    setAcceptance(acceptance.map((a, j) => (j === i ? e.target.value : a)))
                  }
                />
                <button
                  className="modal-close"
                  aria-label="Remove criterion"
                  onClick={() => setAcceptance(acceptance.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              className="btn"
              style={{ marginTop: 4 }}
              onClick={() => setAcceptance([...acceptance, ''])}
            >
              ＋ criterion
            </button>
            {noAcceptance ? (
              <div
                className="text-warning"
                style={{ fontSize: 11, marginTop: 4 }}
                data-testid="acceptance-warning"
              >
                Without acceptance criteria the final report will be marked Unverified-by-user.
              </div>
            ) : null}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="text-muted" style={{ fontSize: 11 }}>
              Verification commands (optional; VER-001/002)
            </span>
            {suggestions.map((s) => (
              <label key={s.label} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  data-testid={`verification-suggest-${s.label.replace(/\s+/g, '-')}`}
                  checked={selectedVerifications.has(s.label)}
                  onChange={(e) => {
                    const next = new Set(selectedVerifications);
                    if (e.target.checked) next.add(s.label);
                    else next.delete(s.label);
                    setSelectedVerifications(next);
                  }}
                />
                <span className="mono" style={{ fontSize: 12 }}>
                  {s.label}
                </span>
              </label>
            ))}
            <input
              data-testid="task-verification-custom"
              value={customVerification}
              onChange={(e) => setCustomVerification(e.target.value)}
              placeholder="Custom command, e.g. node check-agent.mjs (no shell syntax)"
              style={{
                background: 'var(--bg-input)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '6px 8px',
                fontSize: 12,
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <span className="text-muted" style={{ fontSize: 11 }}>
              Mode
            </span>
            {(['ask', 'edit', 'auto', 'full'] as const).map((m) => (
              <label
                key={m}
                style={{
                  display: 'flex',
                  gap: 4,
                  alignItems: 'center',
                  ...(m === 'full' ? { color: 'var(--danger)' } : {}),
                }}
                title={
                  m === 'full'
                    ? 'Nothing asks and the result is applied automatically — you can still roll back'
                    : undefined
                }
              >
                <input
                  type="radio"
                  data-testid={`mode-${m}`}
                  checked={mode === m}
                  onChange={() => setMode(m)}
                />
                {m === 'ask'
                  ? 'Ask (read-only)'
                  : m === 'edit'
                    ? 'Edit (approvals)'
                    : m === 'auto'
                      ? 'Auto (bounded)'
                      : 'Full auto (dangerous)'}
              </label>
            ))}
          </div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="text-muted" style={{ fontSize: 11 }}>
              Model
            </span>
            <select
              data-testid="task-model"
              value={modelKey}
              style={{
                background: 'var(--bg-input)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '6px 8px',
              }}
              onChange={(e) => setModelKey(e.target.value)}
            >
              <option value="">— choose —</option>
              {configuredModels.map((m) => (
                <option
                  key={`${m.providerId}::${m.modelId}`}
                  value={`${m.providerId}::${m.modelId}`}
                >
                  {m.providerId} / {m.displayName}
                </option>
              ))}
            </select>
          </label>

          {configuredModels.length === 0 ? (
            <div
              data-testid="provider-setup"
              style={{
                border: '1px solid var(--warning)',
                borderRadius: 6,
                padding: 10,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <div className="text-warning" style={{ fontSize: 12 }}>
                No model provider is configured yet. Store an API key (encrypted with your OS
                keychain) to enable real models — or enable the deterministic mock runtime in
                Settings → Models for demos.
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <select
                  value={providerForKey}
                  style={{
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    padding: '5px 8px',
                  }}
                  onChange={(e) => setProviderForKey(e.target.value)}
                >
                  {['anthropic', 'openai', 'google', 'xai', 'groq', 'openrouter'].map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <input
                  type="password"
                  placeholder="API key"
                  value={apiKey}
                  style={{
                    flex: 1,
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    padding: '5px 8px',
                  }}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <button
                  className="btn primary"
                  disabled={savingKey || !apiKey.trim()}
                  onClick={() => void saveKey()}
                >
                  {savingKey ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
        <div
          style={{
            padding: 12,
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
            borderTop: '1px solid var(--border)',
          }}
        >
          <button className="btn" onClick={() => store.setNewTaskOpen(false)}>
            Cancel
          </button>
          <button
            className="btn primary"
            data-testid="task-create-start"
            disabled={submitting || !title.trim() || !goal.trim() || !modelKey}
            onClick={() => void submit()}
          >
            {submitting ? 'Starting…' : 'Create & start'}
          </button>
        </div>
      </div>
    </div>
  );
}
