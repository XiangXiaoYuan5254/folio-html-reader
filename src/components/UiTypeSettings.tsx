import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, LoaderCircle } from 'lucide-react';
import { fontStack, localFonts, setUiType, uiZooms, useUiType } from '../ui-type';
import type { FontOption } from '../ui-type';
import { useDismiss } from '../hooks/useDismiss';

const percent = (zoom: number) => `${Math.round(zoom * 100)}%`;

// 设置 › 外观与阅读: the interface's font, from the fonts on this computer, and its size.
export function UiTypeSettings() {
  const { font, zoom } = useUiType();
  const [picking, setPicking] = useState(false);
  const [fonts, setFonts] = useState<FontOption[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useDismiss(picking, () => setPicking(false), button, panel);
  useEffect(() => {
    if (!picking || fonts) return;
    localFonts().then(setFonts, () => setFailed(true));
  }, [picking, fonts]);
  const q = query.trim().toLowerCase();
  const shown = (fonts || []).filter(
    (f) => !q || f.family.toLowerCase().includes(q) || f.name.includes(query.trim()),
  );
  const current = fonts?.find((f) => f.family === font);
  return (
    <section className="settings-group">
      <h4>界面字体与大小</h4>
      <div className="settings-row">
        <span>
          <strong>界面字体</strong>
          <small>侧栏、工具栏、批注、AI 面板和设置里的文字；文档保持它自己的字体。</small>
        </span>
        <button
          ref={button}
          type="button"
          className="settings-font-button"
          aria-label="界面字体"
          aria-expanded={picking}
          style={font ? { fontFamily: fontStack(font) } : undefined}
          onClick={() => setPicking((v) => !v)}
        >
          <span>{font ? current?.name || font : '跟随主题'}</span>
          <ChevronDown size={14} />
        </button>
      </div>
      {picking ? (
        <div
          ref={panel}
          className="settings-font-panel"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // Closes the list, not the settings.
              e.stopPropagation();
              setPicking(false);
            }
          }}
        >
          <input
            value={query}
            placeholder="搜索字体，例如：宋体、Songti、Helvetica"
            aria-label="搜索字体"
            spellCheck={false}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="settings-font-list" role="listbox" aria-label="这台电脑上的字体">
            {!q ? (
              <button
                type="button"
                role="option"
                aria-selected={!font}
                className={!font ? 'active' : ''}
                onClick={() => setUiType({ font: '' })}
              >
                <span>跟随主题（默认）</span>
                {!font ? <Check size={13} /> : null}
              </button>
            ) : null}
            {shown.map((f) => (
              <button
                type="button"
                role="option"
                key={f.family}
                aria-selected={f.family === font}
                className={f.family === font ? 'active' : ''}
                style={{ fontFamily: fontStack(f.family) }}
                onClick={() => setUiType({ font: f.family })}
              >
                <span>{f.name || f.family}</span>
                {f.name ? <small>{f.family}</small> : null}
                {f.family === font ? <Check size={13} /> : null}
              </button>
            ))}
            {!fonts && !failed ? (
              <p className="settings-font-note">
                <LoaderCircle className="spin" size={13} />
                正在读取这台电脑上的字体…
              </p>
            ) : failed || (fonts && !fonts.length) ? (
              <p className="settings-font-note">读取不到这台电脑上的字体。</p>
            ) : q && !shown.length ? (
              <p className="settings-font-note">没有找到“{query.trim()}”</p>
            ) : null}
          </div>
          <div className="settings-font-actions">
            <span>
              {fonts ? `共 ${fonts.length} 种字体，点一下立即生效` : ''}
              {font && fonts && !current ? '；当前字体已不在这台电脑上' : ''}
            </span>
            <button type="button" className="settings-link" onClick={() => setPicking(false)}>
              收起
            </button>
          </div>
        </div>
      ) : null}
      <label className="settings-row">
        <span>
          <strong>界面大小</strong>
          <small>
            整个界面一起缩放，文字、图标和间距同比变化；文档大小不变，仍用文档缩放调整。
          </small>
        </span>
        <select
          aria-label="界面大小"
          value={zoom}
          onChange={(e) => setUiType({ zoom: Number(e.target.value) })}
        >
          {uiZooms.map((z) => (
            <option key={z} value={z}>
              {percent(z)}
              {z === 1 ? '（默认）' : ''}
            </option>
          ))}
        </select>
      </label>
      {font || zoom !== 1 ? (
        <button
          type="button"
          className="settings-link settings-reset"
          onClick={() => setUiType({ font: '', zoom: 1 })}
        >
          恢复默认字体和大小
        </button>
      ) : null}
    </section>
  );
}
