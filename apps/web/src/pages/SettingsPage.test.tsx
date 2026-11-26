import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsPage } from './SettingsPage.tsx';

const root = document.documentElement;

afterEach(() => {
  localStorage.clear();
  root.removeAttribute('data-mode');
  root.removeAttribute('data-theme');
});

describe('SettingsPage', () => {
  it('starts on System and Teal', () => {
    render(<SettingsPage />);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /^System/ }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Teal' }).checked).toBe(true);
    expect(
      screen.getAllByRole('radio', { name: /^(Teal|Ocean|Violet|Rose|Forest|Slate)$/ }),
    ).toHaveLength(6);
  });

  it('shows a choice at once, and keeps it for next time', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<SettingsPage />);
    await user.click(screen.getByRole('radio', { name: /^Dark/ }));
    await user.click(screen.getByRole('radio', { name: 'Forest' }));
    expect(root.getAttribute('data-mode')).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('forest');
    unmount();

    render(<SettingsPage />);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /^Dark/ }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Forest' }).checked).toBe(true);
  });

  it('groups each choice under a named fieldset', () => {
    render(<SettingsPage />);
    expect(screen.getByRole('group', { name: 'Mode' })).toBeDefined();
    expect(screen.getByRole('group', { name: 'Theme' })).toBeDefined();
  });
});
