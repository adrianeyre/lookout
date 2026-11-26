import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyAppearance,
  chooseMode,
  chooseTheme,
  MODE_KEY,
  readMode,
  readTheme,
  resolvedMode,
  THEME_KEY,
} from './appearance.ts';

const root = document.documentElement;

afterEach(() => {
  localStorage.clear();
  root.removeAttribute('data-mode');
  root.removeAttribute('data-theme');
  vi.restoreAllMocks();
});

describe('appearance', () => {
  it('defaults to System and Teal, with no attributes', () => {
    expect(readMode()).toBe('system');
    expect(readTheme()).toBe('teal');
    applyAppearance('system', 'teal');
    expect(root.hasAttribute('data-mode')).toBe(false);
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('shows and saves a chosen mode and theme', () => {
    chooseMode('dark');
    chooseTheme('rose');
    expect(root.getAttribute('data-mode')).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('rose');
    expect(localStorage.getItem(MODE_KEY)).toBe('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('rose');
    expect(resolvedMode()).toBe('dark');
  });

  it('forgets the defaults rather than saving them', () => {
    chooseMode('light');
    chooseMode('system');
    chooseTheme('slate');
    chooseTheme('teal');
    expect(localStorage.getItem(MODE_KEY)).toBeNull();
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it('ignores a saved value it does not know', () => {
    localStorage.setItem(MODE_KEY, 'sepia');
    localStorage.setItem(THEME_KEY, '"><script>');
    expect(readMode()).toBe('system');
    expect(readTheme()).toBe('teal');
  });

  it('still shows a choice when storage refuses it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    chooseMode('dark');
    expect(root.getAttribute('data-mode')).toBe('dark');
  });
});
