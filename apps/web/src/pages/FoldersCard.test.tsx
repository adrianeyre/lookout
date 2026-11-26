import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOLDER_SCAN_PATH, type FolderScan } from '@lookout/shared';
import { FoldersCard } from './HostPage.tsx';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const GiB = 1024 ** 3;
const done: FolderScan = {
  state: 'done',
  folders: [
    {
      path: '/var/lib/docker/volumes',
      bytes: 120 * GiB,
      mountPoint: '/',
      diskBytes: 468 * GiB,
      percentOfDisk: 25.6,
    },
    {
      path: '/srv/media/films',
      bytes: 900 * GiB,
      mountPoint: '/srv/media',
      diskBytes: 3600 * GiB,
      percentOfDisk: 25,
    },
  ],
  startedAt: NOW - 600_000,
  finishedAt: NOW - 420_000,
  walked: 50_000,
  unreadable: 0,
  partial: false,
  error: null,
  nextAt: NOW + 3_600_000,
};

afterEach(() => vi.restoreAllMocks());

describe('FoldersCard', () => {
  it('lists each folder with its size and a bar of its share of its disk', () => {
    render(<FoldersCard scan={done} now={NOW} />);
    const rows = screen.getAllByTestId('folder');
    expect(rows).toHaveLength(2);
    expect(screen.getAllByTestId('folder-path').map((el) => el.textContent)).toEqual([
      '/var/lib/docker/volumes',
      '/srv/media/films',
    ]);
    const meter = screen.getByRole('meter', { name: '/var/lib/docker/volumes uses 25.6% of /' });
    expect(meter.getAttribute('aria-valuenow')).toBe('26');
    expect(screen.getByTestId('folders-status').textContent).toMatch(/^Scanned 7m ago/);
    expect(screen.queryByTestId('folders-unreadable')).toBeNull();
  });

  it('says how many folders it could not read, and never advises running as root (#108)', () => {
    render(<FoldersCard scan={{ ...done, unreadable: 3 }} now={NOW} />);
    const note = screen.getByTestId('folders-unreadable').textContent;
    expect(note).toMatch(/^3 folders could not be read, so these sizes leave them out\.$/);
    expect(note).not.toMatch(/root|0:0/);
  });

  it('says when a scan stopped at its limits (#109)', () => {
    render(<FoldersCard scan={done} now={NOW} />);
    expect(screen.queryByTestId('folders-partial')).toBeNull();
    cleanup();
    render(<FoldersCard scan={{ ...done, partial: true }} now={NOW} />);
    expect(screen.getByTestId('folders-partial').textContent).toMatch(/stopped early/);
  });

  it('says home folders are never scanned (#107)', () => {
    render(<FoldersCard scan={done} now={NOW} />);
    expect(screen.getByTestId('folders-private').textContent).toBe(
      'Home folders (/home and /root) are never scanned.',
    );
  });

  it('isolates folder paths in <bdi> (#112)', () => {
    render(<FoldersCard scan={done} now={NOW} />);
    for (const cell of screen.getAllByTestId('folder-path')) {
      expect(cell.firstElementChild?.tagName).toBe('BDI');
    }
  });

  it('Scan now asks the server to scan', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ ...done, state: 'scanning' }), { status: 202 }),
      );
    const user = userEvent.setup();
    render(<FoldersCard scan={done} now={NOW} />);
    await user.click(screen.getByRole('button', { name: 'Scan now' }));
    expect(fetch).toHaveBeenCalledWith(
      FOLDER_SCAN_PATH,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('cannot be asked to scan while a scan runs', () => {
    render(<FoldersCard scan={{ ...done, state: 'scanning', walked: 10 }} now={NOW} />);
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Scanning…' });
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId('folders-status').textContent).toBe('Scanning… 10 folders so far');
  });
});
