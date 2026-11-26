import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { InWidget } from '../components/Card.tsx';
import {
  filled,
  spreadIntoAbsent,
  fitToContent,
  GRID,
  moveWidget,
  pinWidget,
  resizeWidget,
  rowsFor,
  setWidgetHidden,
  specsOf,
  unfitted,
  widgetSpec,
  widgetsIn,
  withoutWidgets,
  ZONES,
  type Cell,
  type WidgetLayout,
  type Zone,
} from './layout.ts';

export interface WidgetGridProps {
  layout: WidgetLayout;
  onLayout: (layout: WidgetLayout) => void;
  /** What each Widget shows. One left out isn't drawn, and its place is left alone. */
  widgets: Readonly<Record<string, ReactNode>>;
  /**
   * Widgets with nothing to show just now, such as a Container's Hosted Sites when it serves
   * none. They are off the Grid, their rows closed up, until they have something.
   */
  empty?: readonly string[] | undefined;
}

/** How far the pointer must go before a press becomes a drag, so a click stays a click. */
const DRAG_THRESHOLD = 4;
/** How close to the top or bottom of the window a drag scrolls the page. */
const EDGE = 48;
/** How long Widgets take to glide to a new place (Material's "standard" easing). */
const GLIDE = { duration: 240, easing: 'cubic-bezier(0.2, 0, 0, 1)' } as const;
/** How far a Widget being dragged tilts, so it reads as picked up. */
const TILT = 'rotate(1.5deg)';
/** The little shake the Widgets beside a dropped one give, added to any glide. */
const SHAKE: Keyframe[] = [
  { transform: 'rotate(0deg)' },
  { transform: 'rotate(-1.2deg)' },
  { transform: 'rotate(1.1deg)' },
  { transform: 'rotate(-0.7deg)' },
  { transform: 'rotate(0.4deg)' },
  { transform: 'rotate(0deg)' },
];
const SHAKE_TIMING: KeyframeAnimationOptions = {
  duration: 420,
  easing: 'ease-in-out',
  composite: 'add',
};

interface Gesture {
  id: string;
  kind: 'move' | 'resize';
  pointerId: number;
  from: { x: number; y: number };
  /** One cell plus its gap, in pixels. */
  pitch: { x: number; y: number };
  last: { x: number; y: number };
  /** How far the page had scrolled when the press began: scrolling mid-drag carries it along. */
  scrollStart: number;
  started: boolean;
}

interface Drag {
  id: string;
  kind: 'move' | 'resize';
  offset: { x: number; y: number };
  /** The layout as it will be drawn once dropped, which the placeholder and the others show. */
  preview: WidgetLayout;
  /** The same layout as it will be kept: what dropping it saves. */
  saved: WidgetLayout;
}

const describe = (title: string, cell: Cell) =>
  `${title}: column ${cell.x + 1}, row ${cell.y + 1}, ${cell.w} wide by ${cell.h} tall.`;

const sameRows = (a: Record<string, number>, b: Record<string, number>) => {
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...ids].every((id) => a[id] === b[id]);
};

/**
 * Content that grows into a Widget drawn taller than it needs, such as a chart or a log: it is
 * measured at its least height (its `min-block-size`), so growing never makes it need more.
 */
const GROWS = '[data-grow]';

/**
 * How tall a Widget's content is at its own height, before anything in it grows. The content
 * fills its Widget, so this adds up what is in it (its children, which don't collapse their
 * margins in its column) less what its growers took beyond their least height.
 */
function naturalHeight(host: HTMLElement): number {
  const own = getComputedStyle(host);
  let height = parseFloat(own.paddingBlockStart) + parseFloat(own.paddingBlockEnd);
  for (const child of host.children) {
    const style = getComputedStyle(child);
    height +=
      (child as HTMLElement).offsetHeight +
      parseFloat(style.marginBlockStart) +
      parseFloat(style.marginBlockEnd);
  }
  for (const grower of host.querySelectorAll<HTMLElement>(GROWS)) {
    const least = parseFloat(getComputedStyle(grower).minBlockSize);
    if (Number.isFinite(least)) height -= Math.max(0, grower.clientHeight - least);
  }
  return height;
}

