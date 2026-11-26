import type { ReactNode } from 'react';
import type { StatsBucket } from '@lookout/shared';

/**
 * Charts for the Site Stats page and the Docker disk card: plain SVG, no library. Each has a
 * legend, its first and last time and its top value as text, a tooltip per point, and a
 * visually-hidden summary, so a screen reader gets the figures the picture shows.
 */

export type ChartTone = 'primary' | 'secondary' | 'ok' | 'warn' | 'critical' | 'muted';

export interface ChartSeries {
  name: string;
  /** One value per point, oldest first. Null is a gap: no data for that point. */
  values: (number | null)[];
  tone: ChartTone;
}

const WIDTH = 100;
const HEIGHT = 40;

/** The top of the value axis: the largest value (or stacked total) shown, at least 1. */
export function chartMax(series: readonly ChartSeries[], stacked = false): number {
  let largest = 0;
  if (stacked) {
    const points = Math.max(0, ...series.map((s) => s.values.length));
    for (let i = 0; i < points; i++) {
      largest = Math.max(
        largest,
        series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0),
      );
    }
  } else {
    for (const s of series) for (const v of s.values) largest = Math.max(largest, v ?? 0);
  }
  return largest > 0 ? largest : 1;
}

const xOf = (index: number, points: number) =>
  points <= 1 ? WIDTH / 2 : (index / (points - 1)) * WIDTH;
const yOf = (value: number, max: number) =>
  HEIGHT - (Math.min(Math.max(value, 0), max) / max) * (HEIGHT - 2) - 1;

/** The SVG path of one line, with a gap wherever a value is null. */
export function linePath(values: readonly (number | null)[], max: number): string {
  let path = '';
  let drawing = false;
  values.forEach((value, i) => {
    if (value === null) {
      drawing = false;
      return;
    }
    const x = xOf(i, values.length).toFixed(2);
    const y = yOf(value, max).toFixed(2);
    path += `${drawing ? 'L' : 'M'}${x} ${y}`;
    drawing = true;
  });
  return path;
}

