import { useEffect, useId, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { createPortal } from 'react-dom';
// Moving from one button to the next while a tooltip shows (or just did) shows the next
// one at once, without waiting or animating again, as Mac toolbars do.
let tipShowing = 0;
let tipHiddenAt = 0;
const warm = () => tipShowing > 0 || Date.now() - tipHiddenAt < 400;
export function IconButton({
  label,
  children,
  active = false,
  help,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>;
  label: string;
  children: ReactNode;
  active?: boolean;
  help?: string;
}) {
  const id = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tip, setTip] = useState<{
    left: number;
    top: number;
    above: boolean;
    instant: boolean;
  } | null>(null);
  const shown = useRef(false);
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (shown.current) {
      shown.current = false;
      tipShowing--;
      tipHiddenAt = Date.now();
    }
    setTip(null);
  };
  const show = (element: HTMLElement, delay = 300) => {
    hide();
    const rect = element.getBoundingClientRect();
    const instant = warm();
    timer.current = setTimeout(
      () => {
        const above = rect.bottom + 85 > innerHeight;
        shown.current = true;
        tipShowing++;
        setTip({
          left: Math.max(120, Math.min(innerWidth - 120, rect.left + rect.width / 2)),
          top: above ? rect.top - 8 : rect.bottom + 8,
          above,
          instant,
        });
      },
      instant ? 0 : delay,
    );
  };
  useEffect(() => {
    window.addEventListener('blur', hide);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (shown.current) tipShowing--;
      window.removeEventListener('blur', hide);
    };
  }, []);
  return (
    <>
      <button
        {...props}
        type="button"
        aria-label={label}
        aria-describedby={tip ? id : undefined}
        aria-pressed={active}
        className={`icon-button ${active ? 'active' : ''} ${props.className || ''}`}
        onMouseEnter={(e) => {
          show(e.currentTarget);
          props.onMouseEnter?.(e);
        }}
        onMouseLeave={(e) => {
          hide();
          props.onMouseLeave?.(e);
        }}
        onFocus={(e) => {
          if (e.currentTarget.matches(':focus-visible')) show(e.currentTarget, 0);
          props.onFocus?.(e);
        }}
        onBlur={(e) => {
          hide();
          props.onBlur?.(e);
        }}
        onClick={(e) => {
          hide();
          // After a click the next tooltip waits again.
          tipHiddenAt = 0;
          props.onClick?.(e);
        }}
      >
        {children}
      </button>
      {tip
        ? createPortal(
            <div
              id={id}
              role="tooltip"
              className={`tool-tooltip${tip.above ? ' above' : ''}${tip.instant ? ' instant' : ''}`}
              style={{ left: tip.left, top: tip.top }}
            >
              <strong>{label}</strong>
              {help ? <span>{help}</span> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
