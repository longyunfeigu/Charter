import React, { useEffect } from 'react';
import { useAppStore } from '../store/appStore.js';
import { useSkillsStore } from '../store/skillsStore.js';
import { Ic } from './home-icons.js';

export function SkillSourcesSettingsSection(): React.JSX.Element {
  const sources = useSkillsStore((state) => state.sources);
  const init = useSkillsStore((state) => state.init);
  const rescan = useSkillsStore((state) => state.rescan);
  const importSkill = useSkillsStore((state) => state.importSkill);
  const addSource = useSkillsStore((state) => state.addSource);
  const removeSource = useSkillsStore((state) => state.removeSource);
  const setSourcePolicy = useSkillsStore((state) => state.setSourcePolicy);

  useEffect(() => init(), [init]);

  const openSkills = (): void => {
    useAppStore.getState().openSettings('skills');
  };

  return (
    <>
      <div className="st-card">
        <div className="st-row">
          <span className="st-row-label">
            Skills workspace
            <span className="st-row-hint">
              Usage, cross-Agent copies and per-Agent cleanup live in Settings → Skills
            </span>
          </span>
          <span className="st-row-control">
            <button
              className="btn primary"
              data-testid="settings-go-to-skills"
              onClick={openSkills}
            >
              <Ic name="puzzle" size={13} /> Open Skills
            </button>
          </span>
        </div>
      </div>

      <div className="st-card">
        <div className="st-card-head">
          <Ic name="folder" size={14} />
          <div>
            <div className="st-card-title">Sources &amp; trust</div>
            <div className="st-card-sub">
              Choose where Charter scans and whether linked instructions may enter Charter context.
            </div>
          </div>
          <span className="st-sp" />
          <button className="btn" onClick={() => void importSkill()}>
            <Ic name="plus" size={12} /> Import copy
          </button>
          <button className="btn" onClick={() => void addSource()}>
            <Ic name="folder-plus" size={12} /> Connect folder
          </button>
          <button className="btn" onClick={() => void rescan()}>
            <Ic name="refresh" size={12} /> Rescan
          </button>
        </div>
        <div className="st-sources">
          {sources.map((source) => (
            <div
              className={`st-source-row ${source.available ? '' : 'missing'}`}
              key={source.id}
              data-testid={`skill-source-${source.id}`}
            >
              <Ic name="folder" size={13} />
              <div className="st-source-main">
                <span className="st-source-name">{source.label}</span>
                <span className="st-source-path">{source.path}</span>
              </div>
              <span className={`st-source-state ${source.available ? 'ok' : ''}`}>
                {source.available ? `${source.skillCount} Skills` : 'Not found'}
              </span>
              <label
                className={`st-source-check ${source.trusted ? 'on' : ''} ${source.kind === 'managed' ? 'disabled' : ''}`}
              >
                <input
                  type="checkbox"
                  data-testid={`skill-source-trust-${source.id}`}
                  checked={source.trusted}
                  disabled={source.kind === 'managed'}
                  onChange={(event) =>
                    void setSourcePolicy(source.id, { trusted: event.target.checked })
                  }
                />
                Trusted
              </label>
              <label
                className={`st-source-check ${source.autoEnableNew ? 'on' : ''} ${source.kind === 'managed' || !source.trusted ? 'disabled' : ''}`}
              >
                <input
                  type="checkbox"
                  data-testid={`skill-source-auto-${source.id}`}
                  checked={source.autoEnableNew}
                  disabled={source.kind === 'managed' || !source.trusted}
                  onChange={(event) =>
                    void setSourcePolicy(source.id, { autoEnableNew: event.target.checked })
                  }
                />
                Auto new
              </label>
              {source.removable ? (
                <button className="btn quiet-danger" onClick={() => void removeSource(source.id)}>
                  Disconnect
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="st-card">
        <div className="st-row">
          <span className="st-row-label">
            More Agent adapters
            <span className="st-row-hint">
              The catalog groups copies by Agent; Kimi Code and future adapters can join the same
              model.
            </span>
          </span>
          <span className="st-row-control text-muted">Adapter-ready</span>
        </div>
      </div>
    </>
  );
}
