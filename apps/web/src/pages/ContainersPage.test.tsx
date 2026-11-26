import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { summary } from '../test-support.ts';
import { ContainerList } from './ContainersPage.tsx';

const NOW = Date.parse('2026-11-25T12:00:00Z');

const containers = [
  summary({
    id: 'web',
    composeProject: 'shop',
    image: 'nginx:1.29',
    health: 'healthy',
    startedAt: NOW - (3 * 3600 + 5 * 60) * 1000,
    ports: [
      { privatePort: 80, publicPort: 8080, protocol: 'tcp', ip: '0.0.0.0' },
      { privatePort: 80, publicPort: 8080, protocol: 'tcp', ip: '::' },
    ],
  }),
  summary({ id: 'db', composeProject: 'shop', image: 'postgres:17', health: 'unhealthy' }),
  summary({ id: 'worker', composeProject: 'shop', state: 'restarting' }),
  summary({ id: 'alpha', composeProject: 'blog', image: 'ghost:6' }),
  summary({
    id: 'migrate',
    state: 'exited',
    exitCode: 1,
    finishedAt: NOW - 12 * 60_000,
  }),
  summary({ id: 'backup', state: 'exited', exitCode: 0, finishedAt: NOW - 60_000 }),
  summary({ id: 'cache', state: 'paused' }),
  summary({ id: 'fresh', state: 'created', exitCode: null, startedAt: null }),
];

function renderList() {
  render(
    <ContainerList
      snapshot={{ available: true, containers }}
      stats={
        new Map([
          [
            'web',
            {
              containerId: 'web',
              cpuPercent: 3.5,
              memoryUsedBytes: 64 * 1024 ** 2,
              memoryLimitBytes: 1024 ** 3,
            },
          ],
        ])
      }
      now={NOW}
    />,
  );
}

const names = () => screen.queryAllByTestId('container-name').map((el) => el.textContent);

afterEach(() => localStorage.clear());

describe('ContainerList', () => {
  it('opens and closes each Compose Project from its heading, starting open', async () => {
    const user = userEvent.setup();
    renderList();
    const toggle = screen.getByRole('button', { name: /^shop/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const shop = screen.getByRole('region', { name: 'shop' });
    expect(within(shop).getAllByTestId('container-name')).toHaveLength(3);

    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(shop).queryAllByRole('listitem')).toHaveLength(0);
    // The others stay open.
    const blog = screen.getByRole('region', { name: 'blog' });
    expect(within(blog).getAllByTestId('container-name')).toHaveLength(1);

    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(shop).getAllByTestId('container-name')).toHaveLength(3);
  });

  it('remembers a closed Compose Project in this browser', async () => {
    const user = userEvent.setup();
    const first = render(
      <ContainerList snapshot={{ available: true, containers }} stats={new Map()} now={NOW} />,
    );
    await user.click(screen.getByRole('button', { name: /^blog/ }));
    first.unmount();
    render(
      <ContainerList snapshot={{ available: true, containers }} stats={new Map()} now={NOW} />,
    );
    expect(screen.getByRole('button', { name: /^blog/ }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(screen.getByRole('button', { name: /^shop/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('groups by Compose Project with Standalone last', () => {
    renderList();
    expect(screen.getAllByTestId('group-name').map((el) => el.textContent)).toEqual([
      'blog',
      'shop',
      'Standalone',
    ]);
    const shop = screen.getByRole('region', { name: 'shop' });
    expect(
      within(shop)
        .getAllByTestId('container-name')
        .map((el) => el.textContent),
    ).toEqual(['db', 'web', 'worker']);
  });

  it('shows state, health, uptime or exit, stats and ports', () => {
    renderList();
    const row = (name: string) =>
      screen.getAllByTestId('container-row').find((el) => el.dataset.name === name)!;
    expect(within(row('web')).getByTestId('container-status').textContent).toBe('Up 3h 5m');
    expect(within(row('web')).getByTestId('container-health').textContent).toBe('healthy');
    expect(within(row('web')).getByTestId('container-cpu').textContent).toBe('CPU 3.5%');
    expect(within(row('web')).getByTestId('container-memory').textContent).toBe(
      'Mem 64.0 MiB / 1.00 GiB',
    );
    expect(within(row('web')).getByTestId('container-ports').textContent).toBe('8080→80/tcp');
    expect(within(row('migrate')).getByTestId('container-status').textContent).toBe(
      'Exited (1) 12m ago',
    );
    expect(within(row('fresh')).getByTestId('container-status').textContent).toBe('Created');
    expect(within(row('cache')).getByTestId('container-state').textContent).toBe('paused');
  });

  it('marks Flagged Containers with an icon and a reason', () => {
    renderList();
    const flagged = screen
      .getAllByTestId('container-row')
      .filter((el) => el.dataset.flagged === 'true')
      .map((el) => el.dataset.name);
    expect(flagged.sort()).toEqual(['db', 'migrate', 'worker']);
    expect(screen.getAllByTestId('container-flag').map((el) => el.textContent)).toEqual(
      expect.arrayContaining(['⚑Flagged: Unhealthy', '⚑Flagged: Exited with code 1']),
    );
  });

  it('filters by text, state and Flagged only', async () => {
    renderList();
    await userEvent.type(screen.getByRole('searchbox'), 'POSTGRES');
    expect(names()).toEqual(['db']);
    await userEvent.clear(screen.getByRole('searchbox'));

    await userEvent.selectOptions(screen.getByLabelText('State'), 'exited');
    expect(names()).toEqual(['backup', 'migrate']);
    await userEvent.selectOptions(screen.getByLabelText('State'), 'all');

    await userEvent.click(screen.getByLabelText('Flagged only'));
    expect(names().sort()).toEqual(['db', 'migrate', 'worker']);
    expect(screen.getByTestId('container-count').textContent).toBe('Showing 3 of 8 Containers');
  });

  it('says Docker is unavailable', () => {
    render(
      <ContainerList snapshot={{ available: false, containers: [] }} stats={new Map()} now={NOW} />,
    );
    expect(screen.getByTestId('docker-unavailable').textContent).toContain('Docker unavailable');
  });
});
