import { createContext, createElement, useEffect, useRef, useState, type ReactNode } from 'react';

// How long an overlay takes to leave; matches --dur-exit in styles.css.
export const exitMs = 160;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
export const prefersReducedMotion = () => reducedMotion.matches;

// Keeps the last value on screen for a moment after it goes away, so whatever shows it
// can play its exit animation. Returns the value to show and whether it is leaving.
export function useExit<T>(value: T | null | undefined | false, ms = exitMs) {
  const last = useRef<T | null>(null);
  const [, rerender] = useState(0);
  if (value) last.current = value;
  useEffect(() => {
    if (value || !last.current) return;
    const timer = setTimeout(
      () => {
        last.current = null;
        rerender((n) => n + 1);
      },
      prefersReducedMotion() ? 0 : ms,
    );
    return () => clearTimeout(timer);
  }, [value, ms]);
  const shown = value || last.current;
  return [shown || null, !value && !!shown] as const;
}

// True inside an overlay that is playing its exit animation; overlays that render
// through a portal read it to mark their own backdrop.
export const Closing = createContext(false);

// Shows `children(value)` while `when` holds a value and for its exit animation after.
// While leaving, the overlay can't be clicked or focused and is hidden from assistive tech;
// CSS animates it through [data-closing].
export function Exit<T>({
  when,
  children,
  ms,
}: {
  when: T | null | undefined | false;
  children: (value: T) => ReactNode;
  ms?: number;
}) {
  const [shown, closing] = useExit(when, ms);
  if (!shown) return null;
  return createElement(
    Closing.Provider,
    { value: closing },
    createElement(
      'div',
      {
        className: 'exit-presence',
        'data-closing': closing || undefined,
        'aria-hidden': closing || undefined,
        inert: closing,
      },
      children(shown),
    ),
  );
}

// A stable key for an object, so a component shown for one value isn't reused for the
// next one that arrives while the first is still leaving.
const keys = new WeakMap<object, number>();
let nextKey = 0;
export function objectKey(value: object) {
  let key = keys.get(value);
  if (key === undefined) keys.set(value, (key = ++nextKey));
  return key;
}

// Cross-fades the whole window from how it looks now to how `update` leaves it.
export function crossFade(update: () => void) {
  if (prefersReducedMotion() || !document.startViewTransition) return update();
  document.startViewTransition(update);
}
