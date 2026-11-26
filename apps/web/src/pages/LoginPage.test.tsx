import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LoginPage', () => {
  it('posts the password and calls onSuccess', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetch);
    const onSuccess = vi.fn();
    render(<LoginPage onSuccess={onSuccess} />);
    await userEvent.type(screen.getByLabelText('Password'), 'hunter22');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      '/api/login',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ password: 'hunter22' }) }),
    );
  });

  it('shows the server error and clears the field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({ error: 'Too many failed attempts. Try again later.' }, { status: 429 }),
        ),
      ),
    );
    render(<LoginPage onSuccess={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Password'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Too many failed attempts. Try again later.',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('');
  });
});
