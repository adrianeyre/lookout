import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import pkg from '../../../../../package.json';
import { MODE_KEY, THEME_KEY } from '../../appearance.ts';
import { gridKey, PAGE_WIDGETS, type GridPage } from '../../grid/layout.ts';
import { Footer } from './Footer.tsx';

const PACKAGE_VERSION = pkg.version;

const dialogNamed = (name: string) =>
  screen
    .getAllByRole('dialog', { hidden: true })
    .find(
      (dialog) => dialog.hasAttribute('open') && within(dialog).queryByRole('heading', { name }),
    );

describe('Footer', () => {
  it('links to the source in a new tab, and says so', () => {
    render(<Footer />);
    const link = screen.getByRole('link', {
      name: /Website design, source on GitHub, opens in a new tab/,
    });
    expect(link.getAttribute('href')).toBe('https://github.com/adrianeyre/lookout');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('shows the build as its first item', () => {
    render(<Footer />);
    expect(screen.getByTestId('version').textContent).toBe(`Version: ${PACKAGE_VERSION}`);
  });

  it.each([
    [`Version: ${PACKAGE_VERSION}`, 'Changelog', /no changelog/],
    ['Credits', 'Credits', /Adrian Eyre/],
    ['Privacy policy', 'Privacy policy', /no telemetry/],
    ['Terms and conditions', 'Terms and conditions', /MIT licence/],
    ['Cookie policy', 'Cookie policy', /SameSite=Strict/],
    ['Accessibility', 'Accessibility', /\(WCAG\) 2\.2 at Level AA/],
  ])('%s opens the %s modal', async (label, title, text) => {
    const user = userEvent.setup();
    render(<Footer />);
    const opener = screen.getByRole('button', { name: label });
    expect(opener.getAttribute('aria-haspopup')).toBe('dialog');
    await user.click(opener);
    const dialog = dialogNamed(title);
    expect(dialog).toBeDefined();
    expect(dialog!.textContent).toMatch(text);
  });

  it('closes from its close button and returns focus to the opener', async () => {
    const user = userEvent.setup();
    render(<Footer />);
    const opener = screen.getByRole('button', { name: 'Privacy policy' });
    await user.click(opener);
    const close = screen.getByRole('button', { name: 'Close privacy policy' });
    expect(document.activeElement).toBe(close);
    await user.click(close);
    expect(dialogNamed('Privacy policy')).toBeUndefined();
    expect(document.activeElement).toBe(opener);
  });

  it('closes on Esc (the dialog’s cancel event) and from the Close button', async () => {
    const user = userEvent.setup();
    render(<Footer />);
    await user.click(screen.getByRole('button', { name: 'Credits' }));
    fireEvent(dialogNamed('Credits')!, new Event('cancel', { cancelable: true }));
    expect(dialogNamed('Credits')).toBeUndefined();

    await user.click(screen.getByRole('button', { name: 'Cookie policy' }));
    await user.click(within(dialogNamed('Cookie policy')!).getByRole('button', { name: 'Close' }));
    expect(dialogNamed('Cookie policy')).toBeUndefined();
  });

  it('the Cookie policy names every cookie and storage key the dashboard uses', async () => {
    const user = userEvent.setup();
    render(<Footer />);
    await user.click(screen.getByRole('button', { name: 'Cookie policy' }));
    const table = within(dialogNamed('Cookie policy')!).getByRole('table');
    const names = within(table)
      .getAllByRole('rowheader')
      .map((cell) => cell.textContent);
    expect(names).toEqual(['lookout_session', MODE_KEY, THEME_KEY, 'lookout.grid.<page>']);
    for (const page of Object.keys(PAGE_WIDGETS) as GridPage[]) {
      expect(gridKey(page)).toBe(`lookout.grid.${page}`);
      expect(table.textContent).toContain(page);
    }
  });
});
