"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Headless popover/menu controller shared by every custom dropdown (token picker,
 * slippage, wallet menus). Owns the open state and wires the keyboard/pointer
 * affordances the hand-rolled versions were missing:
 *  - close on a pointer-down outside the container,
 *  - close on Escape AND return focus to the trigger,
 * so the menus are operable (and escapable) by keyboard, not just the mouse.
 *
 * Put `containerRef` on the wrapper that holds BOTH the trigger and the popover, and
 * `triggerRef` on the toggle button (so focus can return to it on Escape).
 */
export function useMenu<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<T>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return { open, setOpen, containerRef, triggerRef };
}
