import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CircleHelp, Palette, Settings, X } from 'lucide-react';
import { IconButton } from './IconButton';
import { shortcut } from '../platform';
import { useUnreadAnnouncements } from '../announcements';

export function ReadingStatus(p: {
  format: string;
  hint: string;
  onOpenSettings: () => void;
  updateNotice: ReactNode;
  themeOpen: boolean;
  onTheme: () => void;
  annotations: number;
  progress: number;
}) {
  const [open, setOpen] = useState(false);
  const unseen = useUnreadAnnouncements();
  const host = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!host.current?.contains(event.target as Node)) setOpen(false);
    };
    const blur = () => setOpen(false);
    document.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('blur', blur);
    };
  }, [open]);
  return (
    <footer ref={host} className="statusbar" aria-label="阅读状态">
      {p.updateNotice ? <div className="sidebar-update">{p.updateNotice}</div> : null}
      <div className="sidebar-account">
        <div className="sidebar-preferences">
          <IconButton
            label="界面主题"
            help="切换配色，可跟随系统浅色 / 深色"
            className="theme-button"
            active={p.themeOpen}
            onClick={p.onTheme}
          >
            <Palette size={16} />
          </IconButton>
          <IconButton label="阅读提示与快捷键" active={open} onClick={() => setOpen(!open)}>
            <CircleHelp size={15} />
          </IconButton>
          <IconButton
            label="设置"
            help={unseen ? '打开设置 · 有未读公告' : '打开设置'}
            aria-description={unseen ? '有未读公告' : undefined}
            className="settings-button"
            onClick={p.onOpenSettings}
          >
            <Settings size={16} />
            {unseen ? <span className="announcement-dot" aria-hidden="true" /> : null}
          </IconButton>
        </div>
      </div>
      {open ? (
        <div
          className="reading-help"
          role="dialog"
          aria-label="阅读提示与快捷键"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <div className="reading-help-heading">
            <strong>阅读提示</strong>
            <IconButton label="关闭阅读提示" onClick={() => setOpen(false)}>
              <X size={15} />
            </IconButton>
          </div>
          <p>{p.hint}</p>
          <dl>
            <div>
              <dt>切换最近两个工具</dt>
              <dd>Tab</dd>
            </div>
            <div>
              <dt>自由缩放</dt>
              <dd>{shortcut('mod')} + 滚轮</dd>
            </div>
            <div>
              <dt>进入 / 退出专注</dt>
              <dd>{shortcut('mod', 'shift', 'F')}</dd>
            </div>
            <div>
              <dt>退出专注 / 返回选择</dt>
              <dd>Esc</dd>
            </div>
          </dl>
          <p className="reading-help-stats">
            {p.annotations} 条批注 · 阅读进度 {p.progress}%
          </p>
          {p.format === '图片' ? (
            <p>图片批注自动保存在项目中，原图保持不变。</p>
          ) : p.format !== 'HTML' ? (
            <p>{`${p.format} 批注自动保存在项目中，原 ${p.format} 保持不变。`}</p>
          ) : null}
        </div>
      ) : null}
    </footer>
  );
}
