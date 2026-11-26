import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TLS_THRESHOLDS } from '@lookout/shared';
import { hostedSite, summary } from '../test-support.ts';
import { ContainerSites, EnvList, MaskedValue } from './ContainerDetailPage.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EnvList', () => {
  it('masks every value and fetches only the one revealed', async () => {
    const fetch = vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify({ name: decodeURIComponent(url.split('/').pop()!), value: 'hunter2' }),
          {
            status: 200,
          },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    render(<EnvList containerId="abc" names={['DB_PASSWORD', 'MODE']} />);
    expect(screen.getAllByTestId('env-value').map((el) => el.textContent)).toEqual([
      '••••••••',
      '••••••••',
    ]);
    expect(fetch).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Reveal DB_PASSWORD' }));
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/containers/abc/env/DB_PASSWORD', {
      credentials: 'same-origin',
    });
    expect(screen.getAllByTestId('env-value').map((el) => el.textContent)).toEqual([
      'hunter2',
      '••••••••',
    ]);

    await userEvent.click(screen.getByRole('button', { name: 'Hide DB_PASSWORD' }));
    expect(screen.queryByText('hunter2')).toBeNull();
  });

  it("offers no reveal on Lookout's own Container, and says why (#79)", () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<EnvList containerId="lookout" names={['LOOKOUT_SESSION_SECRET']} self />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('env-self').textContent).toContain("Lookout's own Container");
    expect(screen.getByTestId('env-value').textContent).toBe('••••••••');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('MaskedValue', () => {
  it('shows the masked text and fetches the real value only when revealed (#91)', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ field: 'command', key: '2', value: 's3cret' }), {
          status: 200,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    render(
      <MaskedValue
        containerId="abc"
        field="command"
        secretKey={2}
        shown="••••••••"
        label="command argument 3"
      />,
    );
    expect(screen.getByTestId('masked-value').textContent).toContain('••••••••');
    expect(fetch).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Reveal command argument 3' }));
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/containers/abc/secrets/command/2', {
      credentials: 'same-origin',
    });
    expect(screen.getByTestId('masked-value').textContent).toContain('s3cret');

    await userEvent.click(screen.getByRole('button', { name: 'Hide command argument 3' }));
    expect(screen.queryByText('s3cret')).toBeNull();
  });

  it('says why when a value cannot be revealed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'No such masked value' }), { status: 404 }),
        ),
      ),
    );
    render(
      <MaskedValue
        containerId="abc"
        field="label"
        secretKey="a.b"
        shown="••••••••"
        label="label a.b"
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reveal label a.b' }));
    expect(screen.getByRole('alert').textContent).toContain('Could not reveal label a.b');
  });
});

describe('ContainerSites', () => {
  it('lists the Hosted Sites a Container serves, Flagged ones marked', () => {
    const web = summary({ id: 'c1', name: 'shop-web-1' });
    const settings = {
      checkIntervalMs: 60_000,
      timeoutMs: 10_000,
      slowMs: 2000,
      tls: DEFAULT_TLS_THRESHOLDS,
      historyCapacity: 15,
    };
    render(
      <ContainerSites
        container={web}
        now={Date.now()}
        sites={{
          settings,
          sites: [
            hostedSite({ url: 'https://shop.example/', containerId: 'c1', status: 'down' }),
            hostedSite({ url: 'https://other.example/', containerId: 'c2' }),
          ],
        }}
      />,
    );
    const items = screen.getAllByTestId('detail-site');
    expect(items.map((item) => item.getAttribute('data-url'))).toEqual(['https://shop.example/']);
    expect(items[0]!.textContent).toContain('Flagged: Down');
    expect(screen.getByRole('link', { name: 'https://shop.example/' }).getAttribute('href')).toBe(
      '/websites',
    );
  });

  it('shows nothing for a Container that serves no Hosted Site', () => {
    const { container } = render(
      <ContainerSites container={summary({ id: 'c9' })} now={Date.now()} sites={undefined} />,
    );
    expect(container.innerHTML).toBe('');
  });
});
