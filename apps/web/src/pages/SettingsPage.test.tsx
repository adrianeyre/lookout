import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage.tsx';

const root = document.documentElement;

/** Answers /api/session and /api/password as the server would. */
function fakeServer(options: { changeable: boolean; currentPassword?: string }) {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ url, body });
      if (url === '/api/session') {
        return Response.json({ authenticated: true, passwordChangeable: options.changeable });
      }
      if (url === '/api/password') {
        const { currentPassword } = body as { currentPassword: string };
        if (currentPassword !== options.currentPassword) {
          return Response.json({ error: 'The current password is incorrect' }, { status: 403 });
        }
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    }),
  );
  return calls;
}

beforeEach(() => {
  fakeServer({ changeable: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
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

describe('Password', () => {
  it('changes the password with the current one and the new one twice', async () => {
    const calls = fakeServer({ changeable: true, currentPassword: 'old password' });
    const user = userEvent.setup();
    render(<SettingsPage />);
    const current = await screen.findByLabelText('Current password');
    const submit = screen.getByRole('button', { name: 'Change password' });
    expect(submit).toHaveProperty('disabled', true);

    await user.type(current, 'old password');
    await user.type(screen.getByLabelText('New password'), 'new password');
    await user.type(screen.getByLabelText('Confirm new password'), 'new passworx');
    expect(screen.getByText('The new passwords do not match')).toBeDefined();
    expect(submit).toHaveProperty('disabled', true);

    await user.clear(screen.getByLabelText('Confirm new password'));
    await user.type(screen.getByLabelText('Confirm new password'), 'new password');
    await user.click(submit);
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Password changed/));
    expect(calls.at(-1)).toEqual({
      url: '/api/password',
      body: { currentPassword: 'old password', newPassword: 'new password' },
    });
    expect(screen.getByLabelText<HTMLInputElement>('Current password').value).toBe('');
  });

  it('shows why a change was refused', async () => {
    fakeServer({ changeable: true, currentPassword: 'old password' });
    const user = userEvent.setup();
    render(<SettingsPage />);
    await user.type(await screen.findByLabelText('Current password'), 'wrong');
    await user.type(screen.getByLabelText('New password'), 'new password');
    await user.type(screen.getByLabelText('Confirm new password'), 'new password');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The current password is incorrect',
    );
  });

  it('explains how to change it in .env when this Lookout keeps no data', async () => {
    render(<SettingsPage />);
    expect(await screen.findByText(/can only be changed in its/)).toBeDefined();
    expect(screen.queryByLabelText('Current password')).toBeNull();
  });
});
