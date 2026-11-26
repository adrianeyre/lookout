import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

export type MenuItem =
  | { kind: 'action'; id: string; label: string; onSelect: () => void }
  /** Toggles without closing the menu, so several can be changed in one visit. */
  | { kind: 'checkbox'; id: string; label: string; checked: boolean; onToggle: () => void }
  /** Opens a side menu of its own items. */
  | { kind: 'submenu'; id: string; label: string; items: readonly MenuItem[] }
  | { kind: 'separator'; id: string };

const actionable = (items: readonly MenuItem[]) =>
  items.flatMap((item, index) => (item.kind === 'separator' ? [] : [index]));

/** Arrow, Home and End movement through one list's actionable items. */
function step(list: number[], from: number, key: string): number | undefined {
  const at = list.indexOf(from);
  if (key === 'ArrowDown') return list[(at + 1) % list.length];
  if (key === 'ArrowUp') return list[(at - 1 + list.length) % list.length];
  if (key === 'Home') return list[0];
  if (key === 'End') return list.at(-1);
  return undefined;
}

/**
 * A menu button (WAI-ARIA APG): Enter, Space or the down arrow open it on its first item, the
 * up arrow on its last; the arrows, Home and End move between items; Escape closes it and hands
 * focus back to the button, and Tab or a click outside closes it too.
 *
 * A submenu opens beside it on the right arrow, Enter, Space or a click, on its first item;
 * the left arrow or Escape closes it again and hands focus back to the item that opened it.
 * Checkboxes toggle without closing anything.
 */
export function Menu({ label, items }: { label: string; items: readonly MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [focusAt, setFocusAt] = useState(0);
  const [sub, setSub] = useState<{ index: number; focusAt: number } | null>(null);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const actions = actionable(items);
  const openSubItem = sub ? items[sub.index] : undefined;
  const subActions = openSubItem?.kind === 'submenu' ? actionable(openSubItem.items) : [];

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setSub(null);
      }
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const selector = sub ? `[data-sub-index="${sub.focusAt}"]` : `[data-menu-index="${focusAt}"]`;
    rootRef.current?.querySelector<HTMLButtonElement>(selector)?.focus();
  }, [open, focusAt, sub]);

  // The item to focus is set with the menu, never after it, so a quick Enter cannot land on
  // the item focused last time.
  const openAt = (where: 'first' | 'last') => {
    setFocusAt(where === 'first' ? actions[0]! : actions.at(-1)!);
    setSub(null);
    setOpen(true);
  };

  const close = (returnFocus: boolean) => {
    setOpen(false);
    setSub(null);
    if (returnFocus) buttonRef.current?.focus();
  };

  const openSub = (index: number) => {
    const item = items[index];
    if (item?.kind !== 'submenu') return;
    setFocusAt(index);
    setSub({ index, focusAt: actionable(item.items)[0] ?? 0 });
  };

  const onButtonKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openAt('first');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openAt('last');
    }
  };

  const onMenuKey = (event: KeyboardEvent) => {
    if (sub) return;
    const to = step(actions, focusAt, event.key);
    if (to !== undefined) {
      event.preventDefault();
      setFocusAt(to);
    } else if (
      (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') &&
      items[focusAt]?.kind === 'submenu'
    ) {
      event.preventDefault();
      openSub(focusAt);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') close(false);
  };

  const onSubKey = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (!sub) return;
    const to = step(subActions, sub.focusAt, event.key);
    if (to !== undefined) {
      event.preventDefault();
      setSub({ ...sub, focusAt: to });
    } else if (event.key === 'ArrowLeft' || event.key === 'Escape') {
      event.preventDefault();
      setSub(null);
    } else if (event.key === 'Tab') close(false);
  };

  const renderItem = (
    item: MenuItem,
    index: number,
    level: 'menu' | 'sub',
    focused: number,
    onFocusItem: () => void,
  ) => {
    if (item.kind === 'separator') {
      return <li key={item.id} role="separator" className="menu__separator" />;
    }
    const isSub = item.kind === 'submenu';
    const subOpen = isSub && sub?.index === index;
    return (
      <li key={item.id} role="none" className={isSub ? 'menu__parent' : undefined}>
        <button
          data-menu-index={level === 'menu' ? index : undefined}
          data-sub-index={level === 'sub' ? index : undefined}
          type="button"
          role={item.kind === 'checkbox' ? 'menuitemcheckbox' : 'menuitem'}
          aria-checked={item.kind === 'checkbox' ? item.checked : undefined}
          aria-haspopup={isSub ? 'menu' : undefined}
          aria-expanded={isSub ? subOpen : undefined}
          className="menu__item"
          tabIndex={index === focused ? 0 : -1}
          onClick={() => {
            onFocusItem();
            if (item.kind === 'submenu') {
              if (subOpen) setSub(null);
              else openSub(index);
            } else if (item.kind === 'checkbox') {
              item.onToggle();
            } else {
              close(false);
              item.onSelect();
            }
          }}
        >
          {item.kind === 'checkbox' && (
            <svg
              className="menu__check"
              data-checked={item.checked || undefined}
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
          )}
          <span className="menu__label">{item.label}</span>
          {isSub && (
            <svg
              className="menu__chevron menu__chevron--side"
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
            >
              <path d="m15 18-6-6 6-6" />
            </svg>
          )}
        </button>
        {subOpen && (
          <ul
            className="menu__list menu__list--sub"
            role="menu"
            aria-label={item.label}
            onKeyDown={onSubKey}
          >
            {item.items.map((child, childIndex) =>
              renderItem(child, childIndex, 'sub', sub.focusAt, () =>
                setSub({ index, focusAt: childIndex }),
              ),
            )}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="button button--quiet menu__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openAt('first'))}
        onKeyDown={onButtonKey}
      >
        {label}
        <svg className="menu__chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <ul className="menu__list" id={menuId} role="menu" aria-label={label} onKeyDown={onMenuKey}>
          {items.map((item, index) =>
            renderItem(item, index, 'menu', focusAt, () => {
              setFocusAt(index);
              if (item.kind !== 'submenu') setSub(null);
            }),
          )}
        </ul>
      )}
    </div>
  );
}
