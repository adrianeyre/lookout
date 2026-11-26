import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  BarChart,
  LineChart,
  barRects,
  chartMax,
  chartSummary,
  formatPointTime,
  linePath,
  type ChartSeries,
} from './Chart.tsx';

const DAY = 24 * 60 * 60 * 1000;
const START = new Date(2026, 10, 20).getTime();
const starts = [0, 1, 2, 3].map((i) => START + i * DAY);

describe('linePath', () => {
  it('draws one line across the width, top value one unit below the top', () => {
    expect(linePath([0, 10], 10)).toBe('M0.00 39.00L100.00 1.00');
  });

  it('breaks the line at a null, so missing data is a gap', () => {
    const path = linePath([1, null, 2, 3], 3);
    expect(path.match(/M/g)).toHaveLength(2);
    expect(path.startsWith('M0.00')).toBe(true);
    expect(path).toContain('M66.67');
  });

  it('puts a single point in the middle', () => {
    expect(linePath([5], 5)).toBe('M50.00 1.00');
  });
});

describe('chartMax', () => {
  const series: ChartSeries[] = [
    { name: 'a', values: [1, 4, null], tone: 'primary' },
    { name: 'b', values: [3, 2, 7], tone: 'secondary' },
  ];

  it('is the largest value, or the largest stacked total', () => {
    expect(chartMax(series)).toBe(7);
    expect(chartMax(series, true)).toBe(7);
    expect(
      chartMax(
        [
          { ...series[0]!, values: [5, 5] },
          { ...series[1]!, values: [5, 1] },
        ],
        true,
      ),
    ).toBe(10);
  });

  it('is 1 with nothing to show, so an empty chart still has an axis', () => {
    expect(chartMax([{ name: 'a', values: [null, 0], tone: 'primary' }])).toBe(1);
  });
});

describe('barRects', () => {
  it('stacks series in one bar per point, the totals reaching the top', () => {
    const rects = barRects(
      [
        { name: 'humans', values: [3, 1], tone: 'primary' },
        { name: 'bots', values: [1, 0], tone: 'muted' },
      ],
      true,
    );
    // No rectangle for a zero.
    expect(rects).toHaveLength(3);
    const first = rects.filter((r) => r.point === 0);
    expect(first.map((r) => r.series)).toEqual([0, 1]);
    // The bots sit on top of the humans, and the stack is the full height.
    expect(first[1]!.y + first[1]!.height).toBeCloseTo(first[0]!.y);
    expect(first[0]!.height + first[1]!.height).toBeCloseTo(39);
    expect(first[0]!.x).toBe(first[1]!.x);
  });

  it('puts series side by side when not stacked', () => {
    const rects = barRects(
      [
        { name: 'a', values: [2], tone: 'primary' },
        { name: 'b', values: [1], tone: 'secondary' },
      ],
      false,
    );
    expect(rects[1]!.x).toBeGreaterThan(rects[0]!.x);
    expect(rects[0]!.height).toBeCloseTo(2 * rects[1]!.height);
  });
});

describe('chartSummary', () => {
  it('gives totals for counts, averages for rates, and skips missing points', () => {
    const series: ChartSeries[] = [{ name: 'Visitors', values: [2, null, 4], tone: 'primary' }];
    expect(chartSummary(series, String, 'total')).toBe('Visitors: total 6, highest 4, latest 4');
    expect(chartSummary(series, String, 'average')).toBe(
      'Visitors: average 3, highest 4, latest 4',
    );
    expect(chartSummary([{ name: 'p95', values: [null], tone: 'primary' }], String, 'total')).toBe(
      'p95: no data',
    );
  });
});

describe('formatPointTime', () => {
  it('shows hours as a time and days as a date', () => {
    expect(formatPointTime(new Date(2026, 10, 26, 14).getTime(), 'hour')).toBe('14:00');
    expect(formatPointTime(new Date(2026, 10, 26).getTime(), 'day')).toBe('26 Nov');
  });
});

describe('LineChart and BarChart', () => {
  it('labels the chart, its first and last time and its top value, with a text summary', () => {
    render(
      <LineChart
        series={[{ name: 'Visitors', values: [1, 2, null, 5], tone: 'primary' }]}
        starts={starts}
        bucket="day"
        label="Visitors per day"
        testId="chart"
      />,
    );
    expect(screen.getByRole('img', { name: 'Visitors per day' })).toBeTruthy();
    const chart = screen.getByTestId('chart');
    expect(chart.getAttribute('data-points')).toBe('4');
    expect(chart.textContent).toContain('20 Nov');
    expect(chart.textContent).toContain('23 Nov');
    expect(screen.getByTestId('chart-summary').textContent).toBe(
      'Visitors per day. Visitors: total 8, highest 5, latest 5.',
    );
    // A tooltip per point, saying when a point has no data.
    const titles = [...chart.querySelectorAll('title')].map((t) => t.textContent);
    expect(titles).toHaveLength(4);
    expect(titles[2]).toBe('22 Nov: Visitors no data');
    // One series: no legend.
    expect(chart.querySelector('.chart__legend')).toBeNull();
  });

  it('stacks bars and gives a legend for several series', () => {
    render(
      <BarChart
        stacked
        series={[
          { name: '2xx', values: [5, 3, 0, 1], tone: 'ok' },
          { name: '5xx', values: [1, 0, 0, 2], tone: 'critical' },
        ]}
        starts={starts}
        bucket="day"
        label="Status codes"
        testId="bars"
      />,
    );
    const chart = screen.getByTestId('bars');
    expect(chart.querySelectorAll('.chart__bar')).toHaveLength(5);
    expect(chart.querySelectorAll('.chart__bar--critical')).toHaveLength(2);
    expect([...chart.querySelectorAll('.legend__item')].map((li) => li.textContent)).toEqual([
      '2xx',
      '5xx',
    ]);
    expect(chart.querySelector('.chart__max')!.textContent).toBe('6');
  });
});
