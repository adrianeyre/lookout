import type { StatsBucket } from '@lookout/shared';

/**
 * Site Stats' hours and days are the server's local ones (the Container's TZ, UTC unless it is
 * set), so "today" and 03:00 match the Host's clock.
 */
export function hourStart(ts: number): number {
  const date = new Date(ts);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

export function dayStart(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function bucketStart(bucket: StatsBucket, ts: number): number {
  return bucket === 'hour' ? hourStart(ts) : dayStart(ts);
}

/** The start of the next hour or day; a day may be 23 or 25 hours long across a DST change. */
export function bucketEnd(bucket: StatsBucket, start: number): number {
  const date = new Date(start);
  if (bucket === 'hour') date.setHours(date.getHours() + 1);
  else date.setDate(date.getDate() + 1);
  return date.getTime();
}

/** The starts of the last `count` hours or days, oldest first, ending with the one `now` is in. */
export function bucketStarts(bucket: StatsBucket, count: number, now: number): number[] {
  const starts: number[] = [];
  const date = new Date(bucketStart(bucket, now));
  for (let i = 0; i < count; i++) {
    starts.unshift(date.getTime());
    if (bucket === 'hour') date.setHours(date.getHours() - 1);
    else date.setDate(date.getDate() - 1);
  }
  return starts;
}

/** The next time the clock reads `hour`:00 after `now`. */
export function nextAt(hour: number, now: number): number {
  const date = new Date(now);
  date.setHours(hour, 0, 0, 0);
  if (date.getTime() <= now) date.setDate(date.getDate() + 1);
  return date.getTime();
}
