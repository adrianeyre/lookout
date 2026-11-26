/** A percentage rounded to one decimal place, clamped to 0–100. Zero when the whole is zero. */
export function percent(part: number, whole: number): number {
  if (!(whole > 0)) return 0;
  const value = (part / whole) * 100;
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}
