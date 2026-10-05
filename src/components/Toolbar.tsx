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
  Presentation,
  Sparkles,
  Maximize,
  Minimize,
  Link2,
  Minus,
  Plus,
  SquareMousePointer,
  History,
  Sparkle,
  WandSparkles,
  ChevronDown,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { EraserMode, Tool } from '../types';
import { IconButton } from './IconButton';
import { PenIcon } from './PenIcon';
import { annotationColors as colors } from '../colors';
import { ColorPicker } from './ColorPicker';
import { zoomAfterWheel, zoomLabel, zoomPresets } from '../zoom';
import { isMac, shortcut } from '../platform';
import { PopupMenu, belowButton, type MenuAnchor } from './PopupMenu';
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
    help: '点击页面贴便签，右上角可改字体、字号和底色；支持移动和调整大小',
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
  { id: 'eraser', label: '橡皮擦', help: '在笔触设置中切换局部擦除或笔画擦除', icon: Eraser },
] as const;
export function Toolbar(p: {
  mode: 'read' | 'source';
  pdf?: boolean;
  focusMode: boolean;
  onFocusMode: () => void;
  onMode: (v: 'read' | 'source') => void;
  tool: Tool;
  onTool: (v: Tool) => void;
  color: string;
  onColor: (v: string) => void;
  canLinkScroll: boolean;
  linkedScroll: boolean;
  onLinkedScroll: () => void;
  zoom: number;
  onZoom: (v: number) => void;
  onLeft: () => void;
  onRight: () => void;
  onFind: () => void;
  onSave: () => void;
  onReload: () => void;
  onHistory: () => void;
  aiEditing?: boolean;
  onAiEdit?: () => void;
  assistantOpen?: boolean;
  onAssistant?: () => void;
  // Explains the selected text, or a framed region of the page, on the whiteboard.
  onWhiteboard?: () => void;
  inspecting: boolean;
  autosave: boolean;
  onAutosave: () => void;
  onInspect: () => void;
  dirty: boolean;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  disabled: boolean;
  strokeWidth: number;
  eraserSize: number;
  eraserMode: EraserMode;
  onEraserMode: (mode: EraserMode) => void;
  onStrokeWidth: (width: number) => void;
  onEraserSize: (size: number) => void;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
}) {
  const { settingsOpen: settings, onSettingsOpenChange: setSettings } = p;
  const settingsHost = useRef<HTMLDivElement>(null);
  const [settingsPosition, setSettingsPosition] = useState({ left: 8, top: 140 });
  useLayoutEffect(() => {
    if (!settings || !settingsHost.current) return;
    const place = () => {
      const rect = settingsHost.current?.getBoundingClientRect();
      if (!rect) return;
      const left = Math.max(8, Math.min(innerWidth - 252, rect.left));
      const top = rect.bottom + 8;
      setSettingsPosition((prev) =>
        prev.left === left && prev.top === top ? prev : { left, top },
      );
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(settingsHost.current.parentElement!);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [settings]);
  useEffect(() => {
    setSettings(false);
  }, [p.tool, p.mode, setSettings]);
  // A narrow toolbar keeps as many tools as fit; the rest move into a menu behind the
  // last button, which wears the current tool's icon when that tool is one of them.
  const strip = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const [fit, setFit] = useState<number>(tools.length);
  const [moreMenu, setMoreMenu] = useState<MenuAnchor | null>(null);
  useLayoutEffect(() => {
    const host = strip.current;
    const bar = host?.parentElement;
    const spacer = bar?.querySelector<HTMLElement>('.toolbar-flex');
    if (!host || !bar || !spacer) return;
    const measure = () => {
      const button = (host.firstElementChild as HTMLElement).offsetWidth;
      const step = button + (parseFloat(getComputedStyle(host).columnGap) || 0);
      const moreWidth =
        (more.current?.offsetWidth || button) + (parseFloat(getComputedStyle(bar).columnGap) || 0);
      // The room the tools would have with the spacer squeezed and no menu button.
      const room =
        host.clientWidth +
        Math.max(0, spacer.offsetWidth - parseFloat(getComputedStyle(spacer).minWidth)) +
        (more.current ? moreWidth : 0);
      const count = (width: number) => Math.floor((width + step - button) / step);
      setFit(count(room) >= tools.length ? tools.length : Math.max(1, count(room - moreWidth)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const el of [bar, host, spacer]) observer.observe(el);
    return () => observer.disconnect();
  }, [p.mode]);
  useEffect(() => setMoreMenu(null), [p.mode, fit]);
  const overflow = tools.slice(fit);
  const hiddenActive = overflow.find((t) => t.id === p.tool);
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
      <IconButton className="focus-hide" label="显示或隐藏文件树" onClick={p.onLeft}>
        <PanelLeft size={17} />
      </IconButton>
      <div className="mode-switch focus-hide">
        <button className={p.mode === 'read' ? 'active' : ''} onClick={() => p.onMode('read')}>
          阅读
        </button>
        <button
          disabled={p.pdf}
          title={p.pdf ? 'PDF 支持阅读和批注，源码编辑仅适用于 HTML' : '编辑 HTML 源码'}
          className={p.mode === 'source' ? 'active' : ''}
          onClick={() => p.onMode('source')}
        >
          源码
        </button>
      </div>
      <span className="toolbar-divider" />
      {p.mode === 'read' ? (
        <>
          <div className="annotation-tools" ref={strip}>
            {tools.map((t, i) => (
              <IconButton
                key={t.id}
                data-overflow={i >= fit || undefined}
                label={t.label}
                help={
                  t.id === 'eraser'
                    ? `${p.eraserMode === 'stroke' ? '笔画擦除：碰到即擦除整笔' : '局部擦除：只擦掉经过的部分'}；在笔触设置中切换`
                    : t.help
                }
                active={p.tool === t.id}
                disabled={p.disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => p.onTool(t.id)}
              >
                <t.icon size={18} />
              </IconButton>
            ))}
          </div>
          {overflow.length ? (
            <IconButton
              ref={more}
              className="tool-overflow"
              label={hiddenActive ? `更多工具 · 当前：${hiddenActive.label}` : '更多工具'}
              help={`窗口太窄，${overflow.map((t) => t.label).join('、')}收在这里`}
              active={!!hiddenActive}
              aria-haspopup="menu"
              aria-expanded={!!moreMenu}
              disabled={p.disabled}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => setMoreMenu(moreMenu ? null : belowButton(e.currentTarget))}
            >
              {hiddenActive ? <hiddenActive.icon size={18} /> : <ChevronDown size={16} />}
            </IconButton>
          ) : null}
          {moreMenu ? (
            <PopupMenu
              at={moreMenu}
              label="更多工具"
              onClose={() => setMoreMenu(null)}
              items={overflow.map((t) => ({
                label: (
                  <span className="overflow-tool" data-active={p.tool === t.id || undefined}>
                    <t.icon size={16} />
                    {t.label}
                  </span>
                ),
                onSelect: () => p.onTool(t.id),
              }))}
            />
          ) : null}
          {['pen', 'arrow', 'rectangle', 'eraser'].includes(p.tool) ? (
            <div className="ink-settings" ref={settingsHost}>
              <IconButton
                label="笔触与橡皮擦大小"
                help="调整画线粗细、擦除范围和擦除方式"
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
                  style={settingsPosition}
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
                  <div className="eraser-mode-setting">
                    <span>擦除方式</span>
                    <div className="eraser-mode-switch" role="radiogroup" aria-label="擦除方式">
                      {(
                        [
                          ['partial', '局部擦除'],
                          ['stroke', '笔画擦除'],
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-checked={p.eraserMode === value}
                          onClick={() => p.onEraserMode(value)}
                          onKeyDown={(e) => {
                            if (
                              !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)
                            )
                              return;
                            e.preventDefault();
                            p.onEraserMode(value === 'partial' ? 'stroke' : 'partial');
                            const buttons =
                              e.currentTarget.parentElement?.querySelectorAll('button');
                            buttons?.[value === 'partial' ? 1 : 0]?.focus();
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <p>
                      {p.eraserMode === 'stroke'
                        ? '碰到一笔，擦除这一整笔；可连续擦多笔。'
                        : '擦头经过哪里，就只擦掉哪里的笔迹。'}
                    </p>
                  </div>
                  <p>画笔模式下按住 E，使用当前擦除方式</p>
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
            <ColorPicker color={p.color} onColor={p.onColor} />
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
          <button
            className={`autosave-toggle ${p.autosave ? 'active' : ''}`}
            aria-pressed={p.autosave}
            title={p.autosave ? '修改会立即写入文件，点击关闭' : '点击开启：修改立即写入文件'}
            onClick={p.onAutosave}
          >
            <span className="switch" aria-hidden="true" />
            自动保存
          </button>
          {p.autosave ? null : (
            <button className="save-button" disabled={!p.dirty} onClick={p.onSave}>
              <Save size={15} />
              保存 <kbd>{shortcut('mod', 'S')}</kbd>
            </button>
          )}
          <IconButton
            label="定位元素"
            help="在右侧预览中指向元素，源码自动跳到对应位置；点击选中，Esc 退出"
            active={p.inspecting}
            aria-pressed={p.inspecting}
            onClick={p.onInspect}
          >
            <SquareMousePointer size={16} />
          </IconButton>
          <button
            className="history-button"
            title="查看源码修改前自动备份的版本，预览后一键恢复"
            onClick={p.onHistory}
          >
            <History size={15} />
            历史版本
          </button>
          {p.onAiEdit ? (
            <button
              className={`ai-edit-button ${p.aiEditing ? 'active' : ''}`}
              aria-pressed={!!p.aiEditing}
              title="描述想怎么改，AI 生成修改，确认后写入源码"
              disabled={p.disabled}
              onClick={p.onAiEdit}
            >
              <WandSparkles size={15} />
              AI 修改
            </button>
          ) : null}
          <IconButton label="重新载入文件" onClick={p.onReload}>
            <RefreshCw size={16} />
          </IconButton>
        </>
      )}
      <div className="toolbar-flex" />
      {p.mode === 'read' && p.canLinkScroll ? (
        <button
          className="linked-scroll-toggle"
          aria-label="同步滚动"
          aria-pressed={p.linkedScroll}
          title="保留两栏当前的位置，滚动任一栏时两篇一起移动；关闭后可分别定位"
          onClick={p.onLinkedScroll}
        >
          <Link2 size={16} />
          同步滚动
        </button>
      ) : null}
      {p.mode === 'read' ? (
        <div className="zoom-control" role="group" aria-label="缩放控制">
          <IconButton
            label="缩小阅读内容"
            onClick={() => p.onZoom(zoomAfterWheel(p.zoom || 1, 60))}
          >
            <Minus size={15} />
          </IconButton>
          <select
            aria-label="阅读缩放"
            title={`按住 ${shortcut('mod')} 滚动鼠标滚轮缩放；${isMac ? 'Mac ' : ''}触控板可双指捏合 · 25%–400%`}
            value={p.zoom}
            onChange={(e) => p.onZoom(Number(e.target.value))}
          >
            <option value={0}>适合宽度</option>
            {p.zoom > 0 && !zoomPresets.includes(p.zoom) ? (
              <option value={p.zoom}>{zoomLabel(p.zoom)}</option>
            ) : null}
            {zoomPresets.map((v) => (
              <option key={v} value={v}>
                {zoomLabel(v)}
              </option>
            ))}
          </select>
          <IconButton
            label="放大阅读内容"
            onClick={() => p.onZoom(zoomAfterWheel(p.zoom || 1, -60))}
          >
            <Plus size={15} />
          </IconButton>
        </div>
      ) : null}
      <IconButton label="查找文内文字" onClick={p.onFind} disabled={p.disabled}>
        <Search size={17} />
      </IconButton>
      {p.onWhiteboard ? (
        <IconButton
          className="focus-hide"
          label="白板讲解"
          help="选中文字，或点这里框选公式、图片，页老师在白板上边写边讲"
          disabled={p.disabled}
          onClick={p.onWhiteboard}
        >
          <Presentation size={17} />
        </IconButton>
      ) : null}
      {p.onAssistant ? (
        <button
          type="button"
          className={`ai-toolbar-button focus-hide ${p.assistantOpen ? 'active' : ''}`}
          aria-label="AI 助手"
          aria-pressed={!!p.assistantOpen}
          title="AI 助手：就当前文档提问、总结、划重点，或让 AI 在整个项目里整理"
          onClick={p.onAssistant}
        >
          <Sparkle size={14} />
          AI<span className="ai-toolbar-extra"> 助手</span>
        </button>
      ) : null}
      <IconButton className="focus-hide" label="显示或隐藏批注栏" onClick={p.onRight}>
        <PanelRight size={17} />
      </IconButton>
      <IconButton
        label={p.focusMode ? '退出专注阅读' : '专注阅读'}
        help={`全屏沉浸阅读 · ${shortcut('mod', 'shift', 'F')} 切换 · Esc 退出`}
        active={p.focusMode}
        disabled={p.disabled}
        onClick={p.onFocusMode}
      >
        {p.focusMode ? <Minimize size={17} /> : <Maximize size={17} />}
      </IconButton>
    </div>
  );
}
