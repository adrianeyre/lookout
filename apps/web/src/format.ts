const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/** Bytes in binary units, as `free -h` and `df -h` show them: 1.5 GiB, 812 MiB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatPercent(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(value >= 99.95 || value === 0 ? 0 : 1)}%`;
}

/** Uptime as "12d 4h 3m", dropping leading zero units. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${s}s`;
}

export function formatLoad(value: number): string {
  return value.toFixed(2);
}

/** Throughput such as "1.50 MiB/s", or a dash before there is a rate. */
export function formatRate(bytesPerSecond: number | null): string {
  return bytesPerSecond === null ? '—' : `${formatBytes(bytesPerSecond)}/s`;
}

/** How long ago a time was, coarsely: "45s", "12m", "3h 5m", "2d 4h". */
export function formatAgo(timestamp: number, now: number): string {
  return formatDuration(Math.max(0, (now - timestamp) / 1000))
    .split(' ')
    .slice(0, 2)
    .join(' ');
}

/** A timestamp as local date and time to the second, e.g. "2026-11-25 14:03:07". */
export function formatTimestamp(timestamp: number | null): string {
  if (timestamp === null) return '—';
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
