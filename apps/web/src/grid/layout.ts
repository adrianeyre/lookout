/**
 * Where each Widget of a page sits on its Grid: a pure model, so moving, resizing, pinning and
 * hiding can be tested without a browser. Ported from soundcheck's Widget Grid.
 *
 * The Grid is `GRID.columns` wide and as many rows tall as it needs. A Widget covers whole
 * cells, so everything snaps. It sits in one of three Zones: `main` scrolls with the page,
 * `top` is pinned to the top of the window and `bottom` above the footer. Widgets never overlap
 * within a Zone: one dropped onto others pushes them down. A Zone never has a gap above a Widget:
 * after a move, a resize, a Widget hidden or pinned away, or its content changing, every Widget
 * rises as far as the Widgets above it let it, so no rows are left blank and no holes are left
 * under a short Widget. As drawn (`filled`), each also reaches down to whatever is under it, so
 * the Grid's edges line up. Pinned Widgets are full-width bands, stacked one above the other.
 */

export const GRID = { columns: 12, rowHeight: 8, gap: 12 } as const;

/**
 * How many of today's rows one row of a layout saved by version 1 was: its rows were 24px with a
 * 16px gap, a 40px pitch, where today's are 20px.
 */
const V1_ROWS = 2;

export type Zone = 'top' | 'main' | 'bottom';

export const ZONES: readonly Zone[] = ['top', 'main', 'bottom'];

export interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WidgetPlacement extends Cell {
  zone: Zone;
  hidden: boolean;
  /**
   * Resized by hand: kept at exactly that height, taller or shorter than its content (which
   * then scrolls), rather than fitted to it. Reset layout fits it again.
   */
  sized?: boolean;
  /**
   * The most rows it takes by itself, fitted to its content, where that is more than it is
   * drawn now (`h`): the rows under its content stay free for another Widget, and it grows back
   * into them only if its content does.
   */
  room?: number | undefined;
}

/** The dashboard's pages that have a Grid. */
export type GridPage = 'host' | 'containers' | 'container' | 'websites' | 'site' | 'settings';

export interface WidgetSpec {
  /** Unique across every page, such as "host.cpu". */
  id: string;
  /** What the Widgets menu, and the Widget's own controls, call it. */
  title: string;
  /** Where it starts, and where "Reset layout" puts it back. */
  initial: Cell;
  /** The smallest it can be made, in cells. */
  min: { w: number; h: number };
  /** The most rows it grows to by itself as its content grows, past the height it was made. */
  grows?: number;
  /** Hidden until shown from the Widgets menu, and again after "Reset layout". */
  startsHidden?: boolean;
}

const MIN = { w: 3, h: 6 };
/** Lists that grow with what they show, such as every Container: they push down what is below. */
const LONG = 800;

/**
 * Each page's Widgets, in Widgets-menu order, which is also their order on narrow screens.
 * The starting places stack them in columns of about the same height, at their usual heights
 * (measured with the screenshot data), so a fresh page's columns end together.
 */