/** What to watch for a Widget's content changing size: it, what is in it, and its growers. */
const watched = (host: HTMLElement): Element[] => [
  host,
  ...host.children,
  ...host.querySelectorAll(GROWS),
];

const reducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A page's Widgets on their Grid. Each is dragged by its bar and resized by its corner,
 * snapping to whole cells; from the keyboard, its grip moves it with the arrow keys and
 * resizes it with Shift and the arrow keys. Pinned Widgets are full-width bands that stay at
 * the top of the window or above the footer. Widgets that a change moves glide to their new
 * places, unless the reader asks for reduced motion.
 */
export function WidgetGrid({
  layout: given,
  onLayout: save,
  widgets,
  empty = [],
}: WidgetGridProps) {
  const present = (id: string) => widgets[id] !== undefined;
  const specs = specsOf(given);
  const absent = specs.map((spec) => spec.id).filter((id) => !present(id) || empty.includes(id));
  const kept = withoutWidgets(given, absent);
  const [needed, setNeeded] = useState<Record<string, number>>({});
  const layout = fitToContent(kept, needed);
  const toKept = (drawn: WidgetLayout, resized: string | null = null) => {
    const next = unfitted(drawn, kept, resized);
    for (const id of absent) next[id] = { ...next[id]!, hidden: given[id]!.hidden };
    return next;
  };
  const onLayout = (drawn: WidgetLayout, resized: string | null = null) =>
    save(toKept(drawn, resized));
  const [drag, setDrag] = useState<Drag | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const gesture = useRef<Gesture | null>(null);
  const controls = useRef(new Map<string, HTMLButtonElement>());
  const refocus = useRef<string | null>(null);
  // Each Widget's content is drawn once, into a node of its own that moves with it between
  // Zones: it is never unmounted, so a log being followed carries on wherever it goes.
  const [hosts] = useState(() => new Map<string, HTMLDivElement>());
  const hostFor = (id: string) => {
    let host = hosts.get(id);
    if (!host) {
      host = document.createElement('div');
      host.className = 'widget__content';
      hosts.set(id, host);
    }
    return host;
  };
  const [stable] = useState(() => {
    const made = new Map<string, (element: HTMLElement | null) => void>();
    return (key: string, make: () => (element: HTMLElement | null) => void) => {
      if (!made.has(key)) made.set(key, make());
      return made.get(key)!;
    };
  });
  const hintId = useId();
  const shown = drag?.preview ?? layout;
  // As drawn, each Widget also reaches down to the one under it, so the Grid has no holes.
  // A Widget beside one with nothing to show spreads into its cells.
  const drawn = filled(spreadIntoAbsent(shown, absent));
  const before = drag ? filled(spreadIntoAbsent(layout, absent)) : drawn;

  // Each Widget's height as its content needs it, measured whenever the content changes size.
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const next: Record<string, number> = {};
      for (const [id, host] of hosts) {
        const body = host.parentElement;
        const frame = body?.closest<HTMLElement>('.widget');
        const zone = frame?.closest<HTMLElement>('.widget-zone')?.dataset.zone as Zone | undefined;
        if (!body || !frame || !zone || host.offsetHeight === 0) continue;
        next[id] = rowsFor(frame.offsetHeight - body.clientHeight + naturalHeight(host), zone);
      }
      setNeeded((before) => (sameRows(before, next) ? before : next));
    };
    observer.current = new ResizeObserver(measure);
    return () => observer.current?.disconnect();
  }, [hosts]);
  useEffect(() => {
    for (const host of hosts.values()) {
      for (const element of watched(host)) observer.current?.observe(element);
    }
  });

  // Pinned bands stay in view, so they publish their heights: scroll-padding then keeps
  // focused content clear of them (WCAG 2.4.11 Focus Not Obscured).
  const pinnedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = pinnedRef.current?.parentElement;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const style = document.documentElement.style;
    const publish = () => {
      for (const zone of ['top', 'bottom'] as const) {
        const band = root.querySelector<HTMLElement>(`.widget-zone[data-zone="${zone}"]`);
        const sticky = band && getComputedStyle(band).position === 'sticky';
        style.setProperty(`--pinned-${zone}`, sticky ? `${band.offsetHeight}px` : '0px');
      }
    };
    const observer = new ResizeObserver(publish);
    observer.observe(root);
    publish();
    return () => {
      observer.disconnect();
      style.removeProperty('--pinned-top');
      style.removeProperty('--pinned-bottom');
    };
  });

  // A Widget moved by the keyboard or pinned moves in the DOM too, which drops focus: the
  // control used takes it back.
  useLayoutEffect(() => {
    if (refocus.current) controls.current.get(refocus.current)?.focus();
    refocus.current = null;
  });

  // Glide: each Widget that a change moved starts from where it was and slides to its new
  // place (FLIP). Places are read from offsetLeft/offsetTop, which a running glide's transform
  // doesn't change, so a quick second change glides on from the right place.
  const frames = useRef(new Map<string, HTMLElement>());
  const places = useRef(new Map<string, { x: number; y: number; w: number; h: number }>());
  const lastCells = useRef('');
  /** The Widget just dropped: once it is drawn in its new place, those beside it shake. */
  const shakeAround = useRef<string | null>(null);
  useLayoutEffect(() => {
    const cells = JSON.stringify(Object.fromEntries(specs.map(({ id }) => [id, shown[id]])));
    const changed = cells !== lastCells.current && lastCells.current !== '';
    lastCells.current = cells;
    const animate = changed && !reducedMotion();
    const next = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (const [id, element] of frames.current) {
      const zone = element.closest<HTMLElement>('.widget-zone');
      const place = {
        x: element.offsetLeft,
        y: element.offsetTop + (zone?.offsetTop ?? 0),
        w: element.offsetWidth,
        h: element.offsetHeight,
      };
      next.set(id, place);
      const before = places.current.get(id);
      const following = drag?.id === id && drag.kind === 'move';
      if (!animate || !before || following || typeof element.animate !== 'function') continue;
      const dx = before.x - place.x;
      const dy = before.y - place.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      element.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
        GLIDE,
      );
    }
    places.current = next;

    const dropped = shakeAround.current;
    shakeAround.current = null;
    const landed = dropped ? next.get(dropped) : undefined;
    if (!landed || reducedMotion()) return;
    const reach = GRID.gap + 2;
    for (const [id, element] of frames.current) {
      const place = next.get(id);
      if (id === dropped || !place || typeof element.animate !== 'function') continue;
      const beside =
        place.x < landed.x + landed.w + reach &&
        landed.x < place.x + place.w + reach &&
        place.y < landed.y + landed.h + reach &&
        landed.y < place.y + place.h + reach;
      if (beside) element.animate(SHAKE, SHAKE_TIMING);
    }
  });

  const cancel = () => {
    gesture.current = null;
    setDrag(null);
  };

  const begin = (event: PointerEvent<HTMLElement>, id: string, kind: Gesture['kind']) => {
    if (event.button !== 0) return;
    // The bar's own buttons are clicked, not dragged; the grip is the exception.
    const button = (event.target as HTMLElement).closest('button');
    if (kind === 'move' && button && !button.classList.contains('widget__grip')) return;
    const grid = event.currentTarget.closest<HTMLElement>('.widget-grid');
    if (!grid) return;
    const cell = (grid.clientWidth - GRID.gap * (GRID.columns - 1)) / GRID.columns;
    gesture.current = {
      id,
      kind,
      pointerId: event.pointerId,
      from: { x: event.clientX, y: event.clientY },
      pitch: { x: cell + GRID.gap, y: GRID.rowHeight + GRID.gap },
      last: { x: event.clientX, y: event.clientY },
      scrollStart: window.scrollY,
      started: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  /** Where the Widget being dragged would land, with the pointer and the page as they are. */
  const follow = () => {
    const current = gesture.current;
    if (!current?.started) return;
    const scrolled = window.scrollY - current.scrollStart;
    const offset = {
      x: current.last.x - current.from.x,
      y: current.last.y - current.from.y + scrolled,
    };
    const start = layout[current.id]!;
    const cols = Math.round(offset.x / current.pitch.x);
    // A Widget pinned to the bottom is resized by its top edge, so dragging up makes it taller.
    const rows =
      Math.round(offset.y / current.pitch.y) *
      (current.kind === 'resize' && start.zone === 'bottom' ? -1 : 1);
    const moved =
      current.kind === 'move'
        ? moveWidget(layout, current.id, start.x + cols, start.y + rows)
        : resizeWidget(layout, current.id, start.w + cols, start.h + rows);
    const saved = toKept(moved, current.kind === 'resize' ? current.id : null);
    const preview = fitToContent(withoutWidgets(saved, absent), needed);
    setDrag({ id: current.id, kind: current.kind, offset, preview, saved });
  };

  const track = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.last = { x: event.clientX, y: event.clientY };
    const moved = { x: event.clientX - current.from.x, y: event.clientY - current.from.y };
    if (!current.started && Math.hypot(moved.x, moved.y) < DRAG_THRESHOLD) return;
    current.started = true;
    event.preventDefault();
    follow();
  };

  const end = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (drag) {
      if (drag.kind === 'move') shakeAround.current = drag.id;
      save(drag.saved);
      setAnnouncement(describe(widgetSpec(drag.id).title, drag.preview[drag.id]!));
    }
    cancel();
  };

  const change = (id: string, next: WidgetLayout, resized = false) => {
    onLayout(next, resized ? id : null);
    setAnnouncement(describe(widgetSpec(id).title, next[id]!));
  };

  const onGripKey = (event: KeyboardEvent, id: string) => {
    const step = (
      { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<
        string,
        [number, number]
      >
    )[event.key];
    if (!step) return;
    event.preventDefault();
    const [dx, dy] = step;
    const placement = layout[id]!;
    refocus.current = `${id}:grip`;
    const grow = event.shiftKey && placement.zone === 'bottom' ? -dy : dy;
    change(
      id,
      event.shiftKey
        ? resizeWidget(layout, id, placement.w + dx, placement.h + grow)
        : moveWidget(layout, id, placement.x + dx, placement.y + dy),
      event.shiftKey,
    );
  };

  const pin = (id: string, zone: Zone) => {
    const { title } = widgetSpec(id);
    refocus.current = `${id}:${zone === 'main' ? layout[id]!.zone : zone}`;
    onLayout(pinWidget(layout, id, zone));
    setAnnouncement(
      zone === 'main'
        ? `${title} unpinned.`
        : `${title} pinned to the ${zone === 'top' ? 'top' : 'bottom'}.`,
    );
  };

  const hide = (id: string) => {
    onLayout(setWidgetHidden(layout, id, true));
    setAnnouncement(`${widgetSpec(id).title} hidden. Show it again from the Widgets menu.`);
  };

  // The frames get handlers that never change and call the latest ones, so a frame re-renders
  // only when its own place does, not on every live update of the page.
  const latest = useRef({ begin, track, follow, end, cancel, onGripKey, pin, hide });
  useLayoutEffect(() => {
    latest.current = { begin, track, follow, end, cancel, onGripKey, pin, hide };
  });

  const isDragging = drag !== null;
  useEffect(() => {
    if (!isDragging) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') latest.current.cancel();
    };
    window.addEventListener('keydown', onKey);
    const onScroll = () => latest.current.follow();
    window.addEventListener('scroll', onScroll, { passive: true });
    // Held near the top or bottom of the window, a drag scrolls the page.
    let frame = 0;
    const edgeScroll = () => {
      const current = gesture.current;
      if (current) {
        const by =
          current.last.y < EDGE
            ? current.last.y - EDGE
            : current.last.y > window.innerHeight - EDGE
              ? current.last.y - (window.innerHeight - EDGE)
              : 0;
        if (by !== 0) window.scrollBy(0, Math.round(by / 3));
      }
      frame = requestAnimationFrame(edgeScroll);
    };
    if (typeof requestAnimationFrame !== 'undefined') frame = requestAnimationFrame(edgeScroll);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [isDragging]);

  const [actions] = useState<FrameActions>(() => ({
    begin: (event, id, kind) => latest.current.begin(event, id, kind),
    track: (event) => latest.current.track(event),
    end: (event) => latest.current.end(event),
    cancel: () => latest.current.cancel(),
    gripKey: (event, id) => latest.current.onGripKey(event, id),
    pin: (id, zone) => latest.current.pin(id, zone),
    hide: (id) => latest.current.hide(id),
    control: (key) =>
      stable(`control:${key}`, () => (element) => {
        if (element) controls.current.set(key, element as HTMLButtonElement);
        else controls.current.delete(key);
      }),
    frame: (id) =>
      stable(`frame:${id}`, () => (element) => {
        if (element) frames.current.set(id, element);
        else frames.current.delete(id);
      }),
    body: (id) =>
      stable(`body:${id}`, () => (element) => {
        const host = hostFor(id);
        if (element && host.parentNode !== element) element.appendChild(host);
      }),
  }));

  const renderWidget = (id: string) => {
    const dragging = drag?.id === id;
    // The Widget dragged follows the pointer from where it was; the placeholder shows where it lands.
    const moving = dragging && drag.kind === 'move';
    const cell = moving ? before[id]! : drawn[id]!;
    return (
      <WidgetFrame
        key={id}
        id={id}
        x={cell.x}
        y={cell.y}
        w={cell.w}
        h={cell.h}
        zone={layout[id]!.zone}
        sized={cell.sized === true}
        dragging={dragging}
        offsetX={moving ? drag.offset.x : 0}
        offsetY={moving ? drag.offset.y : 0}
        hintId={hintId}
        actions={actions}
      />
    );
  };

  return (
    <>
      <p id={hintId} className="visually-hidden" ref={pinnedRef}>
        Arrow keys move it; Shift and the arrow keys resize it.
      </p>
      {ZONES.map((zone) => {
        // In the order they were before a drag began, while it lasts: moving a Widget in the
        // page would lose the pointer's capture, and with it the end of the drag.
        const ids = widgetsIn(drag ? layout : shown, zone).filter(present);
        if (ids.length === 0 && zone !== 'main') return null;
        const placeholder =
          drag?.kind === 'move' && shown[drag.id]!.zone === zone ? shown[drag.id]! : null;
        const rows: CSSProperties =
          zone === 'main'
            ? { gridAutoRows: `${GRID.rowHeight}px`, gap: `${GRID.gap}px` }
            : { gridAutoRows: `${GRID.rowHeight + GRID.gap}px`, gap: 0 };
        return (
          <div
            key={zone}
            className="widget-zone"
            data-zone={zone}
            role={zone === 'main' ? undefined : 'group'}
            aria-label={
              zone === 'top'
                ? 'Pinned to the top'
                : zone === 'bottom'
                  ? 'Pinned to the bottom'
                  : undefined
            }
          >
            <div
              className="widget-grid"
              style={{ gridTemplateColumns: `repeat(${GRID.columns}, minmax(0, 1fr))`, ...rows }}
            >
              {placeholder && (
                <div
                  className="widget-placeholder"
                  aria-hidden="true"
                  style={{
                    gridColumn: `${placeholder.x + 1} / span ${placeholder.w}`,
                    gridRow: `${placeholder.y + 1} / span ${placeholder.h}`,
                  }}
                />
              )}
              {ids.map(renderWidget)}
            </div>
          </div>
        );
      })}
      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
      {specs
        .filter((spec) => present(spec.id))
        .map((spec) =>
          createPortal(
            <InWidget.Provider value>{widgets[spec.id]}</InWidget.Provider>,
            hostFor(spec.id),
            spec.id,
          ),
        )}
    </>
  );
}

