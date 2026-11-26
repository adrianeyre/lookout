import { useState, type SubmitEvent } from 'react';
import { login } from '../api.ts';
import { useResolvedMode } from '../appearance.ts';
import logoDark from '../brand/logo-dark.svg';
import logo from '../brand/logo.svg';
import { Footer } from '../components/footer/Footer.tsx';

export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const resolved = useResolvedMode();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await login(password);
    setBusy(false);
    if (result.ok) onSuccess();
    else {
      setError(result.message);
      setPassword('');
    }
  };

  return (
    <div className="shell">
      <main className="login">
        <form className="login__form card" onSubmit={(event) => void submit(event)}>
          <img
            className="login__logo"
            src={resolved === 'dark' ? logoDark : logo}
            alt="Lookout"
            width="174"
            height="48"
          />
          <h1 className="login__title">Sign in</h1>
          <label className="field">
            <span className="field__label">Password</span>
            <input
              className="field__input"
              type="password"
              name="password"
              autoComplete="current-password"
              required
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error && (
            <p className="login__error" role="alert">
              {error}
            </p>
          )}
          <button className="button" type="submit" disabled={busy || password.length === 0}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </main>
      <Footer />
    </div>
  );
}
