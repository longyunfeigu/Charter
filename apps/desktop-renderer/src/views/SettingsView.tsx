import React, { useEffect, useState } from 'react';
import {
  PROVIDER_PRESETS,
  providerPreset,
  type CharterTerminalSurfaceDto,
  type ProviderInfoDto,
} from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useAppStore, type SettingsSection } from '../store/appStore.js';
import { useTaskStore } from '../store/taskStore.js';
import { Ic } from './home-icons.js';
import { SkillSourcesSettingsSection } from './SkillSourcesSettings.js';
import { SKIN_LABELS, type AppearanceSkin } from '../appearance.js';
import { ZOOM_STEPS, zoomPercentLabel } from './ui-zoom.js';
import '../styles/settings.css';

const API_LABEL: Record<string, string> = {
  anthropic: 'Claude API',
  openai: 'OpenAI API',
};

/** Multi-provider credentials + live model fetch (PIVOT-009/026/033). */
function ProvidersBlock(): React.JSX.Element {
  const pushToast = useAppStore((s) => s.pushToast);
  const [items, setItems] = useState<ProviderInfoDto[]>([]);
  const [choice, setChoice] = useState('anthropic'); // preset id or 'custom'
  const [customId, setCustomId] = useState('');
  const [customName, setCustomName] = useState('');
  const [customApi, setCustomApi] = useState<'anthropic' | 'openai'>('openai');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const preset = choice === 'custom' ? null : providerPreset(choice);
  const isCustom = choice === 'custom';

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
    const url = baseUrl.trim();
    if (url && !/^https?:\/\/\S+$/.test(url)) {
      pushToast('warning', 'Base URL must start with http:// or https://');
      return;
    }
    const providerId = isCustom ? customId.trim().toLowerCase().replace(/\s+/g, '-') : choice;
    if (isCustom && !/^[a-z0-9][a-z0-9-]{1,39}$/.test(providerId)) {
      pushToast('warning', 'Custom provider id: lowercase letters, digits and dashes.');
      return;
    }
    if (isCustom && !url) {
      pushToast('warning', 'Custom providers need a Base URL.');
      return;
    }
    if (preset?.baseUrlRequired && !url) {
      pushToast(
        'warning',
        `${preset.displayName} needs its Base URL (e.g. ${preset.placeholder}).`,
      );
      return;
    }
    setBusy('save');
    const res = await rpcResult('secrets.set', {
      providerId,
      apiKey: apiKey.trim(),
      ...(url ? { baseUrl: url } : {}),
      ...(isCustom
        ? { api: customApi, ...(customName.trim() ? { displayName: customName.trim() } : {}) }
        : { api: preset!.api, displayName: preset!.displayName }),
    });
    setBusy(null);
    setApiKey('');
    if (res.ok) {
      pushToast('success', `Credential stored for ${providerId}.`);
      setCustomId('');
      setCustomName('');
      setBaseUrl('');
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
    <div className="st-card">
      <div className="st-card-head">
        <Ic name="shield" size={14} />
        <div>
          <div className="st-card-title">Providers</div>
          <div className="st-card-sub">
            Keys live in the encrypted OS keychain scope — never in files, the renderer or logs.
          </div>
        </div>
      </div>

      <div className="st-provider-form">
        <select
          className="st-input"
          data-testid="provider-select"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          style={{ width: 130, flex: 'none' }}
        >
          {PROVIDER_PRESETS.map((p) => (
            <option key={p.providerId} value={p.providerId}>
              {p.displayName}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
        {isCustom ? (
          <>
            <input
              className="st-input mono"
              data-testid="provider-custom-id"
              placeholder="id (e.g. my-gateway)"
              value={customId}
              onChange={(e) => setCustomId(e.target.value)}
              style={{ width: 140, flex: 'none' }}
            />
            <select
              className="st-input"
              data-testid="provider-custom-api"
              value={customApi}
              onChange={(e) => setCustomApi(e.target.value as 'anthropic' | 'openai')}
              style={{ width: 170, flex: 'none' }}
              title="Wire protocol the endpoint speaks"
            >
              <option value="openai">OpenAI-compatible</option>
              <option value="anthropic">Anthropic-compatible</option>
            </select>
          </>
        ) : null}
        <input
          className="st-input"
          data-testid="provider-key-input"
          type="password"
          placeholder="API key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          style={{ flex: 1, minWidth: 160 }}
        />
        <input
          className="st-input mono"
          data-testid="provider-baseurl-input"
          placeholder={
            isCustom
              ? 'Base URL (required) — e.g. http://gateway:4000/v1'
              : `Base URL — ${preset?.placeholder ?? ''}`
          }
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          style={{ flex: 1.2, minWidth: 200 }}
        />
        <button
          className="btn primary"
          data-testid="provider-key-save"
          disabled={!apiKey.trim() || busy === 'save'}
          onClick={() => void save()}
        >
          Save
        </button>
      </div>
      {isCustom ? (
        <div className="st-provider-form" style={{ marginTop: 6 }}>
          <input
            className="st-input"
            data-testid="provider-custom-name"
            placeholder="Display name (optional — e.g. Team Gateway)"
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            style={{ flex: 1 }}
          />
        </div>
      ) : null}
      <div className="st-hint">
        {isCustom
          ? 'Any Anthropic- or OpenAI-compatible endpoint works — LiteLLM, vLLM, Ollama, team gateways. OpenAI-compatible base URLs include /v1.'
          : preset?.baseUrlRequired
            ? `${preset.displayName} is self-hosted — point the Base URL at your instance.`
            : 'Leave the Base URL empty for the official API, or point it at a compatible gateway/proxy.'}
      </div>

      {items.length === 0 ? (
        <div className="st-empty" data-testid="providers-empty">
          No provider credentials yet. Add a key above, then fetch its live model list.
        </div>
      ) : (
        items.map((item) => (
          <div
            key={item.providerId}
            className="st-provider-row"
            data-testid={`provider-row-${item.providerId}`}
          >
            <span className="st-provider-name" title={item.providerId}>
              {item.displayName}
            </span>
            <span className="st-provider-api" data-testid={`provider-api-${item.providerId}`}>
              {API_LABEL[item.api] ?? item.api}
            </span>
            <span className="mono st-provider-hint">{item.hint}</span>
            {(() => {
              // Presets with a default endpoint (OpenRouter) show it even when
              // the user left the field empty — that IS where requests go.
              const effective =
                item.baseUrl ?? providerPreset(item.providerId)?.defaultBaseUrl ?? null;
              return effective ? (
                <span
                  className="mono st-provider-url"
                  data-testid={`provider-baseurl-${item.providerId}`}
                  title={effective}
                >
                  {effective}
                  {item.baseUrl === null ? ' (default)' : ''}
                </span>
              ) : (
                <span className="st-provider-url official">official API</span>
              );
            })()}
            <button
              className="btn"
              data-testid={`provider-fetch-${item.providerId}`}
              disabled={busy === `fetch-${item.providerId}`}
              onClick={() => void fetchModels(item.providerId)}
              title="Pull the live model list from this endpoint"
            >
              {busy === `fetch-${item.providerId}` ? 'Fetching…' : 'Fetch models'}
            </button>
            <button
              className="btn quiet-danger"
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

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: string }> = [
  { id: 'general', label: 'General', icon: 'sliders' },
  { id: 'editor', label: 'Editor', icon: 'pencil' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'agent', label: 'Agent', icon: 'bot' },
  { id: 'skills', label: 'Skill Sources', icon: 'folder' },
  { id: 'models', label: 'Models', icon: 'provider' },
  { id: 'permissions', label: 'Permissions', icon: 'shield' },
  { id: 'privacy', label: 'Privacy', icon: 'eye' },
  { id: 'updates', label: 'Updates', icon: 'refresh' },
  { id: 'about', label: 'About', icon: 'info' },
];

/** ADR-0045: one click installs the orchestration manual into Charter's
 * managed store plus ~/.claude/skills and ~/.codex/skills, with a
 * FanBox-style byte comparison so a revised manual surfaces as an update. */
function CharterTerminalManualRow(): React.JSX.Element {
  const pushToast = useAppStore((s) => s.pushToast);
  const [surfaces, setSurfaces] = useState<CharterTerminalSurfaceDto[] | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void rpcResult('skills.charterTerminalStatus', {}).then((result) => {
      if (result.ok) setSurfaces(result.data.surfaces);
      else setStatusError(result.error.userMessage);
    });
  }, []);

  const stateLabel = (surface: CharterTerminalSurfaceDto): string => {
    if (surface.error) return `error: ${surface.error}`;
    if (!surface.installed) return 'not installed';
    return surface.upToDate ? 'up to date' : 'update available';
  };
  const allCurrent =
    surfaces !== null && surfaces.every((surface) => surface.installed && surface.upToDate);

  return (
    <Row
      label="External CLI instructions"
      hint="Installs the charter-terminal manual into Charter's Skills store plus ~/.claude/skills and ~/.codex/skills, so hand-launched claude/codex sessions can trigger orchestration"
    >
      <span className="st-provider-form" style={{ padding: 0 }}>
        {statusError ? <span className="st-hint">{statusError}</span> : null}
        {surfaces === null && !statusError ? <span className="st-hint">Checking…</span> : null}
        {surfaces?.map((surface) => (
          <span
            key={surface.target}
            className="st-hint"
            style={{ padding: 0 }}
            data-testid={`charter-terminal-surface-${surface.target}`}
          >
            {surface.target}: {stateLabel(surface)}
          </span>
        ))}
        <button
          className="btn"
          data-testid="settings-install-charter-terminal"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void rpcResult('skills.installCharterTerminal', {}).then((result) => {
              setBusy(false);
              if (!result.ok) {
                pushToast('error', result.error.userMessage);
                return;
              }
              setSurfaces(result.data.surfaces);
              const failed = result.data.surfaces.filter((surface) => surface.error);
              pushToast(
                failed.length > 0 ? 'error' : 'success',
                failed.length > 0
                  ? `Some surfaces failed: ${failed.map((surface) => surface.target).join(', ')}`
                  : 'charter-terminal manual installed for Charter, claude, and codex.',
              );
            });
          }}
        >
          {busy ? 'Installing…' : allCurrent ? 'Reinstall' : 'Install / update'}
        </button>
      </span>
    </Row>
  );
}

function Row(props: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="st-row">
      <span className="st-row-label">
        {props.label}
        {props.hint ? <span className="st-row-hint">{props.hint}</span> : null}
      </span>
      <span className="st-row-control">{props.children}</span>
    </label>
  );
}

/** iOS-style switch on top of a real checkbox (keyboard/AT semantics intact). */
function Toggle(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  testid?: string;
}): React.JSX.Element {
  return (
    <span className={`st-toggle ${props.checked ? 'on' : ''}`}>
      <input
        type="checkbox"
        {...(props.testid ? { 'data-testid': props.testid } : {})}
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <i />
    </span>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const ANALYTICS_SENT = [
  'Event name (e.g. task_completed, review_opened)',
  'App version / OS version / UI language',
  'Coarse durations and counts (task-length buckets, event magnitudes)',
  'A random install id (not linked to any account)',
];
const ANALYTICS_NEVER = [
  'Code, prompts, diffs, terminal output',
  'File paths, project names, repository URLs',
  'API keys, provider config, model responses',
];

/** PRIV-001..003: honest local-data controls (no upload transport in this build). */
function PrivacySection(props: {
  telemetryEnabled: boolean;
  crashReportsEnabled: boolean;
  set: (patch: Record<string, unknown>) => void;
}): React.JSX.Element {
  const pushToast = useAppStore((s) => s.pushToast);
  const [summary, setSummary] = useState<{
    dataDir: string;
    totalBytes: number;
    history: number;
    attachments: number;
    logs: number;
    logRetentionDays: number;
    taskCount: number;
  } | null>(null);
  const [modal, setModal] = useState<'none' | 'fields' | 'crash' | 'delete'>('none');
  const [crashText, setCrashText] = useState('');
  const [transportAvailable, setTransportAvailable] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const loadSummary = async (): Promise<void> => {
    const res = await rpcResult('privacy.dataSummary', {});
    if (res.ok) setSummary(res.data);
  };
  useEffect(() => {
    void loadSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openCrash = async (): Promise<void> => {
    const res = await rpcResult('privacy.crashPreview', {});
    if (res.ok) {
      setCrashText(res.data.text);
      setTransportAvailable(res.data.transportAvailable);
    }
    setModal('crash');
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    const res = await rpcResult('privacy.clearHistory', {});
    setDeleteArmed(false);
    setModal('none');
    if (res.ok) {
      pushToast(
        'success',
        `Deleted ${res.data.clearedTasks} task${res.data.clearedTasks === 1 ? '' : 's'}, ${res.data.clearedLogFiles} log file(s) and ${res.data.clearedAttachmentDirs} attachment folder(s).`,
      );
      await loadSummary();
    } else {
      pushToast('error', res.error.userMessage);
    }
  };

  const closeModal = (): void => {
    setDeleteArmed(false);
    setModal('none');
  };

  return (
    <div className="st-card" data-testid="privacy-section">
      <div className="st-card-head">
        <Ic name="eye" size={14} />
        <div>
          <div className="st-card-title">Telemetry & reporting</div>
          <div className="st-card-sub">
            This build ships no telemetry or crash-report transport — nothing is ever sent. The
            switches record your preference for a future networked build.
          </div>
        </div>
      </div>

      <Row label="Product analytics" hint="Default off. Never includes code, prompts or paths.">
        <span className="st-privacy-controls">
          <button
            type="button"
            className="btn ghost"
            data-testid="privacy-view-fields"
            onClick={() => setModal('fields')}
          >
            View fields
          </button>
          <Toggle
            testid="privacy-analytics"
            checked={props.telemetryEnabled}
            onChange={(v) => {
              if (v) setModal('fields');
              else props.set({ privacy: { telemetryEnabled: false } });
            }}
          />
        </span>
      </Row>

      <Row
        label="Crash reports"
        hint="Separate opt-in. Each report is redacted; preview before enabling."
      >
        <span className="st-privacy-controls">
          <button
            type="button"
            className="btn ghost"
            data-testid="privacy-crash-preview"
            onClick={() => void openCrash()}
          >
            Preview
          </button>
          <Toggle
            testid="privacy-crash"
            checked={props.crashReportsEnabled}
            onChange={(v) => {
              if (v) void openCrash();
              else props.set({ privacy: { crashReportsEnabled: false } });
            }}
          />
        </span>
      </Row>

      <div className="st-card-head" style={{ marginTop: 18 }}>
        <Ic name="folder" size={14} />
        <div>
          <div className="st-card-title">Local data</div>
          <div className="st-card-sub">
            All code, tasks, timelines and diffs stay on this machine. Model requests go directly to
            your configured provider.
          </div>
        </div>
      </div>

      {summary ? (
        <div className="st-privacy-data" data-testid="privacy-data">
          <div className="st-kv">
            <span className="k">Location</span>
            <span className="v mono" data-testid="privacy-data-dir">
              {summary.dataDir}
            </span>
          </div>
          <div className="st-kv">
            <span className="k">Retention</span>
            <span className="v">
              Logs roll off after {summary.logRetentionDays} days; task history and attachments are
              kept until you delete them.
            </span>
          </div>
          <div className="st-privacy-usage">
            <b>
              {summary.taskCount} task{summary.taskCount === 1 ? '' : 's'} ·{' '}
              {formatBytes(summary.totalBytes)}
            </b>
            <div className="st-usage-legend">
              <span>History {formatBytes(summary.history)}</span>
              <span>Attachments {formatBytes(summary.attachments)}</span>
              <span>Logs {formatBytes(summary.logs)}</span>
            </div>
          </div>
          <Row
            label="Delete history & cache"
            hint="Removes every task, timeline, replay and attachment. Settings and API keys are kept."
          >
            <button
              type="button"
              className="btn danger"
              data-testid="privacy-delete"
              onClick={() => setModal('delete')}
            >
              Delete history & cache…
            </button>
          </Row>
        </div>
      ) : (
        <div className="st-hint">Reading local data…</div>
      )}

      {modal === 'fields' ? (
        <PrivacyModal
          title="Before enabling analytics, this is everything that would be sent"
          onClose={closeModal}
        >
          <div className="st-fields">
            <div className="send">
              <div className="fh">Would send</div>
              <ul>
                {ANALYTICS_SENT.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
            <div className="never">
              <div className="fh">Never sent</div>
              <ul>
                {ANALYTICS_NEVER.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          </div>
          <p className="st-modal-note">
            This build has no analytics endpoint — enabling records your preference only.
          </p>
          <div className="st-modal-actions">
            <button type="button" className="btn" onClick={closeModal}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              data-testid="privacy-fields-confirm"
              onClick={() => {
                props.set({ privacy: { telemetryEnabled: true } });
                closeModal();
              }}
            >
              Enable analytics
            </button>
          </div>
        </PrivacyModal>
      ) : null}

      {modal === 'crash' ? (
        <PrivacyModal title="Crash report — redacted preview" onClose={closeModal}>
          <pre className="st-crash-pre" data-testid="privacy-crash-text">
            {crashText}
          </pre>
          <p className="st-modal-note">
            {transportAvailable
              ? 'Reports are redacted with the same rules as the support bundle before sending.'
              : 'This build has no crash-report upload; enabling records your preference. The redaction shown above is real.'}
          </p>
          <div className="st-modal-actions">
            <button type="button" className="btn" onClick={closeModal}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              data-testid="privacy-crash-confirm"
              onClick={() => {
                props.set({ privacy: { crashReportsEnabled: true } });
                closeModal();
              }}
            >
              Enable crash reports
            </button>
          </div>
        </PrivacyModal>
      ) : null}

      {modal === 'delete' ? (
        <PrivacyModal title="Delete history & cache?" onClose={closeModal}>
          <p className="st-modal-note">
            This is immediate and cannot be undone. Every task, timeline, replay and attachment is
            removed. Settings, provider keys, skins and layout are kept.
          </p>
          <div className="st-modal-actions">
            <button type="button" className="btn" onClick={closeModal}>
              Cancel
            </button>
            <button
              type="button"
              className={`btn danger ${deleteArmed ? 'confirming' : ''}`}
              data-testid="privacy-delete-confirm"
              onClick={() => void confirmDelete()}
            >
              {deleteArmed ? 'Click again to delete' : 'Delete history & cache'}
            </button>
          </div>
        </PrivacyModal>
      ) : null}
    </div>
  );
}

function PrivacyModal(props: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className="st-modal-veil"
      data-testid="privacy-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="st-modal" role="dialog" aria-modal="true" aria-label={props.title}>
        <h3>{props.title}</h3>
        {props.children}
      </div>
    </div>
  );
}

const APPEARANCE_SKINS: AppearanceSkin[] = ['studio', 'terminal', 'archive', 'index'];

function SkinPicker(props: {
  value: AppearanceSkin;
  onChange: (skin: AppearanceSkin) => void;
}): React.JSX.Element {
  return (
    <div className="st-skin-block">
      <div className="st-skin-heading">
        <span>Skin</span>
        <small>Color · type · icons · code</small>
      </div>
      <div className="st-skin-grid" role="radiogroup" aria-label="Application skin">
        {APPEARANCE_SKINS.map((skin) => {
          const meta = SKIN_LABELS[skin];
          const selected = skin === props.value;
          return (
            <button
              key={skin}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`st-skin-option ${selected ? 'selected' : ''}`}
              data-testid={`settings-skin-${skin}`}
              onClick={() => props.onChange(skin)}
            >
              <span
                className="st-skin-preview"
                data-skin={skin}
                data-theme={skin === 'terminal' ? 'dark' : 'light'}
                aria-hidden
              >
                <span className="st-skin-preview-side">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="st-skin-preview-code">
                  <i className="kw" />
                  <i className="tx" />
                  <i className="str" />
                  <i className="tx short" />
                </span>
              </span>
              <span className="st-skin-name">
                {meta.name}
                <Ic name={selected ? 'checkCircle' : 'circle'} size={14} />
              </span>
              <span className="st-skin-description">{meta.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function SettingsView(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings);
  const issues = useAppStore((s) => s.settingsIssues);
  const appInfo = useAppStore((s) => s.appInfo);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const requestedSection = useAppStore((s) => s.settingsSection);
  const [section, setSection] = useState<SettingsSection>(requestedSection);

  useEffect(() => setSection(requestedSection), [requestedSection]);

  if (!settings) return <div className="empty-state">Loading settings…</div>;

  const set = (patch: Record<string, unknown>) => void updateSettings('global', patch);

  return (
    <div className="st-root">
      <nav aria-label="Settings sections" className="st-nav">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`st-nav-item ${s.id === section ? 'active' : ''}`}
            data-testid={`settings-section-${s.id}`}
            aria-current={s.id === section ? 'page' : undefined}
            onClick={() => setSection(s.id)}
          >
            <Ic name={s.icon} size={14} />
            {s.label}
          </button>
        ))}
      </nav>
      <div className="st-body">
        {issues.length > 0 ? (
          <div className="st-issues">
            {issues.length} setting value(s) were invalid and fell back to defaults.
          </div>
        ) : null}

        {section === 'general' ? (
          <div className="st-card">
            <SkinPicker
              value={settings.general.skin}
              onChange={(skin) => set({ general: { skin } })}
            />
            <Row label="Brightness" hint="Each skin includes a coordinated light and dark variant">
              <select
                className="st-input"
                value={settings.general.theme}
                onChange={(e) => set({ general: { theme: e.target.value } })}
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </Row>
            <Row label="UI zoom" hint="Whole window, editor and terminal included · ⌘+ / ⌘− / ⌘0">
              <div
                className="st-zoom-seg"
                role="radiogroup"
                aria-label="UI zoom"
                data-testid="settings-zoom"
              >
                {ZOOM_STEPS.map((z) => {
                  const active = Math.abs(settings.general.uiScale - z) < 0.001;
                  return (
                    <button
                      key={z}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`st-zoom-step${active ? ' on' : ''}`}
                      data-testid={`settings-zoom-${Math.round(z * 100)}`}
                      onClick={() => set({ general: { uiScale: z } })}
                    >
                      {zoomPercentLabel(z).replace('%', '')}
                    </button>
                  );
                })}
              </div>
            </Row>
            <Row
              label="Rich Markdown by default"
              hint="Open .md files in the Notion-style editor (toggle per file on the tab)"
            >
              <Toggle
                testid="settings-md-rich"
                checked={settings.editor.markdownRichDefault}
                onChange={(v) => set({ editor: { markdownRichDefault: v } })}
              />
            </Row>
            <Row
              label="System notifications"
              hint="Plan approval · permission · review ready · failed (silent while focused)"
            >
              <Toggle
                testid="settings-notifications"
                checked={settings.notifications.enabled}
                onChange={(v) => set({ notifications: { enabled: v } })}
              />
            </Row>
            <Row
              label="Preview console → agent"
              hint="Auto: errors landing right after the agent's own write are steered back (deduped, rate-limited). Manual: collect + one-click send. Off: count only."
            >
              <select
                className="st-input"
                data-testid="settings-preview-console"
                value={settings.preview.consoleToAgent}
                onChange={(e) => set({ preview: { consoleToAgent: e.target.value } })}
              >
                <option value="auto">Auto (self-heal)</option>
                <option value="manual">Manual</option>
                <option value="off">Off</option>
              </select>
            </Row>
          </div>
        ) : null}

        {section === 'editor' ? (
          <div className="st-card">
            <Row label="Font size">
              <input
                className="st-input"
                type="number"
                min={8}
                max={40}
                value={settings.editor.fontSize}
                onChange={(e) => set({ editor: { fontSize: Number(e.target.value) } })}
              />
            </Row>
            <Row label="Font family">
              <input
                className="st-input wide"
                value={settings.editor.fontFamily}
                onChange={(e) => set({ editor: { fontFamily: e.target.value } })}
              />
            </Row>
            <Row label="Tab size">
              <input
                className="st-input"
                type="number"
                min={1}
                max={8}
                value={settings.editor.tabSize}
                onChange={(e) => set({ editor: { tabSize: Number(e.target.value) } })}
              />
            </Row>
            <Row label="Word wrap">
              <select
                className="st-input"
                value={settings.editor.wordWrap}
                onChange={(e) => set({ editor: { wordWrap: e.target.value } })}
              >
                <option value="off">Off</option>
                <option value="on">On</option>
              </select>
            </Row>
            <Row label="Minimap">
              <Toggle
                checked={settings.editor.minimap}
                onChange={(v) => set({ editor: { minimap: v } })}
              />
            </Row>
            <Row label="Auto save">
              <select
                className="st-input"
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
                className="st-input"
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
                className="st-input"
                type="number"
                min={1}
                max={512}
                value={settings.editor.largeFileSizeMb}
                onChange={(e) => set({ editor: { largeFileSizeMb: Number(e.target.value) } })}
              />
            </Row>
          </div>
        ) : null}

        {section === 'terminal' ? (
          <div className="st-card">
            <Row label="Font size">
              <input
                className="st-input"
                type="number"
                min={8}
                max={32}
                value={settings.terminal.fontSize}
                onChange={(e) => set({ terminal: { fontSize: Number(e.target.value) } })}
              />
            </Row>
            <Row label="Shell path" hint="Empty = system default shell">
              <input
                className="st-input wide mono"
                placeholder="/bin/zsh"
                value={settings.terminal.shellPath ?? ''}
                onChange={(e) => set({ terminal: { shellPath: e.target.value || null } })}
              />
            </Row>
            <Row label="Scrollback lines">
              <input
                className="st-input"
                type="number"
                min={100}
                max={200000}
                value={settings.terminal.scrollback}
                onChange={(e) => set({ terminal: { scrollback: Number(e.target.value) } })}
              />
            </Row>
            <Row
              label="Terminal renderer"
              hint="Auto uses GPU acceleration when available and falls back safely after setup or context loss"
            >
              <select
                className="st-input wide"
                data-testid="settings-terminal-renderer"
                value={settings.terminal.renderer}
                onChange={(e) => set({ terminal: { renderer: e.target.value } })}
              >
                <option value="auto">Auto · WebGL with fallback</option>
                <option value="software">Software compatibility</option>
              </select>
            </Row>
            <Row
              label="Terminal character widths"
              hint="Unicode 11 improves CJK and emoji alignment; use Unicode 6 for older TUIs with different wcwidth tables"
            >
              <select
                className="st-input wide"
                data-testid="settings-terminal-unicode"
                value={settings.terminal.unicodeVersion}
                onChange={(e) => set({ terminal: { unicodeVersion: e.target.value } })}
              >
                <option value="11">Unicode 11 · recommended</option>
                <option value="6">Unicode 6 · compatibility</option>
              </select>
            </Row>
            <Row
              label="Auto-move external agent sessions to the side panel"
              hint="Off = a detected claude/codex session only decorates its terminal in place; moving it is your click"
            >
              <Toggle
                checked={settings.terminal.autoPromoteExternal}
                onChange={(v) => set({ terminal: { autoPromoteExternal: v } })}
              />
            </Row>
            <Row
              label="Shell integration (command blocks)"
              hint="Injects OSC 133 marks into zsh/bash/fish: block jumps, marker rail, sourced progress, finish notifications. Off or an unknown shell = plain scrollback, nothing breaks"
            >
              <Toggle
                checked={settings.terminal.shellIntegration}
                onChange={(v) => set({ terminal: { shellIntegration: v } })}
              />
            </Row>
            <Row
              label="Notify when a long command finishes (seconds)"
              hint="Unfocused only, one notification per command; its click lands on the command's block"
            >
              <input
                className="st-input"
                type="number"
                min={5}
                max={600}
                value={settings.terminal.longCommandSeconds}
                onChange={(e) => set({ terminal: { longCommandSeconds: Number(e.target.value) } })}
              />
            </Row>
          </div>
        ) : null}

        {section === 'agent' ? (
          <>
            <div className="st-card">
              <Row label="Default mode">
                <select
                  className="st-input"
                  value={settings.agent.defaultMode}
                  onChange={(e) => set({ agent: { defaultMode: e.target.value } })}
                >
                  <option value="ask">Read-only</option>
                  <option value="edit">Approve changes</option>
                  <option value="auto">Auto · pause on risk</option>
                </select>
              </Row>
              <Row
                label="Auto mode: auto-approve workspace edits (R1)"
                hint="Off = Auto only auto-approves read-only tools"
              >
                <Toggle
                  checked={settings.agent.autoApproveR1}
                  onChange={(v) => set({ agent: { autoApproveR1: v } })}
                />
              </Row>
              <Row
                label="Auto mode: auto-approve recognized verification commands (R2)"
                hint="npm test / lint / typecheck detected from the project"
              >
                <Toggle
                  checked={settings.agent.autoApproveKnownR2}
                  onChange={(v) => set({ agent: { autoApproveKnownR2: v } })}
                />
              </Row>
              <Row
                label="Show model thinking"
                hint="Streams the model's reasoning, collapsed in the timeline — never treated as evidence"
              >
                <Toggle
                  checked={settings.agent.showThinking}
                  onChange={(v) => set({ agent: { showThinking: v } })}
                />
              </Row>
            </div>
            <div className="st-card">
              <div className="st-card-head">
                <Ic name="terminal" size={14} />
                <div>
                  <div className="st-card-title">Session orchestration</div>
                  <div className="st-card-sub">
                    One agent can direct visible Claude, Codex, or shell workers.
                  </div>
                </div>
              </div>
              <Row
                label="会话编排"
                hint="Master switch: off unregisters terminal.* tools, removes ctl.sock, and hides every orchestration surface"
              >
                <Toggle
                  testid="settings-orchestration"
                  checked={settings.orchestration.enabled}
                  onChange={(v) => set({ orchestration: { enabled: v } })}
                />
              </Row>
              <Row label="Maximum live workers per session">
                <input
                  className="st-input"
                  type="number"
                  min={1}
                  max={12}
                  value={settings.orchestration.maxWorkers}
                  onChange={(e) => set({ orchestration: { maxWorkers: Number(e.target.value) } })}
                />
              </Row>
              <Row label="Maximum sends per minute">
                <input
                  className="st-input"
                  type="number"
                  min={1}
                  max={120}
                  value={settings.orchestration.maxSendsPerMinute}
                  onChange={(e) =>
                    set({ orchestration: { maxSendsPerMinute: Number(e.target.value) } })
                  }
                />
              </Row>
              <CharterTerminalManualRow />
            </div>
            <div className="st-card">
              <Row
                label="Capture review corrections as rule candidates"
                hint="Request-fix notes and plan pushback offer a distill card (ADR-0028); nothing is captured when off"
              >
                <Toggle
                  checked={settings.memory.captureEnabled}
                  onChange={(v) => set({ memory: { captureEnabled: v } })}
                />
              </Row>
              <Row
                label="Project rules & agent memories"
                hint="Shared rules, CLAUDE.md / AGENTS.md sync and private CLI memory live in Memory"
              >
                <button
                  className="btn"
                  data-testid="settings-open-memory"
                  onClick={() => useAppStore.getState().setOverlay('memory')}
                >
                  Open Memory
                </button>
              </Row>
              <Row label="Skills" hint="Usage and cross-Agent cleanup live on the main Skills page">
                <button
                  className="btn"
                  data-testid="settings-open-skills"
                  onClick={() => {
                    useAppStore.getState().setOverlay('none');
                    useAppStore.getState().setRailView('skills');
                  }}
                >
                  Open Skills
                </button>
              </Row>
            </div>
          </>
        ) : null}

        {section === 'skills' ? <SkillSourcesSettingsSection /> : null}

        {section === 'models' ? (
          <>
            <div className="st-card">
              <Row label="Default thinking level">
                <select
                  className="st-input"
                  value={settings.models.defaultThinkingLevel}
                  onChange={(e) => set({ models: { defaultThinkingLevel: e.target.value } })}
                >
                  {['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Deterministic mock runtime" hint="For demos/tests without a provider">
                <Toggle
                  checked={settings.models.useMockRuntime}
                  onChange={(v) => set({ models: { useMockRuntime: v } })}
                />
              </Row>
            </div>
            <ProvidersBlock />
          </>
        ) : null}

        {section === 'permissions' ? (
          <div className="st-card st-prose">
            <div className="st-card-title" style={{ marginBottom: 8 }}>
              Risk policy defaults (spec §10.2)
            </div>
            <ul>
              <li>
                <b>R0</b> read-only — allowed automatically in every mode.
              </li>
              <li>
                <b>R1</b> reversible workspace writes — Edit asks / plan approval; Auto per setting.
              </li>
              <li>
                <b>R2</b> local execution — recognized verification commands may run; unknown ask.
              </li>
              <li>
                <b>R3</b> external / hard-to-reverse — always asks, never permanently allowed.
              </li>
              <li>
                <b>R4</b> forbidden — sudo, git push, writes outside the workspace: always blocked.
              </li>
            </ul>
            <p className="st-hint">
              Per-workspace grants appear here once made from permission cards.
            </p>
          </div>
        ) : null}

        {section === 'privacy' ? (
          <PrivacySection
            telemetryEnabled={settings.privacy.telemetryEnabled}
            crashReportsEnabled={settings.privacy.crashReportsEnabled}
            set={set}
          />
        ) : null}

        {section === 'updates' ? (
          <div className="st-card">
            <Row label="Channel">
              <select
                className="st-input"
                value={settings.updates.channel}
                onChange={(e) => set({ updates: { channel: e.target.value } })}
              >
                <option value="stable">Stable</option>
                <option value="beta">Beta</option>
              </select>
            </Row>
            <Row label="Check automatically">
              <Toggle
                checked={settings.updates.autoCheck}
                onChange={(v) => set({ updates: { autoCheck: v } })}
              />
            </Row>
          </div>
        ) : null}

        {section === 'about' && appInfo ? (
          <div className="st-card st-prose">
            <div className="st-about-name">
              <Ic name="flag" size={18} />
              <b>Charter</b> <span className="text-muted">{appInfo.appVersion}</span>
            </div>
            <div className="mono st-about-meta">
              Electron {appInfo.electron} · Node {appInfo.node} · Chrome {appInfo.chrome}
              <br />
              Agent engine {appInfo.piSdkVersion ?? 'not installed'}
              <br />
              Commit {appInfo.commit ?? 'n/a'} · Channel {appInfo.updateChannel}
              <br />
              Data: {appInfo.userDataDir}
            </div>
            <p className="st-hint">
              Local-first: your code and tasks stay on this machine. License: MIT.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
