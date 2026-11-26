import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  DEFAULT_LOG_TAIL,
  LOG_TAIL_OPTIONS,
  type LogLine,
  type LogStreamEvents,
  type LogTail,
} from '@lookout/shared';
import { formatTimestamp } from '../format.ts';
import { useEventStream } from '../live.ts';
import { InWidget } from './Card.tsx';

/** Most lines kept in the browser; older ones are dropped as new ones arrive. */
export const MAX_LOG_LINES = 5000;

/** How close to the bottom still counts as "at the latest line", in pixels. */
const FOLLOW_SLACK = 24;

export interface NumberedLine extends LogLine {
  seq: number;
}

type StreamState = 'connecting' | 'live' | 'ended' | 'error';

/** One occurrence of the search text: which line, which occurrence in it, and where. */
export interface LogMatch {
  seq: number;
  /** The occurrence's position among this line's matches. */
  n: number;
  start: number;
  end: number;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every case-insensitive occurrence of `query` in the lines' text, oldest first. */
export function findMatches(lines: readonly NumberedLine[], query: string): LogMatch[] {
  if (query === '') return [];
  const pattern = new RegExp(escapeRegExp(query), 'giu');
  const matches: LogMatch[] = [];
  for (const line of lines) {
    let n = 0;
    for (const found of line.text.matchAll(pattern)) {
      matches.push({ seq: line.seq, n, start: found.index, end: found.index + found[0].length });
      n += 1;
    }
  }
  return matches;
}

const matchKey = (match: Pick<LogMatch, 'seq' | 'n'>) => `${match.seq}:${match.n}`;

/** A line's text with its matches wrapped in <mark>, the current one marked as such. */
function Highlighted({
  text,
  matches,
  currentKey,
}: {
  text: string;
  matches: LogMatch[] | undefined;
  currentKey: string | null;
}) {
  if (!matches) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of matches) {
    if (match.start > at) parts.push(text.slice(at, match.start));
    const current = matchKey(match) === currentKey;
    parts.push(
      <mark
        key={match.n}
        className={current ? 'logs__match logs__match--current' : 'logs__match'}
        data-testid="log-match"
        data-current={current || undefined}
      >
        {text.slice(match.start, match.end)}
      </mark>,
    );
    at = match.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/**
 * A live log tail (FR-21): stdout and stderr interleaved, last N lines, follow mode and
 * timestamps, and search with highlighted matches. The stream, and Docker's log request
 * behind it, closes on unmount (FR-22).
 */
export function LogViewer({ containerId }: { containerId: string }) {
  const inWidget = useContext(InWidget);
  const [tail, setTail] = useState<LogTail>(DEFAULT_LOG_TAIL);
  const [timestamps, setTimestamps] = useState(false);
  const [follow, setFollow] = useState(true);
  const [lines, setLines] = useState<NumberedLine[]>([]);
  const [state, setState] = useState<StreamState>('connecting');
  const pending = useRef<LogLine[]>([]);
  const frame = useRef<number | null>(null);
  const seq = useRef(0);
  const view = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  /** The current match, by identity, so it stays put as new lines arrive. */
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  /** Bumped to scroll the current match into view. */
  const [reveal, setReveal] = useState(0);

  // Search runs over the lines held in the browser (FR-21), so it keeps up as lines arrive
  // and as old ones are dropped.
  const matches = useMemo(() => findMatches(lines, query), [lines, query]);
  const matchesBySeq = useMemo(() => {
    const bySeq = new Map<number, LogMatch[]>();
    for (const match of matches) {
      const list = bySeq.get(match.seq);
      if (list) list.push(match);
      else bySeq.set(match.seq, [match]);
    }
    return bySeq;
  }, [matches]);
  const position = currentKey === null ? -1 : matches.findIndex((m) => matchKey(m) === currentKey);

  // Lines are applied at most once per animation frame, so a fast log cannot flood React
  // with renders, and the kept lines are capped.
  const flush = useCallback(() => {
    frame.current = null;
    const incoming = pending.current;
    pending.current = [];
    if (incoming.length === 0) return;
    setLines((current) => {
      const added = incoming.map((line) => ({ ...line, seq: (seq.current += 1) }));
      const next = current.concat(added);
      return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
    });
  }, []);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const handlers = useMemo(
    () => ({
      reset: () => {
        pending.current = [];
        setLines([]);
        setState('live');
      },
      lines: (batch: LogStreamEvents['lines']) => {
        pending.current.push(...batch);
        frame.current ??= requestAnimationFrame(flush);
      },
      end: () => setState('ended'),
    }),
    [flush],
  );
  const onError = useCallback((source: EventSource) => {
    if (source.readyState === 2) setState((s) => (s === 'ended' ? s : 'error'));
  }, []);
  // An ended log closes its stream, so EventSource does not reconnect and replay it.
  const url =
    state === 'ended'
      ? null
      : `/api/containers/${encodeURIComponent(containerId)}/logs?tail=${tail}`;
  useEventStream(url, handlers, onError);

  // Follow mode keeps the newest line in view.
  useLayoutEffect(() => {
    const element = view.current;
    if (follow && element) element.scrollTop = element.scrollHeight;
  }, [lines, follow, timestamps]);

  const onScroll = () => {
    const element = view.current;
    if (!element) return;
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK;
    // Scrolling up pauses follow; scrolling back to the bottom resumes it.
    if (atBottom !== follow) setFollow(atBottom);
  };

  // Searching starts at the newest match, nearest the line being followed.
  const changeQuery = (value: string) => {
    setQuery(value);
    const found = findMatches(lines, value);
    const last = found.at(-1);
    setCurrentKey(last ? matchKey(last) : null);
    if (last) setReveal((r) => r + 1);
  };

  /** Moves to the next (1) or previous (-1) match, wrapping around. */
  const step = (direction: 1 | -1) => {
    if (matches.length === 0) return;
    const from = position < 0 ? (direction === 1 ? -1 : matches.length) : position;
    const next = matches[(from + direction + matches.length) % matches.length]!;
    setCurrentKey(matchKey(next));
    // Looking at an older line pauses follow, like scrolling up does.
    setFollow(false);
    setReveal((r) => r + 1);
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape' && query !== '') {
      event.preventDefault();
      changeQuery('');
    }
  };

  useLayoutEffect(() => {
    if (reveal === 0) return;
    const element = view.current?.querySelector<HTMLElement>('[data-current]');
    // Optional because jsdom has no scrollIntoView.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    element?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  }, [reveal]);

  const changeTail = (value: LogTail) => {
    setTail(value);
    setState('connecting');
    setFollow(true);
  };

  return (
    <section
      className={inWidget ? 'logs card card--bare' : 'logs card'}
      aria-label="Logs"
      data-testid="logs"
    >
      <div className="logs__bar">
        {!inWidget && <h2 className="card__title">Logs</h2>}
        <label className="logs__control">
          Last
          <select
            className="field__input field__input--small"
            value={tail}
            onChange={(event) => changeTail(Number(event.target.value) as LogTail)}
            aria-label="Number of lines"
          >
            {LOG_TAIL_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          lines
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={timestamps}
            onChange={(event) => setTimestamps(event.target.checked)}
          />
          Timestamps
        </label>
        <div className="logs__search" role="search" aria-label="Search the log">
          <input
            type="search"
            className="field__input field__input--small logs__search-input"
            placeholder="Search"
            aria-label="Search log"
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
            onKeyDown={onSearchKey}
            data-testid="log-search"
          />
          <span className="logs__count muted" aria-live="polite" data-testid="log-match-count">
            {query === ''
              ? ''
              : matches.length === 0
                ? 'No matches'
                : `${position < 0 ? '–' : position + 1} of ${matches.length}`}
          </span>
          <button
            type="button"
            className="button button--quiet button--small"
            onClick={() => step(-1)}
            disabled={matches.length === 0}
            aria-label="Previous match"
            data-testid="log-match-previous"
          >
            ↑
          </button>
          <button
            type="button"
            className="button button--quiet button--small"
            onClick={() => step(1)}
            disabled={matches.length === 0}
            aria-label="Next match"
            data-testid="log-match-next"
          >
            ↓
          </button>
        </div>
        <span className="logs__state muted" role="status" data-testid="logs-state">
          {state === 'connecting' && 'Connecting…'}
          {state === 'live' && (follow ? 'Following' : 'Paused')}
          {state === 'ended' && 'Log ended'}
          {state === 'error' && 'Log unavailable'}
        </span>
      </div>
      <div className="logs__frame">
        <div
          className="logs__view"
          ref={view}
          onScroll={onScroll}
          tabIndex={0}
          role="log"
          aria-label="Container log"
          data-testid="log-view"
          data-follow={follow}
          data-grow
        >
          {lines.length === 0 && state !== 'connecting' ? (
            <p className="muted logs__empty">No log lines.</p>
          ) : (
            lines.map((line) => (
              <div
                key={line.seq}
                className={`logs__line logs__line--${line.stream}`}
                data-testid="log-line"
                data-stream={line.stream}
              >
                {timestamps && line.timestamp > 0 && (
                  <span className="logs__time">{formatTimestamp(line.timestamp)} </span>
                )}
                {line.stream === 'stderr' && <span className="visually-hidden">stderr: </span>}
                {/* Isolated, so a bidirectional control in the line cannot reorder what is
                    around it (#89). */}
                <bdi>
                  <Highlighted
                    text={line.text}
                    matches={matchesBySeq.get(line.seq)}
                    currentKey={currentKey}
                  />
                </bdi>
              </div>
            ))
          )}
        </div>
        {!follow && (
          <button
            type="button"
            className="button logs__jump"
            onClick={() => setFollow(true)}
            data-testid="jump-to-latest"
          >
            Jump to latest ↓
          </button>
        )}
      </div>
    </section>
  );
}