export const PAGE_WIDGETS: Readonly<Record<GridPage, readonly WidgetSpec[]>> = {
  host: [
    {
      id: 'host.overview',
      title: 'Overview',
      initial: { x: 0, y: 0, w: 4, h: 10 },
      min: MIN,
      grows: 40,
    },
    { id: 'host.cpu', title: 'CPU', initial: { x: 4, y: 0, w: 4, h: 16 }, min: MIN, grows: 60 },
    {
      id: 'host.memory',
      title: 'Memory',
      initial: { x: 0, y: 10, w: 4, h: 18 },
      min: MIN,
      grows: 60,
    },
    {
      id: 'host.disks',
      title: 'Disk space',
      initial: { x: 8, y: 0, w: 4, h: 14 },
      min: MIN,
      grows: 80,
    },
    {
      id: 'host.diskIo',
      title: 'Disk I/O',
      initial: { x: 4, y: 16, w: 4, h: 16 },
      min: MIN,
      grows: 80,
    },
    {
      id: 'host.network',
      title: 'Network',
      initial: { x: 8, y: 14, w: 4, h: 18 },
      min: MIN,
      grows: 80,
    },
    {
      id: 'host.folders',
      title: 'Largest folders',
      initial: { x: 0, y: 32, w: 12, h: 24 },
      min: { w: 4, h: 8 },
      grows: 80,
    },
    {
      id: 'host.docker',
      title: 'Docker disk',
      initial: { x: 0, y: 56, w: 12, h: 22 },
      min: { w: 4, h: 8 },
      grows: 80,
    },
  ],
  containers: [
    {
      id: 'containers.list',
      title: 'Container list',
      initial: { x: 0, y: 0, w: 12, h: 48 },
      min: { w: 6, h: 12 },
      grows: LONG,
    },
  ],
  container: [
    {
      id: 'container.details',
      title: 'Container',
      initial: { x: 0, y: 0, w: 6, h: 17 },
      min: MIN,
      grows: 60,
    },
    {
      id: 'container.lifecycle',
      title: 'Lifecycle',
      initial: { x: 6, y: 0, w: 6, h: 12 },
      min: MIN,
      grows: 40,
    },
    {
      id: 'container.sites',
      title: 'Hosted Sites',
      initial: { x: 6, y: 12, w: 3, h: 6 },
      min: MIN,
      grows: 60,
    },
    {
      id: 'container.env',
      title: 'Environment',
      initial: { x: 0, y: 17, w: 6, h: 15 },
      min: MIN,
      grows: 120,
    },
    {
      id: 'container.mounts',
      title: 'Mounts',
      initial: { x: 6, y: 18, w: 6, h: 7 },
      min: MIN,
      grows: 80,
    },
    {
      id: 'container.networks',
      title: 'Networks',
      initial: { x: 9, y: 12, w: 3, h: 6 },
      min: MIN,
      grows: 60,
    },
    {
      id: 'container.labels',
      title: 'Labels',
      initial: { x: 6, y: 25, w: 6, h: 8 },
      min: MIN,
      grows: 120,
    },
    {
      id: 'container.logs',
      title: 'Logs',
      initial: { x: 0, y: 33, w: 12, h: 33 },
      min: { w: 6, h: 20 },
      grows: 80,
    },
  ],
  websites: [
    {
      id: 'websites.list',
      title: 'Hosted Sites',
      initial: { x: 0, y: 0, w: 12, h: 30 },
      min: { w: 6, h: 12 },
      grows: LONG,
    },
  ],
  site: [
    {
      id: 'site.visitors',
      title: 'Visitors',
      initial: { x: 0, y: 0, w: 6, h: 16 },
      min: MIN,
      grows: 40,
    },
    {
      id: 'site.pageViews',
      title: 'Page views and requests',
      initial: { x: 6, y: 0, w: 6, h: 16 },
      min: MIN,
      grows: 40,
    },
    {
      id: 'site.bots',
      title: 'Humans and bots',
      initial: { x: 0, y: 16, w: 6, h: 16 },
      min: MIN,
      grows: 40,
    },
    {
      id: 'site.status',
      title: 'Status codes',
      initial: { x: 6, y: 16, w: 6, h: 16 },
      min: MIN,
      grows: 40,
    },
    {
      id: 'site.responseTime',
      title: 'Response time',
      initial: { x: 0, y: 32, w: 6, h: 16 },
      min: MIN,
      grows: 40,
    },
    {
      id: 'site.uptime',
      title: 'Uptime',
      initial: { x: 6, y: 32, w: 6, h: 16 },
      min: MIN,
      grows: 40,
    },
    {
      id: 'site.topPages',
      title: 'Top pages',
      initial: { x: 0, y: 48, w: 6, h: 20 },
      min: MIN,
      grows: 60,
    },
    {
      id: 'site.topReferrers',
      title: 'Top referrers',
      initial: { x: 6, y: 48, w: 6, h: 20 },
      min: MIN,
      grows: 60,
    },
    {
      id: 'site.size',
      title: 'Disk and Docker space',
      initial: { x: 0, y: 68, w: 8, h: 22 },
      min: MIN,
      grows: 60,
    },
    {
      id: 'site.tls',
      title: 'TLS certificate',
      initial: { x: 8, y: 68, w: 4, h: 8 },
      min: MIN,
      grows: 20,
    },
    {
      id: 'site.containers',
      title: 'Containers',
      initial: { x: 8, y: 76, w: 4, h: 14 },
      min: MIN,
      grows: 60,
    },
  ],
  settings: [
    {
      id: 'settings.appearance',
      title: 'Appearance',
      initial: { x: 0, y: 0, w: 12, h: 16 },
      min: { w: 4, h: 16 },
      grows: 80,
    },
    {
      id: 'settings.password',
      title: 'Password',
      initial: { x: 0, y: 16, w: 12, h: 16 },
      min: { w: 4, h: 12 },
      grows: 60,
    },
  ],
};

