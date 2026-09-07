import { useEffect, useId, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { createPortal } from 'react-dom';
export function IconButton({
  label,
  children,
  active = false,
  help,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
  active?: boolean;
  help?: string;
}) {
  const id = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tip, setTip] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setTip(null);
  };
  const show = (element: HTMLElement, delay = 300) => {
    hide();
    const rect = element.getBoundingClientRect();
    timer.current = setTimeout(() => {
      const above = rect.bottom + 85 > innerHeight;
      setTip({
        left: Math.max(120, Math.min(innerWidth - 120, rect.left + rect.width / 2)),
        top: above ? rect.top - 8 : rect.bottom + 8,
        above,
      });
    }, delay);
  };
  useEffect(() => {
    window.addEventListener('blur', hide);
    return () => {
      if (timer.current) clearTimeout(timer.current);
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
              className={`tool-tooltip ${tip.above ? 'above' : ''}`}
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
