import type { FolderScan } from '@lookout/shared';
import { formatAgo, formatDuration } from './format.ts';

/**
 * What the Largest folders Widget says about the scan: when it ran and how long it took, or
 * how far it has got, and when the next one is.
 */
export function scanStatusText(scan: FolderScan, now: number): string {
  if (scan.state === 'scanning') {
    return `Scanning… ${scan.walked.toLocaleString('en-GB')} folders so far`;
  }
  const parts: string[] = [];
  if (scan.state === 'failed') parts.push(`The last scan failed: ${scan.error ?? 'unknown error'}`);
  if (scan.state === 'done' && scan.finishedAt !== null && scan.startedAt !== null) {
    parts.push(
      `Scanned ${formatAgo(scan.finishedAt, now)} ago, in ${formatDuration((scan.finishedAt - scan.startedAt) / 1000)}`,
    );
  }
  if (scan.state === 'waiting' && scan.nextAt === null) parts.push('Not scanned yet');
  if (scan.nextAt !== null) {
    parts.push(`next in ${formatAgo(now, scan.nextAt)}`);
  } else if (scan.state !== 'waiting') {
    parts.push('scans only when you ask');
  }
  const text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
