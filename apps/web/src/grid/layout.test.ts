import { describe, expect, it } from 'vitest';
import {
  compactRows,
  defaultLayout,
  filled,
  fitToContent,
  GRID,
  moveWidget,
  PAGE_WIDGETS,
  parseLayout,
  pinWidget,
  resizeWidget,
  rowsFor,
  serialiseLayout,
  setWidgetHidden,
  spreadIntoAbsent,
  withoutWidgets,
  widgetsIn,
  type Cell,
  type GridPage,
  type WidgetLayout,
} from './layout.ts';

const overlaps = (a: Cell, b: Cell) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** No Zone has a row, above its last Widget's bottom, that no shown Widget covers. */
function expectNoBlankRows(layout: WidgetLayout) {
  for (const zone of ['top', 'main', 'bottom'] as const) {
    const ids = widgetsIn(layout, zone);
    const bottom = Math.max(0, ...ids.map((id) => layout[id]!.y + layout[id]!.h));
    for (let row = 0; row < bottom; row++) {
      const covered = ids.some((id) => layout[id]!.y <= row && row < layout[id]!.y + layout[id]!.h);
      expect(covered, `${zone} row ${row}`).toBe(true);
    }
  }
}

function expectNoOverlaps(layout: WidgetLayout) {
  for (const zone of ['top', 'main', 'bottom'] as const) {
    const ids = widgetsIn(layout, zone);
    for (const [i, a] of ids.entries()) {
      for (const b of ids.slice(i + 1))
        expect(overlaps(layout[a]!, layout[b]!), `${a} ${b}`).toBe(false);
    }
  }
}

