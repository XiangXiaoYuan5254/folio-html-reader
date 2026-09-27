import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { History, RotateCcw, X } from 'lucide-react';
import { invoke } from '../api';
import type { BackupEntry, OpenDocument } from '../types';
import { IconButton } from './IconButton';

// Selection key of the file as it is now, listed above its backups.
const currentFile = '';
const message = (e: unknown) =>
  (e as Error).message.replace(/Error invoking remote method '[^']+': Error: /, '');
const clock = (time: number) =>
  new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
export function backupLabel(time: number) {
  const d = new Date(time);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${clock(time)}`;
}
function dayLabel(time: number) {
  const d = new Date(time);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  if (time >= today) return '今天';
  if (time >= yesterday) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]}`;
}
function ago(time: number) {
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`;
}
function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function HistoryPanel({
  doc,
  unsaved,
  onRestore,
  onClose,
}: {
  doc: OpenDocument;
  // The editor holds edits that are not in the file; restoring discards them.
  unsaved: boolean;
  onRestore: (entry: BackupEntry) => Promise<void>;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<BackupEntry[] | null>(null);
  const [selected, setSelected] = useState(currentFile);
  const [view, setView] = useState<'page' | 'source'>('page');
  const [content, setContent] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const cache = useRef(new Map<string, string>());
  const list = useRef<HTMLDivElement>(null);
  const entry = entries?.find((e) => e.name === selected);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    invoke<BackupEntry[]>('backups', { path: doc.path })
      .then(setEntries)
      .catch((e) => {
        setEntries([]);
        setError(message(e));
      });
  }, [doc.path]);
  useEffect(() => {
    setError('');
    const known = selected === currentFile ? doc.source : cache.current.get(selected);
    if (known !== undefined) {
      setContent(known);
      return;
    }
    let cancelled = false;
    setContent(null);
    invoke<string>('backup', { path: doc.path, name: selected })
      .then((source) => {
        cache.current.set(selected, source);
        if (!cancelled) setContent(source);
      })
      .catch((e) => {
        if (!cancelled) setError(message(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selected, doc.path, doc.source]);
  useEffect(() => {
    if (content === null || view !== 'page') return;
    let cancelled = false;
    invoke<string>('preview', { path: doc.path, source: content })
      .then((next) => {
        if (!cancelled) setUrl(next);
      })
      .catch((e) => {
        if (!cancelled) setError(message(e));
      });
    return () => {
      cancelled = true;
    };
  }, [content, view, doc.path]);
  function move(e: KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const keys = [currentFile, ...(entries || []).map((e) => e.name)];
    const index = keys.indexOf(selected) + (e.key === 'ArrowDown' ? 1 : -1);
    const next = keys[Math.max(0, Math.min(keys.length - 1, index))];
    setSelected(next);
    list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(next)}"]`)?.focus();
  }
  async function restore() {
    if (!entry) return;
    setBusy(true);
    setError('');
    try {
      await onRestore(entry);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const days: [string, BackupEntry[]][] = [];
  for (const e of entries || []) {
    const day = dayLabel(e.time);
    if (days.at(-1)?.[0] === day) days.at(-1)![1].push(e);
    else days.push([day, [e]]);
  }
  const option = (key: string, title: string, detail: string, badge?: string) => (
    <button
      key={key}
      type="button"
      role="option"
      data-key={key}
      aria-selected={selected === key}
      tabIndex={selected === key ? 0 : -1}
      className="history-item"
      onClick={() => setSelected(key)}
    >
      <strong>
        {title}
        {badge ? <em>{badge}</em> : null}
      </strong>
      <small>{detail}</small>
    </button>
  );
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="history-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) onClose();
        }}
      >
        <header className="history-heading">
          <h2 id="history-title">
            <History size={17} />
            历史版本
          </h2>
          <span title={doc.path}>{doc.path.split('/').at(-1)}</span>
          <IconButton label="关闭历史版本" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        <div className="history-body">
          <div className="history-sidebar">
            <div
              className="history-list"
              role="listbox"
              aria-label="历史版本列表"
              ref={list}
              onKeyDown={move}
            >
              {option(
                currentFile,
                '当前文件',
                unsaved
                  ? '已保存的内容 · 编辑器里还有未保存修改'
                  : sizeLabel(new TextEncoder().encode(doc.source).length),
              )}
              {entries === null ? (
                <p className="history-empty">正在读取…</p>
              ) : entries.length ? (
                days.map(([day, items]) => (
                  <div role="group" aria-label={day} key={day}>
                    <div className="history-day" aria-hidden="true">
                      {day}
                    </div>
                    {items.map((e) =>
                      option(
                        e.name,
                        clock(e.time),
                        `${ago(e.time)} · ${sizeLabel(e.size)}`,
                        e.restore ? '恢复前' : undefined,
                      ),
                    )}
                  </div>
                ))
              ) : (
                <p className="history-empty">
                  还没有历史版本。保存源码修改时，会自动备份修改前的文件。
                </p>
              )}
            </div>
            <p className="history-policy">
              修改源码时，最多每 10 分钟备份一次修改前的文件。
              <br />
              自动清理：2 小时内全部保留，24 小时内每小时留一份，30
              天内每天留一份，更早的删除；每篇文档的备份最多占 200 MB。
            </p>
          </div>
          <div className="history-preview">
            <div className="history-preview-bar">
              <strong>{entry ? `${backupLabel(entry.time)} 的版本` : '当前文件'}</strong>
              <div className="history-view-switch" role="radiogroup" aria-label="预览方式">
                {(
                  [
                    ['page', '页面'],
                    ['source', '源码'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={view === value}
                    onClick={() => setView(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className={`primary-button history-restore ${unsaved ? 'danger' : ''}`}
                disabled={!entry || busy || content === null}
                onClick={restore}
              >
                <RotateCcw size={14} />
                {busy ? '正在恢复…' : unsaved ? '放弃修改并恢复' : '恢复此版本'}
              </button>
            </div>
            {error ? (
              <p className="history-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="history-stage">
              {view === 'source' ? (
                content === null ? (
                  <div className="history-loading">正在读取…</div>
                ) : (
                  <pre className="history-source" aria-label="历史版本源码">
                    {content}
                  </pre>
                )
              ) : url ? (
                <iframe
                  className="history-frame"
                  title="历史版本预览"
                  sandbox="allow-scripts"
                  src={url}
                />
              ) : (
                <div className="history-loading">正在载入预览…</div>
              )}
            </div>
            <p className="history-hint">
              {!entry
                ? '在左侧选择一个历史版本，预览确认后再恢复。'
                : unsaved
                  ? '编辑器里未保存的修改会被放弃；文件当前的内容会先自动备份。'
                  : '恢复前会自动备份文件当前的内容，之后随时可以再恢复回来。'}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
