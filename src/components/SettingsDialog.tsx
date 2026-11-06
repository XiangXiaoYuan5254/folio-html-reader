import { useEffect, useRef, useState } from 'react';
import {
  AudioLines,
  BookOpen,
  ExternalLink,
  HardDrive,
  Info,
  LoaderCircle,
  Megaphone,
  Palette,
  Puzzle,
  Settings,
  Sparkles,
  X,
} from 'lucide-react';
import { invoke, isDesktop } from '../api';
import { useUnreadAnnouncements } from '../announcements';
import { useAiConfig } from '../ai/client';
import { useSpeechSupport, useVoiceSettings } from '../ai/voice';
import { shortcut } from '../platform';
import type { UpdateState } from '../types';
import type { ToolbarSide } from './SelectionToolbar';
import { AiSettings, SpeechVoices } from './AiSettings';
import { Announcements } from './Announcements';
import { VoiceButton } from './BoardVoice';
import { PluginSettings } from './PluginSettings';
import { ThemePicker } from './ThemePicker';
import { StorageSettings } from './StorageSettings';
import { UiTypeSettings } from './UiTypeSettings';
import '../whiteboard.css';
import '../settings.css';

export type SettingsPage =
  'appearance' | 'ai' | 'plugins' | 'voices' | 'storage' | 'announcements' | 'about';
const pages = [
  { id: 'appearance', name: '外观与阅读', icon: Palette, detail: '让页间更适合你的阅读习惯。' },
  { id: 'ai', name: 'AI', icon: Sparkles, detail: '连接自己的服务，为不同功能选择合适的模型。' },
  {
    id: 'plugins',
    name: '插件',
    icon: Puzzle,
    detail: '让 AI 按插件的说明定时或一键干活，比如每天整理一份 AI 前沿日报。',
  },
  {
    id: 'voices',
    name: '语音',
    icon: AudioLines,
    detail: '选择页老师的声音与讲解方式，管理语音服务。',
  },
  {
    id: 'storage',
    name: '项目存储',
    icon: HardDrive,
    detail: '看看页间在当前项目里存了多少数据，清理用不到的数据、白板和旧备份。',
  },
  {
    id: 'announcements',
    name: '公告',
    icon: Megaphone,
    detail: '查看 AI 服务的免费额度与优惠活动。',
  },
  { id: 'about', name: '关于', icon: Info, detail: '版本信息、更新、用户交流与常用快捷键。' },
] as const;

