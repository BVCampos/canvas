"use client";

import { useEffect, useRef, type HTMLAttributes, type KeyboardEvent } from "react";

// Shared keyboard contract for the app's lightweight popover menus. Visual
// placement stays with each caller; focus, Arrow/Home/End navigation, and
// Escape-to-close are consistent everywhere.
export function MenuSurface({
  onClose,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const origin = document.activeElement as HTMLElement | null;
    const root = ref.current;
    requestAnimationFrame(() => menuItems(root)[0]?.focus());
    return () => {
      if (root?.contains(document.activeElement)) origin?.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    props.onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = menuItems(ref.current);
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    items[next]?.focus();
  };

  return (
    <div {...props} ref={ref} role="menu" onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

export function ListboxSurface({
  onClose,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const origin = document.activeElement as HTMLElement | null;
    const root = ref.current;
    requestAnimationFrame(() => {
      const options = listboxOptions(root);
      (options.find((option) => option.getAttribute("aria-selected") === "true") ??
        options[0])?.focus();
    });
    return () => {
      if (root?.contains(document.activeElement)) origin?.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    props.onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const options = listboxOptions(ref.current);
    if (options.length === 0) return;
    event.preventDefault();
    const current = options.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
            options.length;
    options[next]?.focus();
  };

  return (
    <div {...props} ref={ref} role="listbox" onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

function menuItems(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled])',
    ),
  ).filter((item) => item.getAttribute("aria-disabled") !== "true");
}

function listboxOptions(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>('[role="option"]:not([disabled])'),
  ).filter((option) => option.getAttribute("aria-disabled") !== "true");
}
