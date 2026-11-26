import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventSourceContext } from '../live.ts';
import { FakeEventSource } from '../test-support.ts';
import { LogViewer, MAX_LOG_LINES, findMatches } from './LogViewer.tsx';

beforeEach(() => {
  FakeEventSource.instances = [];
});

const nextFrame = () => act(() => new Promise((resolve) => requestAnimationFrame(resolve)));

function renderViewer() {
  const result = render(
    <EventSourceContext.Provider
      value={(url) => new FakeEventSource(url) as unknown as EventSource}
    >
      <LogViewer containerId="abc" />
    </EventSourceContext.Provider>,
  );
  const source = () => FakeEventSource.instances.at(-1)!;
  return { ...result, source };
}

describe('LogViewer', () => {
  it('opens the stream with the default 500 lines and shows stderr differently', async () => {
    const { source } = renderViewer();
    expect(source().url).toBe('/api/containers/abc/logs?tail=500');
    act(() => {
      source().emit('reset', { tail: 500 });
      source().emit('lines', [
        { stream: 'stdout', timestamp: 1, text: 'listening' },
        { stream: 'stderr', timestamp: 2, text: 'warning: slow' },
      ]);
    });
    await nextFrame();
    const lines = screen.getAllByTestId('log-line');
    expect(lines.map((el) => el.dataset.stream)).toEqual(['stdout', 'stderr']);
    expect(lines[1]!.className).toContain('logs__line--stderr');
  });

  it('reopens the stream when the line count changes, and closes it on unmount', async () => {
    const { source, unmount } = renderViewer();
    const first = source();
    await userEvent.selectOptions(screen.getByLabelText('Number of lines'), '1000');
    expect(first.closed).toBe(true);
    expect(source().url).toBe('/api/containers/abc/logs?tail=1000');
    unmount();
    expect(source().closed).toBe(true);
  });

  it('closes the stream when the log ends, so it is not replayed', () => {
    const { source } = renderViewer();
    act(() => source().emit('end', {}));
    expect(source().closed).toBe(true);
    expect(screen.getByTestId('logs-state').textContent).toBe('Log ended');
  });

  it('keeps at most MAX_LOG_LINES lines', async () => {
    const { source } = renderViewer();
    const batch = Array.from({ length: MAX_LOG_LINES + 50 }, (_, i) => ({
      stream: 'stdout' as const,
      timestamp: i,
      text: `line ${i}`,
    }));
    act(() => source().emit('lines', batch));
    await nextFrame();
    const lines = screen.getAllByTestId('log-line');
    expect(lines).toHaveLength(MAX_LOG_LINES);
    expect(lines[0]!.textContent).toBe('line 50');
  });

  it('shows timestamps when asked', async () => {
    const { source } = renderViewer();
    act(() =>
      source().emit('lines', [
        { stream: 'stdout', timestamp: Date.parse('2026-11-25T10:00:00Z'), text: 'hi' },
      ]),
    );
    await nextFrame();
    expect(screen.getByTestId('log-line').textContent).toBe('hi');
    await userEvent.click(screen.getByLabelText('Timestamps'));
    expect(screen.getByTestId('log-line').textContent).toMatch(/^2026-11-25 \d\d:00:00 hi$/);
  });

  it('highlights matches, counts them and moves between them, as new lines arrive', async () => {
    const { source } = renderViewer();
    act(() => {
      source().emit('reset', { tail: 500 });
      source().emit('lines', [
        { stream: 'stdout', timestamp: 1, text: 'GET /health 200' },
        { stream: 'stderr', timestamp: 2, text: 'error: timeout talking to db (error 2)' },
        { stream: 'stdout', timestamp: 3, text: 'GET / 200' },
      ]);
    });
    await nextFrame();
    await userEvent.type(screen.getByLabelText('Search log'), 'ERROR');
    expect(screen.getAllByTestId('log-match').map((el) => el.textContent)).toEqual([
      'error',
      'error',
    ]);
    // Starts at the newest match.
    expect(screen.getByTestId('log-match-count').textContent).toBe('2 of 2');
    const current = () => screen.getAllByTestId('log-match').findIndex((el) => el.dataset.current);
    expect(current()).toBe(1);

    await userEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(current()).toBe(0);
    expect(screen.getByTestId('log-match-count').textContent).toBe('1 of 2');
    expect(screen.getByTestId('log-view').dataset.follow).toBe('false');
    await userEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(current()).toBe(1);
    await userEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(current()).toBe(0);

    act(() => {
      source().emit('lines', [{ stream: 'stderr', timestamp: 4, text: 'another error' }]);
    });
    await nextFrame();
    expect(screen.getByTestId('log-match-count').textContent).toBe('1 of 3');
    expect(current()).toBe(0);

    await userEvent.type(screen.getByLabelText('Search log'), '{Escape}');
    expect(screen.queryAllByTestId('log-match')).toHaveLength(0);
  });
});

describe('findMatches', () => {
  const line = (seq: number, text: string) => ({
    seq,
    text,
    stream: 'stdout' as const,
    timestamp: 0,
  });

  it('finds every case-insensitive occurrence, treating the query literally', () => {
    expect(findMatches([line(1, 'a.b A.B axb')], 'a.b')).toEqual([
      { seq: 1, n: 0, start: 0, end: 3 },
      { seq: 1, n: 1, start: 4, end: 7 },
    ]);
    expect(findMatches([line(1, 'x(y)[z]')], '(y)[')).toHaveLength(1);
    expect(findMatches([line(1, 'anything')], '')).toEqual([]);
  });
});
