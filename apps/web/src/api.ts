import type { ApiError } from '@lookout/shared';

export type LoginResult = { ok: true } | { ok: false; message: string };

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as Partial<ApiError>;
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

export async function login(password: string): Promise<LoginResult> {
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
      credentials: 'same-origin',
    });
    if (response.ok) return { ok: true };
    return { ok: false, message: await errorMessage(response, 'Sign-in failed') };
  } catch {
    return { ok: false, message: 'Lookout cannot be reached. Check your connection.' };
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  } finally {
    window.location.assign('/login');
  }
}

/** True if the session is valid, false if it has expired, null if the server is unreachable. */
export async function checkSession(): Promise<boolean | null> {
  try {
    const response = await fetch('/api/session', { credentials: 'same-origin' });
    if (response.status === 401) return false;
    return response.ok ? true : null;
  } catch {
    return null;
  }
}

export type FetchResult<T> =
  { ok: true; value: T } | { ok: false; status: number; message: string };

/** GETs JSON from the API, turning failures into a message for the page. */
export async function getJson<T>(url: string): Promise<FetchResult<T>> {
  try {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (response.status === 401) {
      window.location.assign('/login');
      return { ok: false, status: 401, message: 'Not signed in' };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: await errorMessage(response, `Request failed (${response.status})`),
      };
    }
    return { ok: true, value: (await response.json()) as T };
  } catch {
    return { ok: false, status: 0, message: 'Lookout cannot be reached. Check your connection.' };
  }
}

/** POSTs JSON to the API (same origin, so the server's Origin check passes). */
export async function postJson<T>(url: string, body: unknown = {}): Promise<FetchResult<T>> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
    if (response.status === 401) {
      window.location.assign('/login');
      return { ok: false, status: 401, message: 'Not signed in' };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: await errorMessage(response, `Request failed (${response.status})`),
      };
    }
    return { ok: true, value: (await response.json()) as T };
  } catch {
    return { ok: false, status: 0, message: 'Lookout cannot be reached. Check your connection.' };
  }
}