export function SettingsDialog(p: {
  request: { page: SettingsPage };
  onClose: () => void;
  root?: string;
  projectName?: string;
  toolbarSide: ToolbarSide;
  onToolbarSide: (side: ToolbarSide) => void;
  noteFontSize: number;
  onNoteFontSize: (size: number) => void;
  autosave: boolean;
  onToggleAutosave: () => void;
  appVersion: string;
  update: UpdateState;
  onCheckUpdates: () => Promise<string>;
  onShowUpdate: () => void;
  onNotify: (message: string) => void;
  onBoardDeleted: (id: string) => void;
  onRunPlugin: (id: string) => void;
  onOpenPluginFolder: (id: string) => void;
}) {
  const [page, setPage] = useState<SettingsPage>(p.request.page);
  const [visited, setVisited] = useState(() => new Set<SettingsPage>([p.request.page]));
  const [presetRequest, setPresetRequest] = useState<{ id: string }>();
  const unseen = useUnreadAnnouncements();
  const [aiBusy, setAiBusy] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const config = useAiConfig();
  const busy = aiBusy;
  const current = pages.find((entry) => entry.id === page)!;
  function navigate(next: SettingsPage) {
    setVisited((before) => new Set([...before, next]));
    setPage(next);
  }
  useEffect(() => {
    navigate(p.request.page);
  }, [p.request]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop settings-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) p.onClose();
      }}
    >
      <div
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        ref={panel}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (!busy) p.onClose();
          } else if (e.key === 'Tab') {
            const focusable = Array.from(
              panel.current!.querySelectorAll<HTMLElement>(
                'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
              ),
            ).filter((el) => el.getClientRects().length && !el.closest('[hidden]'));
            const first = focusable[0];
            const last = focusable.at(-1);
            if (
              e.shiftKey &&
              (document.activeElement === first || document.activeElement === panel.current)
            ) {
              e.preventDefault();
              last?.focus();
            } else if (
              !e.shiftKey &&
              (document.activeElement === last || document.activeElement === panel.current)
            ) {
              e.preventDefault();
              first?.focus();
            }
          }
          // Reading shortcuts must not change the document behind the settings window.
          e.stopPropagation();
        }}
      >
        <aside className="settings-sidebar">
          <h2 id="settings-title">
            <Settings size={17} />
            设置
          </h2>
          <nav aria-label="设置分类">
            {pages.map(({ id, name, icon: Icon }) => (
              <button
                type="button"
                key={id}
                aria-label={name}
                aria-description={id === 'announcements' && unseen ? '有未读公告' : undefined}
                title={id === 'announcements' && unseen ? '公告 · 有未读公告' : name}
                className={page === id ? 'active' : ''}
                aria-current={page === id ? 'page' : undefined}
                onClick={() => navigate(id)}
              >
                <Icon size={17} />
                <span className="settings-nav-label">{name}</span>
                {id === 'announcements' && unseen ? (
                  <span className="announcement-dot" aria-hidden="true" />
                ) : null}
              </button>
            ))}
          </nav>
          <div className="settings-sidebar-foot">
            <BookOpen size={15} />
            <span>页间 · Folio</span>
            <small>{p.appVersion}</small>
          </div>
        </aside>
        <main className="settings-main">
          <header className="settings-heading">
            <div>
              <h3>{current.name}</h3>
              <p>{current.detail}</p>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="关闭设置"
              title="关闭设置（Esc）"
              disabled={busy}
              onClick={p.onClose}
            >
              <X size={18} />
            </button>
          </header>
          <section
            className="settings-page settings-scroll"
            hidden={page !== 'appearance'}
            aria-label="外观与阅读设置"
          >
            <ThemePicker embedded onClose={() => {}} />
            <UiTypeSettings />
            <section className="settings-group">
              <h4>阅读偏好</h4>
              <label className="settings-row">
                <span>
                  <strong>划词工具条位置</strong>
                  <small>选中文字后，批注与 AI 工具出现的位置。</small>
                </span>
                <select
                  aria-label="划词工具条位置"
                  value={p.toolbarSide}
                  onChange={(e) => p.onToolbarSide(e.target.value as ToolbarSide)}
                >
                  <option value="below">文字下方</option>
                  <option value="above">文字上方</option>
                </select>
              </label>
              <label className="settings-row">
                <span>
                  <strong>高亮笔记字号</strong>
                  <small>调整高亮与下划线附带笔记的文字大小。</small>
                </span>
                <span className="settings-range">
                  <input
                    type="range"
                    aria-label="高亮笔记字号"
                    min={12}
                    max={26}
                    step={1}
                    value={p.noteFontSize}
                    onChange={(e) => p.onNoteFontSize(Number(e.target.value))}
                  />
                  <output>{p.noteFontSize} px</output>
                </span>
              </label>
              <label className="settings-row">
                <span>
                  <strong>自动保存源码</strong>
                  <small>编辑 HTML 时自动写入文件；开启也会保存当前未保存的修改。</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={p.autosave}
                  onChange={p.onToggleAutosave}
                  aria-label="自动保存源码"
                />
              </label>
              <p className="settings-footnote">阅读偏好即时生效，重启后仍会记住。</p>
            </section>
          </section>
          <section className="settings-page" hidden={page !== 'ai'} aria-label="AI 设置">
            {visited.has('ai') ? (
              <AiSettings
                embedded
                onClose={p.onClose}
                root={p.root}
                projectName={p.projectName}
                presetRequest={presetRequest}
                onNavigate={navigate}
                onBusyChange={setAiBusy}
              />
            ) : null}
          </section>
          <section
            className="settings-page settings-scroll"
            hidden={page !== 'plugins'}
            aria-label="插件"
          >
            {visited.has('plugins') ? (
              <PluginSettings
                root={p.root}
                projectName={p.projectName}
                onRun={p.onRunPlugin}
                onOpenFolder={p.onOpenPluginFolder}
              />
            ) : null}
          </section>
          <section
            className="settings-page settings-scroll settings-announcements"
            hidden={page !== 'announcements'}
            aria-label="公告"
          >
            {visited.has('announcements') ? (
              <Announcements
                active={page === 'announcements'}
                presets={config?.presets || []}
                onConfigure={(id) => {
                  setPresetRequest({ id });
                  navigate('ai');
                }}
              />
            ) : null}
          </section>
          <section
            className="settings-page settings-scroll"
            hidden={page !== 'voices'}
            aria-label="语音设置"
          >
            {visited.has('voices') ? <VoiceSettings /> : null}
          </section>
          <section
            className="settings-page settings-scroll"
            hidden={page !== 'storage'}
            aria-label="项目存储"
          >
            {/* Counted afresh each time the page is opened. */}
            {page === 'storage' ? (
              <StorageSettings
                projectName={p.projectName}
                onBoardDeleted={p.onBoardDeleted}
                onNotify={p.onNotify}
              />
            ) : null}
          </section>
          <section
            className="settings-page settings-scroll"
            hidden={page !== 'about'}
            aria-label="关于页间"
          >
            {visited.has('about') ? (
              <AboutSettings
                version={p.appVersion}
                update={p.update}
                onCheckUpdates={p.onCheckUpdates}
                onShowUpdate={p.onShowUpdate}
              />
            ) : null}
          </section>
        </main>
      </div>
    </div>
  );
}

