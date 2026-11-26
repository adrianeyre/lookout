import { useState } from 'react';
import { PageGrid } from '../grid/PageGrid.tsx';
import {
  MODES,
  THEMES,
  chooseMode,
  chooseTheme,
  readMode,
  readTheme,
  type Mode,
  type Theme,
} from '../appearance.ts';

const MODE_HINTS: Record<Mode, string> = {
  system: 'Follows your device’s light or dark setting',
  light: 'Always light',
  dark: 'Always dark',
};

/**
 * Settings: the appearance, kept in this browser. Every mode and theme meets WCAG 2.2 AA, and a
 * change shows straight away. Radio groups, so the arrow keys move between choices.
 */
export function SettingsPage() {
  return (
    <PageGrid
      page="settings"
      title="Settings"
      widgets={{ 'settings.appearance': <Appearance /> }}
    />
  );
}

/** The appearance Settings, in their Widget. */
export function Appearance() {
  const [mode, setMode] = useState<Mode>(readMode);
  const [theme, setTheme] = useState<Theme>(readTheme);

  return (
    <>
      <section className="settings" aria-label="Appearance">
        <p className="muted">
          Saved in this browser only. Every mode and theme meets WCAG 2.2 level AA.
        </p>

        <fieldset className="settings__group">
          <legend>Mode</legend>
          <div className="choices">
            {MODES.map(({ id, label }) => (
              <label key={id} className="choice">
                <input
                  type="radio"
                  name="mode"
                  value={id}
                  checked={mode === id}
                  onChange={() => {
                    setMode(id);
                    chooseMode(id);
                  }}
                />
                <span className="choice__text">
                  <span className="choice__label">{label}</span>
                  <span className="choice__hint">{MODE_HINTS[id]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="settings__group">
          <legend>Theme</legend>
          <div className="choices choices--themes">
            {THEMES.map(({ id, label }) => (
              <label key={id} className="choice">
                <input
                  type="radio"
                  name="theme"
                  value={id}
                  checked={theme === id}
                  onChange={() => {
                    setTheme(id);
                    chooseTheme(id);
                  }}
                />
                <span className="swatch" data-swatch={id} aria-hidden="true" />
                <span className="choice__label">{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </section>
    </>
  );
}
