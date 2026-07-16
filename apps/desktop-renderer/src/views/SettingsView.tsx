import React, { useEffect, useState } from 'react';
import { PROVIDER_PRESETS, providerPreset, type ProviderInfoDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useAppStore, type SettingsSection } from '../store/appStore.js';
import { useTaskStore } from '../store/taskStore.js';
import { useSkillsStore } from '../store/skillsStore.js';
import { Ic } from './home-icons.js';
import { SKIN_LABELS, type AppearanceSkin } from '../appearance.js';
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

/** Multi-source skill catalog (ADR-0015 + ADR-0019). */
function SkillsBlock(): React.JSX.Element {
  const skills = useSkillsStore((s) => s.skills);
  const sources = useSkillsStore((s) => s.sources);
  const refresh = useSkillsStore((s) => s.refresh);
  const rescan = useSkillsStore((s) => s.rescan);
  const importSkill = useSkillsStore((s) => s.importSkill);
  const addSource = useSkillsStore((s) => s.addSource);
  const removeSource = useSkillsStore((s) => s.removeSource);
  const setSourcePolicy = useSkillsStore((s) => s.setSourcePolicy);
  const removeSkill = useSkillsStore((s) => s.remove);
  const setEnabled = useSkillsStore((s) => s.setEnabled);
  const read = useSkillsStore((s) => s.read);
  const [auditId, setAuditId] = useState<string | null>(null);
  const [auditText, setAuditText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openAudit = async (id: string): Promise<void> => {
    if (auditId === id) {
      setAuditId(null);
      return;
    }
    const file = await read(id);
    setAuditText(file?.content ?? '');
    setAuditId(id);
  };

  const remove = async (id: string): Promise<void> => {
    if (!window.confirm(`Remove the "${id}" skill from the managed store?`)) return;
    await removeSkill(id);
    if (auditId === id) setAuditId(null);
  };

  const disconnect = async (id: string, label: string): Promise<void> => {
    if (
      !window.confirm(`Disconnect the "${label}" skill source? Original files are not deleted.`)
    ) {
      return;
    }
    await removeSource(id);
  };

  return (
    <div className="st-card" data-testid="skills-block">
      <div className="st-card-head">
        <Ic name="zap" size={14} />
        <div>
          <div className="st-card-title">Skills</div>
          <div className="st-card-sub">
            Charter discovers Agent, Codex and Claude Code skills and follows linked sources live.
            Discovery never means trust: only enabled skills reach the audited load_skill tool.
          </div>
        </div>
        <span className="st-sp" />
        <button
          className="btn"
          data-testid="skills-rescan"
          disabled={busy !== null}
          onClick={() => {
            setBusy('scan');
            void rescan().finally(() => setBusy(null));
          }}
        >
          {busy === 'scan' ? 'Scanning…' : 'Rescan'}
        </button>
        <button
          className="btn"
          data-testid="skills-connect-source"
          disabled={busy !== null}
          onClick={() => {
            setBusy('connect');
            void addSource().finally(() => setBusy(null));
          }}
        >
          {busy === 'connect' ? 'Connecting…' : 'Connect folder…'}
        </button>
        <button
          className="btn primary"
          data-testid="skills-import"
          disabled={busy !== null}
          onClick={() => {
            setBusy('import');
            void importSkill().finally(() => setBusy(null));
          }}
        >
          {busy === 'import' ? 'Importing…' : 'Import copy…'}
        </button>
      </div>

      <div className="st-skill-safe">
        <Ic name="alert" size={14} />
        <span>
          Skills can bundle scripts. Review each one before enabling — every command a skill runs
          still passes the Permission Engine, so a skill can’t run anything you didn’t allow.
          Project folders are never scanned unless you explicitly connect one.
        </span>
      </div>

      <div className="st-sources" data-testid="skill-sources">
        <div className="st-skill-cap">Sources</div>
        {sources.map((source) => (
          <div
            key={source.id}
            className={`st-source-row ${source.available ? '' : 'missing'}`}
            data-testid={`skill-source-${source.id}`}
          >
            <Ic name="folder" size={13} />
            <span className="st-source-main">
              <span className="st-source-name">{source.label}</span>
              <span className="st-source-path mono" title={source.path}>
                {source.path}
              </span>
            </span>
            <span className={`st-source-state ${source.available ? 'ok' : ''}`}>
              {source.available ? `${source.skillCount} found` : 'not installed'}
            </span>
            {source.kind === 'managed' ? (
              <span className="st-skill-badge">managed copies</span>
            ) : (
              <>
                <label className={`st-source-check ${source.trusted ? 'on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={source.trusted}
                    data-testid={`skill-source-trust-${source.id}`}
                    onChange={(event) =>
                      void setSourcePolicy(source.id, { trusted: event.target.checked })
                    }
                  />
                  Trust
                </label>
                <label
                  className={`st-source-check ${source.autoEnableNew ? 'on' : ''} ${source.trusted ? '' : 'disabled'}`}
                  title="Automatically enable skills added to this source later"
                >
                  <input
                    type="checkbox"
                    checked={source.autoEnableNew}
                    disabled={!source.trusted}
                    data-testid={`skill-source-auto-${source.id}`}
                    onChange={(event) =>
                      void setSourcePolicy(source.id, { autoEnableNew: event.target.checked })
                    }
                  />
                  Auto-enable new
                </label>
              </>
            )}
            {source.removable ? (
              <button
                className="btn quiet-danger"
                data-testid={`skill-source-remove-${source.id}`}
                onClick={() => void disconnect(source.id, source.label)}
              >
                Disconnect
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {skills.length === 0 ? (
        <div className="st-empty" data-testid="skills-empty">
          No skills found. Connect a source or import a folder containing SKILL.md.
        </div>
      ) : (
        skills.map((skill) => (
          <React.Fragment key={skill.id}>
            <div
              className={`st-skill-row ${skill.enabled ? '' : 'off'}`}
              data-testid={`skill-row-${skill.id}`}
            >
              <span className="st-skill-name">
                <span className="mono">{skill.name}</span>
                <span className={`st-skill-badge source ${skill.live ? 'live' : ''}`}>
                  {skill.sourceLabel}
                </span>
                {skill.live ? <span className="st-skill-badge live">live</span> : null}
                {skill.status === 'conflict' ? (
                  <span className="st-skill-badge conflict" title={skill.issues.join('\n')}>
                    name conflict
                  </span>
                ) : null}
                {skill.status === 'invalid' ? (
                  <span className="st-skill-badge invalid" title={skill.issues.join('\n')}>
                    invalid
                  </span>
                ) : null}
                {skill.compatibility === 'needs-review' ? (
                  <span className="st-skill-badge review" title={skill.issues.join('\n')}>
                    needs review
                  </span>
                ) : null}
                {skill.explicitOnly ? (
                  <span
                    className="st-skill-badge explicit"
                    title="The skill declares disable-model-invocation — the model never auto-fires it; run it with /skill:name"
                  >
                    explicit-only
                  </span>
                ) : null}
                {skill.scriptCount > 0 ? (
                  <span className="st-skill-badge script">
                    {skill.scriptCount} script{skill.scriptCount > 1 ? 's' : ''}
                  </span>
                ) : null}
              </span>
              <span className="st-skill-desc" title={`${skill.description}\n${skill.sourcePath}`}>
                {skill.description || '(no description)'}
              </span>
              <span
                className="st-skill-seg"
                role="radiogroup"
                aria-label={`${skill.name} enablement`}
              >
                <button
                  className={skill.enabled ? '' : 'on'}
                  data-testid={`skill-off-${skill.id}`}
                  role="radio"
                  aria-checked={!skill.enabled}
                  title="Disabled: not offered to the model, hidden from the “/” picker"
                  onClick={() => void setEnabled(skill.id, false)}
                >
                  Off
                </button>
                <button
                  className={skill.enabled ? 'on' : ''}
                  data-testid={`skill-auto-${skill.id}`}
                  role="radio"
                  aria-checked={skill.enabled}
                  disabled={skill.status === 'invalid'}
                  title="Enabled: the model may auto-invoke it; you can also run /skill:name"
                  onClick={() => void setEnabled(skill.id, true)}
                >
                  Auto
                </button>
              </span>
              <button
                className="btn"
                data-testid={`skill-audit-${skill.id}`}
                title="Inspect SKILL.md and bundled files before trusting"
                onClick={() => void openAudit(skill.id)}
              >
                {auditId === skill.id ? 'Close' : 'Audit'}
              </button>
              {skill.source === 'managed' ? (
                <button
                  className="btn quiet-danger"
                  data-testid={`skill-remove-${skill.id}`}
                  onClick={() => void remove(skill.id)}
                >
                  Remove
                </button>
              ) : null}
            </div>
            {auditId === skill.id ? (
              <div className="st-skill-audit" data-testid={`skill-audit-panel-${skill.id}`}>
                <div className="st-skill-files">
                  <div className="st-skill-cap">Bundled files</div>
                  {skill.files.map((f) => (
                    <div key={f} className={`st-skill-file ${isScriptPath(f) ? 'script' : ''}`}>
                      <Ic name={isScriptPath(f) ? 'terminal' : 'file'} size={12} />
                      <span className="mono">{f}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <div className="st-skill-cap">SKILL.md</div>
                  <div className="st-skill-origin mono">
                    {skill.sourcePath} · revision {skill.revision.slice(0, 12)}
                  </div>
                  <pre className="st-skill-md">{auditText}</pre>
                  {skill.issues.length > 0 ? (
                    <div className="st-skill-issues">
                      {skill.issues.map((issue) => (
                        <div key={issue}>{issue}</div>
                      ))}
                    </div>
                  ) : null}
                  <div className="st-skill-gate">
                    <Ic name="check" size={13} strokeWidth={2} />
                    {skill.scriptCount > 0
                      ? `${skill.scriptCount} script${skill.scriptCount > 1 ? 's' : ''} — each run still goes through the Permission Engine.`
                      : 'Instructions only — no bundled scripts.'}
                  </div>
                </div>
              </div>
            ) : null}
          </React.Fragment>
        ))
      )}
    </div>
  );
}

/** Audit view: which bundled files look executable (mirrors the store's list). */
function isScriptPath(relPath: string): boolean {
  return /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|cmd|bat)$/i.test(relPath);
}

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: string }> = [
  { id: 'general', label: 'General', icon: 'sliders' },
  { id: 'editor', label: 'Editor', icon: 'pencil' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'agent', label: 'Agent', icon: 'bot' },
  { id: 'models', label: 'Models', icon: 'zap' },
  { id: 'permissions', label: 'Permissions', icon: 'shield' },
  { id: 'privacy', label: 'Privacy', icon: 'eye' },
  { id: 'updates', label: 'Updates', icon: 'refresh' },
  { id: 'about', label: 'About', icon: 'info' },
];

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
            <Row label="UI scale" hint="0.8 – 2.0">
              <input
                className="st-input"
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
            <SkillsBlock />
          </>
        ) : null}

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
          <div className="st-card">
            <Row
              label="Product analytics"
              hint="Default off. Never includes code, prompts or paths."
            >
              <Toggle
                checked={settings.privacy.telemetryEnabled}
                onChange={(v) => set({ privacy: { telemetryEnabled: v } })}
              />
            </Row>
            <Row label="Crash reports" hint="Separate opt-in with redacted preview">
              <Toggle
                checked={settings.privacy.crashReportsEnabled}
                onChange={(v) => set({ privacy: { crashReportsEnabled: v } })}
              />
            </Row>
            <div className="st-hint" style={{ padding: '10px 2px 2px' }}>
              All code, tasks, timelines and diffs stay on this machine. Model requests go directly
              to your configured provider.
            </div>
          </div>
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
