import { useEffect, useRef } from 'react';
import { Check, SunMoon } from 'lucide-react';
import { freeTheme, setFollowSystem, setTheme, themes, useTheme } from '../theme';
import { askMembership } from '../license';
import type { ThemeId } from '../theme';

// A small window drawn with the theme's own tokens.
function ThemePreview({ id }: { id: ThemeId }) {
  return (
    <span className="theme-preview" data-theme={id} aria-hidden="true">
      <i className="tp-titlebar" />
      <span className="tp-body">
        <span className="tp-sidebar">
          <b className="tp-folder" />
          <b />
          <b className="tp-on" />
          <b />
        </span>
        <span className="tp-main">
          <span className="tp-toolbar">
            <b className="tp-pill" />
            <b className="tp-dot" />
            <b className="tp-dot" />
            <b className="tp-ai" />
          </span>
          <span className="tp-desk">
            <span className="tp-paper">
              <b className="tp-title" />
              <b />
              <b className="tp-mark" />
              <b />
              <b className="tp-short" />
            </span>
          </span>
        </span>
        <span className="tp-inspector">
          <b className="tp-tab" />
          <b className="tp-card" />
          <b className="tp-card" />
        </span>
      </span>
    </span>
  );
}

export function ThemePicker({ onClose }: { onClose: () => void }) {
  const { prefs, active, unlocked } = useTheme();
  // Without a membership the other themes and following the system open the membership dialog.
  const locked = (id?: ThemeId) => !unlocked && id !== freeTheme;
  const askPro = () => {
    onClose();
    askMembership('十套界面主题');
  };
  const following = unlocked && prefs.followSystem;
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
    function outside(e: PointerEvent) {
      const target = e.target as Element | null;
      if (!panel.current?.contains(target) && !target?.closest('.theme-button')) onClose();
    }
    function key(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', onClose);
    };
  }, []);
  const groups = [
    { dark: false, title: following ? '白天使用' : '浅色' },
    { dark: true, title: following ? '夜间使用' : '深色' },
  ];
  return (
    <section className="theme-picker" ref={panel} role="dialog" aria-label="界面主题">
      <header className="theme-picker-heading">
        <h2>界面主题</h2>
        <button
          type="button"
          role="switch"
          aria-checked={following}
          className={`theme-follow${following ? ' on' : ''}`}
          onClick={() => (unlocked ? setFollowSystem(!prefs.followSystem) : askPro())}
        >
          <SunMoon size={14} />
          跟随系统
          <span className="switch" />
        </button>
      </header>
      <p className="theme-picker-hint">
        {!unlocked
          ? '青岚免费使用。其余九套主题和「跟随系统」是 Pro 会员功能。'
          : following
            ? '白天和夜间各选一套，随系统外观自动切换。'
            : '只改变界面，文档页面保持原样。'}
      </p>
      {groups.map((group) => {
        const chosen = following ? (group.dark ? prefs.dark : prefs.light) : active;
        return (
          <div key={group.title} className="theme-group" role="group" aria-label={group.title}>
            <h3>{group.title}</h3>
            <div className="theme-grid">
              {themes
                .filter((t) => t.dark === group.dark)
                .map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`theme-card${chosen === t.id ? ' selected' : ''}`}
                    aria-pressed={chosen === t.id}
                    aria-label={`${t.name}：${t.tagline}${locked(t.id) ? '（Pro 会员）' : ''}`}
                    onClick={() => (locked(t.id) ? askPro() : setTheme(t.id))}
                  >
                    <ThemePreview id={t.id} />
                    <span className="theme-card-label">
                      <strong>{t.name}</strong>
                      <small>{t.tagline}</small>
                    </span>
                    {chosen === t.id ? (
                      <span className="theme-card-check">
                        <Check size={12} strokeWidth={3} />
                      </span>
                    ) : locked(t.id) ? (
                      <span className="theme-card-pro">Pro</span>
                    ) : null}
                  </button>
                ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
