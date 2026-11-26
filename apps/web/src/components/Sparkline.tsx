export interface SparklineSeries {
  /** Oldest first. Null is a gap, such as the first CPU sample. */
  values: (number | null)[];
  /** Picks the series' colour: "primary" or "secondary". */
  tone: 'primary' | 'secondary';
}

const WIDTH = 100;
const HEIGHT = 28;

/** The SVG path for one series, positioned so the newest point is at the right edge. */
export function sparklinePath(values: (number | null)[], capacity: number, max: number): string {
  const slots = Math.max(2, capacity);
  const offset = slots - values.length;
  let path = '';
  let drawing = false;
  values.forEach((value, i) => {
    if (value === null) {
      drawing = false;
      return;
    }
    const x = ((offset + i) / (slots - 1)) * WIDTH;
    const y = HEIGHT - (Math.min(Math.max(value, 0), max) / max) * (HEIGHT - 2) - 1;
    path += `${drawing ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`;
    drawing = true;
  });
  return path;
}

/**
 * A small line chart of the Live Window (FR-13). Percentages scale to 100; rates scale to
 * the largest value in view.
 */
export function Sparkline({
  series,
  capacity,
  max,
  label,
  testId,
}: {
  series: SparklineSeries[];
  capacity: number;
  /** The value at the top of the chart; defaults to the largest value shown. */
  max?: number;
  label: string;
  testId?: string;
}) {
  const largest = Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
  const top = max ?? (largest > 0 ? largest : 1);
  const points = Math.max(0, ...series.map((s) => s.values.length));
  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      data-testid={testId}
      data-points={points}
      data-grow
    >
      {series.map((s, i) => (
        <path
          key={i}
          className={`sparkline__line sparkline__line--${s.tone}`}
          d={sparklinePath(s.values, capacity, top)}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}