function VoiceSettings() {
  const settings = useVoiceSettings();
  const support = useSpeechSupport();
  const config = useAiConfig();
  const services = useRef<HTMLDivElement>(null);
  return (
    <>
      <div className="settings-voice-preferences">
        {!support ? (
          <p className="settings-footnote" role="status">
            正在读取可用的语音…
          </p>
        ) : null}
        <VoiceButton
          {...settings}
          support={support}
          busy
          embedded
          onOpenSettings={() =>
            services.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        />
        <p className="settings-footnote">与白板里的讲解菜单同步。选择声音不会自动播放。</p>
      </div>
      <section className="settings-voice-services" ref={services}>
        <h4>语音服务</h4>
        <SpeechVoices services={config?.speech || []} />
      </section>
    </>
  );
}

function AboutSettings(p: {
  version: string;
  update: UpdateState;
  onCheckUpdates: () => Promise<string>;
  onShowUpdate: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState('');
  async function check() {
    setChecking(true);
    try {
      setResult(await p.onCheckUpdates());
    } finally {
      setChecking(false);
    }
  }
  return (
    <div className="settings-about">
      <div className="settings-about-brand">
        <span>
          <BookOpen size={28} />
        </span>
        <div>
          <h4>
            页间 <small>Folio</small>
          </h4>
          <p>让阅读、批注与思考留在一起。</p>
        </div>
      </div>
      <div className="settings-row">
        <span>
          <strong>当前版本</strong>
          <small>{p.version || '开发预览'}</small>
        </span>
        <button
          type="button"
          className="secondary-button"
          disabled={!isDesktop || checking}
          onClick={() => void check()}
        >
          {checking ? <LoaderCircle size={14} className="spin" /> : null}
          {checking ? '正在检查…' : '检查更新'}
        </button>
      </div>
      {result ? (
        <p className="settings-footnote" role="status">
          {result}
        </p>
      ) : null}
      {p.update.status === 'downloading' ? (
        <p className="settings-footnote" role="status">
          正在下载 {p.update.version}，完成后会提醒你。
        </p>
      ) : p.update.status === 'ready' || p.update.status === 'manual' ? (
        <button type="button" className="secondary-button" onClick={p.onShowUpdate}>
          查看 {p.update.version} 更新
        </button>
      ) : null}
      <div className="settings-row">
        <span>
          <strong>用户交流群</strong>
          <small>交流用法、反馈问题，分享你的阅读体验。</small>
        </span>
        <button
          type="button"
          className="secondary-button"
          onClick={() =>
            void invoke('external', { url: 'https://helloxxy.com/works/folio/community/' }).catch(
              (error) => setResult(error instanceof Error ? error.message : '暂时无法打开交流群页面'),
            )
          }
        >
          加入交流群 <ExternalLink size={13} />
        </button>
      </div>
      <section className="settings-group">
        <h4>常用快捷键</h4>
        <dl className="settings-shortcuts">
          {[
            ['打开 AI 设置', shortcut('mod', ',')],
            ['选择项目', shortcut('mod', 'O')],
            ['保存文档', shortcut('mod', 'S')],
            ['专注阅读', shortcut('mod', 'shift', 'F')],
            ['切换最近两个工具', 'Tab'],
          ].map(([name, key]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>
                <kbd>{key}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
