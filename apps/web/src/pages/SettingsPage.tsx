import { useEffect, useId, useState, type SubmitEvent } from 'react';
import { MIN_PASSWORD_LENGTH } from '@lookout/shared';
import { changePassword, passwordChangeable } from '../api.ts';
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
 * Settings: the appearance, kept in this browser, and the password. Every mode and theme meets WCAG 2.2 AA, and a
 * change shows straight away. Radio groups, so the arrow keys move between choices.
 */
export function SettingsPage() {
  return (
    <PageGrid
      page="settings"
      title="Settings"
      widgets={{ 'settings.appearance': <Appearance />, 'settings.password': <PasswordSettings /> }}
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

type PasswordState =
  { kind: 'idle' } | { kind: 'saving' } | { kind: 'done' } | { kind: 'error'; message: string };

/**
 * Change the password: the current one, then the new one twice. Every other browser is signed
 * out; this one stays signed in. Without LOOKOUT_DATA_DIR it says how to change it in .env.
 */
export function PasswordSettings() {
  const [changeable, setChangeable] = useState<boolean | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [state, setState] = useState<PasswordState>({ kind: 'idle' });
  const id = useId();

  useEffect(() => {
    let live = true;
    void passwordChangeable().then((value) => {
      if (live) setChangeable(value);
    });
    return () => {
      live = false;
    };
  }, []);

  if (changeable === null) {
    return (
      <p className="muted" role="status">
        Checking…
      </p>
    );
  }
  if (!changeable) {
    return (
      <section className="settings" aria-label="Password">
        <p className="muted">
          This Lookout keeps no data, so its password can only be changed in its <code>.env</code>{' '}
          file: run <code>hash-password --env</code> and replace the{' '}
          <code>LOOKOUT_PASSWORD_HASH</code> line. To change it here, set{' '}
          <code>LOOKOUT_DATA_DIR</code> and give it a volume, as the reference{' '}
          <code>compose.yaml</code> does.
        </p>
      </section>
    );
  }

  const tooShort = next.length > 0 && next.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && next !== confirm;
  const ready = current.length > 0 && next.length >= MIN_PASSWORD_LENGTH && next === confirm;

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready || state.kind === 'saving') return;
    setState({ kind: 'saving' });
    const result = await changePassword({ currentPassword: current, newPassword: next });
    if (result.ok) {
      setCurrent('');
      setNext('');
      setConfirm('');
      setState({ kind: 'done' });
    } else {
      setState({ kind: 'error', message: result.message });
    }
  };

  return (
    <section className="settings" aria-label="Password">
      <p className="muted">
        Changing it signs out every other browser. Keep a note of it: if it is lost, a new one can
        be set in <code>.env</code>.
      </p>
      <form className="password-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="field">
          <label className="field__label" htmlFor={`${id}-current`}>
            Current password
          </label>
          <input
            className="field__input"
            id={`${id}-current`}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${id}-new`}>
            New password
          </label>
          <input
            className="field__input"
            id={`${id}-new`}
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            aria-describedby={`${id}-new-hint`}
            aria-invalid={tooShort || undefined}
            minLength={MIN_PASSWORD_LENGTH}
            required
          />
          <span id={`${id}-new-hint`} className="field__hint">
            At least {MIN_PASSWORD_LENGTH} characters
          </span>
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${id}-confirm`}>
            Confirm new password
          </label>
          <input
            className="field__input"
            id={`${id}-confirm`}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            aria-describedby={mismatch ? `${id}-mismatch` : undefined}
            aria-invalid={mismatch || undefined}
            required
          />
          {mismatch && (
            <span id={`${id}-mismatch`} className="field__hint field__hint--error">
              The new passwords do not match
            </span>
          )}
        </div>
        <div className="password-form__actions">
          <button className="button" type="submit" disabled={!ready || state.kind === 'saving'}>
            {state.kind === 'saving' ? 'Changing…' : 'Change password'}
          </button>
        </div>
        <p className="password-form__status" role="status" aria-live="polite">
          {state.kind === 'done' && 'Password changed. Every other browser has been signed out.'}
        </p>
        {state.kind === 'error' && (
          <p className="error" role="alert">
            {state.message}
          </p>
        )}
      </form>
    </section>
  );
}
