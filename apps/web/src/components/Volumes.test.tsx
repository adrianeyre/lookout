import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DockerVolume } from '@lookout/shared';
import { unusedVolumes, volumesOf, type VolumesState } from '../volumes.ts';
import { ContainerVolumes, UnusedVolumesCard } from './Volumes.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

const volume = (overrides: Partial<DockerVolume> & { name: string }): DockerVolume => ({
  driver: 'local',
  createdAt: Date.parse('2026-11-20T10:00:00Z'),
  project: null,
  sizeBytes: 2_500_000,
  usedBy: [],
  ...overrides,
});

const VOLUMES: DockerVolume[] = [
  volume({
    name: 'shop_pgdata',
    project: 'shop',
    usedBy: [
      {
        containerId: 'db1',
        containerName: 'shop-db-1',
        destination: '/var/lib/postgresql',
        readOnly: false,
      },
    ],
  }),
  volume({
    name: 'shop_static',
    sizeBytes: null,
    usedBy: [
      { containerId: 'db1', containerName: 'shop-db-1', destination: '/static', readOnly: true },
      { containerId: 'web1', containerName: 'shop-web-1', destination: '/srv', readOnly: false },
    ],
  }),
  volume({ name: 'old_cache', project: 'old' }),
  volume({ name: 'stray', sizeBytes: 500_000, createdAt: null }),
];

const ok = (volumes = VOLUMES): VolumesState => ({
  status: 'ok',
  snapshot: { volumes, sizesMeasuredAt: 1 },
});

describe('volumesOf and unusedVolumes', () => {
  it('finds a Container’s volumes and the volumes nothing uses', () => {
    expect(volumesOf(VOLUMES, 'db1').map((v) => [v.volume.name, v.destination])).toEqual([
      ['shop_pgdata', '/var/lib/postgresql'],
      ['shop_static', '/static'],
    ]);
    expect(volumesOf(VOLUMES, 'nobody')).toEqual([]);
    expect(unusedVolumes(VOLUMES).map((v) => v.name)).toEqual(['old_cache', 'stray']);
  });
});

describe('ContainerVolumes', () => {
  it('lists each volume a Container mounts, where, and its size', () => {
    render(<ContainerVolumes state={ok()} containerId="db1" />);
    const items = screen.getAllByTestId('container-volume').map((item) => item.textContent);
    expect(items[0]).toContain('shop_pgdata');
    expect(items[0]).toContain('/var/lib/postgresql');
    expect(items[0]).toContain('2.38 MiB');
    expect(items[1]).toContain('(read-only)');
    expect(items[1]).toContain('size not measured yet');
  });

  it('shows nothing for a Container without volumes, or before they load', () => {
    const { container, rerender } = render(<ContainerVolumes state={ok()} containerId="nobody" />);
    expect(container.textContent).toBe('');
    rerender(<ContainerVolumes state={{ status: 'loading' }} containerId="db1" />);
    expect(container.textContent).toBe('');
  });
});

describe('UnusedVolumesCard', () => {
  it('lists only the unused volumes, with their total', () => {
    render(<UnusedVolumesCard state={ok()} refresh={() => undefined} />);
    const rows = screen.getAllByTestId('unused-volume');
    expect(rows.map((row) => row.getAttribute('data-name'))).toEqual(['old_cache', 'stray']);
    expect(rows[0]!.textContent).toContain('Compose Project old');
    expect(rows[0]!.textContent).toContain('created 20 Nov 2026');
    expect(screen.getByTestId('volumes-unused-count').textContent).toContain('2 volumes');
    expect(screen.getByTestId('volumes-unused-count').textContent).toContain('2.86 MiB');
  });

  it('says so when every volume is used, and shows a load error', () => {
    const { rerender } = render(
      <UnusedVolumesCard state={ok(VOLUMES.slice(0, 2))} refresh={() => undefined} />,
    );
    expect(screen.getByTestId('volumes-none-unused')).toBeTruthy();
    rerender(
      <UnusedVolumesCard
        state={{ status: 'error', message: 'Docker unavailable' }}
        refresh={() => undefined}
      />,
    );
    expect(screen.getByTestId('volumes-error').textContent).toBe('Docker unavailable');
  });

  it('deletes only after the exact name is typed, then refreshes', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ deleted: 'stray' }))));
    vi.stubGlobal('fetch', fetch);
    const refresh = vi.fn();
    render(<UnusedVolumesCard state={ok()} refresh={refresh} />);
    const stray = screen.getAllByTestId('unused-volume')[1]!;
    await userEvent.click(within(stray).getByTestId('volume-delete'));
    const dialog = screen.getByTestId('volume-delete-dialog');
    const confirm = within(dialog).getByTestId('volume-confirm-delete');
    expect(confirm).toHaveProperty('disabled', true);
    await userEvent.type(within(dialog).getByTestId('volume-confirm-name'), 'stra');
    expect(confirm).toHaveProperty('disabled', true);
    await userEvent.type(within(dialog).getByTestId('volume-confirm-name'), 'y');
    await userEvent.click(confirm);
    expect(fetch).toHaveBeenCalledWith(
      '/api/volumes/stray/delete',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ confirmName: 'stray' }) }),
    );
    expect((await screen.findByTestId('volume-delete-result')).textContent).toBe('Deleted stray');
    expect(refresh).toHaveBeenCalled();
  });

  it('cancelling deletes nothing', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<UnusedVolumesCard state={ok()} refresh={() => undefined} />);
    await userEvent.click(screen.getAllByTestId('volume-delete')[0]!);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('volume-delete-dialog')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows the server's refusal", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: 'In use by shop-db-1; only unused volumes can be deleted' }),
            {
              status: 409,
            },
          ),
        ),
      ),
    );
    render(<UnusedVolumesCard state={ok()} refresh={() => undefined} />);
    await userEvent.click(screen.getAllByTestId('volume-delete')[0]!);
    await userEvent.type(screen.getByTestId('volume-confirm-name'), 'old_cache');
    await userEvent.click(screen.getByTestId('volume-confirm-delete'));
    expect((await screen.findByTestId('volume-delete-result')).textContent).toMatch(
      /In use by shop-db-1/,
    );
  });
});
