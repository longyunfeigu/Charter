import React, { useEffect, useState } from 'react';
import { rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { useTaskStore } from '../store/taskStore.js';

/** Provider credentials + live model fetch (PIVOT-009, ONB-004/008). */
function ProvidersBlock(): React.JSX.Element {
  const pushToast = useAppStore((s) => s.pushToast);
  const [items, setItems] = useState<
    Array<{ providerId: string; configured: boolean; hint: string }>
  >([]);
  const [providerId, setProviderId] = useState('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    const res = await rpcResult('secrets.list', {});
    if (res.ok) setItems(res.data.items);
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (): Promise<void> => {
    if (!apiKey.trim()) return;
    setBusy('save');
    const res = await rpcResult('secrets.set', { providerId, apiKey: apiKey.trim() });
    setBusy(null);
    setApiKey('');
    if (res.ok) {
      pushToast('success', `Credential stored for ${providerId}.`);
      await refresh();
      await useTaskStore.getState().refreshModels();
    } else {
      pushToast('error', res.error.userMessage);
    }
  };

  const remove = async (id: string): Promise<void> => {
    if (!window.confirm(`Delete the ${id} credential? Running tasks lose access immediately.`)) {
      return;
    }
    const res = await rpcResult('secrets.delete', { providerId: id });
    if (res.ok) {
      pushToast('info', `Credential for ${id} deleted.`);
      await refresh();
      await useTaskStore.getState().refreshModels();
    } else {
      pushToast('error', res.error.userMessage);
    }
  };

  const fetchModels = async (id: string): Promise<void> => {
    setBusy(`fetch-${id}`);
    const res = await rpcResult('models.fetchRemote', { providerId: id });
    setBusy(null);
    if (res.ok) {
      pushToast('success', `${res.data.models.length} models fetched from ${id}.`);
      await useTaskStore.getState().refreshModels();
    } else {
      pushToast('error', res.error.userMessage);
    }
  };

  return (
    <div style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontWeight: 600 }}>Providers</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          data-testid="provider-select"
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
        >
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
        </select>
        <input
          data-testid="provider-key-input"
          type="password"
          placeholder="API key (stored encrypted, never shown again)"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          style={{
            flex: 1,
            minWidth: 220,
            background: 'var(--bg-input)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '6px 8px',
          }}
        />
        <button
          className="btn primary"
          data-testid="provider-key-save"
          disabled={!apiKey.trim() || busy === 'save'}
          onClick={() => void save()}
        >
          Save key
        </button>
      </div>
      {items.length === 0 ? (
        <div className="text-muted" style={{ fontSize: 12 }} data-testid="providers-empty">
          No provider credentials yet. Keys are stored in the encrypted OS keychain scope — never in
          files, the renderer or logs.
        </div>
      ) : (
        items.map((item) => (
          <div
            key={item.providerId}
            data-testid={`provider-row-${item.providerId}`}
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '8px 10px',
            }}
          >
            <span style={{ fontWeight: 600, minWidth: 90 }}>{item.providerId}</span>
            <span className="mono text-muted" style={{ flex: 1, fontSize: 12 }}>
              {item.hint}
            </span>
            <button
              className="btn"
              data-testid={`provider-fetch-${item.providerId}`}
              disabled={busy === `fetch-${item.providerId}`}
              onClick={() => void fetchModels(item.providerId)}
              title="Pull the live model list from the provider with this key"
            >
              {busy === `fetch-${item.providerId}` ? 'Fetching…' : 'Fetch models'}
            </button>
            <button
              className="btn danger"
              data-testid={`provider-delete-${item.providerId}`}
              onClick={() => void remove(item.providerId)}
            >
              Delete
            </button>
          </div>
        ))
      )}
    </div>
  );
}

type Section =
  | 'general'
  | 'editor'
  | 'terminal'
  | 'agent'
  | 'models'
  | 'permissions'
  | 'privacy'
  | 'updates'
  | 'about';

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'editor', label: 'Editor' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'agent', label: 'Agent' },
  { id: 'models', label: 'Models' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'updates', label: 'Updates' },
  { id: 'about', label: 'About' },
];