interface FrameActions {
  begin: (event: PointerEvent<HTMLElement>, id: string, kind: Gesture['kind']) => void;
  track: (event: PointerEvent<HTMLElement>) => void;
  end: (event: PointerEvent<HTMLElement>) => void;
  cancel: () => void;
  gripKey: (event: KeyboardEvent, id: string) => void;
  pin: (id: string, zone: Zone) => void;
  hide: (id: string) => void;
  control: (key: string) => (element: HTMLElement | null) => void;
  frame: (id: string) => (element: HTMLElement | null) => void;
  body: (id: string) => (element: HTMLElement | null) => void;
}

interface WidgetFrameProps extends Cell {
  id: string;
  zone: Zone;
  /** Made this tall, so its content fills it rather than it being fitted to its content. */
  sized: boolean;
  dragging: boolean;
  offsetX: number;
  offsetY: number;
  hintId: string;
  actions: FrameActions;
}

function Icon({ d }: { d: string }) {
  return (
    <svg className="widget__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}

const ICONS = {
  grip: 'M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01',
  top: 'M5 3h14M12 21V7m-6 6 6-6 6 6',
  bottom: 'M5 21h14M12 3v14m-6-6 6 6 6-6',
  close: 'M18 6 6 18M6 6l12 12',
};

/** One Widget's frame: its bar of controls, the slot its content moves into, and its corner. */
const WidgetFrame = memo(function WidgetFrame({
  id,
  x,
  y,
  w,
  h,
  zone,
  sized,
  dragging,
  offsetX,
  offsetY,
  hintId,
  actions,
}: WidgetFrameProps) {
  const { title } = widgetSpec(id);
  const style: CSSProperties = {
    gridColumn: `${x + 1} / span ${w}`,
    gridRow: `${y + 1} / span ${h}`,
    // Picked up and moving, it follows the pointer, tilted a little.
    transform:
      dragging && (offsetX || offsetY)
        ? `translate(${offsetX}px, ${offsetY}px) ${TILT}`
        : undefined,
  };
  return (
    <div
      ref={actions.frame(id)}
      className="widget"
      data-widget={id}
      data-sized={sized || undefined}
      data-dragging={dragging || undefined}
      style={style}
    >
      <div
        className="widget__bar"
        onPointerDown={(event) => actions.begin(event, id, 'move')}
        onPointerMove={actions.track}
        onPointerUp={actions.end}
        onLostPointerCapture={actions.end}
        onPointerCancel={actions.cancel}
      >
        <button
          ref={actions.control(`${id}:grip`)}
          type="button"
          className="widget__button widget__grip"
          aria-label={`Move ${title}`}
          aria-describedby={hintId}
          title={`Move ${title}`}
          onKeyDown={(event) => actions.gripKey(event, id)}
        >
          <Icon d={ICONS.grip} />
        </button>
        <h2 className="widget__title">{title}</h2>
        <button
          ref={actions.control(`${id}:top`)}
          type="button"
          className="widget__button"
          aria-label={`Pin ${title} to the top`}
          title={zone === 'top' ? `Unpin ${title}` : `Pin ${title} to the top`}
          aria-pressed={zone === 'top'}
          onClick={() => actions.pin(id, zone === 'top' ? 'main' : 'top')}
        >
          <Icon d={ICONS.top} />
        </button>
        <button
          ref={actions.control(`${id}:bottom`)}
          type="button"
          className="widget__button"
          aria-label={`Pin ${title} to the bottom`}
          title={zone === 'bottom' ? `Unpin ${title}` : `Pin ${title} to the bottom`}
          aria-pressed={zone === 'bottom'}
          onClick={() => actions.pin(id, zone === 'bottom' ? 'main' : 'bottom')}
        >
          <Icon d={ICONS.bottom} />
        </button>
        <button
          type="button"
          className="widget__button"
          aria-label={`Hide ${title}`}
          title={`Hide ${title}`}
          onClick={() => actions.hide(id)}
        >
          <Icon d={ICONS.close} />
        </button>
      </div>
      <div className="widget__body" ref={actions.body(id)} />
      <div
        className="widget__resize"
        data-edge={zone === 'main' ? undefined : zone === 'top' ? 'bottom' : 'top'}
        aria-hidden="true"
        onPointerDown={(event) => actions.begin(event, id, 'resize')}
        onPointerMove={actions.track}
        onPointerUp={actions.end}
        onLostPointerCapture={actions.end}
        onPointerCancel={actions.cancel}
      />
    </div>
  );
});