describe('the starting layouts', () => {
  it.each(Object.keys(PAGE_WIDGETS) as GridPage[])('%s fits the Grid with no overlaps', (page) => {
    const layout = defaultLayout(page);
    for (const placement of Object.values(layout)) {
      expect(placement.x + placement.w).toBeLessThanOrEqual(GRID.columns);
    }
    expectNoOverlaps(layout);
  });

  it('every Widget id is unique across pages', () => {
    const ids = Object.values(PAGE_WIDGETS)
      .flat()
      .map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('moving', () => {
  it('goes where it is dropped, pushing down what it lands on', () => {
    const layout = moveWidget(defaultLayout('host'), 'host.network', 0, 0);
    expect(layout['host.network']).toMatchObject({ x: 0, y: 0, w: 4 });
    expectNoOverlaps(layout);
    expect(layout['host.overview']!.y).toBeGreaterThanOrEqual(layout['host.network']!.h);
  });

  it('snaps to whole cells, stays inside the Grid and rises to meet what is above it', () => {
    const layout = moveWidget(defaultLayout('host'), 'host.cpu', 99.4, 2.6);
    expect(layout['host.cpu']).toMatchObject({ x: GRID.columns - 4, y: 0 });
    expectNoOverlaps(layout);
  });

  it('dropped onto a short column, rises to the Widget above it', () => {
    const start = defaultLayout('host');
    const narrow = resizeWidget(start, 'host.folders', 4, start['host.folders']!.h);
    const placed = moveWidget(narrow, 'host.folders', 0, 80);
    // Under Overview and Memory, whatever row it was dropped on.
    expect(placed['host.folders']!.y).toBe(start['host.memory']!.y + start['host.memory']!.h);
  });

  it('moved down onto the Widget under it, swaps with it', () => {
    const start = defaultLayout('host');
    const layout = moveWidget(start, 'host.overview', 0, 1);
    expect(layout['host.memory']!.y).toBe(0);
    expect(layout['host.overview']!.y).toBe(start['host.memory']!.h);
    expectNoOverlaps(layout);
  });
});

describe('resizing, hiding and pinning', () => {
  it('a resized Widget keeps the height given it', () => {
    const layout = resizeWidget(defaultLayout('host'), 'host.cpu', 6, 20);
    expect(layout['host.cpu']).toMatchObject({ w: 6, h: 20, sized: true });
    expectNoOverlaps(layout);
  });

  it('is never made smaller than its minimum', () => {
    const layout = resizeWidget(defaultLayout('host'), 'host.cpu', 0, 0);
    expect(layout['host.cpu']!.w).toBeGreaterThanOrEqual(3);
    expect(layout['host.cpu']!.h).toBeGreaterThanOrEqual(6);
  });

  it('hidden, its rows close up; shown again, it goes back', () => {
    const start = defaultLayout('container');
    const hidden = setWidgetHidden(start, 'container.logs', true);
    expect(widgetsIn(hidden, 'main')).not.toContain('container.logs');
    const network = setWidgetHidden(defaultLayout('host'), 'host.network', true);
    expect(network['host.network']!.hidden).toBe(true);
    const shown = setWidgetHidden(hidden, 'container.logs', false);
    expect(shown['container.logs']).toMatchObject({ hidden: false, y: start['container.logs']!.y });
  });

  it('pinned, it spans the Grid and stacks under what is pinned already', () => {
    let layout = pinWidget(defaultLayout('host'), 'host.cpu', 'top');
    layout = pinWidget(layout, 'host.memory', 'top');
    expect(layout['host.cpu']).toMatchObject({ zone: 'top', x: 0, w: GRID.columns, y: 0 });
    expect(layout['host.memory']!.y).toBe(layout['host.cpu']!.h);
    expect(widgetsIn(layout, 'main')).not.toContain('host.cpu');
    const unpinned = pinWidget(layout, 'host.cpu', 'main');
    expect(unpinned['host.cpu']).toMatchObject({ zone: 'main', y: 0 });
    expectNoOverlaps(unpinned);
  });
});

describe('fitting to content', () => {
  it('draws a Widget only as tall as its content, closing the rows it frees', () => {
    const start = defaultLayout('container');
    const fitted = fitToContent(start, { 'container.logs': 24 });
    expect(fitted['container.logs']!.h).toBe(24);
  });

  it('grows with its content up to its limit, pushing down what is below', () => {
    const start = defaultLayout('host');
    const fitted = fitToContent(start, { 'host.overview': 15 });
    expect(fitted['host.overview']!.h).toBe(15);
    expectNoOverlaps(fitted);
  });

  it('counts the gap between rows', () => {
    expect(rowsFor(GRID.rowHeight, 'main')).toBe(1);
    expect(rowsFor(GRID.rowHeight * 2 + GRID.gap, 'main')).toBe(2);
  });
});

describe('keeping a layout', () => {
  it('reads back what it saved', () => {
    const moved = moveWidget(defaultLayout('host'), 'host.cpu', 0, 30);
    expect(parseLayout(serialiseLayout(moved), 'host')).toEqual(moved);
  });

  it.each([null, '', 'not json', '{"widgets":3}', '{"widgets":{"host.cpu":{"zone":"sideways"}}}'])(
    'falls back to the starting layout for %j',
    (saved) => {
      expect(parseLayout(saved, 'host')).toEqual(defaultLayout('host'));
    },
  );

  it('settles a saved layout that overlaps', () => {
    const clash = {
      widgets: {
        'host.cpu': { x: 0, y: 0, w: 4, h: 8, zone: 'main', hidden: false },
        'host.memory': { x: 0, y: 0, w: 4, h: 8, zone: 'main', hidden: false },
      },
    };
    expectNoOverlaps(parseLayout(JSON.stringify(clash), 'host'));
  });
});

describe('never a whole blank row', () => {
  it.each(Object.keys(PAGE_WIDGETS) as GridPage[])('the %s starting layout has none', (page) => {
    expectNoBlankRows(defaultLayout(page));
  });

  it('a Widget dropped far below the others comes up to meet them', () => {
    const layout = moveWidget(defaultLayout('host'), 'host.overview', 0, 200);
    expectNoBlankRows(layout);
    expect(layout['host.overview']!.y).toBe(layout['host.folders']!.y + layout['host.folders']!.h);
  });

  it('hiding, pinning away or shrinking a Widget leaves no blank band', () => {
    const start = defaultLayout('container');
    expectNoBlankRows(setWidgetHidden(start, 'container.env', true));
    expectNoBlankRows(pinWidget(start, 'container.logs', 'top'));
    expectNoBlankRows(fitToContent(start, { 'container.details': 3, 'container.lifecycle': 3 }));
  });

  it('every move, in any direction, leaves no blank row', () => {
    let layout = defaultLayout('host');
    for (const [x, y] of [
      [8, 40],
      [0, 2],
      [4, 15],
      [6, 0],
      [2, 60],
    ] as const) {
      for (const id of ['host.cpu', 'host.network', 'host.disks']) {
        layout = moveWidget(layout, id, x, y);
        expectNoBlankRows(layout);
        expectNoOverlaps(layout);
      }
    }
  });

  it('closes the gaps in a layout saved by an older version', () => {
    const gappy = {
      widgets: {
        'host.cpu': { x: 0, y: 0, w: 4, h: 8, zone: 'main', hidden: false },
        'host.memory': { x: 0, y: 30, w: 4, h: 8, zone: 'main', hidden: false },
      },
    };
    const layout = parseLayout(JSON.stringify(gappy), 'host');
    expectNoBlankRows(layout);
    expect(compactRows(layout)).toEqual(layout);
  });
});

describe('no holes', () => {
  it.each(Object.keys(PAGE_WIDGETS) as GridPage[])(
    'the %s starting layout has no Widget that could rise',
    (page) => {
      expect(compactRows(defaultLayout(page))).toEqual(defaultLayout(page));
    },
  );

  it('a Widget left under a hole by a shorter one above rises into it', () => {
    const start = defaultLayout('host');
    const fitted = fitToContent(start, { 'host.overview': 6 });
    expect(fitted['host.memory']!.y).toBe(6);
  });

  it('as drawn, each Widget reaches down to the one under it or the foot of its Zone', () => {
    const drawn = filled(defaultLayout('host'));
    // Overview and Memory end at row 28, beside columns that end at row 32.
    expect(drawn['host.memory']).toMatchObject({ y: 10, h: 22 });
    expect(drawn['host.overview']!.h).toBe(10);
    const bottom = drawn['host.folders']!;
    expect(bottom.y + bottom.h).toBe(56);
    expectNoOverlaps(drawn);
  });
});

describe('a layout kept by version 1', () => {
  it("is read at today's finer rows", () => {
    const v1 = {
      version: 1,
      widgets: {
        'host.cpu': { x: 0, y: 0, w: 4, h: 8, zone: 'main', hidden: false, sized: true },
      },
    };
    expect(parseLayout(JSON.stringify(v1), 'host')['host.cpu']).toMatchObject({
      h: 16,
      sized: true,
    });
  });
});

describe('a Widget made taller can be made smaller again', () => {
  it('keeps the height it was last given, even below what its content needs', () => {
    let layout = resizeWidget(defaultLayout('host'), 'host.cpu', 4, 20);
    // As drawn, its content fills the 20 rows it was given.
    layout = fitToContent(layout, { 'host.cpu': 20 });
    expect(layout['host.cpu']!.h).toBe(20);
    layout = resizeWidget(layout, 'host.cpu', 4, 6);
    expect(fitToContent(layout, { 'host.cpu': 20 })['host.cpu']!.h).toBe(6);
    expect(fitToContent(layout, { 'host.cpu': 8 })['host.cpu']!.h).toBe(6);
  });

  it('is never made smaller than its minimum', () => {
    const layout = resizeWidget(defaultLayout('host'), 'host.cpu', 4, 1);
    expect(fitToContent(layout, { 'host.cpu': 8 })['host.cpu']!.h).toBe(6);
  });
});

describe('spreadIntoAbsent', () => {
  it('draws Networks across the cells a Container with no Hosted Sites leaves', () => {
    const kept = withoutWidgets(defaultLayout('container'), ['container.sites']);
    const drawn = spreadIntoAbsent(kept, ['container.sites']);
    const sites = kept['container.sites']!;
    expect(drawn['container.networks']).toMatchObject({ x: sites.x, w: 6 });
    expectNoOverlaps(drawn);
    // Never kept: the layout itself is unchanged.
    expect(kept['container.networks']).toMatchObject({ x: 9, w: 3 });
  });

  it('leaves the layout alone when nothing is absent', () => {
    const layout = defaultLayout('container');
    expect(spreadIntoAbsent(layout, [])).toBe(layout);
  });

  it('does not spread over another Widget', () => {
    const kept = withoutWidgets(defaultLayout('container'), ['container.sites']);
    // Mounts moved up into the absent cells' rows, so nothing may spread there.
    const blocked = {
      ...kept,
      'container.mounts': { ...kept['container.mounts']!, x: 6, y: 12, w: 3 },
    };
    const drawn = spreadIntoAbsent(blocked, ['container.sites']);
    expect(drawn['container.networks']).toMatchObject({ x: 9, w: 3 });
  });
});
