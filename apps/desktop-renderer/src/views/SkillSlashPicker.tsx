import React, { useEffect, useState } from 'react';
import { useSkillsStore } from '../store/skillsStore.js';
import { useAppStore } from '../store/appStore.js';
import { Ic } from './home-icons.js';
import { preambleTotalTokens } from './skills-insight.js';

/**
 * Composer "/" skill picker (ADR-0015; mockup: skills-manager-mockup.html).
 * Typing "/" in an EMPTY composer opens a popover listing the ENABLED skills
 * (Off skills never appear); picking one inserts `/skill:name ` — the product
 * expands it into the skill's instructions when the prompt is sent.
 *
 * The host keeps focus in its textarea: route onKeyDown/onChange through the
 * returned handlers (handleKeyDown returns true when the picker consumed the
 * key — preventDefault and stop), and render `menu` inside a positioned
 * ancestor (`.skill-pick` pops upward).
 */
export function useSkillSlash(options: {
  value: string;
  setValue: (next: string) => void;
  testid: string;
  focus?: () => void;
}): {
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
  handleChange: (next: string) => void;
  menu: React.JSX.Element | null;
} {
  const { value, setValue, testid } = options;
  const skills = useSkillsStore((s) => s.skills);
  const loaded = useSkillsStore((s) => s.loaded);
  const usage = useSkillsStore((s) => s.usage);
  const usageLoaded = useSkillsStore((s) => s.usageLoaded);
  const overheadTokens = useSkillsStore((s) => s.preambleOverheadTokens);
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (!loaded) void useSkillsStore.getState().refresh();
  }, [loaded]);
  useEffect(() => {
    // Usage evidence can require a large transcript walk. The composer only
    // needs the catalog until the picker is actually opened.
    if (open && !usageLoaded) void useSkillsStore.getState().refreshUsage();
  }, [open, usageLoaded]);

  // Query = text after "/" (a pasted "/skill:" prefix matches too).
  const query = value.startsWith('/')
    ? value
        .slice(1)
        .toLowerCase()
        .replace(/^skill:/, '')
    : '';
  const items = skills.filter(
    (s) =>
      s.enabled &&
      (s.name.toLowerCase().includes(query) || s.displayName.toLowerCase().includes(query)),
  );
  const safeIdx = Math.min(idx, Math.max(0, items.length - 1));

  const pick = (name: string): void => {
    setValue(`/skill:${name} `);
    setOpen(false);
    options.focus?.();
  };

  const handleKeyDown = (e: React.KeyboardEvent): boolean => {
    if (!open) {
      // "/" in an empty composer opens the picker; the character still lands.
      if (e.key === '/' && value.length === 0 && skills.some((s) => s.enabled)) {
        setOpen(true);
        setIdx(0);
      }
      return false;
    }
    if (e.key === 'Escape') {
      setOpen(false);
      return true;
    }
    if (e.key === 'ArrowDown') {
      setIdx(Math.min(safeIdx + 1, Math.max(0, items.length - 1)));
      return true;
    }
    if (e.key === 'ArrowUp') {
      setIdx(Math.max(safeIdx - 1, 0));
      return true;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      const item = items[safeIdx];
      if (item) pick(item.name);
      else setOpen(false);
      return true;
    }
    return false;
  };

  const handleChange = (next: string): void => {
    // Leaving "slash command" shape (space, cleared, prose) closes the picker.
    if (open && !/^\/[A-Za-z0-9_:@-]*$/.test(next)) setOpen(false);
  };

  const menu = open ? (
    <div className="skill-pick" data-testid={`${testid}-skill-picker`}>
      <div className="skill-pick-cap">Skills</div>
      {items.map((s, i) => (
        <button
          key={s.id}
          className={`hm-row ${i === safeIdx ? 'active' : ''}`}
          data-testid={`${testid}-skill-item-${s.name}`}
          onMouseDown={(e) => e.preventDefault() /* keep textarea focus */}
          onClick={() => pick(s.name)}
        >
          <Ic name="puzzle" size={13} />
          <span className="hm-tt">
            <span className="skill-pick-name">/skill:{s.name}</span>
            <span className="skill-pick-desc">
              {s.description} · {s.sourceLabel}
            </span>
          </span>
          {s.live ? <span className="skill-pick-badge">live</span> : null}
          {s.explicitOnly ? <span className="skill-pick-badge">explicit-only</span> : null}
        </button>
      ))}
      {items.length === 0 ? (
        <div className="hm-sec" style={{ padding: '8px 10px' }}>
          No matching enabled skill.
        </div>
      ) : null}
      <div className="skill-pick-hint">
        <span>↑↓ select · ⏎ insert · esc close</span>
        {usageLoaded ? (
          <button
            className="skill-pick-manage"
            data-testid={`${testid}-skill-manage`}
            title="Per-Agent usage and installed copies in Skills"
            onMouseDown={(e) => e.preventDefault() /* keep textarea focus until click */}
            onClick={() => {
              setOpen(false);
              useAppStore.getState().setRailView('skills');
            }}
          >
            {skills.filter((s) => s.enabled).length} enabled · ≈
            {preambleTotalTokens(usage, overheadTokens).toLocaleString()} tok/turn · Manage…
          </button>
        ) : null}
      </div>
    </div>
  ) : null;

  return { handleKeyDown, handleChange, menu };
}
