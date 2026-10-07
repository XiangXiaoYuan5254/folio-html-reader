import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// Where the bar belongs: under the chosen tab, or nowhere.
function measure(bar: HTMLElement) {
  const tab = bar.parentElement?.querySelector<HTMLElement>(':scope > button.active');
  return tab ? { x: `${tab.offsetLeft}px`, w: `${tab.offsetWidth}px` } : null;
}
function place(bar: HTMLElement, at: ReturnType<typeof measure>) {
  bar.style.visibility = at ? '' : 'hidden';
  if (!at) return;
  bar.style.setProperty('--tab-x', at.x);
  bar.style.setProperty('--tab-w', at.w);
}

// The bar under the chosen tab of a strip. It slides from tab to tab when the choice
// changes, and follows the tabs without sliding when the strip itself is resized.
// Put it inside the strip, which must be its positioned parent; it reads the chosen
// tab's place from the button marked .active.
export function TabIndicator({ className, active }: { className: string; active: string }) {
  const bar = useRef<HTMLSpanElement>(null);
  const [moving, setMoving] = useState(false);
  useLayoutEffect(() => place(bar.current!, measure(bar.current!)), [active]);
  useEffect(() => {
    const el = bar.current!;
    let first = true;
    const observer = new ResizeObserver(() => {
      if (first) return void (first = false);
      // A resize that comes with a new choice was already measured; it keeps its slide.
      const at = measure(el);
      if (
        at &&
        el.style.getPropertyValue('--tab-x') === at.x &&
        el.style.getPropertyValue('--tab-w') === at.w
      )
        return;
      el.style.transition = 'none';
      place(el, at);
      void el.offsetWidth;
      el.style.transition = '';
    });
    observer.observe(el.parentElement!);
    // Starts sliding only after it has been placed under the first tab.
    const frame = requestAnimationFrame(() => setMoving(true));
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  return <span ref={bar} className={`${className}${moving ? ' moving' : ''}`} aria-hidden="true" />;
}
