import { useEffect, type RefObject } from 'react';

// Closes something open in place (a list, a panel) when the pointer goes down anywhere
// outside it and the button that opens it, as the app's menus do.
export function useDismiss(
  open: boolean,
  close: () => void,
  ...inside: RefObject<HTMLElement | null>[]
) {
  useEffect(() => {
    if (!open) return;
    const press = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!inside.some((ref) => ref.current?.contains(target))) close();
    };
    document.addEventListener('pointerdown', press, true);
    return () => document.removeEventListener('pointerdown', press, true);
  }, [open]);
}