/** Where each Widget of one page sits. It holds only that page's Widgets. */
export type WidgetLayout = Record<string, WidgetPlacement>;

const ALL_WIDGETS: readonly WidgetSpec[] = Object.values(PAGE_WIDGETS).flat();
const SPECS = new Map(ALL_WIDGETS.map((spec) => [spec.id, spec]));

export function widgetSpec(id: string): WidgetSpec {
  const spec = SPECS.get(id);
  if (!spec) throw new Error(`No Widget "${id}"`);
  return spec;
}

/** The Widgets `layout` holds, in their page's order. */
export function specsOf(layout: WidgetLayout): WidgetSpec[] {
  return ALL_WIDGETS.filter((spec) => layout[spec.id] !== undefined);
}

export function defaultLayout(page: GridPage): WidgetLayout {
  return Object.fromEntries(
    PAGE_WIDGETS[page].map((spec) => [
      spec.id,
      { ...spec.initial, zone: 'main', hidden: spec.startsHidden === true },
    ]),
  );
}

const overlaps = (a: Cell, b: Cell) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const at = (layout: WidgetLayout, id: string): WidgetPlacement => layout[id]!;

/** The Widgets shown in `zone`, top to bottom, then left to right. */
export function widgetsIn(layout: WidgetLayout, zone: Zone): string[] {
  return specsOf(layout)
    .map((spec) => spec.id)
    .filter((id) => at(layout, id).zone === zone && !at(layout, id).hidden)
    .sort((a, b) => at(layout, a).y - at(layout, b).y || at(layout, a).x - at(layout, b).x);
}

/** How many rows `zone` needs to show all its Widgets. */
export function zoneRows(layout: WidgetLayout, zone: Zone): number {
  return Math.max(0, ...widgetsIn(layout, zone).map((id) => at(layout, id).y + at(layout, id).h));
}

const pinned = (zone: Zone) => zone !== 'main';

/** `cell` made whole, at least the Widget's minimum and inside the Grid; pinned, full width. */
function fit(id: string, cell: Cell, zone: Zone): Cell {
  const { min } = widgetSpec(id);
  const w = pinned(zone)
    ? GRID.columns
    : Math.min(GRID.columns, Math.max(min.w, Math.round(cell.w)));
  return {
    w,
    h: Math.max(min.h, Math.round(cell.h)),
    x: Math.min(GRID.columns - w, Math.max(0, Math.round(cell.x))),
    y: Math.max(0, Math.round(cell.y)),
  };
}

/** Push whatever `id` now covers down below it, and whatever that covers below that. */
function settle(layout: WidgetLayout, id: string): WidgetLayout {
  const next = { ...layout };
  const queue: string[] = [id];
  while (queue.length > 0) {
    const mover = at(next, queue.shift()!);
    for (const other of widgetsIn(next, mover.zone)) {
      if (other === id || next[other] === mover || !overlaps(mover, at(next, other))) continue;
      next[other] = { ...at(next, other), y: mover.y + mover.h };
      queue.push(other);
    }
  }
  return next;
}

/** The rows of `zone` some shown Widget covers. */
function coveredRows(layout: WidgetLayout, zone: Zone): Set<number> {
  return new Set(
    widgetsIn(layout, zone).flatMap((id) =>
      Array.from({ length: at(layout, id).h }, (_, row) => at(layout, id).y + row),
    ),
  );
}

/**
 * Closes every gap in each Zone. First the rows no shown Widget covers are taken out, moving
 * what is below up; a hidden Widget moves with the rows above it, so it comes back beside the
 * same neighbours. Then each shown Widget, top to bottom, rises until it meets the Widgets
 * above it, so none is left hanging under a hole beside a taller one.
 */
