// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEMES } from './appearance.ts';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

/** The custom properties set by the first rule with exactly this selector. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`styles.css has no ${selector}`);
  const body = css.slice(start + selector.length + 2, css.indexOf('}', start));
  return Object.fromEntries(
    [...body.matchAll(/(--color-[\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]),
  );
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const light = tokens(':root');
const dark = { ...light, ...tokens(":root[data-mode='dark']") };

function palette(mode: 'light' | 'dark', theme: string): Record<string, string> {
  const base = mode === 'light' ? light : dark;
  if (theme === 'teal') return base;
  const selector =
    mode === 'light'
      ? `:root[data-theme='${theme}']`
      : `:root[data-theme='${theme}'][data-mode='dark']`;
  return { ...base, ...tokens(selector) };
}

describe.each(['light', 'dark'] as const)('%s mode', (mode) => {
  describe.each(THEMES.map(({ id }) => id))('the %s theme meets WCAG 2.2 AA', (theme) => {
    const t = palette(mode, theme);
    const c = (name: string) => t[`--color-${name}`]!;

    it.each([
      ['text', 'bg'],
      ['text', 'surface'],
      ['text-muted', 'bg'],
      ['text-muted', 'surface'],
      ['text-muted', 'surface-muted'],
      ['accent', 'bg'],
      ['accent', 'surface'],
      ['on-accent', 'accent'],
      ['on-accent', 'accent-strong'],
    ])('%s on %s has at least 4.5:1 (text)', (fg, bg) => {
      expect(contrast(c(fg), c(bg))).toBeGreaterThanOrEqual(4.5);
    });

    it.each([
      ['meter', 'meter-track'],
      ['meter', 'surface'],
      ['accent', 'surface-muted'],
      ['focus', 'bg'],
      ['focus', 'surface'],
    ])('%s on %s has at least 3:1 (non-text)', (fg, bg) => {
      expect(contrast(c(fg), c(bg))).toBeGreaterThanOrEqual(3);
    });
  });
});

describe('the System mode', () => {
  it('uses the same dark colours as Dark', () => {
    const media = css.slice(
      css.indexOf("@media (prefers-color-scheme: dark) {\n  :root:not([data-mode='light']) {"),
    );
    const body = media.slice(0, media.indexOf('}'));
    const fromMedia = Object.fromEntries(
      [...body.matchAll(/(--color-[\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]),
    );
    expect(fromMedia).toEqual(tokens(":root[data-mode='dark']"));
  });

  it.each(THEMES.filter(({ id }) => id !== 'teal').map(({ id }) => id))(
    'uses the same dark %s colours as Dark',
    (theme) => {
      const selector = `:root[data-theme='${theme}']:not([data-mode='light'])`;
      expect(tokens(selector)).toEqual(tokens(`:root[data-theme='${theme}'][data-mode='dark']`));
    },
  );
});