export interface BarRect {
  series: number;
  point: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The rectangles of a bar chart. Stacked, each point is one bar with the series on top of one
 * another; otherwise each point has one thinner bar per series, side by side.
 */
export function barRects(
  series: readonly ChartSeries[],
  stacked: boolean,
  max = chartMax(series, stacked),
): BarRect[] {
  const points = Math.max(0, ...series.map((s) => s.values.length));
  if (points === 0) return [];
  const slot = WIDTH / points;
  const barWidth = slot * 0.7;
  const rects: BarRect[] = [];
  for (let point = 0; point < points; point++) {
    const left = point * slot + (slot - barWidth) / 2;
    let base = 0;
    series.forEach((s, index) => {
      const value = s.values[point] ?? 0;
      const height = (Math.min(Math.max(value, 0), max) / max) * (HEIGHT - 1);
      if (stacked) {
        if (height > 0) {
          rects.push({
            series: index,
            point,
            x: left,
            y: HEIGHT - base - height,
            width: barWidth,
            height,
          });
        }
        base += height;
      } else if (height > 0) {
        const width = barWidth / series.length;
        rects.push({
          series: index,
          point,
          x: left + index * width,
          y: HEIGHT - height,
          width,
          height,
        });
      }
    });
  }
  return rects;
}

/** A point's time as the axis and tooltips show it: "14:00" for an hour, "26 Nov" for a day. */
export function formatPointTime(start: number, bucket: StatsBucket): string {
  const date = new Date(start);
  return bucket === 'hour'
    ? date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

const plain = (value: number) => value.toLocaleString('en-GB', { maximumFractionDigits: 1 });

/**
 * What the chart shows, in words: per series its total (or average, for rates and
 * percentages), its highest and its latest value. Points with no data are left out.
 */
export function chartSummary(
  series: readonly ChartSeries[],
  format: (value: number) => string,
  kind: 'total' | 'average',
): string {
  return series
    .map((s) => {
      const known = s.values.filter((v): v is number => v !== null);
      if (known.length === 0) return `${s.name}: no data`;
      const sum = known.reduce((a, b) => a + b, 0);
      const lead =
        kind === 'total' ? `total ${format(sum)}` : `average ${format(sum / known.length)}`;
      const latest = [...s.values].reverse().find((v) => v !== null)!;
      return `${s.name}: ${lead}, highest ${format(Math.max(...known))}, latest ${format(latest)}`;
    })
    .join('. ');
}

interface ChartProps {
  series: ChartSeries[];
  /** The start of each point, ms since the epoch, oldest first. */
  starts: number[];
  bucket: StatsBucket;
  /** What the chart is of, such as "Visitors per day". */
  label: string;
  format?: (value: number) => string;
  /** Fixed top of the value axis, such as 100 for a percentage. */
  max?: number;
  testId?: string;
  /** Whether the summary gives totals (counts) or averages (rates, percentages, times). */
  summary?: 'total' | 'average';
}

function ChartFrame({
  props,
  max,
  children,
  kind,
}: {
  props: ChartProps;
  max: number;
  children: ReactNode;
  kind: 'line' | 'bar';
}) {
  const { series, starts, bucket, label, testId } = props;
  const format = props.format ?? plain;
  const points = starts.length;
  const summaryText = chartSummary(series, format, props.summary ?? 'total');
  const slot = points > 0 ? WIDTH / points : WIDTH;
  return (
    <figure className="chart" data-testid={testId} data-kind={kind} data-points={points}>
      {series.length > 1 && (
        <ul className="legend chart__legend" aria-hidden="true">
          {series.map((s) => (
            <li key={s.name} className={`legend__item legend__item--${s.tone}`}>
              {s.name}
            </li>
          ))}
        </ul>
      )}
      <div className="chart__plot">
        <span className="chart__max" aria-hidden="true">
          {format(max)}
        </span>
        <svg
          className="chart__svg"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
          data-grow
        >
          <line
            className="chart__axis"
            x1="0"
            y1={HEIGHT}
            x2={WIDTH}
            y2={HEIGHT}
            vectorEffect="non-scaling-stroke"
          />
          {children}
          {/* One column per point to hover, with every series' value as its tooltip. */}
          {starts.map((start, i) => (
            <rect
              key={start}
              className="chart__hit"
              x={kind === 'bar' ? i * slot : xOf(i, points) - slot / 2}
              y="0"
              width={slot}
              height={HEIGHT}
            >
              <title>
                {`${formatPointTime(start, bucket)}: ${series
                  .map((s) => {
                    const value = s.values[i];
                    return `${s.name} ${value == null ? 'no data' : format(value)}`;
                  })
                  .join(', ')}`}
              </title>
            </rect>
          ))}
        </svg>
      </div>
      {points > 0 && (
        <div className="chart__times" aria-hidden="true">
          <span>{formatPointTime(starts[0]!, bucket)}</span>
          <span>{formatPointTime(starts[points - 1]!, bucket)}</span>
        </div>
      )}
      <figcaption
        className="visually-hidden"
        data-testid={testId ? `${testId}-summary` : undefined}
      >
        {label}. {summaryText}.
      </figcaption>
    </figure>
  );
}

export function LineChart(props: ChartProps) {
  const max = props.max ?? chartMax(props.series);
  return (
    <ChartFrame props={props} max={max} kind="line">
      {props.series.map((s) => (
        <path
          key={s.name}
          className={`chart__line chart__line--${s.tone}`}
          d={linePath(s.values, max)}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </ChartFrame>
  );
}

export function BarChart(props: ChartProps & { stacked?: boolean }) {
  const stacked = props.stacked ?? false;
  const max = props.max ?? chartMax(props.series, stacked);
  return (
    <ChartFrame props={props} max={max} kind="bar">
      {barRects(props.series, stacked, max).map((rect) => (
        <rect
          key={`${rect.series}-${rect.point}`}
          className={`chart__bar chart__bar--${props.series[rect.series]!.tone}`}
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
        />
      ))}
    </ChartFrame>
  );
}