export function compactRows(layout: WidgetLayout): WidgetLayout {
  let next = layout;
  for (const zone of ZONES) {
    const covered = coveredRows(next, zone);
    const bottom = zoneRows(next, zone);
    const blank = Array.from({ length: bottom }, (_, row) => row).filter(
      (row) => !covered.has(row),
    );
    if (blank.length > 0) {
      const moved = { ...next };
      for (const spec of specsOf(next)) {
        const placement = at(next, spec.id);
        if (placement.zone !== zone) continue;
        const up = blank.filter((row) => row < placement.y).length;
        if (up > 0) moved[spec.id] = { ...placement, y: placement.y - up };
      }
      next = moved;
    }
    next = rise(next, zone);
  }
  return next;
}

/** Each shown Widget of `zone`, top to bottom, as high as the Widgets above it let it go. */
function rise(layout: WidgetLayout, zone: Zone): WidgetLayout {
  let next = layout;
  const placed: WidgetPlacement[] = [];
  for (const id of widgetsIn(layout, zone)) {
    const placement = at(layout, id);
    const y = Math.max(
      0,
      ...placed
        .filter((above) => above.x < placement.x + placement.w && placement.x < above.x + above.w)
        .map((above) => above.y + above.h),
    );
    const risen = y === placement.y ? placement : { ...placement, y };
    if (risen !== placement) {
      if (next === layout) next = { ...layout };
      next[id] = risen;
    }
    placed.push(risen);
  }
  return next;
}

/**
 * The layout as it is drawn with `absent` Widgets left out (WidgetGrid's `empty`): a shown
 * Widget beside the cells an absent one would take spreads sideways into them, so a Container
 * with no Hosted Sites shows its Networks the full width of that column rather than beside a
 * blank space. Only where those cells are free in every row it covers, and never kept: the
 * Widget's own width is unchanged, and it draws narrower again when the absent one comes back.
 */
export function spreadIntoAbsent(layout: WidgetLayout, absent: readonly string[]): WidgetLayout {
  let next = layout;
  for (const gap of absent) {
    const hole = next[gap];
    if (!hole || hole.zone !== 'main') continue;
    const shown = widgetsIn(next, 'main');
    const free = (cell: Cell, except: string) =>
      shown.every((other) => other === except || !overlaps(cell, at(next, other)));
    const rowsMeet = (cell: Cell) => cell.y < hole.y + hole.h && hole.y < cell.y + cell.h;
    // The Widget to its right spreads left first, then the one to its left spreads right.
    const right = shown.find((id) => at(next, id).x === hole.x + hole.w && rowsMeet(at(next, id)));
    const left = shown.find(
      (id) => at(next, id).x + at(next, id).w === hole.x && rowsMeet(at(next, id)),
    );
    for (const [id, side] of [
      [right, 'left'],
      [left, 'right'],
    ] as const) {
      if (id === undefined) continue;
      const placement = at(next, id);
      const strip: Cell = { x: hole.x, y: placement.y, w: hole.w, h: placement.h };
      if (!free(strip, id)) continue;
      if (next === layout) next = { ...layout };
      next[id] =
        side === 'left'
          ? { ...placement, x: hole.x, w: placement.w + hole.w }
          : { ...placement, w: placement.w + hole.w };
      break;
    }
  }
  return next;
}

/**
 * The layout as it is drawn: each shown Widget reaches down to the Widget under it, or to the
 * bottom of its Zone, so the Grid has no holes and its edges line up. It is never kept: a
 * Widget's own height is still what its content, or its resize, gives it.
 */
export function filled(layout: WidgetLayout): WidgetLayout {
  let next = layout;
  for (const zone of ZONES) {
    const ids = widgetsIn(layout, zone);
    const bottom = zoneRows(layout, zone);
    for (const id of ids) {
      const placement = at(layout, id);
      const floor = Math.min(
        bottom,
        ...ids
          .map((other) => at(layout, other))
          .filter(
            (other) =>
              other.y >= placement.y + placement.h &&
              other.x < placement.x + placement.w &&
              placement.x < other.x + other.w,
          )
          .map((other) => other.y),
      );
      if (floor <= placement.y + placement.h) continue;
      if (next === layout) next = { ...layout };
      next[id] = { ...placement, h: floor - placement.y };
    }
  }
  return next;
}

/**
 * The layout as a page that doesn't draw `absent` shows it: without them, and without the
 * rows they leave empty. One that comes back pushes down whatever it now overlaps.
 */
