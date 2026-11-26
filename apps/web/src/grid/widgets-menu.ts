import { createContext, useContext } from 'react';
import type { MenuItem } from '../components/Menu.tsx';

/**
 * The open page's Widgets, for the header Menu's Widgets side menu: each one to show or hide,
 * then Reset layout. The page's Grid supplies them; the header shows them.
 */
export interface WidgetsMenu {
  items: readonly MenuItem[] | null;
  setItems: (items: readonly MenuItem[] | null) => void;
}

export const WidgetsMenuContext = createContext<WidgetsMenu>({
  items: null,
  setItems: () => undefined,
});

export const useWidgetsMenu = () => useContext(WidgetsMenuContext);
