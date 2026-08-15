import React, { useEffect, useRef, useState } from 'react';
import {
  PROVIDER_PRESETS,
  providerPreset,
  type CharterTerminalSurfaceDto,
  type GithubAuthStatusDto,
  type ProviderInfoDto,
} from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useAppStore, type SettingsSection } from '../store/appStore.js';
import { useTaskStore } from '../store/taskStore.js';
import { useAgentCatalogStore } from '../store/agentCatalogStore.js';
import { Ic } from './home-icons.js';
import { MemoryView } from './MemoryView.js';
import { SkillsView } from './SkillsView.js';
import { SkillSourcesSettingsSection } from './SkillSourcesSettings.js';
import { AgentVerificationCenter } from './AgentVerificationCenter.js';
import { SKIN_LABELS, type AppearanceSkin } from '../appearance.js';
import { ZOOM_STEPS, zoomPercentLabel } from './ui-zoom.js';
import { t } from '../i18n.js';
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
      const available = res.data.models.length;
      const unavailable = res.data.unavailableModelIds.length;
      if (res.data.candidateCount === 0) {
        pushToast('warning', `No model candidates were found for ${id}.`);
      } else if (available === 0) {
        pushToast(
          'warning',
          `0/${res.data.candidateCount} models verified for ${id}; none are currently available.`,
        );
      } else {
        const routeSummary =
          res.data.routeCount > 1 ? ` across ${res.data.routeCount} protocol routes` : '';
        const failedSummary =
          res.data.failedRouteIds.length > 0
            ? `; ${res.data.failedRouteIds.length} route unavailable`
            : '';
        pushToast(
          'success',
          `${available}/${res.data.candidateCount} models verified for ${id}${routeSummary} (${res.data.advertisedCount} advertised, ${res.data.registryCandidateCount} Pi registry candidates${unavailable > 0 ? `; ${unavailable} unavailable` : ''}${failedSummary}).`,
        );
      }
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
            Keys live in the encrypted OS keychain scope. Fetch &amp; verify sends one minimal
            request per unique provider/registry candidate across compatible protocol routes; only
            models that respond appear in Charter.
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
              title="Fetch provider and Pi registry candidates across compatible Anthropic/OpenAI routes, then show only verified models"
            >
              {busy === `fetch-${item.providerId}` ? 'Verifying…' : 'Fetch & verify'}
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