export function withoutWidgets(layout: WidgetLayout, absent: readonly string[]): WidgetLayout {
  const next = { ...layout };
  for (const id of absent) next[id] = { ...at(next, id), hidden: true };
  const shown = ZONES.flatMap((zone) => widgetsIn(next, zone));
  const clashes = shown.some((id, index) =>
    shown
      .slice(index + 1)
      .some(
        (other) =>
          at(next, id).zone === at(next, other).zone && overlaps(at(next, id), at(next, other)),
      ),
  );
  if (absent.length === 0 && !clashes) return layout;
  return compactRows(clashes ? shown.reduce(settle, next) : next);
}

/** How many rows a Widget in `zone` needs to show `px` of itself, bar and frame included. */
export function rowsFor(px: number, zone: Zone): number {
  const pitch = GRID.rowHeight + GRID.gap;
  return Math.ceil(((pinned(zone) ? px : px + GRID.gap) - 0.5) / pitch);
}

/**
 * The layout as the Grid draws it: each shown Widget no taller than its content needs
 * (`needed` rows) and no shorter than its minimum, unless it was resized by hand (`sized`). One
 * that grows pushes down what is below it; the rows a smaller one frees are closed up.
 */
export function fitToContent(
  layout: WidgetLayout,
  needed: Readonly<Record<string, number>>,
): WidgetLayout {
  let next = { ...layout };
  let changed = false;
  const grown: string[] = [];
  for (const spec of specsOf(layout)) {
    const content = needed[spec.id];
    const placement = at(next, spec.id);
    if (content === undefined || placement.hidden) continue;
    const most = Math.max(placement.room ?? placement.h, placement.h, spec.grows ?? 0);
    const fitted = Math.max(spec.min.h, Math.min(most, content));
    // Resized by hand, it keeps the height it was given, taller or shorter than its content
    // (which then scrolls inside it); otherwise it fits its content.
    const h = placement.sized ? Math.max(spec.min.h, placement.h) : fitted;
    if (h === placement.h) continue;
    next[spec.id] = { ...placement, h };
    if (h > placement.h) grown.push(spec.id);
    changed = true;
  }
  next = grown.reduce(settle, next);
  if (!changed) return layout;
  return compactRows(next);
}

/**
 * A layout changed as it is drawn (`fitToContent`) back as it is kept: where each Widget now
 * is, at the height it is drawn, with the most it takes (`room`) kept beside that. `resized`'s
 * is the height given it. One that grew with its content is kept at its own height, so it
 * shrinks again when its content does.
 */
export function unfitted(
  next: WidgetLayout,
  kept: WidgetLayout,
  resized: string | null,
): WidgetLayout {
  const layout = { ...next };
  for (const spec of specsOf(next)) {
    if (spec.id === resized) continue;
    const drawn = at(next, spec.id);
    const own = at(kept, spec.id);
    if (spec.grows !== undefined && !drawn.sized) {
      layout[spec.id] = { ...drawn, h: own.h };
      continue;
    }
    const room = Math.max(own.room ?? own.h, own.h);
    const rest = { ...drawn };
    delete rest.room;
    layout[spec.id] = room > drawn.h ? { ...rest, room } : rest;
  }
  const order = ZONES.flatMap((zone) => widgetsIn(layout, zone));
  return compactRows(order.reduce(settle, layout));
}

/** `id` changed, whatever it now covers pushed down, and any blank rows closed up. */
function place(layout: WidgetLayout, id: string, changes: Partial<WidgetPlacement>): WidgetLayout {
  const placed = { ...at(layout, id), ...changes };
  return compactRows(
    settle({ ...layout, [id]: { ...placed, ...fit(id, placed, placed.zone) } }, id),
  );
}

/**
 * A Widget moved goes where it was dropped, and any rows that leaves blank close up, so it
 * never strands a band of blank space. Moved down onto the Widgets below it, it swaps with
 * them: they rise into the rows it left and it goes under them, so the arrow keys can move a
 * Widget past the one under it. If they can't rise, it pushes them down instead.
 */
