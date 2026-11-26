import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Menu } from './Menu.tsx';

function setup() {
  const settings = vi.fn();
  const logout = vi.fn();
  render(
    <>
      <Menu
        label="Menu"
        items={[
          { kind: 'action', id: 'settings', label: 'Settings', onSelect: settings },
          { kind: 'separator', id: 'sep' },
          { kind: 'action', id: 'logout', label: 'Log out', onSelect: logout },
        ]}
      />
      <p>Outside</p>
    </>,
  );
  return {
    user: userEvent.setup(),
    settings,
    logout,
    button: screen.getByRole('button', { name: 'Menu' }),
  };
}

describe('Menu', () => {
  it('is a closed menu button to start with', () => {
    const { button } = setup();
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens on its first item, and the arrows wrap past the separator', async () => {
    const { user, button } = setup();
    await user.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Settings' }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Log out' }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Settings' }));
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Log out' }));
  });

  it('opens on its last item from the up arrow', async () => {
    const { user, button } = setup();
    button.focus();
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Log out' }));
  });

  it('Escape closes it and hands focus back to the button', async () => {
    const { user, button } = setup();
    await user.click(button);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('reopens on its first item, not the one focused last time', async () => {
    const { user, button, logout, settings } = setup();
    await user.click(button);
    await user.keyboard('{End}{Escape}{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Settings' }));
    await user.keyboard('{Enter}');
    expect(settings).toHaveBeenCalledOnce();
    expect(logout).not.toHaveBeenCalled();
  });

  it('runs the chosen item and closes', async () => {
    const { user, button, settings, logout } = setup();
    await user.click(button);
    await user.click(screen.getByRole('menuitem', { name: 'Log out' }));
    expect(logout).toHaveBeenCalledOnce();
    expect(settings).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a click outside closes it', async () => {
    const { user, button } = setup();
    await user.click(button);
    await user.click(screen.getByText('Outside'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  describe('a side menu', () => {
    function withSide() {
      const toggle = vi.fn();
      const reset = vi.fn();
      render(
        <Menu
          label="Menu"
          items={[
            {
              kind: 'submenu',
              id: 'widgets',
              label: 'Widgets',
              items: [
                { kind: 'checkbox', id: 'cpu', label: 'CPU', checked: true, onToggle: toggle },
                {
                  kind: 'checkbox',
                  id: 'memory',
                  label: 'Memory',
                  checked: false,
                  onToggle: toggle,
                },
                { kind: 'separator', id: 'sep' },
                { kind: 'action', id: 'reset', label: 'Reset layout', onSelect: reset },
              ],
            },
            { kind: 'action', id: 'settings', label: 'Settings', onSelect: vi.fn() },
          ]}
        />,
      );
      return { user: userEvent.setup(), toggle, reset };
    }
    const item = (name: string) => screen.getByRole('menuitem', { name });

    it('is the first item, and says it opens a menu', async () => {
      const { user } = withSide();
      await user.click(screen.getByRole('button', { name: 'Menu' }));
      const widgets = item('Widgets');
      expect(document.activeElement).toBe(widgets);
      expect(widgets.getAttribute('aria-haspopup')).toBe('menu');
      expect(widgets.getAttribute('aria-expanded')).toBe('false');
    });

    it('opens on the right arrow at its first item, and the left arrow closes it', async () => {
      const { user } = withSide();
      await user.click(screen.getByRole('button', { name: 'Menu' }));
      await user.keyboard('{ArrowRight}');
      expect(screen.getByRole('menu', { name: 'Widgets' })).toBeDefined();
      expect(document.activeElement).toBe(screen.getByRole('menuitemcheckbox', { name: 'CPU' }));
      await user.keyboard('{End}');
      expect(document.activeElement).toBe(item('Reset layout'));
      await user.keyboard('{ArrowLeft}');
      expect(screen.queryByRole('menu', { name: 'Widgets' })).toBeNull();
      expect(document.activeElement).toBe(item('Widgets'));
      expect(screen.getByRole('menu', { name: 'Menu' })).toBeDefined();
    });

    it('Escape closes only the side menu', async () => {
      const { user } = withSide();
      await user.click(screen.getByRole('button', { name: 'Menu' }));
      await user.keyboard('{Enter}{Escape}');
      expect(screen.queryByRole('menu', { name: 'Widgets' })).toBeNull();
      expect(document.activeElement).toBe(item('Widgets'));
    });

    it('a Widget toggles and the side menu stays open; Reset layout closes everything', async () => {
      const { user, toggle, reset } = withSide();
      await user.click(screen.getByRole('button', { name: 'Menu' }));
      await user.click(item('Widgets'));
      await user.click(screen.getByRole('menuitemcheckbox', { name: 'Memory' }));
      expect(toggle).toHaveBeenCalledOnce();
      expect(screen.getByRole('menu', { name: 'Widgets' })).toBeDefined();
      await user.click(item('Reset layout'));
      expect(reset).toHaveBeenCalledOnce();
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });
});
