import { useEffect, useRef, useState } from 'react';
import { CircleHelp, X } from 'lucide-react';
import { IconButton } from './IconButton';

export function ReadingStatus(p: {
  format: string;
  saving: boolean;
  error: boolean;
  hint: string;
  annotations: number;
  progress: number;
}) {
  const [open, setOpen] = useState(false);
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
      <span className="status-format">{p.format}</span>
      <span className={`save-state${p.error ? ' error' : ''}`}>
        <i />
        {p.saving ? '正在保存…' : p.error ? '请检查提示' : '本地保存'}
      </span>
      <IconButton label="阅读提示与快捷键" active={open} onClick={() => setOpen(!open)}>
        <CircleHelp size={15} />
      </IconButton>
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
              <dd>⌘ + 滚轮</dd>
            </div>
            <div>
              <dt>进入 / 退出专注</dt>
              <dd>⌘ ⇧ F</dd>
            </div>
            <div>
              <dt>退出专注 / 返回选择</dt>
              <dd>Esc</dd>
            </div>
          </dl>
          <p className="reading-help-stats">
            {p.annotations} 条批注 · 阅读进度 {p.progress}%
          </p>
          {p.format === 'PDF' ? <p>PDF 批注自动保存在项目中，原 PDF 保持不变。</p> : null}
        </div>
      ) : null}
    </footer>
  );
}