export function moveWidget(layout: WidgetLayout, id: string, x: number, y: number): WidgetLayout {
  const from = at(layout, id);
  const to = { ...from, ...fit(id, { ...from, x, y }, from.zone) };
  if (to.y <= from.y) return place(layout, id, to);
  const below = widgetsIn(layout, from.zone).filter(
    (other) =>
      other !== id && at(layout, other).y >= from.y + from.h && overlaps(to, at(layout, other)),
  );
  if (below.length === 0) return place(layout, id, to);
  const rise = Math.min(...below.map((other) => at(layout, other).y)) - from.y;
  const risen = { ...layout };
  for (const other of below) risen[other] = { ...at(layout, other), y: at(layout, other).y - rise };
  const blocked = widgetsIn(layout, from.zone).some(
    (other) =>
      other !== id &&
      !below.includes(other) &&
      below.some((b) => overlaps(at(risen, b), at(layout, other))),
  );
  if (blocked) return place(layout, id, to);
  const under = Math.max(
    to.y,
    ...below
      .filter((b) => overlaps({ ...to, y: 0, h: Infinity }, at(risen, b)))
      .map((b) => at(risen, b).y + at(risen, b).h),
  );
  return place(risen, id, { ...to, y: under });
}

/** Made taller or shorter, a Widget keeps the height given it (`sized`). */
export function resizeWidget(layout: WidgetLayout, id: string, w: number, h: number): WidgetLayout {
  const placement = at(layout, id);
  const sized =
    placement.sized === true || fit(id, { ...placement, w, h }, placement.zone).h !== placement.h;
  return place(layout, id, sized ? { w, h, sized, room: undefined } : { w, h });
}

/** Hidden, a Widget's rows close up; shown again, it goes back where it was. */
export function setWidgetHidden(layout: WidgetLayout, id: string, hidden: boolean): WidgetLayout {
  return hidden
    ? compactRows({ ...layout, [id]: { ...at(layout, id), hidden } })
    : place(layout, id, { hidden });
}

/**
 * Moves a Widget to another Zone. Pinned, it spans the Grid and goes under whatever is pinned
 * there already; unpinned from the top it goes to the top of the page, and from the bottom to
 * the bottom, which is where it was on screen.
 */
export function pinWidget(layout: WidgetLayout, id: string, zone: Zone): WidgetLayout {
  const from = at(layout, id).zone;
  if (from === zone) return layout;
  const without = { ...layout, [id]: { ...at(layout, id), hidden: true } };
  const y = zone === 'main' && from === 'top' ? 0 : zoneRows(without, zone);
  return place(layout, id, { zone, y, hidden: false });
}

/** Where a page's layout is kept in this browser. */
export function gridKey(page: GridPage): string {
  return `lookout.grid.${page}`;
}

export function serialiseLayout(layout: WidgetLayout): string {
  return JSON.stringify({ version: 2, widgets: layout });
}

/**
 * A saved layout, as far as it can be trusted. A Widget missing from it (one added since) or
 * saved wrongly gets its starting place.
 */
export function parseLayout(saved: string | null, page: GridPage): WidgetLayout {
  const layout = defaultLayout(page);
  if (!saved) return layout;
  let widgets: unknown;
  let version: unknown;
  try {
    ({ widgets, version } = JSON.parse(saved) as { widgets?: unknown; version?: unknown });
  } catch {
    return layout;
  }
  // Version 1 counted in rows twice as tall as today's.
  const scale = version === 1 ? V1_ROWS : 1;
  if (typeof widgets !== 'object' || widgets === null) return layout;
  for (const spec of PAGE_WIDGETS[page]) {
    const entry = (widgets as Record<string, unknown>)[spec.id] as
      Partial<WidgetPlacement> | undefined;
    if (!entry || !ZONES.includes(entry.zone as Zone)) continue;
    const cell = [entry.x, entry.y, entry.w, entry.h];
    if (!cell.every((value) => typeof value === 'number' && Number.isFinite(value))) continue;
    const zone = entry.zone!;
    const room = typeof entry.room === 'number' ? entry.room * scale : undefined;
    const h = (entry.h as number) * scale;
    layout[spec.id] = {
      ...fit(spec.id, { ...(entry as Cell), y: (entry.y as number) * scale, h }, zone),
      zone,
      hidden: entry.hidden === true,
      ...(entry.sized === true && { sized: true }),
      ...(room !== undefined && Number.isInteger(room) && room > h && { room }),
    };
  }
  // Saved by hand or by an older version, it may overlap: settle each in order.
  return compactRows(
    PAGE_WIDGETS[page].reduce(
      (settled, spec) => (at(settled, spec.id).hidden ? settled : settle(settled, spec.id)),
      layout,
    ),
  );
}
