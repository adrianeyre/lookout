import { describe, expect, it } from 'vitest';
import type { FolderScan } from '@lookout/shared';
import { scanStatusText } from './folders.ts';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const HOUR = 3_600_000;
const scan = (changes: Partial<FolderScan>): FolderScan => ({
  state: 'done',
  folders: [],
  startedAt: NOW - 2 * HOUR - 180_000,
  finishedAt: NOW - 2 * HOUR,
  walked: 0,
  unreadable: 0,
  partial: false,
  error: null,
  nextAt: NOW + 4 * HOUR,
  ...changes,
});

describe('scanStatusText', () => {
  it('says when it scanned, how long it took, and when it scans next', () => {
    expect(scanStatusText(scan({}), NOW)).toBe('Scanned 2h 0m ago, in 3m · next in 4h 0m');
  });

  it('counts the folders walked while it scans', () => {
    expect(scanStatusText(scan({ state: 'scanning', walked: 12_345 }), NOW)).toBe(
      'Scanning… 12,345 folders so far',
    );
  });

  it('says when the first scan will be', () => {
    expect(
      scanStatusText(scan({ state: 'waiting', finishedAt: null, nextAt: NOW + 30_000 }), NOW),
    ).toBe('Next in 30s');
  });

  it('says it scans only when asked when nothing is scheduled', () => {
    expect(scanStatusText(scan({ state: 'waiting', finishedAt: null, nextAt: null }), NOW)).toBe(
      'Not scanned yet',
    );
    expect(scanStatusText(scan({ nextAt: null }), NOW)).toBe(
      'Scanned 2h 0m ago, in 3m · scans only when you ask',
    );
  });

  it('says why a scan failed', () => {
    expect(scanStatusText(scan({ state: 'failed', error: 'No such file' }), NOW)).toMatch(
      /^The last scan failed: No such file/,
    );
  });
});