function Row(props: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label
      style={{
        display: 'grid',
        gridTemplateColumns: '240px 1fr',
        gap: 12,
        padding: '10px 16px',
        alignItems: 'center',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <span>
        {props.label}
        {props.hint ? (
          <span className="text-muted" style={{ display: 'block', fontSize: 11 }}>
            {props.hint}
          </span>
        ) : null}
      </span>
      <span>{props.children}</span>
    </label>
  );
}

export function SettingsView(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings);
  const issues = useAppStore((s) => s.settingsIssues);
  const appInfo = useAppStore((s) => s.appInfo);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const [section, setSection] = useState<Section>('general');

  if (!settings) return <div className="empty-state">Loading settings…</div>;

  const set = (patch: Record<string, unknown>) => void updateSettings('global', patch);

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <nav
        aria-label="Settings sections"
        style={{
          width: 180,
          borderRight: '1px solid var(--border)',
          padding: '8px 0',
          overflow: 'auto',
        }}
      >
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className="quickpick-item"
            style={{
              background: s.id === section ? 'var(--bg-selected)' : 'transparent',
              padding: '8px 16px',
            }}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {issues.length > 0 ? (
          <div className="text-warning" style={{ padding: '8px 16px', fontSize: 12 }}>
            {issues.length} setting value(s) were invalid and fell back to defaults.
          </div>
        ) : null}

        {section === 'general' ? (
          <>
            <Row label="Theme">
              <select
                value={settings.general.theme}
                onChange={(e) => set({ general: { theme: e.target.value } })}
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </Row>
            <Row label="UI scale" hint="0.8 – 2.0">
              <input
                type="number"
                step="0.05"
                min={0.8}
                max={2}
                value={settings.general.uiScale}
                onChange={(e) => set({ general: { uiScale: Number(e.target.value) } })}
              />
            </Row>
            <Row
              label="Rich Markdown by default"
              hint="Open .md files in the Notion-style editor (toggle per file on the tab)"
            >
              <input
                type="checkbox"
                data-testid="settings-md-rich"
                checked={settings.editor.markdownRichDefault}
                onChange={(e) => set({ editor: { markdownRichDefault: e.target.checked } })}
              />
            </Row>
            <Row
              label="System notifications"
              hint="Plan approval · permission · review ready · failed (silent while a window is focused)"
            >
              <input
                type="checkbox"
                data-testid="settings-notifications"
                checked={settings.notifications.enabled}
                onChange={(e) => set({ notifications: { enabled: e.target.checked } })}
              />
            </Row>
          </>
        ) : null}

        {section === 'editor' ? (
          <>
            <Row label="Font size">
              <input
                type="number"
                min={8}
                max={40}
                value={settings.editor.fontSize}
                onChange={(e) => set({ editor: { fontSize: Number(e.target.value) } })}
              />
            </Row>
            <Row label="Font family">
              <input
                style={{ width: '100%' }}
                value={settings.editor.fontFamily}
                onChange={(e) => set({ editor: { fontFamily: e.target.value } })}
              />
            </Row>
            <Row label="Tab size">
              <input
                type="number"
                min={1}
                max={8}
                value={settings.editor.tabSize}
                onChange={(e) => set({ editor: { tabSize: Number(e.target.value) } })}
              />
            </Row>
            <Row label="Word wrap">
              <select
                value={settings.editor.wordWrap}
                onChange={(e) => set({ editor: { wordWrap: e.target.value } })}
              >
                <option value="off">Off</option>
                <option value="on">On</option>
              </select>
            </Row>
            <Row label="Minimap">
              <input
                type="checkbox"
                checked={settings.editor.minimap}
                onChange={(e) => set({ editor: { minimap: e.target.checked } })}
              />
            </Row>
            <Row label="Auto save">
              <select
                value={settings.editor.autoSave}
                onChange={(e) => set({ editor: { autoSave: e.target.value } })}
              >
                <option value="off">Off</option>
                <option value="afterDelay">After delay</option>
                <option value="onFocusChange">On focus change</option>
              </select>
            </Row>
            <Row label="Auto save delay (ms)">
              <input
                type="number"
                min={200}
                max={60000}
                value={settings.editor.autoSaveDelayMs}
                onChange={(e) => set({ editor: { autoSaveDelayMs: Number(e.target.value) } })}
              />
            </Row>
            <Row
              label="Large file threshold (MB)"
              hint="Beyond this size semantic features degrade"
            >
              <input
                type="number"
                min={1}
                max={512}
                value={settings.editor.largeFileSizeMb}
                onChange={(e) => set({ editor: { largeFileSizeMb: Number(e.target.value) } })}
              />
            </Row>
          </>
        ) : null}

        {section === 'terminal' ? (
          <>
            <Row label="Font size">
              <input
                type="number"
                min={8}
                max={32}
                value={settings.terminal.fontSize}
                onChange={(e) => set({ terminal: { fontSize: Number(e.target.value) } })}
              />
            </Row>
            <Row label="Shell path" hint="Empty = system default shell">
              <input
                style={{ width: '100%' }}
                placeholder="/bin/zsh"
                value={settings.terminal.shellPath ?? ''}
                onChange={(e) => set({ terminal: { shellPath: e.target.value || null } })}
              />
            </Row>
            <Row label="Scrollback lines">
              <input
                type="number"
                min={100}
                max={200000}
                value={settings.terminal.scrollback}
                onChange={(e) => set({ terminal: { scrollback: Number(e.target.value) } })}
              />
            </Row>
          </>
        ) : null}

        {section === 'agent' ? (
          <>
            <Row label="Default mode">
              <select
                value={settings.agent.defaultMode}
                onChange={(e) => set({ agent: { defaultMode: e.target.value } })}
              >
                <option value="ask">Ask (read-only)</option>
                <option value="edit">Edit (approvals)</option>
                <option value="auto">Auto (bounded)</option>
              </select>
            </Row>
            <Row
              label="Auto mode: auto-approve workspace edits (R1)"
              hint="Off = Auto only auto-approves read-only tools"
            >
              <input
                type="checkbox"
                checked={settings.agent.autoApproveR1}
                onChange={(e) => set({ agent: { autoApproveR1: e.target.checked } })}
              />
            </Row>
            <Row
              label="Auto mode: auto-approve recognized verification commands (R2)"
              hint="npm test / lint / typecheck detected from the project"
            >
              <input
                type="checkbox"
                checked={settings.agent.autoApproveKnownR2}
                onChange={(e) => set({ agent: { autoApproveKnownR2: e.target.checked } })}
              />
            </Row>
          </>
        ) : null}

        {section === 'models' ? (
          <>
            <Row label="Default thinking level">
              <select
                value={settings.models.defaultThinkingLevel}
                onChange={(e) => set({ models: { defaultThinkingLevel: e.target.value } })}
              >
                {['off', 'minimal', 'low', 'medium', 'high', 'max'].map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Use deterministic mock runtime" hint="For demos/tests without a provider">
              <input
                type="checkbox"
                checked={settings.models.useMockRuntime}
                onChange={(e) => set({ models: { useMockRuntime: e.target.checked } })}
              />
            </Row>
            <ProvidersBlock />
          </>
        ) : null}

        {section === 'permissions' ? (
          <div style={{ padding: 16 }} className="text-muted">
            <p>Risk policy defaults (spec §10.2):</p>
            <ul style={{ lineHeight: 1.9 }}>
              <li>R0 read-only — allowed automatically in every mode.</li>
              <li>R1 reversible workspace writes — Edit asks / plan approval; Auto per setting.</li>
              <li>R2 local execution — recognized verification commands may run; unknown ask.</li>
              <li>R3 external / hard-to-reverse — always asks, cannot be permanently allowed.</li>
              <li>R4 forbidden — sudo, git push, writes outside the workspace: always blocked.</li>
            </ul>
            <p>Per-workspace grants appear here once made from permission cards.</p>
          </div>
        ) : null}

        {section === 'privacy' ? (
          <>
            <Row
              label="Product analytics"
              hint="Default off. Never includes code, prompts or paths."
            >
              <input
                type="checkbox"
                checked={settings.privacy.telemetryEnabled}
                onChange={(e) => set({ privacy: { telemetryEnabled: e.target.checked } })}
              />
            </Row>
            <Row label="Crash reports" hint="Separate opt-in with redacted preview">
              <input
                type="checkbox"
                checked={settings.privacy.crashReportsEnabled}
                onChange={(e) => set({ privacy: { crashReportsEnabled: e.target.checked } })}
              />
            </Row>
            <div className="text-muted" style={{ padding: '10px 16px', fontSize: 12 }}>
              All code, tasks, timelines and diffs stay on this machine. Model requests go directly
              to your configured provider.
            </div>
          </>
        ) : null}

        {section === 'updates' ? (
          <>
            <Row label="Channel">
              <select
                value={settings.updates.channel}
                onChange={(e) => set({ updates: { channel: e.target.value } })}
              >
                <option value="stable">Stable</option>
                <option value="beta">Beta</option>
              </select>
            </Row>
            <Row label="Check automatically">
              <input
                type="checkbox"
                checked={settings.updates.autoCheck}
                onChange={(e) => set({ updates: { autoCheck: e.target.checked } })}
              />
            </Row>
          </>
        ) : null}

        {section === 'about' && appInfo ? (
          <div style={{ padding: 16, lineHeight: 2 }}>
            <div>
              <strong>Charter</strong> {appInfo.appVersion}
            </div>
            <div className="mono text-muted" style={{ fontSize: 12 }}>
              Electron {appInfo.electron} · Node {appInfo.node} · Chrome {appInfo.chrome}
              <br />
              Agent engine {appInfo.piSdkVersion ?? 'not installed'}
              <br />
              Commit {appInfo.commit ?? 'n/a'} · Channel {appInfo.updateChannel}
              <br />
              Data: {appInfo.userDataDir}
            </div>
            <div className="text-muted" style={{ fontSize: 12 }}>
              License: MIT. Third-party notices ship with the installer.
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
