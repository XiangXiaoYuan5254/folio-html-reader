import {
  MousePointer2,
  Highlighter,
  Underline,
  MoveUpRight,
  Square,
  Eraser,
  Undo2,
  Redo2,
  PanelLeft,
  PanelRight,
  Search,
  Save,
  RefreshCw,
  StickyNote,
  SlidersHorizontal,
  Type,
  Sparkles,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { Tool } from '../types';
import { IconButton } from './IconButton';
import { PenIcon } from './PenIcon';
export const colors = [
  { value: '#edbd39', name: '黄色' },
  { value: '#ed737a', name: '珊瑚色' },
  { value: '#369b8d', name: '青色' },
  { value: '#598be7', name: '蓝色' },
  { value: '#334155', name: '墨色' },
];
const tools = [
  {
    id: 'select',
    label: '选择文字',
    help: '选择原文；点击高亮添加笔记，悬停查看笔记',
    icon: MousePointer2,
  },
  {
    id: 'highlight',
    label: '高亮',
    help: '拖选文字高亮；点击高亮添加笔记，悬停查看',
    icon: Highlighter,
  },
  { id: 'underline', label: '下划线', help: '拖选文字，在文字下方划线', icon: Underline },
  {
    id: 'text',
    label: '文本注释',
    help: '点击页面直接输入文字，透明背景，可移动和调字号',
    icon: Type,
  },
  {
    id: 'sticky',
    label: '便签',
    help: '点击页面任意位置贴便签，可拖动和调整大小',
    icon: StickyNote,
  },
  { id: 'pen', label: '画笔', help: '按住拖动自由画线；按住 E 临时擦除', icon: PenIcon },
  {
    id: 'laser',
    label: '激光笔',
    help: '拖动临时指示，松开约 3 秒后消失，不保存到文档',
    icon: Sparkles,
  },
  { id: 'arrow', label: '箭头', help: '按住拖动，指向你想标记的位置', icon: MoveUpRight },
  { id: 'rectangle', label: '矩形', help: '按住拖动，框选一块页面区域', icon: Square },
  { id: 'eraser', label: '橡皮擦', help: '按住拖动，只擦掉擦头经过的局部笔迹', icon: Eraser },
] as const;
export function Toolbar(p: {
  mode: 'read' | 'source';
  onMode: (v: 'read' | 'source') => void;
  tool: Tool;
  onTool: (v: Tool) => void;
  color: string;
  onColor: (v: string) => void;
  zoom: number;
  onZoom: (v: number) => void;
  onLeft: () => void;
  onRight: () => void;
  onFind: () => void;
  onSave: () => void;
  onReload: () => void;
  dirty: boolean;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  disabled: boolean;
  strokeWidth: number;
  eraserSize: number;
  onStrokeWidth: (width: number) => void;
  onEraserSize: (size: number) => void;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
}) {
  const { settingsOpen: settings, onSettingsOpenChange: setSettings } = p;
  const settingsHost = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setSettings(false);
  }, [p.tool, p.mode, setSettings]);
  useEffect(() => {
    if (!settings) return;
    const dismiss = (e: PointerEvent) => {
      if (!settingsHost.current?.contains(e.target as Node)) setSettings(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [settings, setSettings]);
  return (
    <div className="reader-toolbar">
      <IconButton label="显示或隐藏文件树" onClick={p.onLeft}>
        <PanelLeft size={17} />
      </IconButton>
      <div className="mode-switch">
        <button className={p.mode === 'read' ? 'active' : ''} onClick={() => p.onMode('read')}>
          阅读
        </button>
        <button className={p.mode === 'source' ? 'active' : ''} onClick={() => p.onMode('source')}>
          源码
        </button>
      </div>
      <span className="toolbar-divider" />
      {p.mode === 'read' ? (
        <>
          <div className="annotation-tools">
            {tools.map((t) => (
              <IconButton
                key={t.id}
                label={t.label}
                help={t.help}
                active={p.tool === t.id}
                disabled={p.disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => p.onTool(t.id)}
              >
                <t.icon size={18} />
              </IconButton>
            ))}
          </div>
          {['pen', 'arrow', 'rectangle', 'eraser'].includes(p.tool) ? (
            <div className="ink-settings" ref={settingsHost}>
              <IconButton
                label="笔触与橡皮擦大小"
                help="调整画线粗细和擦除范围"
                active={settings}
                onClick={() => setSettings(!settings)}
              >
                <SlidersHorizontal size={16} />
              </IconButton>
              {settings ? (
                <div
                  className="ink-settings-popover"
                  role="group"
                  aria-label="笔触设置"
                  style={{
                    left: Math.max(
                      8,
                      Math.min(
                        innerWidth - 252,
                        settingsHost.current?.getBoundingClientRect().left || 8,
                      ),
                    ),
                    top: (settingsHost.current?.getBoundingClientRect().bottom || 140) + 8,
                  }}
                >
                  <label>
                    画笔粗细 <output>{p.strokeWidth} px</output>
                    <input
                      aria-label="画笔粗细"
                      type="range"
                      min="1"
                      max="12"
                      step="0.5"
                      value={p.strokeWidth}
                      onChange={(e) => p.onStrokeWidth(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    橡皮擦大小 <output>{p.eraserSize} px</output>
                    <input
                      aria-label="橡皮擦大小"
                      type="range"
                      min="8"
                      max="64"
                      step="4"
                      value={p.eraserSize}
                      onChange={(e) => p.onEraserSize(Number(e.target.value))}
                    />
                  </label>
                  <p>画笔模式下按住 E 可临时擦除</p>
                </div>
              ) : null}
            </div>
          ) : null}
          <span className="toolbar-divider" />
          <div className="ink-colors">
            {colors.map((c) => (
              <button
                key={c.value}
                aria-label={c.name}
                title={c.name}
                aria-pressed={p.color === c.value}
                className={`color-dot ${p.color === c.value ? 'selected' : ''}`}
                style={{ '--ink': c.value } as React.CSSProperties}
                onClick={() => p.onColor(c.value)}
              />
            ))}
          </div>
          <span className="toolbar-divider optional" />
          <div className="history-tools">
            <IconButton label="撤销批注" onClick={p.onUndo} disabled={!p.canUndo}>
              <Undo2 size={16} />
            </IconButton>
            <IconButton label="重做批注" onClick={p.onRedo} disabled={!p.canRedo}>
              <Redo2 size={16} />
            </IconButton>
          </div>
        </>
      ) : (
        <>
          <span className="source-hint">HTML 源码</span>
          <button className="save-button" disabled={!p.dirty} onClick={p.onSave}>
            <Save size={15} />
            保存 <kbd>⌘ S</kbd>
          </button>
          <IconButton label="重新载入文件" onClick={p.onReload}>
            <RefreshCw size={16} />
          </IconButton>
        </>
      )}
      <div className="toolbar-flex" />
      {p.mode === 'read' ? (
        <select
          aria-label="阅读缩放"
          value={p.zoom}
          onChange={(e) => p.onZoom(Number(e.target.value))}
        >
          <option value={0}>适合宽度</option>
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => (
            <option key={v} value={v}>
              {v * 100}%
            </option>
          ))}
        </select>
      ) : null}
      <IconButton label="查找文内文字" onClick={p.onFind} disabled={p.disabled}>
        <Search size={17} />
      </IconButton>
      <IconButton label="显示或隐藏批注栏" onClick={p.onRight}>
        <PanelRight size={17} />
      </IconButton>
    </div>
  );
}