function AgentAdaptersBlock(): React.JSX.Element {
  const init = useAgentCatalogStore((state) => state.init);
  const refresh = useAgentCatalogStore((state) => state.refresh);
  const agents = useAgentCatalogStore((state) => state.agents);
  const loading = useAgentCatalogStore((state) => state.loading);
  const error = useAgentCatalogStore((state) => state.error);
  const engineVersion = useAgentCatalogStore((state) => state.engineVersion);
  const overrideEnabled = useAgentCatalogStore((state) => state.overrideEnabled);
  const diagnostics = useAgentCatalogStore((state) => state.diagnostics);
  const packs = useAgentCatalogStore((state) => state.packs);
  const packBusy = useAgentCatalogStore((state) => state.packBusy);
  const installPack = useAgentCatalogStore((state) => state.installPack);
  const setPackEnabled = useAgentCatalogStore((state) => state.setPackEnabled);
  const rollbackPack = useAgentCatalogStore((state) => state.rollbackPack);
  const removePack = useAgentCatalogStore((state) => state.removePack);

  useEffect(() => init(), [init]);

  return (
    <div className="st-card st-adapters" data-testid="agent-adapters">
      <div className="st-card-head">
        <Ic name="bot" size={14} />
        <div>
          <div className="st-card-title">Agent Adapters</div>
          <div className="st-card-sub">
            Engine {engineVersion} · strict capability, launch, session and lifecycle contracts ·
            local override {overrideEnabled ? 'enabled' : 'disabled'}
          </div>
        </div>
        <span className="st-sp" />
        <button className="btn" disabled={loading} onClick={() => void refresh(true)}>
          {loading ? 'Scanning…' : 'Rescan'}
        </button>
        <button
          className="btn"
          data-testid="agent-pack-install"
          disabled={packBusy !== null}
          onClick={() => void installPack()}
        >
          {packBusy === 'install' ? 'Installing…' : 'Install Pack…'}
        </button>
      </div>
      {error ? <div className="st-adapter-diagnostic error">{error}</div> : null}
      <div className="st-pack-list" data-testid="agent-pack-list">
        {packs.length === 0 ? (
          <div className="st-pack-empty">
            No Agent Packs available. Packs are declarative JSON and cannot run extension code.
          </div>
        ) : (
          packs.map((pack) => (
            <div className="st-pack" data-testid={`agent-pack-${pack.id}`} key={pack.id}>
              <div className="st-pack-main">
                <div>
                  <b>{pack.displayName}</b>
                  <span className={`st-adapter-state ${pack.enabled ? 'ready' : ''}`}>
                    {pack.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  <span className={`st-pack-trust ${pack.trust}`}>{pack.trust}</span>
                  {pack.bundled ? <span className="st-pack-trust verified">official</span> : null}
                </div>
                <div className="st-adapter-meta mono">
                  {pack.publisher} · v{pack.currentVersion} · {pack.adapterIds.join(', ')}
                </div>
                <div className="st-adapter-path mono">{pack.sourcePath}</div>
              </div>
              <div className="st-pack-actions">
                <button
                  className="btn"
                  disabled={packBusy !== null}
                  data-testid={`agent-pack-toggle-${pack.id}`}
                  onClick={() => void setPackEnabled(pack.id, !pack.enabled)}
                >
                  {pack.enabled ? 'Disable' : 'Enable'}
                </button>
                {!pack.bundled ? (
                  <>
                    <button
                      className="btn"
                      disabled={packBusy !== null || !pack.previousVersion}
                      data-testid={`agent-pack-rollback-${pack.id}`}
                      title={
                        pack.previousVersion
                          ? `Switch to stored version ${pack.previousVersion}`
                          : 'No previous version is stored'
                      }
                      onClick={() => void rollbackPack(pack.id)}
                    >
                      Roll back
                    </button>
                    <button
                      className="btn quiet-danger"
                      disabled={packBusy !== null}
                      data-testid={`agent-pack-remove-${pack.id}`}
                      onClick={() => {
                        if (window.confirm(`Remove ${pack.displayName} and its stored versions?`)) {
                          void removePack(pack.id);
                        }
                      }}
                    >
                      Remove
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
      <AgentVerificationCenter />
      {diagnostics.map((diagnostic, index) => (
        <div
          className={`st-adapter-diagnostic ${diagnostic.severity}`}
          data-testid="agent-adapter-diagnostic"
          key={`${diagnostic.sourcePath}:${diagnostic.code}:${index}`}
        >
          <b>{diagnostic.code}</b> · {diagnostic.message}
          <span className="mono">{diagnostic.sourcePath}</span>
        </div>
      ))}
      <div className="st-adapter-list">
        {agents.map((agent) => {
          const capabilityLabels = [
            agent.capabilities.terminal && 'Terminal',
            agent.capabilities.acp && 'ACP',
            agent.capabilities.images && 'Images',
            agent.capabilities.exactResume && 'Exact resume',
            agent.capabilities.history && 'History',
            agent.capabilities.skills && 'Skills',
            agent.capabilities.instructions && 'Instructions',
            agent.capabilities.remote && 'SSH',
            agent.capabilities.lifecycle === 'observed' && 'Observed lifecycle',
            agent.capabilities.lifecycle === 'structured' && 'Structured lifecycle',
          ].filter((value): value is string => Boolean(value));
          return (
            <div className="st-adapter" data-testid={`agent-adapter-${agent.id}`} key={agent.id}>
              <div className="st-adapter-main">
                <div>
                  <b>{agent.displayName}</b>
                  <span className={`st-adapter-state ${agent.installed ? 'ready' : ''}`}>
                    {agent.installed ? 'Installed' : 'Not installed locally'}
                  </span>
                </div>
                <div className="st-adapter-meta mono">
                  Adapter {agent.adapter.adapterVersion} · {agent.adapter.source}
                  {agent.adapter.lifecycleVersion
                    ? ` · lifecycle ${agent.adapter.lifecycleVersion} (${agent.adapter.lifecycleAuthority})`
                    : ''}
                </div>
                {agent.adapter.sourcePath ? (
                  <div className="st-adapter-path mono">{agent.adapter.sourcePath}</div>
                ) : null}
              </div>
              <div className="st-adapter-capabilities">
                {capabilityLabels.map((label) => (
                  <span key={label}>{label}</span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const SETTINGS_GROUPS: Array<{
  label: string;
  items: Array<{ id: SettingsSection; label: string; icon: string }>;
}> = [
  {
    label: 'Application',
    items: [
      { id: 'general', label: 'General', icon: 'sliders' },
      { id: 'editor', label: 'Editor', icon: 'pencil' },
      { id: 'terminal', label: 'Terminal', icon: 'terminal' },
    ],
  },
  {
    label: 'AI & Agents',
    items: [
      { id: 'agent', label: 'Agent', icon: 'bot' },
      { id: 'models', label: 'Models', icon: 'provider' },
      { id: 'memory', label: 'Memory', icon: 'brain' },
      { id: 'skills', label: 'Skills', icon: 'puzzle' },
      { id: 'skill-sources', label: 'Skill Sources', icon: 'folder' },
      { id: 'permissions', label: 'Permissions', icon: 'shield' },
    ],
  },
  {
    label: 'Data & System',
    items: [
      { id: 'privacy', label: 'Privacy', icon: 'eye' },
      { id: 'github', label: 'GitHub', icon: 'branch' },
      { id: 'updates', label: 'Updates', icon: 'refresh' },
      { id: 'about', label: 'About', icon: 'info' },
    ],
  },
];

const SECTION_COPY: Record<SettingsSection, { title: string; description: string }> = {
  general: {
    title: 'General',
    description: 'Appearance, application behavior, and everyday workspace defaults.',
  },
  editor: { title: 'Editor', description: 'Typography, formatting, and file editing behavior.' },
  terminal: {
    title: 'Terminal',
    description: 'Shell, rendering, typography, and command integration.',
  },
  agent: {
    title: 'Agent',
    description: 'Default autonomy, Mission Fabric, and knowledge capture behavior.',
  },
  models: {
    title: 'Models',
    description: 'Provider credentials, model discovery, and thinking defaults.',
  },
  memory: {
    title: 'Memory',
    description: 'Inspect and manage the knowledge carried by each Agent.',
  },
  skills: {
    title: 'Skills',
    description: 'Manage installed capabilities, observed usage, and Agent availability.',
  },
  'skill-sources': {
    title: 'Skill Sources',
    description: 'Choose where Charter discovers and synchronizes Agent Skills.',
  },
  permissions: {
    title: 'Permissions',
    description: 'Review the risk policy that governs Agent actions.',
  },
  privacy: {
    title: 'Privacy',
    description: 'Control local data, analytics, and crash reporting.',
  },
  github: {
    title: 'GitHub',
    description: 'Credential for read-only issue import into the Work board.',
  },
  updates: {
    title: 'Updates',
    description: 'Check the installed version and choose an update channel.',
  },
  about: { title: 'About', description: 'Build, runtime, and local data information.' },
};

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
      label="Mission orchestration Skill"
      hint="Charter keeps its Mission routing manuals current for every detected Agent. Native tools, MCP and the charter CLI share the same command definitions; use this action only to repair an installation."
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
                  : 'Mission routing manuals repaired for detected Agents.',
              );
            });
          }}
        >
          {busy ? 'Repairing…' : allCurrent ? 'Repair' : 'Repair now'}
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

/** ADR-0056: credential for read-only GitHub issue import. The token is
 * verified against /user before it is stored; the renderer only ever sees
 * booleans and the verified login. */
function GithubSettingsSection(): React.JSX.Element {
  const pushToast = useAppStore((s) => s.pushToast);
  const [status, setStatus] = useState<GithubAuthStatusDto | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    const result = await rpcResult('github.auth.status', {});
    if (result.ok) setStatus(result.data);
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (): Promise<void> => {
    if (!token.trim() || busy) return;
    setBusy(true);
    const result = await rpcResult('github.auth.setToken', { token: token.trim() });
    setBusy(false);
    if (result.ok) {
      pushToast('success', `GitHub token verified — connected as @${result.data.login}.`);
      setToken('');
      await load();
    } else {
      pushToast('error', result.error.userMessage);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    const result = await rpcResult('github.auth.clearToken', {});
    setBusy(false);
    if (result.ok) {
      pushToast('success', 'GitHub token removed.');
      await load();
    } else {
      pushToast('error', result.error.userMessage);
    }
  };

  const connection = !status
    ? 'Checking…'
    : status.method === 'pat'
      ? `Personal access token${status.tokenLogin ? ` · @${status.tokenLogin}` : ''}`
      : status.method === 'gh-cli'
        ? 'GitHub CLI (gh) login detected — imports use it automatically'
        : 'Not connected — public repositories still work';

  return (
    <div className="st-card" data-testid="github-settings">
      <div className="st-card-head">
        <Ic name="branch" size={14} />
        <div>
          <div className="st-card-title">GitHub issue import</div>
          <div className="st-card-sub">
            Used only to read issues you import into the Work board. Charter never posts comments,
            pull requests, or state changes back to GitHub.
          </div>
        </div>
      </div>
      <Row label="Connection" hint={connection}>
        {status?.hasToken ? (
          <button
            className="btn"
            data-testid="github-remove-token"
            disabled={busy}
            onClick={() => void remove()}
          >
            Remove token
          </button>
        ) : (
          <span className="st-hint">{status?.ghCliAvailable ? 'gh CLI' : ''}</span>
        )}
      </Row>
      <Row
        label="Personal access token"
        hint="Needed for private repositories. Verified against GitHub before it is stored in the OS keychain."
      >
        <span className="st-privacy-controls">
          <input
            className="st-input"
            data-testid="github-token-input"
            type="password"
            value={token}
            placeholder="ghp_… or github_pat_…"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
            }}
          />
          <button
            className="btn primary"
            data-testid="github-save-token"
            disabled={!token.trim() || busy}
            onClick={() => void save()}
          >
            {busy ? 'Verifying…' : 'Save'}
          </button>
        </span>
      </Row>
    </div>
  );
}

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
    terminalRecordings: number;
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
        `Deleted ${res.data.clearedTasks} task${res.data.clearedTasks === 1 ? '' : 's'}, ${res.data.clearedRecordingFiles} terminal recording(s), ${res.data.clearedLogFiles} log file(s) and ${res.data.clearedAttachmentDirs} attachment folder(s).`,
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
              Logs roll off after {summary.logRetentionDays} days; task history, terminal recordings
              and attachments are kept until you delete them.
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
              <span>Terminal recordings {formatBytes(summary.terminalRecordings)}</span>
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

const UPDATE_PHASE_LABELS = {
  disabled: 'Unavailable in development',
  idle: 'Ready to check',
  checking: 'Checking…',
  available: 'Update available',
  downloading: 'Downloading…',
  downloaded: 'Ready to install',
  'up-to-date': 'Up to date',
  error: 'Check failed',
} as const;

function UpdateSettingsSection(props: {
  channel: 'stable' | 'beta';
  autoCheck: boolean;
  set: (patch: Record<string, unknown>) => void;
}): React.JSX.Element {
  const update = useAppStore((s) => s.updateState);
  const check = useAppStore((s) => s.checkForUpdates);
  const openDownload = useAppStore((s) => s.openUpdateDownload);
  const install = useAppStore((s) => s.installUpdate);
  const checking = update?.phase === 'checking';
  const progress = update?.progress;
  const statusMessage =
    update?.message ??
    (update?.phase === 'available' && update.availableVersion
      ? `Charter ${update.availableVersion} is available. Open its verified Release page to download this unsigned preview.`
      : 'Loading update status…');

  return (
    <>
      <div className="st-card st-update-card" data-testid="updates-status">
        <div className="st-card-head">
          <Ic name="refresh" size={14} />
          <div className="st-update-heading">
            <div>
              <div className="st-card-title">Charter {update?.currentVersion ?? '…'}</div>
              <div className="st-card-sub">
                {update?.delivery === 'automatic'
                  ? 'Signed background updates for macOS and Windows'
                  : 'Release notifications with verified manual installation'}
              </div>
            </div>
            {update ? (
              <span className={`st-update-phase ${update.phase}`} data-testid="updates-phase">
                {UPDATE_PHASE_LABELS[update.phase]}
              </span>
            ) : null}
          </div>
        </div>

        <div className="st-update-body" aria-live="polite">
          {update?.availableVersion ? (
            <div className="st-update-version">
              <span>Available</span>
              <b>{update.availableVersion}</b>
              {update.releaseName && update.releaseName !== `Charter ${update.availableVersion}` ? (
                <small>{update.releaseName}</small>
              ) : null}
            </div>
          ) : null}
          <p>{statusMessage}</p>
          {progress ? (
            <div className="st-update-progress" data-testid="updates-progress">
              <span style={{ width: `${progress.percent}%` }} />
              <small>
                {Math.round(progress.percent)}% · {formatBytes(progress.transferred)} of{' '}
                {formatBytes(progress.total)} · {formatBytes(progress.bytesPerSecond)}/s
              </small>
            </div>
          ) : null}
          {update?.checkedAt ? (
            <div className="st-update-checked">
              Last checked {new Date(update.checkedAt).toLocaleString()}
            </div>
          ) : null}
          <div className="st-update-actions">
            <button
              type="button"
              className="btn"
              data-testid="updates-check"
              disabled={!update?.canCheck || checking || update?.phase === 'downloading'}
              onClick={() => void check()}
            >
              {checking ? 'Checking…' : 'Check now'}
            </button>
            {update?.phase === 'available' && update.delivery === 'manual' ? (
              <button
                type="button"
                className="btn primary"
                data-testid="updates-open-download"
                onClick={() => void openDownload()}
              >
                Open release page
              </button>
            ) : null}
            {update?.canInstall ? (
              <button
                type="button"
                className="btn primary"
                data-testid="updates-install"
                onClick={() => void install()}
              >
                Restart and install
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="st-card">
        <Row label="Channel" hint="Beta receives stable releases and newer prereleases.">
          <select
            className="st-input"
            value={props.channel}
            data-testid="updates-channel"
            disabled={
              update?.phase === 'checking' ||
              update?.phase === 'downloading' ||
              update?.phase === 'downloaded'
            }
            onChange={(event) => props.set({ updates: { channel: event.target.value } })}
          >
            <option value="stable">Stable</option>
            <option value="beta">Beta</option>
          </select>
        </Row>
        <Row label="Check automatically" hint="At startup and every six hours while Charter runs.">
          <Toggle
            testid="updates-auto-check"
            checked={props.autoCheck}
            onChange={(autoCheck) => props.set({ updates: { autoCheck } })}
          />
        </Row>
      </div>
    </>
  );
}

const APPEARANCE_SKINS: AppearanceSkin[] = [
  'studio',
  'terminal',
  'archive',
  'index',
  'atelier',
  'codex',
];

function SkinPicker(props: {
  value: AppearanceSkin;
  onChange: (skin: AppearanceSkin) => void;
}): React.JSX.Element {
  return (
    <div className="st-skin-block">
      <div className="st-skin-heading">
        <span>{t('Skin')}</span>
        <small>{t('Color · type · icons · code')}</small>
      </div>
      <div className="st-skin-grid" role="radiogroup" aria-label={t('Application skin')}>
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
              <span className="st-skin-description">{t(meta.description)}</span>
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
  const section = useAppStore((s) => s.settingsSection);
  const openSettings = useAppStore((s) => s.openSettings);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const [navQuery, setNavQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent): void => {
      if (event.key.toLocaleLowerCase() !== 'f' || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [section]);

  const normalizedQuery = navQuery.trim().toLocaleLowerCase();
  const groups = SETTINGS_GROUPS.map((group) => ({
    ...group,
    items: normalizedQuery
      ? group.items.filter((item) =>
          `${item.label} ${t(item.label)} ${SECTION_COPY[item.id].description} ${t(SECTION_COPY[item.id].description)}`
            .toLocaleLowerCase()
            .includes(normalizedQuery),
        )
      : group.items,
  })).filter((group) => group.items.length > 0);
  const workspaceSection = section === 'memory' || section === 'skills';
  const copy = SECTION_COPY[section];

  if (!settings) {
    return (
      <div className="st-root" data-testid="settings-page" aria-label={t('Settings')}>
        <div className="empty-state">{t('Loading settings…')}</div>
      </div>
    );
  }

  const set = (patch: Record<string, unknown>) => void updateSettings('global', patch);
  const setMockRuntime = async (useMockRuntime: boolean): Promise<void> => {
    await updateSettings('global', { models: { useMockRuntime } });
    await useTaskStore.getState().refreshModels();
  };

  return (
    <div className="st-root" data-testid="settings-page" aria-label={t('Settings')}>
      <nav aria-label={t('Settings sections')} className="st-nav">
        <div className="st-nav-head">
          <button
            type="button"
            className="st-back"
            data-testid="settings-back"
            onClick={closeSettings}
            autoFocus
          >
            <Ic name="chevron" size={12} />
            {t('Back to app')}
          </button>
          <div className="st-nav-title">
            <span className="st-nav-mark" aria-hidden="true">
              <Ic name="sliders" size={15} />
            </span>
            <div>
              <strong>{t('Settings')}</strong>
              <small>{t('Charter preferences')}</small>
            </div>
          </div>
        </div>
        <label className="st-nav-search">
          <Ic name="search" size={13} />
          <input
            ref={searchRef}
            value={navQuery}
            aria-label={t('Search settings')}
            placeholder={t('Search settings')}
            onChange={(event) => setNavQuery(event.target.value)}
          />
          <kbd>⌘F</kbd>
        </label>
        <div className="st-nav-groups">
          {groups.map((group) => (
            <div className="st-nav-group" key={group.label}>
              <span>{t(group.label)}</span>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  className={`st-nav-item ${item.id === section ? 'active' : ''}`}
                  data-testid={`settings-section-${item.id}`}
                  aria-current={item.id === section ? 'page' : undefined}
                  onClick={() => openSettings(item.id)}
                >
                  <Ic name={item.icon} size={14} />
                  {t(item.label)}
                </button>
              ))}
            </div>
          ))}
          {groups.length === 0 ? <p className="st-nav-empty">{t('No matching settings')}</p> : null}
        </div>
      </nav>
      <section ref={bodyRef} className={`st-body ${workspaceSection ? 'workspace' : ''}`}>
        {workspaceSection ? (
          section === 'memory' ? (
            <MemoryView embedded />
          ) : (
            <SkillsView />
          )
        ) : (
          <div className="st-content-shell">
            <header className="st-content-head">
              <h1>{t(copy.title)}</h1>
              <p>{t(copy.description)}</p>
            </header>
            <div className="st-content">
              {issues.length > 0 ? (
                <div className="st-issues">
                  {issues.length} setting value(s) were invalid and fell back to defaults.
                </div>
              ) : null}

              {section === 'general' ? (
                <div className="st-card">
                  <Row
                    label={t('Display language')}
                    hint={t('Choose the language used by Charter controls, menus, and messages.')}
                  >
                    <select
                      className="st-input"
                      data-testid="settings-locale"
                      aria-label={t('Display language')}
                      value={settings.general.locale}
                      onChange={(event) =>
                        set({ general: { locale: event.target.value as 'en' | 'zh-CN' } })
                      }
                    >
                      <option value="en">English</option>
                      <option value="zh-CN">简体中文</option>
                    </select>
                  </Row>
                  <SkinPicker
                    value={settings.general.skin}
                    onChange={(skin) => set({ general: { skin } })}
                  />
                  <Row
                    label={t('Brightness')}
                    hint={t('Each skin includes a coordinated light and dark variant')}
                  >
                    <select
                      className="st-input"
                      value={settings.general.theme}
                      onChange={(e) => set({ general: { theme: e.target.value } })}
                    >
                      <option value="system">{t('System')}</option>
                      <option value="light">{t('Light')}</option>
                      <option value="dark">{t('Dark')}</option>
                    </select>
                  </Row>
                  <Row
                    label={t('UI zoom')}
                    hint={t(
                      'Whole window outside a focused terminal · terminal focus uses independent font zoom',
                    )}
                  >
                    <div
                      className="st-zoom-seg"
                      role="radiogroup"
                      aria-label={t('UI zoom')}
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
                    label={t('When closing a window')}
                    hint={t(
                      'Applies while Agents, Missions, terminal jobs, or remote connections are still running.',
                    )}
                  >
                    <select
                      className="st-input"
                      data-testid="settings-background-on-close"
                      value={settings.general.backgroundOnClose}
                      onChange={(event) =>
                        set({ general: { backgroundOnClose: event.target.value } })
                      }
                    >
                      <option value="ask">{t('Ask what to do')}</option>
                      <option value="keep-running">{t('Keep work running in background')}</option>
                      <option value="quit">{t('Quit and stop all work')}</option>
                    </select>
                  </Row>
                  <Row
                    label={t('Rich Markdown by default')}
                    hint={t(
                      'Open .md files in the Notion-style editor (toggle per file on the tab)',
                    )}
                  >
                    <Toggle
                      testid="settings-md-rich"
                      checked={settings.editor.markdownRichDefault}
                      onChange={(v) => set({ editor: { markdownRichDefault: v } })}
                    />
                  </Row>
                  <Row
                    label={t('System notifications')}
                    hint={t(
                      'Plan approval · permission · review ready · failed (silent while focused)',
                    )}
                  >
                    <Toggle
                      testid="settings-notifications"
                      checked={settings.notifications.enabled}
                      onChange={(v) => set({ notifications: { enabled: v } })}
                    />
                  </Row>
                  <Row
                    label={t('Preview console → agent')}
                    hint={t(
                      "Auto: errors landing right after the agent's own write are steered back (deduped, rate-limited). Manual: collect + one-click send. Off: count only.",
                    )}
                  >
                    <select
                      className="st-input"
                      data-testid="settings-preview-console"
                      value={settings.preview.consoleToAgent}
                      onChange={(e) => set({ preview: { consoleToAgent: e.target.value } })}
                    >
                      <option value="auto">{t('Auto (self-heal)')}</option>
                      <option value="manual">{t('Manual')}</option>
                      <option value="off">{t('Off')}</option>
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
                      data-testid="settings-terminal-font-size"
                      type="number"
                      min={8}
                      max={32}
                      value={settings.terminal.fontSize}
                      onChange={(e) => set({ terminal: { fontSize: Number(e.target.value) } })}
                    />
                  </Row>
                  <Row
                    label="Font family"
                    hint="SF Mono by default, with system CJK fallbacks for Chinese output"
                  >
                    <input
                      className="st-input wide mono"
                      data-testid="settings-terminal-font-family"
                      value={settings.terminal.fontFamily}
                      onChange={(e) => set({ terminal: { fontFamily: e.target.value } })}
                    />
                  </Row>
                  <Row label="Font weight" hint="Bold is at least 700 and 200 above normal">
                    <select
                      className="st-input"
                      data-testid="settings-terminal-font-weight"
                      value={settings.terminal.fontWeight}
                      onChange={(e) => set({ terminal: { fontWeight: Number(e.target.value) } })}
                    >
                      {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((weight) => (
                        <option key={weight} value={weight}>
                          {weight}
                        </option>
                      ))}
                    </select>
                  </Row>
                  <Row label="Line height">
                    <input
                      className="st-input"
                      data-testid="settings-terminal-line-height"
                      type="number"
                      min={1}
                      max={2}
                      step={0.05}
                      value={settings.terminal.lineHeight}
                      onChange={(e) => set({ terminal: { lineHeight: Number(e.target.value) } })}
                    />
                  </Row>
                  <Row
                    label="Horizontal padding"
                    hint="Pixels on the left and right of every terminal"
                  >
                    <input
                      className="st-input"
                      data-testid="settings-terminal-padding-x"
                      type="number"
                      min={0}
                      max={32}
                      value={settings.terminal.paddingX}
                      onChange={(e) => set({ terminal: { paddingX: Number(e.target.value) } })}
                    />
                  </Row>
                  <Row label="Vertical padding" hint="Pixels above and below every terminal">
                    <input
                      className="st-input"
                      data-testid="settings-terminal-padding-y"
                      type="number"
                      min={0}
                      max={32}
                      value={settings.terminal.paddingY}
                      onChange={(e) => set({ terminal: { paddingY: Number(e.target.value) } })}
                    />
                  </Row>
                  <Row
                    label="Terminal colors"
                    hint="Orca uses Tango Light and Ghostty Dark with contrast correction"
                  >
                    <select
                      className="st-input wide"
                      data-testid="settings-terminal-color-theme"
                      value={settings.terminal.colorTheme}
                      onChange={(e) => set({ terminal: { colorTheme: e.target.value } })}
                    >
                      <option value="orca">Orca · Tango Light / Ghostty Dark</option>
                      <option value="skin">Match Charter skin</option>
                    </select>
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
                      onChange={(e) =>
                        set({ terminal: { longCommandSeconds: Number(e.target.value) } })
                      }
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
                  <AgentAdaptersBlock />
                  <div className="st-card">
                    <div className="st-card-head">
                      <Ic name="terminal" size={14} />
                      <div>
                        <div className="st-card-title">Mission Fabric</div>
                        <div className="st-card-sub">
                          Recursive Agent teams with durable inboxes, parallel scheduling and ACP
                          session reuse. Claude and Codex automatically fall back to visible
                          terminals if ACP startup is unavailable.
                        </div>
                      </div>
                    </div>
                    <Row
                      label="Mission Fabric"
                      hint="Master switch for Mission tools, ACP/MCP bridge, durable messaging and visible terminal fallback"
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
                        onChange={(e) =>
                          set({ orchestration: { maxWorkers: Number(e.target.value) } })
                        }
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
                        onClick={() => openSettings('memory')}
                      >
                        Open Memory
                      </button>
                    </Row>
                    <Row
                      label="Skills"
                      hint="Usage and cross-Agent cleanup live on the main Skills page"
                    >
                      <button
                        className="btn"
                        data-testid="settings-open-skills"
                        onClick={() => openSettings('skills')}
                      >
                        Open Skills
                      </button>
                    </Row>
                  </div>
                </>
              ) : null}

              {section === 'skill-sources' ? <SkillSourcesSettingsSection /> : null}

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
                    <Row
                      label="Deterministic mock runtime"
                      hint="For demos/tests without a provider"
                    >
                      <Toggle
                        testid="settings-use-mock-runtime"
                        checked={settings.models.useMockRuntime}
                        onChange={(v) => void setMockRuntime(v)}
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
                      <b>R1</b> reversible workspace writes — Edit asks / plan approval; Auto per
                      setting.
                    </li>
                    <li>
                      <b>R2</b> local execution — recognized verification commands may run; unknown
                      ask.
                    </li>
                    <li>
                      <b>R3</b> external / hard-to-reverse — always asks, never permanently allowed.
                    </li>
                    <li>
                      <b>R4</b> forbidden — sudo, git push, writes outside the workspace: always
                      blocked.
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

              {section === 'github' ? <GithubSettingsSection /> : null}

              {section === 'updates' ? (
                <UpdateSettingsSection
                  channel={settings.updates.channel}
                  autoCheck={settings.updates.autoCheck}
                  set={set}
                />
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
        )}
      </section>
    </div>
  );
}
