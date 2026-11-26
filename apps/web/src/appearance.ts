import { useSyncExternalStore } from 'react';

/**
 * The reader's appearance Settings: the mode (System, Light or Dark) and one of six themes.
 * Each is kept in this browser's local storage, never sent to the server, and shown by
 * data-mode and data-theme on <html>, which styles.css reads. public/appearance.js applies the
 * saved ones before the first paint, so there is no flash of the wrong colours.
 */
export type Mode = 'system' | 'light' | 'dark';
export type Theme = 'teal' | 'ocean' | 'violet' | 'rose' | 'forest' | 'slate';

/** Kept in step with public/appearance.js. */
export const MODE_KEY = 'lookout.mode';
export const THEME_KEY = 'lookout.theme';

export const MODES: readonly { id: Mode; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

export const THEMES: readonly { id: Theme; label: string }[] = [
  { id: 'teal', label: 'Teal' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'violet', label: 'Violet' },
  { id: 'rose', label: 'Rose' },
  { id: 'forest', label: 'Forest' },
  { id: 'slate', label: 'Slate' },
];

export const DEFAULT_MODE: Mode = 'system';
export const DEFAULT_THEME: Theme = 'teal';

/** Storage can be missing or refuse (a private window, blocked site data); Settings still work for the visit. */
function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Not saved, but still shown for this visit.
  }
}

export function readMode(): Mode {
  const saved = read(MODE_KEY);
  return MODES.find(({ id }) => id === saved)?.id ?? DEFAULT_MODE;
}

export function readTheme(): Theme {
  const saved = read(THEME_KEY);
  return THEMES.find(({ id }) => id === saved)?.id ?? DEFAULT_THEME;
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/** Shows a mode and a theme on <html>. The defaults need no attribute. */
export function applyAppearance(mode: Mode, theme: Theme): void {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-mode');
  else root.setAttribute('data-mode', mode);
  if (theme === DEFAULT_THEME) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  notify();
}

export function chooseMode(mode: Mode): void {
  write(MODE_KEY, mode === DEFAULT_MODE ? null : mode);
  applyAppearance(mode, readTheme());
}

export function chooseTheme(theme: Theme): void {
  write(THEME_KEY, theme === DEFAULT_THEME ? null : theme);
  applyAppearance(readMode(), theme);
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const media = typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null;
  media?.addEventListener('change', listener);
  return () => {
    listeners.delete(listener);
    media?.removeEventListener('change', listener);
  };
}

/** Light or dark as shown now: the chosen mode, or the system's under System. */
export function resolvedMode(): 'light' | 'dark' {
  const mode = document.documentElement.getAttribute('data-mode');
  if (mode === 'light' || mode === 'dark') return mode;
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches
    ? 'dark'
    : 'light';
}

/** The mode as shown, following both Settings and the system as they change. */
export function useResolvedMode(): 'light' | 'dark' {
  return useSyncExternalStore(subscribe, resolvedMode, () => 'light');
}
