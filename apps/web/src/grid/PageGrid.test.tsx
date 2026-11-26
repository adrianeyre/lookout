import { useMemo, useState } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Card } from '../components/Card.tsx';
import { Menu, type MenuItem } from '../components/Menu.tsx';
import { gridKey } from './layout.ts';
import { PageGrid } from './PageGrid.tsx';
import { WidgetsMenuContext } from './widgets-menu.ts';

afterEach(() => localStorage.clear());

/** The page as the dashboard draws it: its Widgets in the header Menu's Widgets side menu. */
function Settings() {
  const [items, setItems] = useState<readonly MenuItem[] | null>(null);
  const value = useMemo(() => ({ items, setItems }), [items]);
  return (
    <WidgetsMenuContext.Provider value={value}>
      {items && (
        <Menu label="Menu" items={[{ kind: 'submenu', id: 'widgets', label: 'Widgets', items }]} />
      )}
      <Page />
    </WidgetsMenuContext.Provider>
  );
}

function Page() {
  return (
    <PageGrid
      page="host"
      title="Host"
      widgets={{
        'host.overview': <Card title="Overview">Hostname lighthouse</Card>,
        'host.cpu': <Card title="CPU">21.4% in use</Card>,
        'host.memory': <Card title="Memory">61.3% in use</Card>,
      }}
    />
  );
}

const widget = (id: string) => document.querySelector<HTMLElement>(`[data-widget="${id}"]`);

describe('PageGrid', () => {
  it('gives each Widget a bar with its heading and controls, and its content', () => {
    render(<Settings />);
    expect(screen.getByRole('heading', { level: 2, name: 'CPU' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Move CPU' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Pin CPU to the top' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Hide CPU' })).toBeDefined();
    expect(within(widget('host.cpu')!).getByText('21.4% in use')).toBeDefined();
    // The card's own heading gives way to the Widget's.
    expect(screen.getAllByRole('heading', { name: 'CPU' })).toHaveLength(1);
  });

  it('leaves out Widgets the page does not draw', () => {
    render(<Settings />);
    expect(widget('host.network')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move Network' })).toBeNull();
  });

  it('moves a Widget with the arrow keys, says where, and keeps the layout', async () => {
    const user = userEvent.setup();
    render(<Settings />);
    const grip = screen.getByRole('button', { name: 'Move Overview' });
    grip.focus();
    // Moved down onto Memory, under it, it swaps with it.
    await user.keyboard('{ArrowDown}');
    expect(widget('host.memory')!.style.gridRow).toBe('1 / span 18');
    expect(widget('host.overview')!.style.gridRow).toBe('19 / span 10');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move Overview' }));
    expect(screen.getByText(/Overview: column 1, row 19/)).toBeDefined();
    const kept = JSON.parse(localStorage.getItem(gridKey('host'))!) as {
      widgets: Record<string, { y: number }>;
    };
    expect(kept.widgets['host.overview']!.y).toBe(18);
  });

  it('draws each Widget down to the one under it, so the columns end together', () => {
    render(<Settings />);
    // CPU's column ends at row 16; Overview and Memory's at row 28.
    expect(widget('host.cpu')!.style.gridRow).toBe('1 / span 28');
  });

  it('resizes with Shift and the arrow keys', async () => {
    const user = userEvent.setup();
    render(<Settings />);
    screen.getByRole('button', { name: 'Move Memory' }).focus();
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(widget('host.memory')!.style.gridColumn).toBe('1 / span 3');
  });

  it('hides a Widget, and the Widgets menu shows it again', async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await user.click(screen.getByRole('button', { name: 'Hide Overview' }));
    expect(widget('host.overview')).toBeNull();
    expect(screen.getByText(/Overview hidden/)).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Widgets' }));
    const item = screen.getByRole('menuitemcheckbox', { name: 'Overview' });
    expect(item.getAttribute('aria-checked')).toBe('false');
    await user.click(item);
    expect(widget('host.overview')).not.toBeNull();
    // A checkbox toggles without closing the menu.
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'Overview' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('pins a Widget to the top, full width', async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await user.click(screen.getByRole('button', { name: 'Pin CPU to the top' }));
    const top = screen.getByRole('group', { name: 'Pinned to the top' });
    expect(within(top).getByRole('heading', { name: 'CPU' })).toBeDefined();
    expect(widget('host.cpu')!.style.gridColumn).toBe('1 / span 12');
    expect(
      screen.getByRole('button', { name: 'Pin CPU to the top' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('Reset layout puts everything back and forgets the kept layout', async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await user.click(screen.getByRole('button', { name: 'Hide CPU' }));
    expect(localStorage.getItem(gridKey('host'))).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Widgets' }));
    await user.click(screen.getByRole('menuitem', { name: 'Reset layout' }));
    expect(widget('host.cpu')).not.toBeNull();
    expect(localStorage.getItem(gridKey('host'))).toBeNull();
  });

  it('opens as it was left', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Settings />);
    await user.click(screen.getByRole('button', { name: 'Hide Memory' }));
    unmount();
    await act(async () => {
      render(<Settings />);
    });
    expect(widget('host.memory')).toBeNull();
  });
});
