import { OverflowMenuHorizontal } from "@carbon/icons-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

/**
 * Trigger button + click-outside backdrop + menu [renderer §2]. Optionally
 * controlled (`open`) so a row's right-click can open it. Flips upward when
 * the menu would not fit below the trigger.
 */
export function OverflowMenu(props: {
  items: MenuItem[];
  contextSub?: string[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  triggerClassName?: string;
  triggerLabel?: string;
}) {
  const { items, contextSub, open, onOpenChange, trigger } = props;
  const triggerClassName = props.triggerClassName ?? "ov__btn";
  const triggerLabel = props.triggerLabel ?? "More actions";
  const [selfOpen, setSelfOpen] = useState(false);
  const menuOpen = open ?? selfOpen;
  const setMenuOpen = (o: boolean): void => {
    setSelfOpen(o);
    onOpenChange?.(o);
  };
  const [up, setUp] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const btn = btnRef.current;
    const menu = menuRef.current;
    if (!menuOpen || !btn || !menu) return;
    const spaceBelow = window.innerHeight - btn.getBoundingClientRect().bottom;
    setUp(menu.offsetHeight + 8 > spaceBelow);
  }, [menuOpen]);

  return (
    <div className="ov">
      <button
        ref={btnRef}
        type="button"
        className={triggerClassName}
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen(!menuOpen)}
      >
        {trigger ?? <OverflowMenuHorizontal size={16} aria-hidden />}
      </button>
      {menuOpen ? (
        <>
          <div className="ov__backdrop" onClick={() => setMenuOpen(false)} />
          <div ref={menuRef} className={`ov__menu${up ? " ov__menu--up" : ""}`} role="menu">
            {contextSub && contextSub.length > 0 ? (
              <div className="ov__context">
                {contextSub.map((line) => (
                  <div key={line} className="ov__context-sub">
                    {line}
                  </div>
                ))}
              </div>
            ) : null}
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                className={`ov__item${it.danger ? " ov__item--danger" : ""}`}
                onClick={() => {
                  setMenuOpen(false);
                  it.onClick();
                }}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
