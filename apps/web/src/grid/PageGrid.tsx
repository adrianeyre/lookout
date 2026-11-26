import { useEffect, type ReactNode } from 'react';
import { PAGE_WIDGETS, setWidgetHidden, type GridPage } from './layout.ts';
import { useWidgetLayout } from './useWidgetLayout.ts';
import { useWidgetsMenu } from './widgets-menu.ts';
import { WidgetGrid } from './WidgetGrid.tsx';

/**
 * A page of Widgets: its title, its Widgets for the header Menu's Widgets side menu (to show or
 * hide each one and reset the layout),
 * and the Grid. The layout is kept per page, in this browser.
 */
export function PageGrid({
  page,
  title,
  titleHidden = false,
  head,
  widgets,
  empty,
}: {
  page: GridPage;
  title: string;
  /** Kept for screen readers only, where the page shows its own heading in `head`. */
  titleHidden?: boolean;
  /** Shown above the Grid instead of the plain title, such as a Container's name and actions. */
  head?: ReactNode;
  widgets: Readonly<Record<string, ReactNode>>;
  empty?: readonly string[];
}) {
  const { layout, setLayout, reset } = useWidgetLayout(page);
  const { setItems } = useWidgetsMenu();
  const shownIds = PAGE_WIDGETS[page].filter((spec) => widgets[spec.id] !== undefined);
  const key = shownIds.map((spec) => spec.id).join(',');
  // The header Menu's Widgets side menu: each of this page's Widgets, then Reset layout.
  useEffect(() => {
    setItems([
      ...shownIds.map((spec) => ({
        kind: 'checkbox' as const,
        id: spec.id,
        label: spec.title,
        checked: !layout[spec.id]!.hidden,
        onToggle: () => setLayout(setWidgetHidden(layout, spec.id, !layout[spec.id]!.hidden)),
      })),
      { kind: 'separator', id: 'reset-separator' },
      { kind: 'action', id: 'reset', label: 'Reset layout', onSelect: reset },
    ]);
    // shownIds is described by key; the menu changes when the layout or the Widgets do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, key, setItems, setLayout, reset]);
  useEffect(() => () => setItems(null), [setItems]);

  return (
    <>
      {head ? (
        <div className="page-bar">{head}</div>
      ) : (
        <h1 className={titleHidden ? 'visually-hidden' : 'page-title'}>{title}</h1>
      )}
      <WidgetGrid layout={layout} onLayout={setLayout} widgets={widgets} empty={empty} />
    </>
  );
}
