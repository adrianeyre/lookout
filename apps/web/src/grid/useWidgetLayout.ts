import { useCallback, useState } from 'react';
import {
  defaultLayout,
  gridKey,
  parseLayout,
  serialiseLayout,
  type GridPage,
  type WidgetLayout,
} from './layout.ts';

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** A page's Grid layout, kept in this browser so the page opens as it was left. */
export function useWidgetLayout(page: GridPage) {
  const [layout, setState] = useState(() => parseLayout(read(gridKey(page)), page));
  const setLayout = useCallback(
    (next: WidgetLayout) => {
      setState(next);
      try {
        window.localStorage.setItem(gridKey(page), serialiseLayout(next));
      } catch {
        // Not kept, but shown for this visit.
      }
    },
    [page],
  );
  const reset = useCallback(() => {
    setState(defaultLayout(page));
    try {
      window.localStorage.removeItem(gridKey(page));
    } catch {
      // Nothing was kept.
    }
  }, [page]);
  return { layout, setLayout, reset };
}
